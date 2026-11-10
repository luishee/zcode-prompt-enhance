/**
 * 增强服务（ZCode 插件 MCP server）的测试。
 *
 * 三层：
 *  1) 纯函数（清理逻辑）——最容易悄悄坏掉的「误删正文」风险在这里；
 *  2) enhance() 的契约——占位符必须真被替换、失败必须返回空 text、双通道回退；
 *  3) 真实子进程——MCP stdio 握手、HTTP 端点，以及最关键的
 *     「stdin 关闭 → 进程退出」（这是它随 ZCode 一起结束的唯一保证）。
 *
 * 用模拟上游，不联网。
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = join(ROOT, 'plugins', 'enhance-service', 'scripts', 'mcp-server.mjs');
const TOKENLESS = join(HERE, 'nonexistent-token');

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始 HTTP 请求：需要发畸形路径行 / 自定义 Origin 时 fetch 不够用。 */
function raw(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------ 模拟上游

const mock = { content: '增强后的提示词', status: 200, seen: [], down: false };
const mockServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    mock.seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    if (mock.down) {
      res.destroy();
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1', name: '模型一' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(mock.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mock.status === 200
        ? { choices: [{ message: { content: mock.content } }] }
        : { error: { message: '上游炸了' } }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const MOCK_PORT = mockServer.address().port;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

// 必须在本模块 import 之前设好：模块在 import 时就判断是否启动服务
process.env.ENHANCE_SERVICE_AS_LIB = '1';
process.env.PROMPT_ENHANCER_PREFER = 'fallback';
process.env.PROMPT_ENHANCER_BASE_URL = MOCK_BASE;
process.env.PROMPT_ENHANCER_MODEL = 'm1';
// 关键：把通道 A（ZCode provider 配置）指到不存在的文件。
// 否则一旦模拟上游失败，服务会回退到真实网关并"成功"，测试既不封闭也会误判。
process.env.PROMPT_ENHANCER_ZCODE_CONFIG = join(HERE, 'nonexistent-provider-config.json');
// 令牌文件指到不存在的位置：本机打过补丁后真实令牌文件会存在，
// 不覆盖的话模块读到的令牌会把测试自己的请求挡成 401
process.env.PROMPT_ENHANCER_TOKEN_FILE = TOKENLESS;

// Windows 上动态 import 必须用 file:// URL，直接给 D:\... 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(SERVER).href);

// ------------------------------------------------------------------ 1. 纯函数

check('剥 ASCII 引号', mod.stripWrappingQuotes('"请解释代码"') === '请解释代码');
check('剥中文弯引号', mod.stripWrappingQuotes('“请解释代码”') === '请解释代码');
check('剥 markdown 围栏', mod.stripWrappingQuotes('```text\n请解释代码\n```') === '请解释代码');
check('首尾不配对时不剥', mod.stripWrappingQuotes('"请解释代码') === '"请解释代码');
check('只剥一层', mod.stripWrappingQuotes('""a""') === '"a"');

{
  const r = mod.stripMetaLines('用户输入是中文，因此回复使用中文。\n请解释这段代码的功能与边界情况。');
  check('删掉语言标签行', r.removed === 1 && !r.text.includes('用户输入是中文'), `removed=${r.removed}`);
  check('保留正文', r.text.includes('请解释这段代码的功能'));
}
{
  const r = mod.stripMetaLines('用户输入是中文 → Response must be in Chinese.\n请解释代码');
  check('删掉箭头式元信息', r.removed === 1 && r.text === '请解释代码', JSON.stringify(r));
}
{
  const normal = '请把这份英文报告翻译成中文，保留专业术语。';
  const r = mod.stripMetaLines(normal);
  check('不误删含「中文」的正常句', r.removed === 0 && r.text === normal);
}
{
  const long = '无论用户使用什么语言，输出都必须与原始需求保持一致的表达风格，并且要完整覆盖所有要点。'.repeat(2);
  check('长正文不判为元信息', mod.stripMetaLines(long).removed === 0);
}
check('保留空行结构', mod.stripMetaLines('第一段\n\n第二段').text === '第一段\n\n第二段');

check('清理「增强后的提示词：」前缀',
  mod.cleanResult('增强后的提示词：请分析这段代码的时间复杂度').text === '请分析这段代码的时间复杂度');

// ------------------------------------------------------------------ 2. resolveModel

{
  const avail = [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }];
  check('按 id 匹配', mod.resolveModel({ models: [] }, 'deepseek-flash', avail) === 'deepseek-flash');
  check('按显示名匹配', mod.resolveModel({ models: [] }, 'DeepSeek Flash', avail) === 'deepseek-flash');
  check('大小写不敏感', mod.resolveModel({ models: [] }, 'deepseek flash', avail) === 'deepseek-flash');
  check('留空用通道默认', mod.resolveModel({ models: ['def'] }, '', avail) === 'def');
  check('匹配不上原样传', mod.resolveModel({ models: [] }, 'mystery', avail) === 'mystery');
}

// ------------------------------------------------------------------ 2b. Origin 策略

check('Origin: null（file:// 渲染层）放行', mod.originAllowed('null') === true);
check('自定义协议放行', mod.originAllowed('zcode://app') === true);
check('本机 http 放行', mod.originAllowed('http://127.0.0.1:5173') === true);
check('外部 http(s) 站点拒绝', mod.originAllowed('https://evil.example') === false);
check('无 Origin（curl / PowerShell）放行', mod.originAllowed(undefined) === true);

// ------------------------------------------------------------------ 2c. 提示词替换

{
  mock.seen.length = 0;
  mock.content = '替换检查';
  // $& / $` / $' 在 String.replace 的替换串里有特殊含义，必须原样保留
  await mod.enhance("价格 $& 元，$` 和 $' 都要保留");
  const call = mock.seen.find((s) => s.url === '/v1/chat/completions');
  const joined = (call?.body?.messages ?? []).map((m) => m.content).join('\n');
  check('草稿里的 $& / $` / $\' 原样进 payload',
    joined.includes('$&') && joined.includes('$`') && joined.includes("$'"),
    joined.includes('{input}') ? '出现了 {input}（被当成替换模式吃掉了）' : '');
}
{
  mock.seen.length = 0;
  const r = await mod.enhance('啊'.repeat(9000));
  check('超长草稿直接拒绝、不打上游',
    r.success === false && r.code === 'input_too_long' && mock.seen.length === 0,
    `code=${r.code} calls=${mock.seen.length}`);
}
{
  mock.content = '正常结果';
  const r = await mod.enhance('正常草稿');
  check('成功响应带上 maxLength（前端不再硬编码 800）', r.success === true && r.maxLength === 800);
}

// ------------------------------------------------------------------ 3. enhance 契约

mock.seen.length = 0;
{
  const r = await mod.enhance('   ');
  check('空输入 → empty_input 且 text 为空', r.success === false && r.code === 'empty_input' && r.text === '');
}
{
  mock.content = '请分析这段代码的功能与边界情况';
  const r = await mod.enhance('帮我看看代码');
  check('成功返回增强文本', r.success === true && r.text === mock.content, JSON.stringify(r).slice(0, 120));
  check('带上通道与模型', r.channel === 'fallback' && r.model === 'm1');
}
{
  mock.seen.length = 0;
  mock.content = '结果占位';
  await mod.enhance('目标文本XYZ');
  const call = mock.seen.find((s) => s.url === '/v1/chat/completions');
  const joined = (call?.body?.messages ?? []).map((m) => m.content).join('\n');
  check('用户文本真的进了 payload', joined.includes('目标文本XYZ'), joined.slice(0, 80));
  check('{input} 占位符被替换', !joined.includes('{input}'));
  check('temperature 稳（0.3）', call?.body?.temperature === 0.3);
}
{
  mock.status = 500;
  const r = await mod.enhance('草稿');
  check('上游 500 → 失败且 text 为空（前端据此不清空草稿）',
    r.success === false && r.text === '' && r.code === 'llm_error', JSON.stringify(r).slice(0, 140));
  mock.status = 200;
}
{
  mock.down = true;
  const r = await mod.enhance('草稿');
  check('连不上 → upstream_unavailable 且 text 为空',
    r.success === false && r.text === '' && r.code === 'upstream_unavailable', JSON.stringify(r).slice(0, 140));
  mock.down = false;
}
{
  mock.content = '   \n  ';
  const r = await mod.enhance('草稿');
  check('模型返回空白 → llm_error', r.success === false && r.code === 'llm_error');
}
{
  mock.content = '“请解释代码”';
  const r = await mod.enhance('请解释代码');
  check('结果过一遍引号清理', r.text === '请解释代码', r.text);
}
{
  mock.content = '用户输入是中文 → 应回复中文\n请解释这段代码';
  const r = await mod.enhance('请解释代码');
  check('结果里的元信息被清理并计数',
    r.text === '请解释这段代码' && r.removedMetaLines === 1, JSON.stringify(r).slice(0, 140));
}
{
  mock.content = '啊'.repeat(900);
  const r = await mod.enhance('草稿');
  check('超 800 字打标记', r.success === true && r.overLength === true);
}

// ------------------------------------------------------------------ 4. 真实子进程：MCP + HTTP + 生命周期

// 端口一律用 0 让系统分配：写死端口时，一旦本机有别的进程占着，测试会红而
// 原因与代码无关（早先写死 18781/18782，就是这种假失败）。真实端口从
// "HTTP 已监听 http://127.0.0.1:<port>" 这行 stderr 解析。
function waitForPort(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => reject(new Error('等待 HTTP 监听超时')), timeoutMs);
    // 监听器一直保留：管道没人读时子进程写多了会阻塞
    child.stderr.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const hit = settled ? null : buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (hit) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(hit[1]));
      }
    });
  });
}

const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    ENHANCE_SERVICE_AS_LIB: '',
    PROMPT_ENHANCER_PORT: '0',
    PROMPT_ENHANCER_PREFER: 'fallback',
    PROMPT_ENHANCER_BASE_URL: MOCK_BASE,
    PROMPT_ENHANCER_MODEL: 'm1',
    PROMPT_ENHANCER_ZCODE_CONFIG: join(HERE, 'nonexistent-provider-config.json'),
    // 测试发的信标不能落进生产日志（实测被污染过一条 {"stage":"boot"}）
    PROMPT_ENHANCER_BEACON_LOG: join(HERE, 'beacon-test.log'),
    PROMPT_ENHANCER_TOKEN_FILE: TOKENLESS,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let PORT = 0;
try {
  PORT = await waitForPort(child);
} catch {
  /* HTTP 没起来：后面的健康检查会报失败，比直接抛出更好读 */
}

const pending = new Map();
let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* ignore */
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC 超时: ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

// 等 HTTP 起来
let healthy = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (res.ok) {
      healthy = await res.json();
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await wait(100);
}
check('子进程拉起了 HTTP 服务', !!healthy, healthy ? `pid=${healthy.pid}` : '未就绪');
check('HTTP 服务属于该子进程', healthy?.pid === child.pid, `child=${child.pid}`);
check('健康检查里能看到通道', (healthy?.channels ?? []).some((c) => c.name === 'fallback'));

// 版本号只认 plugin.json，别让 health 上报的版本把排查带偏
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugins', 'enhance-service', '.zcode-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(ROOT, 'plugins', 'marketplace.json'), 'utf8'));
  const entry = (market.plugins ?? []).find((p) => p.name === 'enhance-service');
  check('版本号三处一致（plugin.json / marketplace / health）',
    healthy?.version === pkg.version && entry?.version === pkg.version,
    `health=${healthy?.version} plugin=${pkg.version} market=${entry?.version}`);
}

{
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('MCP initialize 握手成功', res.result?.protocolVersion === '2025-06-18' && res.result?.serverInfo?.name === 'enhance-service',
    JSON.stringify(res).slice(0, 140));
}
{
  const res = await rpc('tools/list', {});
  const names = (res.result?.tools ?? []).map((t) => t.name);
  check('tools/list 暴露工具', names.includes('enhance_prompt') && names.includes('enhance_service_status'), names.join(','));
}
{
  mock.content = '【MCP】增强结果';
  const res = await rpc('tools/call', { name: 'enhance_prompt', arguments: { text: '帮我改清楚' } });
  const payload = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
  check('tools/call 能真正增强', payload.success === true && payload.text === '【MCP】增强结果', JSON.stringify(payload).slice(0, 140));
}
{
  const res = await rpc('nope/method', {});
  check('未知方法返回 -32601', res.error?.code === -32601);
}
{
  const res = await fetch(`http://127.0.0.1:${PORT}/api/enhance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '按钮走 HTTP' }),
  });
  const data = await res.json();
  check('HTTP /api/enhance 可用（注入按钮走这条）', data.success === true, JSON.stringify(data).slice(0, 140));
}
{
  const res = await fetch(`http://127.0.0.1:${PORT}/api/enhance`, { method: 'OPTIONS' });
  check('预检 OPTIONS 返回 204', res.status === 204, `status=${res.status}`);
}
{
  const res = await raw(PORT, '/api/enhance', { method: 'OPTIONS', headers: { Origin: 'null' } });
  check('file:// 来源拿到 CORS 头（回显具体 Origin，不再通配）',
    res.headers['access-control-allow-origin'] === 'null'
    && String(res.headers['access-control-allow-headers']).includes('X-ZCE-Token'),
    `acao=${res.headers['access-control-allow-origin']}`);
}
{
  const res = await fetch(`http://127.0.0.1:${PORT}/api/beacon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'boot', session: 'test-session', ts: 1700000000000 }),
  });
  check('信标端点可用', res.status === 200);

  // 会话 id 与客户端时间必须原样落盘：check_beacon 靠 session 区分"本次启动"，
  // 靠 clientTs 判断上报延迟。早先服务端直接把 ts 覆盖成落盘时间，两者都丢了。
  const lines = readFileSync(join(HERE, 'beacon-test.log'), 'utf8').trim().split('\n');
  let last = {};
  try {
    last = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* 下面那条断言会失败并给出原始行 */
  }
  check('信标保留 session 与 clientTs（排查靠它区分本次/上次启动）',
    last.session === 'test-session' && last.clientTs === 1700000000000 && typeof last.ts === 'string',
    JSON.stringify(last).slice(0, 140));
}

// ---- 健壮性：畸形路径不能打掉进程、外部 Origin 不能读、超大 body 不能塞 ----
{
  const res = await raw(PORT, '//');
  check('畸形请求行 → 400 而不是让进程退出', res.status === 400, `status=${res.status}`);
}
{
  const res = await raw(PORT, '/api/health');
  check('畸形请求之后服务仍存活', res.status === 200, `status=${res.status}`);
}
{
  const res = await raw(PORT, '/api/health', { headers: { Origin: 'https://evil.example' } });
  check('非白名单 Origin → 403', res.status === 403, `status=${res.status}`);
  check('403 不带 CORS 头（网页读不到响应）', !res.headers['access-control-allow-origin']);
}
{
  const res = await raw(PORT, '/api/beacon', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(200 * 1024),
  });
  check('超大请求体 → 413', res.status === 413, `status=${res.status}`);
}

// 生命周期：stdin 关闭 = 宿主退出 → 进程必须自己结束
const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
child.stdin.end();
let exitCode = 'timeout';
{
  const raced = await Promise.race([exited, wait(6000).then(() => 'timeout')]);
  exitCode = raced;
}
check('stdin 关闭后进程自动退出（不留孤儿）', exitCode === 0, `exitCode=${exitCode}`);

// 显式放掉子进程的标准流句柄：句柄还在关闭中时结束本进程，
// 会在 Windows 上触发 libuv 断言并让退出码变成 127。
for (const stream of [child.stdin, child.stdout, child.stderr]) {
  try { stream?.destroy(); } catch { /* ignore */ }
}
await wait(120);

// ---- 端口被占时的重试分支（必须被覆盖，否则那是没验证过的代码）----
{
  const blocker = createServer((req, res) => res.end('x'));
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;

  const c2 = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ENHANCE_SERVICE_AS_LIB: '', PROMPT_ENHANCER_PORT: String(busyPort),
      PROMPT_ENHANCER_BEACON_LOG: join(HERE, 'beacon-test.log'),
      PROMPT_ENHANCER_TOKEN_FILE: TOKENLESS,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  c2.stderr.on('data', (d) => { err += d.toString('utf8'); });

  let sawRetry = false;
  for (let i = 0; i < 50; i += 1) {
    if (err.includes('被占用')) { sawRetry = true; break; }
    await wait(100);
  }
  const firstLine = err.trim().split(/\r?\n/)[0] || '(无 stderr)';
  check('端口被占 → 打印重试提示而不是直接放弃', sawRetry, firstLine);

  // 关键回归：端口被占时 MCP 必须仍然可用。
  // 早先 startHttp 被 await 且无限重试，导致 stdio 循环永不建立、
  // 宿主 initialize 收不到回复，插件被判 failed（表现为"装了但没有 node 进程"）。
  let mcpAlive = false;
  try {
    c2.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}
`);
    let buf2 = '';
    mcpAlive = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      c2.stdout.on('data', (d) => {
        buf2 += d.toString('utf8');
        if (buf2.includes('enhance-service')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  } catch {
    mcpAlive = false;
  }
  check('端口被占时 MCP 仍能应答 initialize（HTTP 不得阻塞 stdio）', mcpAlive);

  c2.kill();
  await new Promise((r) => blocker.close(r));
  for (const stream of [c2.stdin, c2.stdout, c2.stderr]) {
    try { stream?.destroy(); } catch { /* ignore */ }
  }
  await wait(200);
}

// ---- 令牌模式：浏览器来源必须带 X-ZCE-Token ----
{
  const tokenFile = join(HERE, 'token-test.txt');
  writeFileSync(tokenFile, 'test-token-123\n', 'utf8');
  const c3 = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ENHANCE_SERVICE_AS_LIB: '',
      PROMPT_ENHANCER_PORT: '0',
      PROMPT_ENHANCER_PREFER: 'fallback',
      PROMPT_ENHANCER_BASE_URL: MOCK_BASE,
      PROMPT_ENHANCER_MODEL: 'm1',
      PROMPT_ENHANCER_ZCODE_CONFIG: join(HERE, 'nonexistent-provider-config.json'),
      PROMPT_ENHANCER_BEACON_LOG: join(HERE, 'beacon-test.log'),
      PROMPT_ENHANCER_TOKEN_FILE: tokenFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let TOKEN_PORT = 0;
  try {
    TOKEN_PORT = await waitForPort(c3);
  } catch {
    /* 起不来时下面的检查会报失败 */
  }

  let up = false;
  for (let i = 0; i < 60 && TOKEN_PORT; i += 1) {
    try {
      const res = await raw(TOKEN_PORT, '/api/health');
      if (res.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await wait(100);
  }
  check('令牌模式下服务能启动', up);

  const noToken = await raw(TOKEN_PORT, '/api/health', { headers: { Origin: 'null' } });
  check('浏览器来源缺令牌 → 401', noToken.status === 401, `status=${noToken.status}`);

  const badToken = await raw(TOKEN_PORT, '/api/health', { headers: { Origin: 'null', 'X-ZCE-Token': 'wrong' } });
  check('令牌不对 → 401', badToken.status === 401, `status=${badToken.status}`);

  const withToken = await raw(TOKEN_PORT, '/api/health', {
    headers: { Origin: 'null', 'X-ZCE-Token': 'test-token-123' },
  });
  check('带正确令牌放行', withToken.status === 200, `status=${withToken.status}`);
  check('health 标明令牌已启用', JSON.parse(withToken.body || '{}').tokenRequired === true);

  // 令牌热更新：apply 在文件缺失时会重新生成令牌，服务不能要求重启 ZCode 才认。
  // 早先令牌是模块级常量，重新注入后按钮会一路 401（现象是"按钮在但一点就失败"）。
  writeFileSync(tokenFile, 'rotated-token-456\n', 'utf8');
  await wait(150);
  const rotated = await raw(TOKEN_PORT, '/api/health', {
    headers: { Origin: 'null', 'X-ZCE-Token': 'rotated-token-456' },
  });
  check('令牌文件更换后无需重启即生效', rotated.status === 200, `status=${rotated.status}`);
  const stale = await raw(TOKEN_PORT, '/api/health', {
    headers: { Origin: 'null', 'X-ZCE-Token': 'test-token-123' },
  });
  check('旧令牌随文件更新后失效', stale.status === 401, `status=${stale.status}`);

  const noOrigin = await raw(TOKEN_PORT, '/api/health');
  check('无 Origin 的本地调用仍免令牌（README 的 curl 用法保持可用）', noOrigin.status === 200);

  c3.kill();
  await wait(150);
  for (const stream of [c3.stdin, c3.stdout, c3.stderr]) {
    try { stream?.destroy(); } catch { /* ignore */ }
  }
  try { unlinkSync(tokenFile); } catch { /* 没产生就算了 */ }
}

// ------------------------------------------------------------------ 收尾

// 清掉测试自己产生的信标日志，避免在工作区留垃圾
try {
  unlinkSync(join(HERE, 'beacon-test.log'));
} catch {
  /* 没产生就算了 */
}

await new Promise((r) => mockServer.close(r));
console.log(`\n${failed === 0 ? `全部通过（${total} 项）` : `失败 ${failed} 项 / 共 ${total} 项`}`);
// 用 exitCode 而不是 process.exit()：后者会在句柄未收干净时触发 Windows 上的 libuv 断言，
// 把退出码变成 127 —— 那样这个测试就不能当自动化判据了。
process.exitCode = failed === 0 ? 0 : 1;
