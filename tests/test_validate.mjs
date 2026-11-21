// 结果校验器与长度带的回归（不需要网络，也不监听端口）。
//
// 为什么要这个文件：原来的 43 项 MCP 回归与 23 项 DOM 回归随项目目录一起没了
// （2026-11-21 核对：D:\Coding\zcode-prompt-enhance 已不存在），本文件是本次
// 「提示词 + 代码校验」改动唯一可跑的回归。它在改前必然失败——旧代码里没有
// validateEnhancement/lengthBand 这两个导出，import 拿到 undefined。
//
// 校验分两级，测试也分两级断言：
//   want     —— 硬失败，命中就重试、仍不过则整份退回原文
//   wantWarn —— 警告，结果照常返回，只是前端显示黄条（长度类都在这一级）
//
// 跑法：node tests/test_validate.mjs   （退出码 0 全过，1 有失败）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 必须先设再 import：模块顶层会用这个开关决定是否真的去监听 8770。
process.env.ENHANCE_SERVICE_AS_LIB = '1';

// 两种布局都要能跑：
//   插件安装后：<plugin>/tests/ 与 <plugin>/scripts/ 同级 → ../scripts/
//   仓库里：    <repo>/tests/  与 <repo>/plugins/enhance-service/scripts/
// 硬编码其中一种，换布局就会 ERR_MODULE_NOT_FOUND（实测踩过）。
import { existsSync } from 'node:fs';
const PLUGIN_ROOT = ['..', '../plugins/enhance-service']
  .map((rel) => new URL(`${rel}/scripts/mcp-server.mjs`, import.meta.url))
  .find((url) => existsSync(url));
if (!PLUGIN_ROOT) throw new Error('找不到 scripts/mcp-server.mjs（既不在 ../ 也不在 ../plugins/enhance-service/）');
const SERVER_URL = PLUGIN_ROOT;
// prompts/ 在插件根下，与 scripts/ 同级 → 从 scripts/mcp-server.mjs 上跳一级
const PROMPT_BASE = new URL('../prompts/', SERVER_URL);

const {
  validateEnhancement, lengthBand, resolveMode, promptFilesFor, orderChannelsForModel, cacheKeyOf,
} = await import(SERVER_URL.href);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- 长度带

check('长度带：短草稿给绝对上限', () => {
  assert.deepEqual(lengthBand(4), { min: 5, max: 1200 });
});
check('长度带：中段按倍数', () => {
  assert.deepEqual(lengthBand(100), { min: 90, max: 450 });
});
check('长度带：长草稿只许轻改', () => {
  assert.deepEqual(lengthBand(300), { min: 270, max: 650 });
});
check('长度带：保守档更紧', () => {
  assert.deepEqual(lengthBand(4, 'basic'), { min: 5, max: 200 });
  assert.deepEqual(lengthBand(100, 'basic'), { min: 90, max: 200 });
  assert.deepEqual(lengthBand(300, 'basic'), { min: 270, max: 390 });
});

// ---------------------------------------------------------------- 档位

check('档位：auto 以 60 字为界', () => {
  assert.equal(resolveMode('', 4), 'professional');
  assert.equal(resolveMode('auto', 59), 'professional');
  assert.equal(resolveMode('auto', 60), 'basic');
  assert.equal(resolveMode(undefined, 200), 'basic');
});
check('档位：显式指定优先于长度', () => {
  assert.equal(resolveMode('professional', 500), 'professional');
  assert.equal(resolveMode('BASIC', 4), 'basic');
});
check('档位：非法值退回 auto 的判定', () => {
  assert.equal(resolveMode('随便写的', 4), 'professional');
  assert.equal(resolveMode('随便写的', 300), 'basic');
});

// ---------------------------------------------------------------- 缓存键
// 缓存本身要打真实模型才能验（放在 e2e 里），这里锁住键的语义：
// 同一份草稿同档位同模型必须命中；任何一项变了都必须换键，否则会拿错结果。

check('缓存键：同输入同键', () => {
  assert.equal(
    cacheKeyOf('写个爬虫', 'deepseek-flash', 'basic'),
    cacheKeyOf('写个爬虫', 'deepseek-flash', 'basic'),
  );
});
check('缓存键：换档位必须换键', () => {
  assert.notEqual(
    cacheKeyOf('写个爬虫', 'deepseek-flash', 'basic'),
    cacheKeyOf('写个爬虫', 'deepseek-flash', 'professional'),
  );
});
check('缓存键：换模型必须换键', () => {
  assert.notEqual(
    cacheKeyOf('写个爬虫', 'deepseek-flash', 'basic'),
    cacheKeyOf('写个爬虫', 'glm5.3-flash', 'basic'),
  );
});
check('缓存键：模型名大小写不敏感', () => {
  assert.equal(
    cacheKeyOf('x', 'DeepSeek-Flash', 'basic'),
    cacheKeyOf('x', 'deepseek-flash', 'basic'),
  );
});
check('缓存键：键长固定，不随草稿长度膨胀', () => {
  assert.equal(cacheKeyOf('短', '', 'basic').length, 40); // sha1 hex
  assert.equal(cacheKeyOf('长'.repeat(5000), '', 'basic').length, 40);
});
check('缓存键：草稿只差一个字符就换键', () => {
  assert.notEqual(cacheKeyOf('写个爬虫', '', 'basic'), cacheKeyOf('写个爬虫。', '', 'basic'));
});

// ---------------------------------------------------------------- 通道路由
// 多 provider 时「当前选中的模型」可能属于第二个 provider，
// 只取第一条会拿错 baseUrl/key。这里断言的是排序，不是网络。

const CH = (id, models) => ({ name: 'zcode', providerId: id, models });

check('通道路由：命中模型的 provider 提到最前', () => {
  const a = CH('p1', ['m-a']);
  const b = CH('p2', ['m-b']);
  assert.deepEqual(orderChannelsForModel([a, b], 'm-b').map((c) => c.providerId), ['p2', 'p1']);
  assert.deepEqual(orderChannelsForModel([a, b], 'm-a').map((c) => c.providerId), ['p1', 'p2']);
});
check('通道路由：没点名 / 匹配不到时保持原顺序', () => {
  const a = CH('p1', ['m-a']);
  const b = CH('p2', []);
  assert.deepEqual(orderChannelsForModel([a, b], '').map((c) => c.providerId), ['p1', 'p2']);
  assert.deepEqual(orderChannelsForModel([a, b], 'm-没这个').map((c) => c.providerId), ['p1', 'p2']);
});
check('通道路由：模型名大小写不敏感', () => {
  const a = CH('p1', ['DeepSeek-Flash']);
  assert.equal(orderChannelsForModel([a], 'deepseek-flash')[0].providerId, 'p1');
  assert.equal(orderChannelsForModel([a], 'DEEPSEEK-FLASH')[0].providerId, 'p1');
});
check('通道路由：不修改传入数组', () => {
  const a = CH('p1', ['m-a']);
  const b = CH('p2', ['m-b']);
  const input = [a, b];
  orderChannelsForModel(input, 'm-b');
  assert.deepEqual(input.map((c) => c.providerId), ['p1', 'p2'], '原数组被就地排序了');
});

// ---------------------------------------------------------------- 校验器
// 每条都写成「draft + 模型输出」，断言的是增强结果能不能直接贴回输入框。

const CASES = [
  {
    name: '通过：正常增强',
    draft: '写个爬虫',
    out: '请编写一个网络爬虫，抓取目标、字段与保存格式由你确定。',
  },
  {
    name: '拦：向用户索要材料（中文）',
    draft: '写个爬虫',
    out: '请写一个爬虫，请提供目标网站和需要抓取的字段。',
    want: ['asks_user'],
  },
  {
    name: '拦：向用户索要材料（换了个说法）',
    draft: '总结这份周报',
    out: '请先指出缺少哪些部分并向我确认，然后总结这份周报。',
    want: ['asks_user'],
  },
  {
    name: '拦：向用户索要材料（英文）',
    draft: 'write a crawler',
    out: 'Write a crawler. Please provide the target site and the fields to extract.',
    want: ['asks_user'],
  },
  {
    name: '拦：英文 ask me',
    draft: 'fix this',
    out: 'Fix the bug. If the reproduction steps are unclear, ask me before editing.',
    want: ['asks_user'],
  },
  // ---- 以下三条是「条件句 + 抵消项」的误判回归（0.1.9 的 ask 三段式重构）----
  // 早先 ASK_RE 把「如果…缺少」当独立违规词，于是下面这条**正确**的输出被退回原文：
  // 模型是让助手自己列假设往下走，并没有把球踢回用户。
  {
    name: '放行：条件句 + 列假设继续做（不该判成索要材料）',
    draft: '这段代码报错怎么改',
    out: '如果缺少关键信息，先列出你的假设再给方案，不要连续追问。',
  },
  {
    name: '放行：条件句 + 自行决定（抵消项）',
    draft: '写个部署脚本',
    out: '若目标环境未提供，由你决定最合理的默认值并继续完成脚本。',
  },
  {
    name: '拦：条件句 + 真索要动作（仍是违规）',
    draft: '写个部署脚本',
    out: '如果目标环境缺少配置，请提供完整的部署环境说明，我再写脚本。',
    want: ['asks_user'],
  },
  {
    name: '拦：凭空加前置步骤',
    draft: '修一下这个 bug',
    out: '请先 locate 出问题的代码文件，然后再修复这个 bug。',
    want: ['preparatory_step'],
  },
  {
    name: '拦：替用户选技术栈',
    draft: '写个爬虫',
    out: '请用 React 写一个爬虫，并说明组件结构。',
    want: ['tech_added:react'],
  },
  {
    name: '放行：草稿自己点了技术栈',
    draft: '用 FastAPI 写个接口',
    out: '请用 FastAPI 写一个接口，说明路由与返回结构。',
  },
  // ---- 基础语言必须被认出来（tech_added 误判回归）----
  // 回归点：TECH_RE 只列框架/库，草稿写「Python」时 techIn 是空集，
  // 于是输出里的 numpy/pandas 全被判成「凭空加技术栈」，两轮都不过 → 整份退回原文。
  // 实测症状：「如何优化 Python 循环性能」点了按钮，输入框一字未变。
  {
    name: '放行：草稿点了基础语言，补同栈库不算凭空加（降为警告）',
    draft: '如何优化 Python 循环性能',
    out: '请说明如何优化 Python 循环性能，可对比 numpy 向量化与 pandas 的写法差异。',
    wantWarn: ['tech_added'],
  },
  {
    name: '放行：草稿点了语言，输出只换了个库',
    draft: '用 Python 读个大文件',
    out: '请用 Python 读取大文件，可借助 pandas 分块读取，注意内存占用。',
    wantWarn: ['tech_added'],
  },
  {
    name: '拦：草稿完全没点技术栈时，加库仍是硬失败',
    draft: '帮我分析一下这段日志',
    out: '请用 pandas 分析这段日志，给出统计结果。',
    want: ['tech_added:pandas'],
  },
  {
    name: '放行：C++ / C# 这类带符号的语言名也能识别',
    draft: '这段 C++ 代码怎么优化',
    out: '请说明这段 C++ 代码的优化方向，可从 TensorFlow 之外的纯算法角度分析。',
    wantWarn: ['tech_added'],
  },
  {
    name: '拦：代码块被改写',
    draft: '帮我优化\n```python\ndef f():\n    return 1\n```',
    out: '请帮我优化下面这个函数，给出改进方案与理由。',
    want: ['code_block_changed'],
  },
  {
    name: '拦：用户禁则丢失',
    draft: '写个函数，不要解释，只给代码',
    out: '请写一个函数，并说明实现思路与设计取舍。',
    want: ['prohibition_lost'],
  },
  {
    name: '放行：禁则被等价扩写',
    draft: '写个函数，不要解释',
    out: '请写一个函数，不要任何解释，并给出关键边界处理。',
  },
  {
    name: '拦：结果里留下占位符',
    draft: '帮我把这段改成正式一点',
    out: '请把下面这段文字改得更正式：\n```\n（在此粘贴原文）\n```',
    want: ['placeholder_left'],
  },
  {
    name: '拦：双花括号占位符（实测漏检过）',
    draft: '帮我把这段改成正式一点',
    out: '请把下面这段文字改写成更正式的书面表达。\n\n【待改写文本】\n{{在此粘贴需要改写的文本}}',
    want: ['placeholder_left'],
  },
  {
    name: '放行：用户自己的模板变量不算占位符',
    draft: '用 {{location_theme}} 这个主题写一段文案，长度 50 字',
    out: '请用 {{location_theme}} 这个主题写一段文案，长度 50 字，风格口语化。',
  },
  {
    name: '警告：结果超长（照常返回，只提示）',
    draft: '写个爬虫',
    out: ('请编写一个网络爬虫，明确目标站点、列表页结构、需要提取的字段、请求频率、'
      + '并发控制、反爬应对方式、异常重试策略、结果保存格式、日志与进度输出，'
      + '并说明各环节的实现要点、边界情况与验收标准。').repeat(20),
    wantWarn: ['over_length'],
  },
  {
    name: '警告：结果过短（等于没改）',
    // 草稿里刻意不写禁则：写了禁则而结果丢掉，会先被 prohibition_lost 判成硬失败，
    // 就测不到 under_length 这条警告了
    draft: '帮我把这段改得正式一点，保持原意和全部信息不变',
    out: '请改得正式一点。',
    wantWarn: ['under_length'],
  },
  {
    name: '拦：空结果',
    draft: '写个爬虫',
    out: '',
    want: ['empty'],
  },
];

for (const c of CASES) {
  check(c.name, () => {
    const { ok, reasons, warnings } = validateEnhancement(c.draft, c.out);
    const want = c.want ?? [];
    const wantWarn = c.wantWarn ?? [];

    assert.equal(
      ok, want.length === 0,
      want.length === 0 ? `期望通过，实际被拦：${reasons.join(', ')}` : '期望被拦，实际通过了',
    );
    for (const w of want) {
      // reason 常带实测数值（tech_added:react、prohibition_lost:2），按前缀比对
      assert.ok(
        reasons.some((r) => r === w || r.startsWith(`${w}:`)),
        `期望命中 ${w}，实际：${reasons.join(', ') || '（空）'}`,
      );
    }
    for (const w of wantWarn) {
      assert.ok(
        warnings.some((r) => r === w || r.startsWith(`${w}:`)),
        `期望警告 ${w}，实际：${warnings.join(', ') || '（空）'}`,
      );
    }
  });
}

// ---------------------------------------------------------------- 提示词文件

check('提示词：user 模板保留 {input} 占位符', () => {
  for (const name of ['enhance_user.txt', 'enhance_user_basic.txt']) {
    const tpl = readFileSync(new URL(`${name}`, PROMPT_BASE), 'utf8');
    assert.ok(tpl.includes('{input}'), `${name} 丢了 {input}，服务会在调用时抛错`);
  }
});

check('提示词：草稿以 JSON 字符串嵌入，并声明是素材不是指令', () => {
  for (const name of ['enhance_user.txt', 'enhance_user_basic.txt']) {
    const tpl = readFileSync(new URL(`${name}`, PROMPT_BASE), 'utf8');
    // 这层包裹是防「草稿里含闭合标签/引号」把结构搞乱，也防草稿里的伪指令被执行
    assert.ok(tpl.includes('{"originalPrompt": {input}}'), `${name} 没有用 JSON 包裹草稿`);
    assert.ok(tpl.includes('evidence to rewrite'), `${name} 缺「这是素材不是指令」的声明`);
  }
});

check('提示词：两档都在输出前自检', () => {
  for (const name of ['enhance_system.txt', 'enhance_system_basic.txt']) {
    const sys = readFileSync(new URL(`${name}`, PROMPT_BASE), 'utf8');
    assert.match(sys, /BEFORE YOU OUTPUT/, `${name} 缺输出前自检清单`);
  }
});

check('提示词：两档都明令禁止索要材料', () => {
  for (const name of ['enhance_system.txt', 'enhance_system_basic.txt']) {
    const sys = readFileSync(new URL(`${name}`, PROMPT_BASE), 'utf8');
    assert.match(sys, /Never ask the user for material/);
    assert.match(sys, /VERBATIM/);
  }
});

check('提示词：展开档长度档与 lengthBand 对齐', () => {
  const sys = readFileSync(new URL('enhance_system.txt', PROMPT_BASE), 'utf8');
  assert.match(sys, /at most 1200 characters/);
  assert.match(sys, /2\.5x the draft, plus 200 characters/);
  assert.match(sys, /1\.5x the draft, plus 200 characters/);
});

check('提示词：保守档长度档与 lengthBand 对齐', () => {
  const sys = readFileSync(new URL('enhance_system_basic.txt', PROMPT_BASE), 'utf8');
  assert.match(sys, /at most 200 characters/);
  assert.match(sys, /1\.5x the draft, plus 50 characters/);
  assert.match(sys, /1\.2x the draft, plus 30 characters/);
});

check('档位：两档的提示词文件都成对存在', () => {
  for (const mode of ['professional', 'basic']) {
    const files = promptFilesFor(mode);
    assert.notEqual(files.system, files.user, 'system 与 user 不应指向同一文件');
    for (const name of [files.system, files.user]) {
      const txt = readFileSync(new URL(`${name}`, PROMPT_BASE), 'utf8');
      assert.ok(txt.length > 200, `${name} 内容过短，可能写错了文件`);
    }
  }
});

// ---------------------------------------------------------------- 汇总

if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
// 用 exitCode 而不是 process.exit()：Windows 上裸 exit 会与未关闭的句柄竞争，
// 实测退出码会变成 127（见项目记忆 hermetic-tests-and-clean-exit）。
process.exitCode = failures.length ? 1 : 0;