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
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'plugins', 'enhance-service', 'scripts', 'mcp-server.mjs');

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const PORT = 18781;
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    ENHANCE_SERVICE_AS_LIB: '',
    PROMPT_ENHANCER_PORT: String(PORT),
    PROMPT_ENHANCER_PREFER: 'fallback',
    PROMPT_ENHANCER_BASE_URL: MOCK_BASE,
    PROMPT_ENHANCER_MODEL: 'm1',
    PROMPT_ENHANCER_ZCODE_CONFIG: join(HERE, 'nonexistent-provider-config.json'),
    // 测试发的信标不能落进生产日志（实测被污染过一条 {"stage":"boot"}）
    PROMPT_ENHANCER_BEACON_LOG: join(HERE, 'beacon-test.log'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

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
check('HTTP 端口与预期一致', healthy?.pid === child.pid, `child=${child.pid}`);
check('健康检查里能看到通道', (healthy?.channels ?? []).some((c) => c.name === 'fallback'));

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
  check('带 CORS 头（file:// 源必需）', res.headers.get('access-control-allow-origin') === '*');
}
{
  const res = await fetch(`http://127.0.0.1:${PORT}/api/beacon`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'boot' }),
  });
  check('信标端点可用', res.status === 200);
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
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));

  const c2 = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ENHANCE_SERVICE_AS_LIB: '', PROMPT_ENHANCER_PORT: String(PORT),
      PROMPT_ENHANCER_BEACON_LOG: join(HERE, 'beacon-test.log'),
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
