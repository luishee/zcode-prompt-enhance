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

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SERVER_NAME = 'enhance-service';
// 与 .zcode-plugin/plugin.json 的 version 保持一致；不一致时 health 上报会误导排查
const SERVER_VERSION = '0.1.2';

// scripts/mcp-server.mjs → 插件根目录
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPT_DIR = join(PLUGIN_ROOT, 'prompts');

const PORT = Number(process.env.PROMPT_ENHANCER_PORT || 8770);
const UPSTREAM_TIMEOUT_MS = 60_000;
// 允许覆盖 provider 配置路径：测试要能把通道 A 关掉（否则会回退到真实网关，测试就不封闭了）
const ZCODE_PROVIDER_CONFIG = process.env.PROMPT_ENHANCER_ZCODE_CONFIG
  || join(homedir(), '.zcode', 'v2', 'provider_config.json');

const QUOTE_CHARS = '"\'“”‘’';
const FENCE_RE = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/;

// 模型偶尔会把「语言判定」写进结果（WorkBuddy 的 BAD OUTPUT 示例就是这种）。
// 只在整行都是元信息、且整行 ≤80 字时才删，避免误伤正文里出现「中文」的正常句子。
const META_LINE_PATTERNS = [
  /^\s*(?:用户输入|输入|input|user input)[^\n]{0,16}(?:是|为|is)[^\n]{0,16}(?:中文|英文|英语|日文|日语|Chinese|English)/i,
  /^\s*(?:回复|响应|输出|response|output|answer)[^\n]{0,18}(?:必须|应该|应|须|must|should)[^\n]{0,18}(?:中文|英文|英语|Chinese|English)/i,
  /^\s*(?:用户输入|输入|input)[^\n]{0,40}(?:→|->)[^\n]{0,40}(?:回复|响应|输出|response|output)[^\n]{0,40}$/i,
];
const LEADING_LABEL_RE =
  /^\s*(?:增强(?:后)?的?提示词|改写后的提示词|优化后的提示词|enhanced prompt|revised prompt|improved prompt)\s*[:：]\s*/i;

const log = (...args) => process.stderr.write(`[enhance-service] ${args.join(' ')}\n`);

// 信标单独落一份文件。为什么不能只靠 stderr：实测 ZCode 只把插件 stderr 的少数几行
// 采进它的 jsonl 日志（2026-11-10 核对：启动重试那 2 行进了，信标 0 条），
// 而「按钮没出现」的排查完全依赖这些信标。退役旧 Python 服务后就靠这个文件。
const BEACON_LOG = process.env.PROMPT_ENHANCER_BEACON_LOG
  || join(process.env.LOCALAPPDATA || homedir(), 'zcode-prompt-enhance', 'beacon.log');

function appendBeacon(raw) {
  try {
    mkdirSync(dirname(BEACON_LOG), { recursive: true });
    appendFileSync(BEACON_LOG, `${new Date().toISOString()} ${String(raw).slice(0, 2000)}\n`, 'utf8');
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
  return { text: stripWrappingQuotes(text), removedMetaLines: removed };
}

// ------------------------------------------------------------------ 通道配置

class UpstreamError extends Error {
  constructor(message, unreachable = false) {
    super(message);
    this.unreachable = unreachable;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 通道 A：读 ZCode 自己的 provider 配置，等价于「用它当前在用的模型」。 */
function readZcodeChannel() {
  const cfg = readJson(ZCODE_PROVIDER_CONFIG);
  if (!cfg) return null;
  const container = cfg.config ?? {};
  const rules = container.providerConfigRules?.providerRules ?? [];
  if (!rules.length) return null;
  const rule = rules[0];
  const providerId = rule.providerId;
  const baseUrl = String(rule.config?.api?.baseUrl ?? '').replace(/\/+$/, '');
  const apiKey = String(rule.config?.access?.apiKey ?? '').trim();
  if (!baseUrl) return null;

  const models = [];
  for (const mr of container.modelConfigRules?.providerModelRules ?? []) {
    if (mr.providerId !== providerId) continue;
    if (mr.config?.enabled === false) continue;
    if (mr.modelId) models.push(mr.modelId);
  }
  return {
    name: 'zcode',
    label: `ZCode 当前配置（${rule.providerName || providerId}）`,
    baseUrl, apiKey, models,
  };
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
  const cfg = readJson(join(PLUGIN_ROOT, 'config.json'))
    ?? readJson(join(PLUGIN_ROOT, 'config.local.json'));
  if (!cfg?.baseUrl) return null;
  return {
    name: 'fallback',
    label: '自配端点',
    baseUrl: String(cfg.baseUrl).replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey ?? ''),
    models: cfg.model ? [cfg.model] : [],
  };
}

function buildChannels() {
  const prefer = (process.env.PROMPT_ENHANCER_PREFER || 'zcode').toLowerCase();
  const zcode = readZcodeChannel();
  const fallback = readFallbackChannel();
  const ordered = prefer === 'fallback' ? [fallback, zcode] : [zcode, fallback];
  return ordered.filter(Boolean);
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

async function listModels(ch) {
  try {
    const data = await requestJson(`${ch.baseUrl}/models`, { method: 'GET', headers: authHeaders(ch) });
    return (data.data ?? [])
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, name: m.name || m.id }));
  } catch {
    return [];
  }
}

function authHeaders(ch) {
  return ch.apiKey ? { Authorization: `Bearer ${ch.apiKey}` } : {};
}

/** 前端可能传显示名（DOM 上看到的是 name），按 id → name 两轮匹配归一到上游 id。 */
function resolveModel(ch, requested, available) {
  const want = String(requested ?? '').trim();
  if (!want) return ch.models[0] ?? '';
  for (const m of available) if (m.id === want) return m.id;
  const low = want.toLowerCase();
  for (const m of available) {
    if ((m.name || '').toLowerCase() === low || m.id.toLowerCase() === low) return m.id;
  }
  return want; // 匹配不上就原样传，让上游报错，别猜
}

function loadPrompt(name) {
  return readFileSync(join(PROMPT_DIR, name), 'utf8');
}

async function callEnhance(ch, model, text) {
  const systemPrompt = loadPrompt('enhance_system.txt');
  const userPrompt = loadPrompt('enhance_user.txt').replace('{input}', text);
  const data = await requestJson(`${ch.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(ch) },
    body: {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // 改写任务要稳：温度高了会自由发挥、偏离原意
      max_tokens: 1200,
    },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new UpstreamError(`上游响应缺少 choices：${JSON.stringify(data).slice(0, 200)}`);
  }
  return content;
}

// ------------------------------------------------------------------ 核心逻辑

async function enhance(text, requestedModel = '') {
  const input = String(text ?? '').trim();
  if (!input) {
    return { success: false, text: '', code: 'empty_input', error: '请先输入需要增强的提示词' };
  }

  const channels = buildChannels();
  if (!channels.length) {
    return { success: false, text: '', code: 'upstream_unavailable', error: '没有可用通道（读不到 ZCode provider 配置，也没有 config.json）' };
  }

  const attempts = [];
  for (const ch of channels) {
    const available = await listModels(ch);
    const model = resolveModel(ch, requestedModel, available);
    if (!model) {
      attempts.push({ channel: ch.name, code: 'llm_error', error: '该通道没有可用模型' });
      continue;
    }
    const started = Date.now();
    try {
      const raw = await callEnhance(ch, model, input);
      const { text: cleaned, removedMetaLines } = cleanResult(raw);
      if (!cleaned) {
        attempts.push({ channel: ch.name, code: 'llm_error', error: '模型返回空结果' });
        continue;
      }
      return {
        success: true,
        text: cleaned,
        original: input,
        model,
        channel: ch.name,
        channelLabel: ch.label,
        elapsedMs: Date.now() - started,
        removedMetaLines,
        overLength: cleaned.length > 800,
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
  return { success: false, text: '', code: last.code, error: last.error, attempts };
}

// ------------------------------------------------------------------ HTTP（供注入的按钮调用）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function sendJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': raw.length, ...CORS });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function createHttpServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const channels = buildChannels();
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          version: SERVER_VERSION,
          channels: channels.map((c) => ({
            name: c.name, label: c.label, baseUrl: c.baseUrl, hasKey: !!c.apiKey, models: c.models.slice(0, 8),
          })),
        });
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
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/beacon') {
        const raw = await readBody(req);
        appendBeacon(raw);
        log('beacon', raw.slice(0, 1000));
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/enhance') {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (err) {
          sendJson(res, 400, { success: false, text: '', code: 'unknown', error: `请求体不是合法 JSON：${err.message}` });
          return;
        }
        sendJson(res, 200, await enhance(body.text, body.model));
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { success: false, text: '', code: 'unknown', error: err?.message ?? String(err) });
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
    const result = await enhance(args?.text ?? '', args?.model ?? '');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  if (name === 'enhance_service_status') {
    const body = {
      pid: process.pid,
      port: PORT,
      listening: httpState.listening,
      version: SERVER_VERSION,
      promptRoot: PROMPT_DIR,
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

const httpState = { listening: false, server: null };

async function startHttp(fastRetries = 15, fastDelayMs = 20_000, slowDelayMs = 300_000) {
  const attempt = (n) =>
    new Promise((resolve) => {
      const server = createHttpServer();
      httpState.server = server;
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // 端口被占不等于永久失败：可能是过渡期里旧的独立服务还没停，也可能是上个会话的僵尸。
          // 先按 20s 密集重试，之后转为 5 分钟一次长期重试——不能"试够就放弃"，
          // 否则一旦旧服务占着端口、而本进程已放弃，按钮要等到下次重启 ZCode 才会恢复。
          const delay = n < fastRetries ? fastDelayMs : slowDelayMs;
          log(`端口 ${PORT} 被占用，${delay / 1000}s 后重试（第 ${n + 2} 次）`);
          const timer = setTimeout(() => resolve(attempt(n + 1)), delay);
          timer.unref?.(); // 等待重试不该阻止进程退出
          return;
        }
        log(`HTTP 启动失败：${err.message}（按钮将无法工作）`);
        resolve();
      });
      server.listen(PORT, '127.0.0.1', () => {
        httpState.listening = true;
        log(`HTTP 已监听 http://127.0.0.1:${PORT}（pid=${process.pid}）`);
        resolve();
      });
    });
  await attempt(0);
}

function shutdown(reason) {
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

export { enhance, cleanResult, stripWrappingQuotes, stripMetaLines, resolveModel, buildChannels, readZcodeChannel };
