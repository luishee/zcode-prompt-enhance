/**
 * 对注入脚本的 DOM 行为做断言（在无头浏览器里跑）。
 *
 * 为什么值得写：注入脚本最容易坏的不是语法，而是「锚点找错」和「写回编辑器失败」，
 * 这两类问题只有真的在 DOM 上点一下才会暴露。用它替代「改完直接让用户重启 ZCode 试」。
 * 结果写进 #result（无头浏览器用 --dump-dom 抓取）并同步到 document.title。
 */
(() => {
  const out = [];
  let failed = 0;

  function check(name, condition, detail) {
    out.push(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failed += 1;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const editor = document.getElementById('editor');
  const status = () => document.querySelector('[data-zce-status]');
  const enhanceBtn = () => document.querySelector('[data-zce-enhance]');
  const revertBtn = () => document.querySelector('[data-zce-revert]');
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');

  function setDraft(value) {
    editor.innerText = value;
  }

  let submitCount = 0;
  document.getElementById('theForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitCount += 1;
  });

  async function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(30);
  }

  async function run() {
    // 等注入脚本挂完（它走 DOMContentLoaded + setTimeout(0)）
    await wait(120);

    // ---- 1. 按钮注入位置 ----
    const button = enhanceBtn();
    check('按钮已注入', !!button);
    if (!button) return finish();
    check('按钮挂在 data-composer-leading-actions 内',
      !!button.closest('[data-composer-leading-actions]'));
    check('按钮位于输入框下方（同在 composer 卡片内）',
      !!button.closest('[data-composer-layout]'));
    // 关键：composer 是 form，按钮若为 submit 会把草稿直接发出去
    check('按钮 type=button（不会误提交）', button.type === 'button',
      `type=${button.type}`);

    // ---- 2. 空草稿时给出提示且不发请求 ----
    setDraft('');
    window.__calls.length = 0;
    await click(button);
    check('空草稿 → 提示且不发请求',
      window.__calls.length === 0 && text(status()).includes('请先输入'),
      `calls=${window.__calls.length} status=${text(status())}`);

    // ---- 3. 模拟「ZCode 刚发过请求」以探测当前模型 ----
    await window.fetch('http://127.0.0.1:3065/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'primed-model', messages: [] }),
    });

    // ---- 4. 正常增强 ----
    setDraft('把这段代码改好');
    window.__calls.length = 0;
    await click(button);
    await wait(60);

    const enhanceCall = window.__calls.find((c) => c.url.includes('/api/enhance'));
    check('点击后调用了 /api/enhance', !!enhanceCall);
    check('请求体带上了草稿', !!enhanceCall && enhanceCall.body.text === '把这段代码改好',
      enhanceCall ? JSON.stringify(enhanceCall.body) : '');
    // 界面锚点（data-model-current-value）优先于抓到的请求体 model：
    // 用户切模型后界面立刻变，而请求体还停留在上一个模型。
    check('模型优先取界面锚点（providerId/modelId 的后半段）',
      !!enhanceCall && enhanceCall.body.model === 'DeepSeek-V4.1-Flash',
      enhanceCall ? String(enhanceCall.body.model) : '');
    check('编辑器被写回增强结果', text(editor) === '【增强】把这段代码改好', text(editor));
    check('出现「还原原文」按钮', !!revertBtn() && revertBtn().hidden === false);
    check('状态区显示已增强', text(status()).includes('已增强'), text(status()));
    check('全程没有提交表单', submitCount === 0, `submit=${submitCount}`);

    // ---- 5. 还原 ----
    await click(revertBtn());
    check('还原后恢复原文', text(editor) === '把这段代码改好', text(editor));
    check('还原后隐藏还原按钮', revertBtn().hidden === true);

    // ---- 5b. 界面锚点缺失时，退回抓到的真实请求体 model ----
    // 这是 ZCode 里 data-model-current-value 因升级消失时的降级路径。
    const modelTrigger = document.querySelector('[data-model-current-value]');
    const savedModelValue = modelTrigger.getAttribute('data-model-current-value');
    modelTrigger.removeAttribute('data-model-current-value');
    window.__calls.length = 0;
    setDraft('锚点缺失时也要能增强');
    await click(button);
    await wait(80);
    const fallbackCall = window.__calls.find((c) => c.url.includes('/api/enhance'));
    check('界面锚点缺失 → 用抓到的请求体 model',
      !!fallbackCall && fallbackCall.body.model === 'primed-model',
      fallbackCall ? String(fallbackCall.body.model) : '');
    modelTrigger.setAttribute('data-model-current-value', savedModelValue);

    // ---- 5c. 用户切模型后，界面新值必须立刻生效（不能沿用旧请求体）----
    modelTrigger.setAttribute('data-model-current-value', 'glm/glm-5.3-flash');
    window.__calls.length = 0;
    setDraft('切换模型后的增强');
    await click(button);
    await wait(80);
    const switched = window.__calls.find((c) => c.url.includes('/api/enhance'));
    check('切换模型后立刻用新模型（旧请求体作废）',
      !!switched && switched.body.model === 'glm-5.3-flash',
      switched ? String(switched.body.model) : '');
    modelTrigger.setAttribute('data-model-current-value', savedModelValue);

    // ---- 6. 后端明确返回 success:false 时也不得清空草稿 ----
    // 这条与「网络失败」是两条不同的分支：success:false 会走到 `return` 分支，
    // 若那里写回空串，用户草稿就被吃掉。先前只测了网络异常，漏掉了这条。
    setDraft('后端报错也要保住');
    const savedFetch2 = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/enhance')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({ success: false, text: '', code: 'llm_error', error: '模型返回空结果' }),
        });
      }
      return savedFetch2(input, init);
    };
    await click(button);
    await wait(60);
    check('success:false → 草稿保持原样',
      text(editor) === '后端报错也要保住', text(editor));
    check('success:false → 状态含错误原因',
      text(status()).includes('模型返回空结果'), text(status()));
    window.fetch = savedFetch2;

    // ---- 7. 网络异常时不清空草稿 ----
    setDraft('这段要保留');
    const saved = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/enhance')) return Promise.reject(new TypeError('Failed to fetch'));
      return saved(input, init);
    };
    await click(button);
    await wait(60);
    check('请求失败 → 草稿保持原样', text(editor) === '这段要保留', text(editor));
    check('请求失败 → 状态提示错误', text(status()).includes('失败'), text(status()));
    window.fetch = saved;

    // ---- 8. 走 ZCode 官方输入 API 的写回路径（真实环境唯一可靠的路径）----
    // 真实 ZCode 的编辑器是 Lexical，会忽略 execCommand / 合成 paste 这类不可信事件，
    // 只能通过组件挂在 editorApiRef.current 上的 setText 写回。这里用假的 fiber 链
    // 模拟那个结构，验证「能沿 fiber 找到 API 并优先使用它」。
    const apiCalls = [];
    const fakeApi = {
      setText(value) {
        apiCalls.push(value);
        editor.innerText = value;
      },
      focus() {},
      getText() {
        return editor.innerText;
      },
    };
    editor['__reactFiber$zcetest'] = {
      memoizedProps: { editorApiRef: { current: fakeApi } },
      return: null,
    };

    setDraft('走官方 API');
    await click(button);
    await wait(80);
    check('沿 fiber 找到 editorApiRef 并优先用 setText',
      apiCalls.length === 1 && apiCalls[0] === '【增强】走官方 API',
      `calls=${JSON.stringify(apiCalls)}`);
    check('API 写回后内容正确', text(editor) === '【增强】走官方 API', text(editor));
    check('API 路径成功时不报错', !text(status()).includes('失败'), text(status()));
    delete editor['__reactFiber$zcetest'];

    // ---- 9. 全部策略都失败时，要如实报错并把详情上报信标 ----
    editor.setAttribute('contenteditable', 'false');
    const draftBefore = text(editor);
    window.__calls.length = 0;
    await click(button);
    await wait(120);
    const failBeacon = window.__calls.find(
      (c) => c.url.includes('/api/beacon') && c.body && c.body.stage === 'write-failed',
    );
    check('写回全失败 → 状态提示失败', text(status()).includes('失败'), text(status()));
    check('写回全失败 → 上报 write-failed 信标（含策略与长度）',
      !!failBeacon && Array.isArray(failBeacon.body.tried) && typeof failBeacon.body.wantLen === 'number',
      failBeacon ? JSON.stringify(failBeacon.body).slice(0, 120) : '无信标');
    // 信标必须带令牌：渲染层 Origin 是 null / 自定义协议，服务端对浏览器来源要求
    // X-ZCE-Token，漏了它令牌生效后信标会全被 401（诊断能力正好在最需要时失效）。
    check('信标请求带 X-ZCE-Token（否则令牌生效后诊断信标被 401）',
      !!failBeacon && !!(failBeacon.headers && failBeacon.headers['X-ZCE-Token']),
      failBeacon ? JSON.stringify(failBeacon.headers || {}) : '无信标');
    // 会话 id 是 check_beacon 区分「本次启动 / 上次启动」的唯一依据：
    // 只按 url 划分会把上次的 attached 算成本次成功（会误报"已挂上"）。
    check('信标带 session 与 url（供 check_beacon 区分本次启动）',
      !!failBeacon && typeof failBeacon.body.session === 'string' && failBeacon.body.session.length >= 8
      && String(failBeacon.body.url).startsWith('file://'),
      failBeacon ? `session=${failBeacon.body.session}` : '无信标');
    editor.setAttribute('contenteditable', 'true');

    // ---- 10. 增强后用户又改了草稿 → 「还原原文」必须失效 ----
    // 否则点还原会把用户刚写的内容整个覆盖掉，而界面上看不出会发生什么。
    setDraft('原始草稿A');
    await click(button);
    await wait(80);
    check('增强后出现还原按钮', !!revertBtn() && revertBtn().hidden === false);
    setDraft('用户又改了');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(450); // 失效判定有 300ms 防抖
    check('草稿被改动后还原按钮消失', !!revertBtn() && revertBtn().hidden === true);
    check('改动后的内容没有被覆盖', text(editor) === '用户又改了', text(editor));

    // ---- 11. 请求途中取消：不写回、不覆盖草稿、状态显示已取消 ----
    window.__mockDelay = 200;
    setDraft('取消测试');
    await click(button);
    check('增强中按钮进入禁用态', button.disabled === true);
    await click(button); // 再点一次 = 取消
    await wait(400); // 等 mock 的延迟彻底过去，确认迟到的结果不会写回
    check('取消后草稿保持原样', text(editor) === '取消测试', text(editor));
    check('取消后状态显示已取消', text(status()).includes('已取消'), text(status()));
    check('取消后按钮恢复可点', button.disabled === false);
    window.__mockDelay = 0;

    finish();
  }

  function finish() {
    const label = failed === 0 ? `自测通过（${out.length} 项）` : `自测失败 ${failed} 项 / 共 ${out.length} 项`;
    const el = document.getElementById('result');
    el.textContent = `${label}\n` + out.join('\n');
    el.className = failed === 0 ? 'ok' : 'bad';
    document.title = failed === 0 ? 'DOMTEST:PASS' : `DOMTEST:FAIL(${failed})`;
  }

  run().catch((err) => {
    check('自测执行异常', false, err && err.message ? err.message : String(err));
    finish();
  });
})();
