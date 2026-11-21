#!/usr/bin/env node
/**
 * 增强提示词服务 —— 作为 ZCode 插件的 MCP server。
 *
 * 为什么是这个形态（2026-11-10）：
 * 目标有两个，而且它们互相拉扯：
 *   ① 进程必须随 ZCode 启停 —— 只有这样才不会出现「重启电脑后按钮静默失效」；
 *   ② 注入到渲染层的按钮只能发 HTTP —— MCP 是 stdio，按钮够不着。
 * 能同时满足的只有一条路：让 ZCode 通过插件机制拉起本进程（满足①），
 * 本进程在 stdio 上讲 MCP 的同时，再监听 127.0.0.1:8770 供按钮调用（满足②）。
 *
 * 生命周期证据：实测本机 6 个官方插件的 MCP server 都是宿主进程的子进程
 * （documents / presentations / pdf / spreadsheets / node-repl-host / zcode-site），
 * 且随会话启动即拉起，因此这里不需要 alwaysLoad；宿主退出时它们一并消失。
 *
 * 退出条件：stdin 关闭（宿主退出）→ 关掉 HTTP 服务并退出，不留孤儿进程。
 */

import { readFileSync, mkdirSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual, createHash } from 'node:crypto';

const SERVER_NAME = 'enhance-service';

// scripts/mcp-server.mjs → 插件根目录
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPT_DIR = join(PLUGIN_ROOT, 'prompts');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// 版本号只认 .zcode-plugin/plugin.json，避免三处手抄后各说各话
const SERVER_VERSION = String(readJson(join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'))?.version || '0.0.0');

const PORT = Number(process.env.PROMPT_ENHANCER_PORT || 8770);
const UPSTREAM_TIMEOUT_MS = 60_000;
// 模型列表只是「把显示名翻译成 id」的辅助信息，不该把增强拖住
const MODELS_TIMEOUT_MS = 3_000;
const MODELS_CACHE_MS = 5 * 60_000;
// 允许覆盖 provider 配置路径：测试要能把通道 A 关掉（否则会回退到真实网关，测试就不封闭了）
const ZCODE_PROVIDER_CONFIG = process.env.PROMPT_ENHANCER_ZCODE_CONFIG
  || join(homedir(), '.zcode', 'v2', 'provider_config.json');

// 注入脚本会把草稿原样发过来；10 万字的草稿既超出模型上下文，也白烧钱
const MAX_INPUT_CHARS = 8_000;

/**
 * 增强档位。
 *
 * professional：短草稿展开成完整指令（WorkBuddy 口径，实测 4 字 → 480~860 字）。
 * basic：草稿本身已经装了用户的要求，只做清晰化，不再扩写。
 * auto：< 60 字走 professional，否则 basic。这个分界来自实测——长草稿被展开会翻三倍
 * （2026-11-21：211 字草稿 → 969 字结果，用户要滚屏删），而短草稿不展开就几乎没有价值。
 */
function resolveMode(mode, draftLen) {
  const want = String(mode ?? '').trim().toLowerCase();
  if (want === 'professional' || want === 'basic') return want;
  return draftLen < 60 ? 'professional' : 'basic';
}

function promptFilesFor(mode) {
  return mode === 'basic'
    ? { system: 'enhance_system_basic.txt', user: 'enhance_user_basic.txt' }
    : { system: 'enhance_system.txt', user: 'enhance_user.txt' };
}

/**
 * 结果长度带（按档位）。
 *
 * 四次踩坑（2026-11-21 实测）：
 *   ① 原来写死 800 字，长草稿被硬割；
 *   ② 改成「1.5x~3x」，模型几无遵从——4 字草稿回 590 字；
 *   ③ 把目标字数写进重试指令也没用，仍回 361~967 字；
 *   ④ 短草稿 professional 上限定 600，实测 5/5 超长（624~1133 字），黄条变成常态噪音。
 * 根因是当前唯一的可用模型（deepseek-flash）是推理模型，且「压缩这段文字」会把它
 * 拖进思考死循环（max_tokens 8000 都被 reasoning 吃干、content 恒为空）。所以带宽
 * 按实测能力定：上限取实测分布的上沿，宁可宽一点也不让黄条常态出现。
 * 长度只做警告（前端黄条），不做硬失败——硬失败会把可用结果整份杀掉。
 * min 取 0.9 倍，允许轻微压缩；否则少一个标点就判「丢了内容」。
 */
function lengthBand(draftLen, mode = 'professional') {
  const basic = mode === 'basic';
  const min = draftLen <= 60 ? Math.ceil(draftLen * 1.1) : Math.ceil(draftLen * 0.9);
  // professional 的短草稿上限 1200：实测 5/5 落在 624~1133 字，且重试后可能到 1400+。
  // basic 保持 200——它本来就只做清晰化，超了是真异常。
  if (draftLen <= 60) return { min, max: basic ? 200 : 1200 };
  if (draftLen <= 250) {
    return { min, max: Math.ceil(draftLen * (basic ? 1.5 : 2.5)) + (basic ? 50 : 200) };
  }
  return { min, max: Math.ceil(draftLen * (basic ? 1.2 : 1.5)) + (basic ? 30 : 200) };
}
// 单次 HTTP 请求体上限：按钮只会发一段草稿，留足余量即可
const MAX_BODY_BYTES = 256 * 1024;

const QUOTE_CHARS = '"\'“”‘’';
const FENCE_RE = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/;

// 模型偶尔会把「语言判定」写进结果（WorkBuddy 的 BAD OUTPUT 示例就是这种）。
// 只在整行都是元信息、且整行 ≤80 字时才删，避免误伤正文里出现「中文」的正常句子。
//
// 语言词必须落在句末（允许尾随标点）：早先语言词只要出现就删，会把
// 「输入可以是中文或英文，输出必须是纯文本」这类正常要求整行吃掉（实测如此）。
const LANG_TOKEN = '(?:中文|英文|英语|日文|日语|Chinese|English)';
const META_LINE_PATTERNS = [
  // 「用户输入是中文」/「User input is in Chinese」
  new RegExp(`^\\s*(?:用户输入|输入|input|user input)[^\\n]{0,16}(?:是|为|is)[^\\n]{0,16}${LANG_TOKEN}[\\s，,。.；;、!！?？:：]*$`, 'i'),
  // 「回复必须用中文」/「Response must be in Chinese」
  new RegExp(`^\\s*(?:回复|响应|输出|response|output|answer)[^\\n]{0,18}(?:必须|应该|应|须|must|should)[^\\n]{0,18}${LANG_TOKEN}[\\s，,。.；;、!！?？:：]*$`, 'i'),
  // 箭头式「输入 → 回复」：主语允许中英混合（含 "User input ..."）
  new RegExp(`^\\s*(?:用户输入|输入|user input|input)[^\\n]{0,40}(?:→|->)[^\\n]{0,40}(?:回复|响应|输出|response|output)[^\\n]{0,40}$`, 'i'),
];
const LEADING_LABEL_RE =
  /^\s*(?:增强(?:后)?的?提示词|改写后的提示词|优化后的提示词|enhanced prompt|revised prompt|improved prompt)\s*[:：]\s*/i;

// ------------------------------------------------------------------ 结果校验
// 为什么提示词之外必须还有这套（2026-11-21 实测）：deepseek-flash 对「至多一处填补」、
// 「只补属于本任务的细节」这类元规则遵从不稳定。改了三轮提示词之后仍出现
// 「总结这份周报（具体是哪份周报由你自行确定）」这种凭空加料，以及
// "inspect the surrounding code" 这种越界前置步骤。措辞管不住的，只能由代码拦：
// 拦下就带修正指令重试一次，仍不过就退回原文，绝不把不合格结果当增强成功写回输入框。

// 向用户索要材料。注意「请说明」不在此列——那是让助手解释，属合法增强。
//
// 必须拆成两段（2026-11-21 修正）：早先把「如果…缺少」当成独立违规词，结果把
// 「如果缺少关键信息，先列出你的假设再给方案，不要连续追问」这类**正确**输出判成
// 违规。实测带代码问报错的 3 次里就有一句是这种写法，本该放行却退回原文。
// 所以条件句只在「同时出现索要动作」时才算违规；而「列假设继续做」这类短语
// 下面是明确的抵消项，出现即不算。
const ASK_ACTION_RE = /请(?:先)?(?:提供|附上|补充|告知|反馈|发我|给我)|(?:向|和|与|跟|问)(?:我|你|您)(?:确认|提问|澄清|要)|请(?:你|您)?确认|由(?:我|你)确认|please (?:provide|share|attach)|ask me|let me know|clarify with me|tell me (?:if|what|which)/i;
// 条件句：单独出现不代表违规，要看伴随的是「索要」还是「继续做」
const ASK_CONDITION_RE = /(?:如(?:果)?|若|万一|假如)[^\n。；;]{0,24}(?:不足|缺少|缺失|不明|不清|没有提供|未提供|为空)/i;
// 抵消项：出现这些说明模型是让助手自己往下走，而不是把球踢回用户
const ASK_SUPPRESS_RE = /列出(?:你的|所做)?假设|说明(?:你的)?假设|按(?:最小|最合理|默认)[^\n。；;]{0,8}(?:方案|理解|处理)|不要(?:连续)?追问|无需追问|自行(?:决定|判断|选择)|由你(?:决定|判断)|use your (?:judgement|judgment)|state your assumptions|make reasonable assumptions/i;

/**
 * 判断一段输出是否在向用户索要材料。
 *
 * 三步：先看有没有「条件句 + 索要动作」同现（最紧的那种真违规），
 * 再看有没有裸的索要动作但被「列假设继续做」抵消，最后兜住无条件的直接索要。
 * 顺序不能颠倒：抵消项的作用域是一句话，不是整段。
 */
function asksUserForMaterial(out) {
  for (const sentence of String(out ?? '').split(/(?<=[。！？!?\n])/)) {
    if (!AskSentenceHasAsk(sentence)) continue;
    if (ASK_SUPPRESS_RE.test(sentence)) continue;
    return true;
  }
  return false;
}

/** 单句判定：有索要动作就算；只有条件句、没有动作的不算。 */
function AskSentenceHasAsk(sentence) {
  if (!sentence?.trim()) return false;
  // 「如果缺少 X，请提供 Y」= 条件句 + 动作，是典型违规
  if (ASK_CONDITION_RE.test(sentence) && ASK_ACTION_RE.test(sentence)) return true;
  // 裸的条件句（没有索要动作）不算：模型只是提醒自己该怎么处理
  if (ASK_CONDITION_RE.test(sentence)) return false;
  // 没有条件句时，任何索要动作都算
  return ASK_ACTION_RE.test(sentence);
}
// 需要额外动作的前置步骤（用户草稿里没有这类要求，增强不该把它加出来）
const PREP_RE = /(?:locate|reproduce|grep|inspect the|search the (?:codebase|repo|code)|look (?:through|into)|check the (?:repository|codebase))/i;
const TECH_RE = /\b(?:Next\.js|NextJS|React|Vue|Django|Flask|FastAPI|PostgreSQL|MySQL|Redis|MongoDB|pandas|numpy|Spring|Laravel|TensorFlow|PyTorch)\b/gi;
// 基础语言必须一起认。TECH_RE 只列框架/库，早先草稿里写「Python」时 techIn 是空集，
// 于是输出里的 numpy/pandas 全被判成「凭空加技术栈」——实测「如何优化 Python 循环性能」
// 两轮都不过、整份退回原文，用户看到的是「点了没反应」。
// 注意：这里误报是安全的（只会让判定更宽松），漏报才是 bug。
const LANG_RE = /\b(?:JavaScript|TypeScript|Python|Golang|Java|Rust|Ruby|Kotlin|Swift|Scala|Perl|Lua|MATLAB|SQL|Bash|PowerShell)\b|C\+\+|C#/gi;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
// 占位符：实测模型会把「（在此粘贴原文）」「{{在此粘贴需要改写的文本}}」这类填空标记
// 写进结果，用户贴回输入框还得自己填，等于没增强。
// 只认带「粘贴 / insert / your text」字样的标记——用户的模板变量（{{location_theme}}）
// 是合法内容，必须逐字保留，不能一并拦掉。
const PLACEHOLDER_RE = /（在此粘贴[^）]*）|\{\{[^}]*(?:粘贴|insert|your text|your prompt)[^}]*\}\}|\{[^{}]*(?:在此粘贴|待粘贴)[^{}]*\}|\[(?:insert|paste)[^\]]*\]|<(?:your|insert)[^>]*>/i;
// 用户自己写的禁则。只认「不要 / 别 / 禁止 / 无需 / do not / never」这一类；
// 不认「只给 / only」——后者的语义落在那一个限定词上，抽成关键词必然误判
// （"只给代码"抽成"代码"，于是任何含"代码"的输出都算保留，等于没检查）。
const PROHIBITION_RE = /(?:不要|无需|不用|禁止|别)[^\s，。；、！!？?\n]{1,24}|(?:do not|don't|dont|never)\s+[A-Za-z][A-Za-z0-9 _/-]{0,28}/gi;

/** 全局正则复用时必须重置 lastIndex，否则第二次调用会从上次匹配处继续。 */
function collectMatches(re, text) {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * 从禁则短语里抽出核心词，用来判断模型有没有把这条禁则丢掉。
 *
 * 为什么不按整句比：用户写「不要解释」，模型写「不要任何解释」是等价保留，
 * 按整句比会把合格结果判成违规，而误杀的代价是整次增强退回原文——
 * 用户看到的是「点了按钮没反应」，比漏检一条禁则严重得多。宁可漏检。
 */
function prohibitionCores(draft) {
  const cores = new Set();
  for (const raw of collectMatches(PROHIBITION_RE, draft)) {
    const core = raw
      .replace(/^(?:不要|无需|不用|禁止|别)\s*/, '')
      .replace(/^(?:do not|don't|dont|never)\s+/i, '')
      .trim()
      .toLowerCase();
    // 单字核心词（「改」「用」）没有辨识度，收进来会让判定退化成恒真
    if (core.length >= 2) cores.add(core);
  }
  return [...cores];
}

/**
 * 校验增强结果，返回 { ok, reasons, warnings }。
 *
 * 判定顺序按「越硬的先查」：先查会不会害用户（索要材料、留下占位符），再查会不会
 * 偷换任务（前置步骤、替用户选技术），最后查保真（代码块、禁则）。
 *
 * 长度不进 ok：一条偏长但内容合格的提示词，用户拿到手就能用，只是需要自己删两句；
 * 而整份退回原文，用户得到的是「点了按钮没反应」。前端的黄条通道（overLength）
 * 本来就是为这件事准备的，所以长度走 warnings。
 */
function validateEnhancement(draft, out, mode = 'professional') {
  const reasons = [];
  const warnings = [];
  if (!out) return { ok: false, reasons: ['empty'], warnings };

  if (asksUserForMaterial(out)) reasons.push('asks_user');
  if (PREP_RE.test(out)) reasons.push('preparatory_step');
  if (PLACEHOLDER_RE.test(out)) reasons.push('placeholder_left');

  // 「替用户选技术栈」只在**草稿完全没点名技术**时才是硬失败：
  // 那时模型加什么都是替用户做主（「写个爬虫」→「用 React 写」）。
  // 草稿已经点名了语言/框架时，补一个同栈的库属于合理展开，不该整份退回原文——
  // 实测「如何优化 Python 循环性能」就因为这个把可用结果丢了两轮。
  // 这类情况降为 warning：结果照常返回，痕迹留在信标里便于回看。
  const techIn = new Set([...collectMatches(TECH_RE, draft), ...collectMatches(LANG_RE, draft)]
    .map((s) => s.toLowerCase()));
  const techOut = new Set([...collectMatches(TECH_RE, out), ...collectMatches(LANG_RE, out)]
    .map((s) => s.toLowerCase()));
  const addedTech = [...techOut].filter((t) => !techIn.has(t));
  if (addedTech.length) {
    if (techIn.size === 0) reasons.push(`tech_added:${addedTech.join(',')}`);
    else warnings.push(`tech_added:${addedTech.join(',')}`);
  }

  // 代码块必须整块原样保留：拆散、改空格、改缩进都会破坏可复制性
  const blocks = collectMatches(CODE_BLOCK_RE, draft);
  if (blocks.some((b) => !out.includes(b))) reasons.push('code_block_changed');

  const outLower = out.toLowerCase();
  const lost = prohibitionCores(draft).filter((core) => !outLower.includes(core));
  if (lost.length) reasons.push(`prohibition_lost:${lost.length}`);

  const band = lengthBand(draft.length, mode);
  if (out.length > band.max) warnings.push(`over_length:${out.length}>${band.max}`);
  if (out.length < band.min) warnings.push(`under_length:${out.length}<${band.min}`);

  return { ok: reasons.length === 0, reasons, warnings };
}

const log = (...args) => process.stderr.write(`[enhance-service] ${args.join(' ')}\n`);

// 信标单独落一份文件。为什么不能只靠 stderr：实测 ZCode 只把插件 stderr 的少数几行
// 采进它的 jsonl 日志（2026-11-10 核对：启动重试那 2 行进了，信标 0 条），
// 而「按钮没出现」的排查完全依赖这些信标。退役旧 Python 服务后就靠这个文件。
const RUNTIME_DIR = join(process.env.LOCALAPPDATA || homedir(), 'zcode-prompt-enhance');
const BEACON_LOG = process.env.PROMPT_ENHANCER_BEACON_LOG || join(RUNTIME_DIR, 'beacon.log');
const MAX_BEACON_LOG_BYTES = 5 * 1024 * 1024;

// 访问令牌：打补丁时由 patch_zcode.py 写进这个文件、同时注入到渲染层脚本。
// 没有它，本机浏览器里任何一个网页都能 POST /api/enhance —— 用用户的 key 花用户的钱。
const TOKEN_FILE = process.env.PROMPT_ENHANCER_TOKEN_FILE || join(RUNTIME_DIR, 'token');

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return ''; // 还没打过补丁（或用户删了）
  }
}

// 启动时读一次作为兜底；请求时再重读（见 currentToken）。
const STARTUP_TOKEN = readToken();
if (!STARTUP_TOKEN) {
  // 措辞必须与真实行为一致：没有令牌时浏览器来源是**直接拒绝**（fail closed），
  // 不是「只校验 Origin」。早先这句写反了，排查时会把人带到错误的方向。
  log(`⚠ 没有读到令牌文件 ${TOKEN_FILE}：浏览器来源的请求将被直接拒绝（fail closed），`
    + '只有不带 Origin 的本地调用仍可用。'
    + ' 先运行一次「修复增强提示词按钮.bat」的注入流程生成令牌。');
}

/**
 * 当前令牌：每次请求重读文件。
 *
 * 为什么不能缓存成常量：apply 会在令牌文件缺失时重新生成一个并写进注入脚本，
 * 而本进程通常比一次 apply 活得久。早先缓存常量，重新注入后按钮会一路 401，
 * 只能靠重启 ZCode 恢复（用户看到的是"按钮在但一点就失败"，很难联想到令牌）。
 * 文件读不到时回退到启动时的值：既保持旧令牌仍然生效，也不会静默放开校验。
 */
function currentToken() {
  return readToken() || STARTUP_TOKEN;
}

/** 常量时间比较令牌，避免用响应时间逐字节试探（localhost 风险低，但顺手做对）。 */
function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function rotateBeaconLog() {
  try {
    if (statSync(BEACON_LOG).size < MAX_BEACON_LOG_BYTES) return;
  } catch {
    return; // 文件还不存在
  }
  try {
    rmSync(`${BEACON_LOG}.1`, { force: true });
    renameSync(BEACON_LOG, `${BEACON_LOG}.1`);
  } catch {
    /* 轮转失败不该影响写入 */
  }
}

function appendBeacon(raw) {
  let payload;
  // 调用方有两种：HTTP 客户端发来的一段 JSON 文本，以及服务内部直接传对象。
  // 早先只处理字符串，内部传对象会被落成 {"raw":"[object Object]"} ——
  // 排查时等于没写（2026-11-21 实测踩到，校验失败的原因全丢了）。
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    payload = { ...raw };
  } else {
    const text = String(raw).slice(0, 2000);
    try {
      const parsed = JSON.parse(text);
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { raw: text };
    } catch {
      payload = { raw: text };
    }
  }
  // 落盘一律单行 JSON：客户端塞进来的换行会被转义，
  // 否则任何人都能伪造一整行信标，把 check_beacon 的结论带偏。
  // 客户端 ts 另存 clientTs：它记录"页面何时发出"，服务端 ts 记录"何时落盘"。
  // 早先直接覆盖客户端 ts，排查时就分不清是上报延迟还是服务端排队。
  const now = new Date().toISOString();
  const record = { ...payload };
  if (record.ts !== undefined && record.ts !== null) record.clientTs = record.ts;
  record.ts = now;
  const line = `${JSON.stringify(record)}\n`;
  try {
    mkdirSync(dirname(BEACON_LOG), { recursive: true });
    rotateBeaconLog();
    appendFileSync(BEACON_LOG, line, 'utf8');
  } catch {
    /* 落盘失败不影响给注入脚本的响应 */
  }
}

// ------------------------------------------------------------------ 文本清理

function stripWrappingQuotes(text) {
  let s = String(text ?? '').trim();
  const fenced = s.match(FENCE_RE);
  if (fenced) s = fenced[1].trim();
  // 只剥一层：剥多了会吃掉提示词里本来有意义的引号
  if (s.length >= 2 && QUOTE_CHARS.includes(s[0]) && QUOTE_CHARS.includes(s[s.length - 1])) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function stripMetaLines(text) {
  const kept = [];
  let removed = 0;
  for (const line of String(text ?? '').split('\n')) {
    const stripped = line.trim();
    if (stripped && stripped.length <= 80 && META_LINE_PATTERNS.some((re) => re.test(stripped))) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), removed };
}

function cleanResult(raw) {
  let s = stripWrappingQuotes(raw);
  s = s.replace(LEADING_LABEL_RE, '').trim();
  const { text, removed } = stripMetaLines(s);
  // 这里只 trim，不再剥一次引号：删掉元信息行后露出的首尾引号往往是内容本身的一部分。
  return { text: text.trim(), removedMetaLines: removed };
}

// ------------------------------------------------------------------ 通道配置

class UpstreamError extends Error {
  constructor(message, unreachable = false) {
    super(message);
    this.unreachable = unreachable;
  }
}

/**
 * 通道 A：读 ZCode 自己的 provider 配置，等价于「用它当前在用的模型」。
 *
 * 返回**所有**可用 provider，而不是第一条。早先只取第一条 enabled 且填了 baseUrl 的
 * 规则——单 provider 时没错，但多 provider 下用户当前选中的模型可能属于第二个，
 * 那样会拿第一个的 baseUrl/apiKey 去调，要么 404 要么用错 key。
 * 排序按 ZCode 自己的 providerOrder，未列在里面的排最后。
 */
function readZcodeChannels() {
  const cfg = readJson(ZCODE_PROVIDER_CONFIG);
  if (!cfg) return [];
  const container = cfg.config ?? {};
  const rules = container.providerConfigRules?.providerRules ?? [];
  const order = Array.isArray(container.providerOrder) ? container.providerOrder : [];
  const rank = (id) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };

  return rules
    .filter((rule) => rule && rule.enabled !== false)
    .filter((rule) => String(rule.config?.api?.baseUrl ?? '').trim())
    .sort((a, b) => rank(a.providerId) - rank(b.providerId))
    .map((rule) => {
      const models = [];
      for (const mr of container.modelConfigRules?.providerModelRules ?? []) {
        if (mr.providerId !== rule.providerId) continue;
        if (mr.config?.enabled === false) continue;
        if (mr.modelId) models.push(mr.modelId);
      }
      return {
        name: 'zcode',
        providerId: String(rule.providerId ?? ''),
        label: `ZCode 配置（${rule.providerName || rule.providerId}）`,
        baseUrl: String(rule.config?.api?.baseUrl ?? '').replace(/\/+$/, ''),
        apiKey: String(rule.config?.access?.apiKey ?? '').trim(),
        models,
      };
    });
}

/** 通道 B：环境变量优先，其次插件目录下的 config.json / config.local.json。 */
function readFallbackChannel() {
  const fromEnv = process.env.PROMPT_ENHANCER_BASE_URL;
  if (fromEnv) {
    return {
      name: 'fallback',
      label: '环境变量端点',
      baseUrl: String(fromEnv).replace(/\/+$/, ''),
      apiKey: String(process.env.PROMPT_ENHANCER_API_KEY ?? ''),
      models: process.env.PROMPT_ENHANCER_MODEL ? [process.env.PROMPT_ENHANCER_MODEL] : [],
    };
  }
  // 逐个校验，别用 `a ?? b`：a 存在但没写 baseUrl 时，b 根本没机会被读到。
  const picked = [readJson(join(PLUGIN_ROOT, 'config.json')),
    readJson(join(PLUGIN_ROOT, 'config.local.json'))]
    .find((c) => c && typeof c.baseUrl === 'string' && c.baseUrl.trim());
  if (!picked) return null;
  return {
    name: 'fallback',
    label: '自配端点',
    baseUrl: String(picked.baseUrl).replace(/\/+$/, ''),
    apiKey: String(picked.apiKey ?? ''),
    models: picked.model ? [picked.model] : [],
  };
}

function buildChannels() {
  const prefer = (process.env.PROMPT_ENHANCER_PREFER || 'zcode').toLowerCase();
  const zcode = readZcodeChannels();
  const fallback = readFallbackChannel();
  const fallbackList = fallback ? [fallback] : [];
  return prefer === 'fallback' ? [...fallbackList, ...zcode] : [...zcode, ...fallbackList];
}

/**
 * 当前端点名了模型时，把它所在的 provider 提到最前。
 *
 * 只看模型 id 不看 providerId 是有意的：注入脚本从 `data-model-current-value`
 * 拿到的是 "providerId/modelId"，但它只转发了 modelId（改注入脚本要动 asar，现在
 * 没有回滚基线）。所以这里用「哪个 provider 声明了这个模型」反推，稳定排序，
 * 命中不到的保持原顺序——不猜、不乱序。
 */
function orderChannelsForModel(channels, requested) {
  const want = String(requested ?? '').trim().toLowerCase();
  if (!want) return channels;
  const hit = (ch) => ch.models.some((m) => String(m).toLowerCase() === want);
  return channels
    .map((ch, index) => ({ ch, index, score: hit(ch) ? 0 : 1 }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.ch);
}

// ------------------------------------------------------------------ 上游调用

function requestJson(urlStr, { method = 'POST', headers = {}, body = null, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new UpstreamError(`非法 URL：${urlStr}`, true));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = mod(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new UpstreamError(`上游返回非 JSON：${text.slice(0, 200)}`));
            }
          } else {
            reject(new UpstreamError(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new UpstreamError(`上游超时（>${timeoutMs / 1000}s）`, true));
    });
    req.on('error', (err) => {
      reject(err instanceof UpstreamError ? err : new UpstreamError(`连不上 ${urlStr}：${err.message}`, true));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const modelCache = new Map(); // `${baseUrl}|${apiKey}` -> { at, models }

async function listModels(ch, timeoutMs = MODELS_TIMEOUT_MS) {
  // 键带上 apiKey：同一 baseUrl 换 key / provider 后不该命中旧模型列表
  const cacheKey = `${ch.baseUrl}|${ch.apiKey || ''}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.models;
  try {
    const data = await requestJson(`${ch.baseUrl}/models`, { method: 'GET', headers: authHeaders(ch), timeoutMs });
    const models = (data.data ?? [])
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, name: m.name || m.id }));
    modelCache.set(cacheKey, { at: Date.now(), models });
    return models;
  } catch {
    return []; // 列出模型失败不影响增强，后续按通道配置的模型继续
  }
}

function authHeaders(ch) {
  return ch.apiKey ? { Authorization: `Bearer ${ch.apiKey}` } : {};
}

/** 前端可能传显示名（DOM 上看到的是 name），按 id → name 两轮匹配归一到上游 id。 */
function resolveModel(ch, requested, available) {
  const want = String(requested ?? '').trim();
  // 没点名时：先看通道配置里的默认模型，再看上游 /models 的返回（早先只用前者，
  // 于是「通道 B 配了端点但没配 model」会误报「该通道没有可用模型」，尽管列表取到了）。
  if (!want) return ch.models[0] ?? available[0]?.id ?? '';
  const low = want.toLowerCase();
  // 配置里的写法才是权威 id：先按大小写不敏感匹配一次，把大小写归一。
  // 某些上游对 model 大小写敏感，原样透传会莫名报「模型不存在」。
  const inConfig = ch.models.find((m) => String(m).toLowerCase() === low);
  if (inConfig) return inConfig;
  for (const m of available) if (m.id === want) return m.id;
  for (const m of available) {
    if ((m.name || '').toLowerCase() === low || m.id.toLowerCase() === low) return m.id;
  }
  return want; // 匹配不上就原样传，让上游报错，别猜
}

/**
 * 校验未过之后，把具体违规项翻译成重试指令。
 *
 * 为什么不直接再调一次：模型不知道自己哪里违规，重试只会重复同样的毛病。
 * 为什么不再写「太长了，压到 N 字」：实测该指令无效（重试仍回 361~967 字），
 * 而且「压缩这段文字」会让推理模型陷进思考死循环——长度已改走黄条提示，不在这里拦。
 */
function retryRules(reasons) {
  const lines = [
    'FINAL ATTEMPT: your previous reply was rejected. Fix exactly the problems below,',
    'and return only the corrected prompt.',
  ];
  if (reasons.includes('asks_user')) {
    lines.push('- Do not ask the user for material or confirmation: no 请提供 / 请附上 / 向我确认 / please provide / ask me / let me know.');
  }
  if (reasons.includes('placeholder_left')) {
    lines.push('- Do not leave placeholders such as "（在此粘贴原文）": write the prompt for the content the user described.');
  }
  if (reasons.some((r) => r.startsWith('tech_added'))) {
    lines.push('- Remove every technology, library and framework the draft did not name.');
  }
  if (reasons.includes('preparatory_step')) {
    lines.push('- Remove preparatory steps such as locate / inspect / reproduce.');
  }
  if (reasons.includes('code_block_changed')) {
    lines.push('- Copy the code block exactly as it appears in the draft.');
  }
  if (reasons.some((r) => r.startsWith('prohibition_lost'))) {
    lines.push('- Keep the constraints the user wrote (不要… / do not …) in the result.');
  }
  return lines.join('\n');
}

function loadPrompt(name) {
  return readFileSync(join(PROMPT_DIR, name), 'utf8');
}

async function callEnhance(ch, model, text, mode, extraRules = '') {
  const files = promptFilesFor(mode);
  const systemPrompt = loadPrompt(files.system);
  const template = loadPrompt(files.user);
  if (!template.includes('{input}')) {
    throw new UpstreamError(`${files.user} 缺少 {input} 占位符`);
  }
  // 草稿以 JSON 字符串的形式嵌进模板：引号、换行、代码块、反斜杠都由 JSON.stringify
  // 负责转义，草稿里出现 "originalPrompt" 或模板里的标签名也破不了结构。
  // 早先直接做裸文本替换，草稿含闭合标签时会把「素材边界」搞乱。
  const userPrompt = template.split('{input}').join(JSON.stringify(text));
  const data = await requestJson(`${ch.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(ch) },
    body: {
      model,
      messages: [
        { role: 'system', content: systemPrompt + (extraRules ? `\n\n${extraRules}` : '') },
        { role: 'user', content: userPrompt },
      ],
      // 改写任务要稳：实测 0.3 时同一输入在不同提示词版本下输出长度差异明显，
      // 降到 0.2 让结果更可复现。
      temperature: 0.2,
      // deepseek-flash 是推理模型，max_tokens 同时覆盖思考与正文：实测首轮
      // reasoning 吃 617、正文 319，而「压缩文本」类请求能把 2000 全吃进思考、
      // 正文返回空（finish_reason=length）。4000 给足余量，减少空响应。
      max_tokens: 4000,
    },
  });
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new UpstreamError(`上游响应缺少 choices：${JSON.stringify(data).slice(0, 200)}`);
  }
  // finish_reason 必须回传给调用方：'length' 表示 max_tokens 截断，
  // 那是半截提示词，绝不能当成功结果写回输入框。
  return { content, finishReason: String(choice?.finish_reason ?? '') };
}

// ------------------------------------------------------------------ 核心逻辑

async function enhanceInner(text, requestedModel = '', requestedMode = '') {
  // 类型必须严格校验：`String(text ?? '')` 会把 {"a":1} 变成 "[object Object]" 发给模型，
  // 既花了用户的 token，又返回一段「内容缺失」的废话，前端还当成功写回输入框。
  if (text !== undefined && text !== null && typeof text !== 'string') {
    return {
      success: false,
      text: '',
      code: 'invalid_input',
      error: `text 必须是字符串，收到的是 ${Array.isArray(text) ? 'array' : typeof text}`,
    };
  }
  const input = String(text ?? '').trim();
  if (!input) {
    return { success: false, text: '', code: 'empty_input', error: '请先输入需要增强的提示词' };
  }
  if (input.length > MAX_INPUT_CHARS) {
    return {
      success: false,
      text: '',
      code: 'input_too_long',
      error: `草稿 ${input.length} 字，超过 ${MAX_INPUT_CHARS} 字上限；请先精简再增强`,
    };
  }

  // 端点点名了模型就把它所在的 provider 提到最前；没点名时保持配置顺序。
  const channels = orderChannelsForModel(buildChannels(), requestedModel);
  if (!channels.length) {
    return { success: false, text: '', code: 'upstream_unavailable', error: '没有可用通道（读不到 ZCode provider 配置，也没有 config.json）' };
  }

  const requested = String(requestedModel ?? '').trim();

  // 档位在通道循环之前定好：重试必须沿用同一档，
  // 否则第一次用展开档、第二次用保守档，等于换了个任务。
  const mode = resolveMode(requestedMode, input.length);

  const attempts = [];
  for (const ch of channels) {
    // 前端已经点名了通道自带的模型 id 时，没必要再打一次 /models
    const known = requested && ch.models.some((m) => String(m).toLowerCase() === requested.toLowerCase());
    const available = known ? [] : await listModels(ch);
    const model = resolveModel(ch, requested, available);
    if (!model) {
      attempts.push({ channel: ch.name, code: 'llm_error', error: '该通道没有可用模型' });
      continue;
    }
    // 「用的是哪个模型」必须可分辨：requested 有值说明前端把当前选中的模型传过来了；
    // 空值则是兜底（配置里的第一个），二者在排查时是完全不同的结论。
    const modelSource = !requested
      ? (ch.models.length ? 'provider-first' : 'upstream-first')
      : (String(model).toLowerCase() === requested.toLowerCase() ? 'requested' : 'requested-unverified');
    const started = Date.now();
    try {
      const raw = await callEnhance(ch, model, input, mode);
      const { text: cleaned, removedMetaLines } = cleanResult(raw.content);
      if (!cleaned) {
        attempts.push({ channel: ch.name, code: 'llm_error', error: '模型返回空结果' });
        continue;
      }
      // 被 max_tokens 截断的结果是半截提示词（可能停在半个列表项或半个句子上）。
      // 与其把它写回输入框让用户以为增强成功，不如如实报错并保留草稿。
      if (raw.finishReason === 'length') {
        attempts.push({
          channel: ch.name,
          code: 'truncated',
          error: `模型输出被 max_tokens 截断（已输出 ${raw.content.length} 字）`,
        });
        continue;
      }

      // 提示词管不住的违规，交给代码拦。不过就带修正指令重试一次，
      // 仍不过就换下一个通道，所有通道都不过由外层退回原文（见 enhance 末尾）。
      let verdict = validateEnhancement(input, cleaned, mode);
      if (!verdict.ok) {
        attempts.push({ channel: ch.name, code: 'validation', error: `校验未过：${verdict.reasons.join(', ')}` });
        const retryRaw = await callEnhance(
          ch, model, input, mode,
          `${retryRules(verdict.reasons)}\nViolations: ${verdict.reasons.join('; ')}`,
        );
        const retryCleaned = cleanResult(retryRaw.content).text;
        if (retryRaw.finishReason === 'length' || !retryCleaned) {
          attempts.push({ channel: ch.name, code: 'validation', error: '重试结果为空或被截断' });
          continue;
        }
        const retryVerdict = validateEnhancement(input, retryCleaned, mode);
        if (!retryVerdict.ok) {
          attempts.push({ channel: ch.name, code: 'validation', error: `重试仍未过：${retryVerdict.reasons.join(', ')}` });
          continue;
        }
        const retryBand = lengthBand(input.length, mode);
        return {
          success: true,
          text: retryCleaned,
          original: input,
          model,
          modelSource,
          channel: ch.name,
          providerId: ch.providerId ?? '',
          channelLabel: ch.label,
          elapsedMs: Date.now() - started,
          removedMetaLines: 0,
          improved: true,
          retried: true,
          mode,
          maxLength: retryBand.max,
          // 偏长不算失败：交给前端黄条提示「结果超过 N 字，建议手动精简后再用」
          overLength: retryVerdict.warnings.some((w) => w.startsWith('over_length')),
        };
      }

      const band = lengthBand(input.length, mode);
      return {
        success: true,
        text: cleaned,
        original: input,
        model,
        modelSource,
        channel: ch.name,
        providerId: ch.providerId ?? '',
        channelLabel: ch.label,
        elapsedMs: Date.now() - started,
        removedMetaLines,
        improved: true,
        retried: false,
        mode,
        maxLength: band.max,
        overLength: verdict.warnings.some((w) => w.startsWith('over_length')),
      };
    } catch (err) {
      attempts.push({
        channel: ch.name,
        code: err instanceof UpstreamError && err.unreachable ? 'upstream_unavailable' : 'llm_error',
        error: err?.message ?? String(err),
      });
    }
  }

  const last = attempts[attempts.length - 1] ?? { code: 'unknown', error: '没有可用通道' };

  // 区分两类失败：上游不可用（模型没跑通，结果为空）与「结果不合格」（模型跑通了，
  // 但违反了红线）。后者不是故障——草稿本身已经很清晰时，「不改动」就是正确答案，
  // 报 error 会让前端弹红条、用户以为功能坏了。所以这里退回原文，并如实标记
  // improved: false，让调用方（MCP 工具）知道「没增强成功，但服务是好的」。
  //
  // 这里必须主动说明一个限制：注入脚本只认 success / text / overLength 三个字段，
  // 无法把「未增强」显示出来，用户看到的是输入框内容没变。要让它可见就得改注入脚本
  // （即改 asar，而当前没有回滚基线），所以这里先不动，只把事实留在信标里。
  const allValidation = attempts.length > 0 && attempts.every((a) => a.code === 'validation');
  if (allValidation) {
    appendBeacon({
      kind: 'enhance-fallback',
      inputLen: input.length,
      reasons: attempts.map((a) => a.error),
    });
    return {
      success: true,
      text: input,
      original: input,
      model: '',
      modelSource: 'none',
      channel: '',
      providerId: '',
      channelLabel: '',
      elapsedMs: 0,
      improved: false,
      mode,
      attempts,
      maxLength: lengthBand(input.length, mode).max,
      overLength: false,
    };
  }
  return { success: false, text: '', code: last.code, error: last.error, attempts };
}

/**
 * 最近一次调用的模型去向。
 *
 * 为什么要在内存里留一份：「增强用的是哪个模型」是这个功能最常被质疑的一点，
 * 而 provider 配置、前端 DOM、上游模型列表三者可能各不相同。把最后一次的结论
 * 记下来，/api/health 直接能看，不用再去翻信标或加日志。
 */
const lastRun = { at: null, model: '', modelSource: '', mode: '', improved: null, channel: '', cached: false, deduped: false };

/**
 * 重复调用的两层处理，默认只开第一层。
 *
 * **第一层：并发去重（默认开）**
 * 同一份草稿 + 同档位 + 同模型正在请求时，第二个请求直接等第一个的结果。
 * 实测意义（2026-11-21）：一次增强 4~12 秒、重试时 44 秒，而按钮 tooltip 写着
 * 「再次点击可取消当前这次增强」——用户取消后立刻重点，服务端那次其实还在跑，
 * 不去重就是两次完整调用、两份钱。去重后第二次直接拿到正在进行的那一份。
 *
 * **第二层：结果缓存（默认关）**
 * 加它之前先确认了连点到底会不会发生：注入脚本在请求中会 `button.disabled = loading`，
 * 所以手滑连点这条路不存在。既然如此，结果缓存的唯一效果就是「用户对结果不满意、
 * 原样再点一次时，永远拿到同一份」——那是伤害，不是优化。
 * 所以默认 TTL=0（关闭），要开必须显式设 PROMPT_ENHANCER_RESULT_CACHE_TTL（秒）。
 * 将来若前端能显示「（缓存）」或提供「重新生成」按钮，再打开它才成立。
 */
const RESULT_CACHE_TTL_MS = Math.max(0, Number(process.env.PROMPT_ENHANCER_RESULT_CACHE_TTL ?? 0) || 0) * 1000;
const RESULT_CACHE_MAX = 100;
const resultCache = new Map(); // key -> { at, result }
const inFlight = new Map(); // key -> Promise<result>

function cacheKeyOf(text, model, mode) {
  // 用 sha1 而不是原文当键：8000 字的草稿直接做键会让 Map 常驻几十 MB
  return createHash('sha1')
    .update(`${mode}\u0000${String(model ?? '').toLowerCase()}\u0000${text}`, 'utf8')
    .digest('hex');
}

function cacheGet(key) {
  if (RESULT_CACHE_TTL_MS <= 0) return null;
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  // LRU：命中的条目挪到末尾，淘汰时总是从最久未用的开始
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit.result;
}

function cacheSet(key, result) {
  if (RESULT_CACHE_TTL_MS <= 0) return;
  resultCache.set(key, { at: Date.now(), result });
  // Map 保持插入顺序，第一个键就是最久未用的
  while (resultCache.size > RESULT_CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

/** 测试用：清空两层，避免用例之间互相命中。 */
function clearResultCache() {
  resultCache.clear();
  inFlight.clear();
}

/** 把一次调用的结论记进 lastRun，供 /api/health 直接读取。 */
function recordRun(result, flags = {}) {
  lastRun.at = new Date().toISOString();
  lastRun.model = result.model ?? '';
  lastRun.modelSource = result.modelSource ?? '';
  lastRun.mode = result.mode ?? '';
  lastRun.improved = result.improved ?? null;
  lastRun.channel = result.providerId || result.channel || '';
  lastRun.cached = flags.cached === true;
  lastRun.deduped = flags.deduped === true;
}

async function enhance(text, requestedModel = '', requestedMode = '', noCache = false) {
  const original = String(text ?? '').trim();
  // noCache 同时关掉两层：连「等别人那一份」也不要，就是强制一次独立的上游调用
  const reuse = !noCache && original !== '';
  // 键里的 mode 必须和 enhanceInner 内部算出来的一致，所以这里用同一套规则先算一遍
  const key = reuse ? cacheKeyOf(original, requestedModel, resolveMode(requestedMode, original.length)) : '';

  if (reuse) {
    // 第一层：同一请求正在飞行中 → 等它，不再打第二次上游
    const running = inFlight.get(key);
    if (running) {
      const shared = await running;
      recordRun(shared, { deduped: true });
      return { ...shared, cached: false, deduped: true };
    }
    // 第二层：结果缓存（默认关闭，见常量区的说明）
    const hit = cacheGet(key);
    if (hit) {
      recordRun(hit, { cached: true });
      return { ...hit, cached: true, deduped: false };
    }
  }

  const pending = enhanceInner(text, requestedModel, requestedMode);
  if (reuse) inFlight.set(key, pending);
  let result;
  try {
    result = await pending;
  } finally {
    // 成功失败都要摘掉：留着一条已失败的 Promise，会让后续同草稿请求一直拿到同一个失败
    if (reuse) inFlight.delete(key);
  }

  recordRun(result);
  // 只收「真增强成功」：退回原文和失败都要给下次留重试机会
  if (reuse && result.success === true && result.improved === true) cacheSet(key, result);
  return { ...result, cached: false, deduped: false };
}

// ------------------------------------------------------------------ HTTP（供注入的按钮调用）

const ALLOW_HEADERS = 'Content-Type, X-ZCE-Token';

/**
 * 谁可以读响应。
 *
 * 之前是 `Access-Control-Allow-Origin: *`：本机浏览器里任何一个网页都能
 * POST /api/enhance（花用户的 API 额度）、读 /api/health（上游地址与模型列表）、
 * 往 /api/beacon 里灌日志。这里只放行「本机来源」与「应用自己的自定义协议」，
 * http(s) 站点一律拒绝；浏览器来源还要求带令牌（见 TOKEN_FILE）。
 */
function originAllowed(origin) {
  if (!origin) return true; // 非浏览器调用（curl / PowerShell / 本地脚本）
  if (origin === 'null') return true; // file:// 页面、沙箱 iframe —— 仍需令牌
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true; // 渲染层自定义协议
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function corsFor(origin) {
  if (!origin || !originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(res, status, body, cors = {}) {
  if (!res || res.writableEnded || res.destroyed) return; // 客户端提前断开时别再写
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    ...cors,
  });
  res.end(raw);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (failed) return; // 超限后继续接收但丢弃，保证 413 能正常送达
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const err = new Error(`请求体超过 ${limit} 字节`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function createHttpServer() {
  return createServer(async (req, res) => {
    // 这段必须在 try 之外先解析，否则畸形请求行（例如 "GET //"）会让 async 回调
    // 抛未捕获异常，Node 默认直接结束进程 —— 任何一个本机进程都能打掉服务。
    let url;
    try {
      url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    } catch {
      sendJson(res, 400, { success: false, error: 'bad request target' });
      return;
    }

    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      sendJson(res, 403, { success: false, error: 'forbidden origin' });
      return;
    }
    const cors = corsFor(origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // 浏览器来源（file:// 与自定义协议的 Origin: null / scheme://）一律必须带访问令牌：
    //   有令牌 → 常量时间校验；没有令牌文件 → 直接拒绝（fail closed），
    //   否则本机任意网页（含沙箱 iframe 的 Origin: null）都能用用户的 key 调 /api/enhance。
    // 不带 Origin 的本地命令行调用（README 里的 curl / PowerShell）保持免令牌。
    const token = currentToken();
    if (origin) {
      if (!token) {
        sendJson(res, 401, {
          success: false,
          error: '服务尚未生成访问令牌，浏览器来源的调用已被拒绝；'
            + '请先运行一次「修复增强提示词按钮.bat」的注入流程生成令牌',
        }, cors);
        return;
      }
      if (!tokensMatch(req.headers['x-zce-token'], token)) {
        sendJson(res, 401, { success: false, error: 'missing or invalid token' }, cors);
        return;
      }
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const channels = buildChannels();
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          port: servedPort(),
          version: SERVER_VERSION,
          tokenRequired: !!token,
          tokenFile: TOKEN_FILE,
          channels: channels.map((c) => ({
            name: c.name,
            providerId: c.providerId ?? '',
            label: c.label,
            baseUrl: c.baseUrl,
            hasKey: !!c.apiKey,
            models: c.models.slice(0, 8),
          })),
          modes: ['auto', 'professional', 'basic'],
          cache: {
            dedupeEnabled: true,
            resultCacheTtlMs: RESULT_CACHE_TTL_MS,
            size: resultCache.size,
            inFlight: inFlight.size,
          },
          lastRun,
        }, cors);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const ch = buildChannels()[0];
        let models = ch ? await listModels(ch) : [];
        if (!models.length && ch) models = ch.models.map((id) => ({ id, name: id }));
        sendJson(res, 200, {
          models,
          channel: ch?.name ?? null,
          channelLabel: ch?.label ?? null,
          source: models.length ? 'upstream' : 'empty',
        }, cors);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/beacon') {
        const raw = await readBody(req, 64 * 1024);
        appendBeacon(raw);
        log('beacon', raw.slice(0, 1000));
        sendJson(res, 200, { ok: true }, cors);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/enhance') {
        let body = {};
        let rawBody;
        try {
          rawBody = await readBody(req);
        } catch (err) {
          // 请求体超限（413）等读失败必须保留原状态码：
          // 早先这里和 JSON 解析共用一个 catch，超限被报成「请求体不是合法 JSON」，误导排查。
          sendJson(res, err?.statusCode || 400, {
            success: false, text: '', code: 'bad_request', error: err?.message ?? String(err),
          }, cors);
          return;
        }
        try {
          body = JSON.parse(rawBody || '{}');
        } catch (err) {
          sendJson(res, 400, { success: false, text: '', code: 'unknown', error: `请求体不是合法 JSON：${err.message}` }, cors);
          return;
        }
        sendJson(res, 200, await enhance(body.text, body.model, body.mode, body.noCache === true), cors);
        return;
      }
      sendJson(res, 404, { error: 'not found' }, cors);
    } catch (err) {
      sendJson(res, err?.statusCode || 500, {
        success: false, text: '', code: 'unknown', error: err?.message ?? String(err),
      }, cors);
    }
  });
}

// ------------------------------------------------------------------ MCP（stdio，按行分隔 JSON-RPC）

const TOOLS = [
  {
    name: 'enhance_prompt',
    description: '把一段草稿改写成更明确、更完整的提示词（与输入框下方的「增强提示词」按钮同一套逻辑与提示词）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要增强的草稿原文' },
        model: { type: 'string', description: '可选，指定模型；留空则用 ZCode 当前配置的模型' },
        mode: {
          type: 'string',
          enum: ['auto', 'professional', 'basic'],
          description: '增强档位：professional 展开成完整指令，basic 只做清晰化不扩写；'
            + 'auto（默认）按草稿长度选（<60 字走 professional）',
        },
        noCache: {
          type: 'boolean',
          description: '跳过结果缓存，强制重新调用模型（默认 false；同一草稿 10 分钟内会命中缓存）',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_service_status',
    description: '查看增强服务状态：监听端口、可用通道与其上游地址。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args) {
  if (name === 'enhance_prompt') {
    const result = await enhance(args?.text ?? '', args?.model ?? '', args?.mode ?? '', args?.noCache === true);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  if (name === 'enhance_service_status') {
    const body = {
      pid: process.pid,
      port: servedPort(),
      listening: httpState.listening,
      // 端口被占时前端要能区分「还没起来」和「被别的进程占着」，
      // 否则用户看到的永远是一句「服务未响应」，无从下手。
      retrying: httpState.retrying,
      giveUp: httpState.giveUp,
      version: SERVER_VERSION,
      promptRoot: PROMPT_DIR,
      beaconLog: BEACON_LOG,
      channels: buildChannels().map((c) => ({ name: c.name, label: c.label, baseUrl: c.baseUrl, hasKey: !!c.apiKey, models: c.models })),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  }
  const err = new Error(`Unknown tool: ${name}`);
  err.code = -32602;
  throw err;
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (id === undefined) return null; // 通知，不回包

  if (method === 'initialize') {
    return {
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') return { result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      return { result: await callTool(params?.name, params?.arguments ?? {}) };
    } catch (err) {
      return { error: { code: err.code ?? -32603, message: err?.message ?? String(err) } };
    }
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

// ------------------------------------------------------------------ 启动

const httpState = { listening: false, server: null, port: null, retrying: false, giveUp: null, slowRetry: false };
// shutdown 可能被多个信号同时触发（rl close / stdin end / SIGTERM / SIGINT），只认第一次
let shuttingDown = false;

/**
 * 实际监听端口。
 * PROMPT_ENHANCER_PORT=0 时由系统分配（测试用它避免固定端口被占），
 * 所以对外报告/打印的必须是真实端口，不能直接用常量 PORT。
 */
function servedPort() {
  return httpState.port ?? PORT;
}

// 端口被占时的退避节奏：先密集重试（覆盖「旧实例正在退出」这段过渡期），
// 再逐步拉长。必须留上限——早先是无限期每 5 分钟重试一次，多开会话就会攒下一堆
// 永远抢不到端口、却一直不退出的 node 进程（实测同一天 connect.started 18 次）。
const PORT_RETRY_FAST = 15;
const PORT_RETRY_FAST_MS = 2_000;
const PORT_RETRY_SLOW_MS = 30_000;
const PORT_RETRY_MAX_TRIES = 40; // 前 15×2s + 25×30s ≈ 13 分钟按密集节奏重试
// 13 分钟之后不放弃，改成每 1~3 分钟试一次。
// 为什么改（2026-11-21 实测）：残留的第二个实例抢不到端口，按原来的逻辑在 13 分钟时
// 永久放弃；随后真正的监听者退出，端口就空悬了——进程还活着、按钮却点不动，
// 而且日志里再没有任何相关记录。低频重试不会新增进程（进程本来就因为 stdin 开着不退），
// 只是给它一个在端口空出来后接管的机会。间隔加随机抖动，避免多个残留实例同一刻一起撞。
const PORT_RETRY_IDLE_MS = 60_000;
const PORT_RETRY_IDLE_JITTER_MS = 120_000;

async function startHttp() {
  const attempt = (n) =>
    new Promise((resolve) => {
      const server = createHttpServer();
      httpState.server = server;
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          httpState.listening = false;
          httpState.retrying = true;
          const idle = n + 1 >= PORT_RETRY_MAX_TRIES;
          httpState.slowRetry = idle;
          const delay = idle
            ? PORT_RETRY_IDLE_MS + Math.floor(Math.random() * PORT_RETRY_IDLE_JITTER_MS)
            : (n < PORT_RETRY_FAST ? PORT_RETRY_FAST_MS : PORT_RETRY_SLOW_MS);
          // 密集阶段每次都记；低频阶段每 10 次记一次，免得刷爆日志
          if (!idle || (n + 1 - PORT_RETRY_MAX_TRIES) % 10 === 0) {
            log(`端口 ${PORT} 被占用，${Math.round(delay / 1000)}s 后重试（第 ${n + 2} 次${idle ? '，低频模式' : ''}）`);
          }
          const timer = setTimeout(() => resolve(attempt(n + 1)), delay);
          timer.unref?.(); // 等待重试不该阻止进程退出
          return;
        }
        httpState.listening = false;
        log(`HTTP 启动失败：${err.message}（按钮将无法工作）`);
        resolve();
      });
      server.listen(PORT, '127.0.0.1', () => {
        httpState.listening = true;
        httpState.retrying = false;
        httpState.giveUp = null;
        httpState.slowRetry = false;
        httpState.port = server.address()?.port ?? PORT;
        log(`HTTP 已监听 http://127.0.0.1:${servedPort()}（pid=${process.pid}）`);
        resolve();
      });
    });
  await attempt(0);
}

function shutdown(reason) {
  // 幂等：stdin 关闭时 rl 'close' 与 stdin 'end' 会先后各触发一次，
  // 早先会打两条「退出（…）」日志，看日志时容易误判成退了两次。
  if (shuttingDown) return;
  shuttingDown = true;
  log(`退出（${reason}）`);
  try {
    httpState.server?.close();
    // 断开 keep-alive 连接，否则 close() 要等连接超时才回调
    httpState.server?.closeAllConnections?.();
  } catch {
    /* ignore */
  }
  // 给事件循环 0.8s 自然收尾，随后强制退出兜底。
  // 不用裸 process.exit()：Windows 上它会与正在关闭的句柄竞争，触发
  // libuv 断言（handle->flags & UV_HANDLE_CLOSING）并把退出码变成 127。
  setTimeout(() => process.exit(0), 800);
}

async function main() {
  // 进程级兜底：这个进程是 ZCode 的子进程，静默退出会让按钮和 MCP 工具一起失效。
  // 记录后继续运行，比直接崩掉更容易排查。
  process.on('uncaughtException', (err) => log(`uncaughtException：${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandledRejection：${err?.stack ?? err}`));

  // HTTP 必须"发起来就走"，绝不能 await 在 MCP 之前。
  // 教训（2026-11-10 实测）：早先写成 `await startHttp()`，而端口被占时是无限重试，
  // 于是它永远不返回 → 后面的 stdio 循环没建立 → 宿主的 initialize 收不到回复
  // → 插件被判 failed、进程被杀。表现为「插件装了但没有任何 node 进程」。
  startHttp().catch((err) => log(`HTTP 启动异常：${err?.message ?? err}`));

  log(`已就绪：pid=${process.pid} 插件根=${PLUGIN_ROOT}`);

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    const reply = await handleMessage(message);
    if (reply) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
    }
  });
  // 宿主退出会关掉我们的 stdin —— 这是本进程唯一的退出信号，
  // 靠它保证不会留下孤儿（比父进程轮询更可靠）。
  rl.on('close', () => shutdown('stdin 已关闭，宿主退出'));
  process.stdin.on('end', () => shutdown('stdin end'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.env.ENHANCE_SERVICE_AS_LIB !== '1') {
  main().catch((err) => {
    log(`启动失败：${err?.stack ?? err}`);
    process.exit(1);
  });
}

export {
  enhance, cleanResult, stripWrappingQuotes, stripMetaLines, resolveModel,
  buildChannels, readZcodeChannels, readFallbackChannel, orderChannelsForModel,
  originAllowed, readToken, validateEnhancement, lengthBand, resolveMode, promptFilesFor,
  clearResultCache, cacheKeyOf,
};
