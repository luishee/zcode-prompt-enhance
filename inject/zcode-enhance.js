/**
 * ZCode 增强提示词 —— 注入到渲染层的小脚本
 *
 * 参考 WorkBuddy 的 chat.promptEnhance / input.enhance 交互复刻，并做了这些优化：
 *   1. 失败绝不动用户的草稿（WorkBuddy 也是失败返回空文本，这里同语义）；
 *   2. 「还原原文」可反复切换，而不是一次性还原；
 *   3. 模型跟随 ZCode 当前选择（先抓真实请求体里的 model，再读 DOM 标签），
 *      交给本地服务按双通道回退；
 *   4. 服务端兜底清理「语言标签」元信息（WorkBuddy 只在提示词里禁止）；
 *   5. 超长（>800 字）给出提示，不静默截断；
 *   6. 编辑器/工具栏被 React 重渲染替换后自动补回按钮。
 *
 * 两个必须保留的细节：
 *   - 按钮必须 type="button" 且 preventDefault：composer 是 <form>，
 *     默认 submit 会把草稿直接发出去。
 *   - 根观察器只关心「新增了 composer」的变更，不监听全文档所有变更：
 *     聊天流式输出时 DOM 变更极多，全量扫描会明显拖慢界面。
 */
(() => {
  'use strict';
  if (window.__zceInstalled) return;
  window.__zceInstalled = true;

  // 打补丁时会替换成实际端点与访问令牌
  const ENDPOINT = '__ZCE_ENDPOINT__';
  // 令牌用来挡住「本机浏览器里任意网页都能调 8770」这条路：CORS 通配时任何站点
  // 都能用用户的 key 花钱。占位符没被替换时（直接打开源文件自测）当作空令牌。
  const RAW_TOKEN = '__ZCE_TOKEN__';
  const TOKEN = /^__ZCE_/.test(RAW_TOKEN) ? '' : RAW_TOKEN;

  // 文案对齐 ZCode 自带的 chat.promptEnhance.* 与 WorkBuddy 的 input.enhance.*
  const TEXT = {
    idle: '增强提示词',
    busy: '增强中…',
    revert: '还原原文',
    empty: '请先输入需要增强的提示词',
    cancelled: '已取消本次提示词增强',
    failedWith: (e) => `提示词增强失败：${e}`,
    // 端口被别的进程占着时，服务会在后台退避重试（最长约 13 分钟），
    // 所以这里要提示「稍后重试」，否则用户会以为插件根本没装。
    offline: '增强服务未响应：确认插件「增强提示词服务」已启用，且 127.0.0.1:8770 在监听；'
      + '若刚重启过 ZCode，旧进程可能还占着端口，等一会儿再试',
    done: (model) => (model ? `已增强 · ${model}` : '已增强'),
    // 实测「再点一次」只会越改越长（34→298→707 字），不能承诺收敛。
    overLength: (max) => `结果超过 ${max || 800} 字，建议手动精简后再用`,
    writeBackFailed: '已生成增强结果，但写回输入框失败（编辑器结构可能已变）',
  };

  const SEL = {
    composer: '[data-composer-layout]',
    actions: '[data-composer-leading-actions]',
    editor: '[data-lexical-editor="true"]',
    // 模型选择器 trigger 上的属性，收起/展开都在（值是 "providerId/modelId"）。
    // 这是唯一可靠的界面锚点：下面 modelLabel 那个属性只在弹出层展开时才渲染。
    modelValue: '[data-model-current-value]',
    modelLabel: '[data-composer-open-label]',
    ownButton: '[data-zce-enhance]',
    ownRevert: '[data-zce-revert]',
    ownStatus: '[data-zce-status]',
  };

  const BEACON_RETRY_MS = 3000;
  const BEACON_MAX_TRIES = 20;

  // 每次页面加载生成一个会话 id。诊断工具靠它把「本次启动」的信标和上次启动分开：
  // 同一份 index.html 每次启动的 url 完全一样，只按 url 划分会把上次的 attached
  // 也算进来，于是"按钮没出现"被误判成"已挂上"（实测踩过）。
  const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * 诊断信标：把「脚本是否加载、有没有找到 composer、锚点是否命中」回报给插件服务。
   *
   * 为什么需要重试：渲染层的启动早于插件 MCP server 绑定 8770，所以 boot 那次上报
   * 常常直接失败（实测：改造为插件后信标一条都收不到）。只发一次等于诊断能力作废，
   * 因此在失败时按 3s 间隔重试，最多 20 次（约 60s），足够等插件起来。
   * 成功即停；上报失败本身不影响增强功能。
   */
  function beacon(stage, extra, attempt = 1) {
    // 诊断关键字段放在展开之后：extra 里将来若出现同名键，不能覆盖掉会话与时间
    const payload = JSON.stringify({
      ...(extra || {}),
      stage,
      url: location.href,
      session: SESSION_ID,
      ts: Date.now(),
    });

    const retry = () => {
      if (attempt >= BEACON_MAX_TRIES) return;
      setTimeout(() => beacon(stage, extra, attempt + 1), BEACON_RETRY_MS);
    };

    try {
      fetch(`${ENDPOINT}/api/beacon`, {
        method: 'POST',
        // 必须带令牌：渲染层的 Origin 是 null / 自定义协议，服务端对「浏览器来源」
        // 一律要求 X-ZCE-Token。早先这里只发 Content-Type，令牌生效后信标全被 401，
        // 于是按钮不显示时 check_beacon 一条都读不到（诊断能力正好在最需要时失效）。
        headers: apiHeaders(),
        body: payload,
        keepalive: true,
      })
        .then((resp) => {
          if (!resp || !resp.ok) retry();
        })
        .catch(retry);
    } catch {
      retry();
    }
  }

  // ---------------------------------------------------------------- 模型探测
  //
  // 锚点在哪：ZCode 的模型选择器属于 chat toolbar，是 [data-composer-layout] 的**兄弟**节点，
  // 不在 composer 子树里（实测：composer.querySelector 一律拿不到）。
  // 所以这里从 composer 逐级向上，找「最近的、包含模型锚点的祖先」，再在那一层里取。
  // 逐级向上而不是直接 document.querySelector：多输入框（侧边会话）时不会串到别的会话上。
  //
  // 三个锚点按可靠度：
  //   1. [data-testid="v4-model-config"][data-model]：隐藏遥测 span，data-model 直接就是模型 id；
  //   2. [data-model-current-value]：选择器 trigger，值形如 "providerId/modelId"；
  //   3. [data-composer-open-label]：只在弹出层展开时渲染，只能兜底。
  const MODEL_CONFIG_SEL = '[data-testid="v4-model-config"][data-model]';

  let lastRequestModel = '';
  let lastRequestAt = 0;
  let lastModelLabel = '';
  // 只在 body 头部找 model 字段：整包 JSON.parse 会把几百 KB 的上下文在主线程上
  // 同步解析一遍，而 model 永远在最前面。
  const MODEL_RE = /"model"\s*:\s*"([^"\\]{1,120})"/;
  (() => {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && typeof init.body === 'string' ? init.body : null;
        if (body && /chat\/completions|completions|\/messages/.test(url)) {
          const hit = MODEL_RE.exec(body.slice(0, 8192));
          if (hit) {
            lastRequestModel = hit[1].trim();
            lastRequestAt = Date.now();
          }
        }
      } catch {
        /* 探测失败不影响请求本身 */
      }
      return originalFetch.apply(this, arguments);
    };
  })();

  // 抓到的 model 有保鲜期，且用户切换模型后要立刻让位给界面锚点：
  // 否则「切了模型但还没发过消息」时，第一次增强会用上一个模型。
  const MODEL_CAPTURE_TTL_MS = 10 * 60_000;

  /** 从 composer 往上找最近一层包含模型锚点的容器；找不到返回 null。 */
  function modelScope(composer) {
    let node = composer || document.documentElement;
    while (node) {
      try {
        if (node.querySelector?.(MODEL_CONFIG_SEL) || node.querySelector?.(SEL.modelValue)) return node;
      } catch {
        /* ignore */
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 读界面上的模型值，并回报命中的是哪个锚点。
   * 回报 anchor 是为了让 check_beacon 能区分「锚点缺失」和「属性存在但值为空」——
   * 这两种失败的处理方式完全不同，混在一起就只剩一句「不跟随」，无从下手。
   */
  function readModelAnchor(composer) {
    const scope = modelScope(composer);
    if (!scope) return { model: '', anchor: '' };
    try {
      const cfg = scope.querySelector(MODEL_CONFIG_SEL);
      const raw = (cfg?.getAttribute('data-model') || '').trim();
      if (raw && raw !== '<synthetic>') return { model: raw, anchor: 'config' };
    } catch {
      /* ignore */
    }
    try {
      const el = scope.querySelector(SEL.modelValue);
      const value = (el?.getAttribute('data-model-current-value') || '').trim();
      if (value && value !== '<synthetic>') {
        // "providerId/modelId"：providerId 本身不带 "/"，按第一个切分取后半段
        const slash = value.indexOf('/');
        const modelId = slash > 0 ? value.slice(slash + 1).trim() : value;
        if (modelId) return { model: modelId, anchor: 'value' };
      }
    } catch {
      /* ignore */
    }
    try {
      const label = (scope.querySelector(SEL.modelLabel)?.textContent || '').trim();
      // 可能是 "DeepSeek-V4.1-Flash · 经济模式" 这类复合文案，取首段
      if (label) return { model: label.split(/[·|｜]/)[0].trim(), anchor: 'label' };
    } catch {
      /* ignore */
    }
    return { model: '', anchor: '' };
  }

  const readModelFromDom = (composer) => readModelAnchor(composer).model;

  function currentModel(composer) {
    const fromDom = readModelFromDom(composer);

    // 界面值变了 = 用户切了模型，立刻作废抓到的请求体 model（它属于上一个模型）
    if (fromDom && fromDom !== lastModelLabel) {
      if (lastModelLabel) lastRequestModel = '';
      lastModelLabel = fromDom;
    }

    const fresh = lastRequestModel && Date.now() - lastRequestAt < MODEL_CAPTURE_TTL_MS;
    // 优先级：界面值 > 新鲜的真实请求体。
    // 反过来的话，用户切模型后第一次增强会沿用旧模型（界面已经变了，请求体还是旧的）。
    return fromDom || (fresh ? lastRequestModel : '');
  }

  // ---------------------------------------------------------------- 编辑器读写
  function findEditor(composer) {
    return composer.querySelector(SEL.editor) || composer.querySelector('[contenteditable="true"]');
  }

  const normalize = (s) => (s || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const readDraft = (editor) => (editor ? editor.innerText || '' : '');

  function selectAll(editor) {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function moveCaretToEnd(editor) {
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      /* ignore */
    }
  }

  /**
   * 从 DOM 节点上取 React fiber。
   * React 会以 `__reactFiber$<随机后缀>` 的形式把 fiber 挂在真实 DOM 节点上。
   */
  function getFiber(node) {
    if (!node) return null;
    for (const key of Object.keys(node)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return node[key];
      }
    }
    return null;
  }

  /**
   * 找到 ZCode 编辑器自己暴露的输入 API。
   *
   * 为什么必须用它（2026-11-10 实测）：ZCode 的编辑器是 Lexical，它会拦截 beforeinput；
   * `document.execCommand('insertText')` 和合成 `paste` 都属于不可信事件，被它忽略，
   * 于是内容没变、读回校验失败，界面就提示"写回输入框失败"。
   * 而官方组件 WYt 会把 { setText, getText, setEditorStateJson, clear, focus, ... }
   * 挂到 editorApiRef.current 上——那是它自己用来恢复草稿的通道，稳定且同步。
   *
   * 取法：从编辑器 DOM 沿 fiber 向上找带 editorApiRef/inputApiRef 的组件。
   * 命中不了就返回 null，由调用方回退到 DOM 方案（不抛错）。
   */
  function findEditorApi(editor) {
    let fiber = getFiber(editor);
    for (let depth = 0; fiber && depth < 80; depth += 1) {
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object') {
        const ref = props.editorApiRef || props.inputApiRef;
        const api = ref && ref.current;
        if (api && (typeof api.setText === 'function' || typeof api.setEditorStateJson === 'function')) {
          return api;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  const squash = (s) => (s || '').replace(/\s+/g, '');

  /** 读回校验：先严格比（含换行），再宽松比（忽略所有空白，容忍段落切分差异）。 */
  function draftMatches(editor, text) {
    const got = readDraft(editor);
    if (normalize(got) === normalize(text)) return true;
    return squash(got) === squash(text);
  }

  /**
   * 让出一拍再读回。
   *
   * 不能用 requestAnimationFrame：它依赖渲染，无头环境或窗口被最小化/遮挡时会被节流甚至不触发，
   * 那样写回校验就会一直等下去（实测在无头自测里表现为状态卡在"增强中…"）。
   * setTimeout 只依赖事件循环，任何情况下都会执行。
   */
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * 写回 Lexical 编辑器：三种策略依次尝试，每种都等一帧再读回校验。
   *   1. editorApi.setText  —— 官方通道，唯一可靠的方式
   *   2. execCommand        —— 纯 DOM 环境（如测试页）可用
   *   3. 合成 paste         —— 最后的兜底
   * 返回 { ok, strategy } 或 { ok:false, tried }，绝不假装成功。
   */
  async function writeDraft(editor, text) {
    if (!editor) return { ok: false, tried: ['no-editor'] };

    const api = findEditorApi(editor);
    const strategies = [];
    if (api?.setText) {
      strategies.push(['editorApi.setText', () => {
        api.setText(text);
        try {
          api.focus?.();
        } catch {
          /* ignore */
        }
      }]);
    }
    strategies.push(['execCommand', () => {
      editor.focus();
      selectAll(editor);
      document.execCommand('insertText', false, text);
      moveCaretToEnd(editor);
    }]);
    strategies.push(['pasteEvent', () => {
      editor.focus();
      selectAll(editor);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }));
      moveCaretToEnd(editor);
    }]);

    const tried = [];
    for (const [name, run] of strategies) {
      tried.push(name);
      try {
        run();
      } catch {
        continue;
      }
      // 先立刻校验（Lexical 的 setText 多半是同步生效），不行再让两拍等批量更新
      if (draftMatches(editor, text)) return { ok: true, strategy: name, hasApi: !!api };
      await nextTick();
      await nextTick();
      if (draftMatches(editor, text)) return { ok: true, strategy: name, hasApi: !!api };
    }
    return {
      ok: false,
      tried,
      hasApi: !!api,
      gotLen: squash(readDraft(editor)).length,
      wantLen: squash(text).length,
      gotHead: readDraft(editor).slice(0, 60),
      wantHead: String(text).slice(0, 60),
    };
  }

  // ---------------------------------------------------------------- 样式
  const CSS = `
.zce-wrap { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; min-width: 0; }
.zce-btn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 9px;
  font-size: 12px; line-height: 1; white-space: nowrap;
  color: var(--foreground-subtle, #5b6270);
  background: transparent;
  border: 1px solid var(--border, rgba(0,0,0,.12));
  border-radius: 999px; cursor: pointer;
  transition: background .15s, border-color .15s, color .15s, opacity .15s;
}
.zce-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 8%, transparent); }
.zce-btn:disabled { opacity: .5; cursor: not-allowed; }
.zce-btn[data-active="true"] { color: var(--brand, #2f6fed); border-color: currentColor; }
.zce-icon { font-size: 12px; }
.zce-spin {
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: zce-spin .7s linear infinite;
}
@keyframes zce-spin { to { transform: rotate(360deg); } }
.zce-status {
  font-size: 11px; color: var(--foreground-subtlest, #98a0ad);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.zce-status[data-tone="error"] { color: var(--destructive, #d64545); }
.zce-status[data-tone="warn"] { color: var(--warning, #b7791f); }
@media (max-width: 760px) { .zce-label { display: none; } .zce-status { display: none; } }
`;

  function ensureStyle() {
    if (document.getElementById('zce-style')) return;
    const style = document.createElement('style');
    style.id = 'zce-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- 状态与渲染
  // 状态挂在 WeakMap 上：React 可以随时换掉 DOM 节点，但状态必须留下来。
  const states = new WeakMap();

  // 只在内容真的变了才写 DOM。写成内联赋值会踩到自己的观察器：
  // innerHTML/textContent 赋值属于 childList 变更 → 触发 composer 观察器 →
  // 又调 render() → 再赋值……形成死循环，界面卡死。无头自测就是这样暴露出来的。
  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  function setHidden(el, value) {
    if (el && el.hidden !== value) el.hidden = value;
  }

  function setStatus(st, text, tone) {
    if (!st.status) return;
    setText(st.status, text || '');
    if (st.status.title !== (text || '')) st.status.title = text || '';
    const next = tone || '';
    if ((st.status.dataset.tone || '') !== next) {
      if (next) st.status.dataset.tone = next;
      else delete st.status.dataset.tone;
    }
  }

  /**
   * 按钮内容只用 DOM API 拼，不拼 innerHTML：
   * 现在虽然全是常量，但这条路径以后一旦插进变量就是一个 XSS 口子。
   * 用 dataset 记「当前渲染的是哪一态」，避免无谓重建（重建会触发观察器）。
   */
  function renderButton(st) {
    const button = st.button;
    const state = st.loading ? 'busy' : 'idle';
    if (button.dataset.zceRender === state) return;

    button.textContent = '';
    const icon = document.createElement('span');
    if (st.loading) {
      icon.className = 'zce-spin';
    } else {
      icon.className = 'zce-icon';
      icon.textContent = '✨';
    }
    const label = document.createElement('span');
    label.className = 'zce-label';
    label.textContent = st.loading ? TEXT.busy : TEXT.idle;
    button.append(icon, label);

    button.dataset.zceRender = state;
    button.setAttribute('aria-label', st.loading ? TEXT.busy : TEXT.idle);
  }

  function render(st) {
    if (!st.button) return;
    if (st.button.disabled !== st.loading) st.button.disabled = st.loading;
    const active = st.loading ? 'true' : 'false';
    if (st.button.dataset.active !== active) st.button.dataset.active = active;

    renderButton(st);

    const tip = st.loading ? '再次点击可取消当前这次增强' : `${TEXT.idle}（Ctrl+Shift+E）`;
    if (st.button.title !== tip) st.button.title = tip;

    if (st.revert) {
      setHidden(st.revert, !(st.original !== null && !st.loading));
      setText(st.revert, TEXT.revert);
      if (st.revert.title !== '恢复到增强前的原文') st.revert.title = '恢复到增强前的原文';
    }
  }

  /** 组请求头：令牌只在补丁替换过占位符时才带。 */
  function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['X-ZCE-Token'] = TOKEN;
    return headers;
  }

  /**
   * 读响应体：HTTP 非 2xx / 非 JSON 都要给出可读原因。
   * 不先判状态码的话，反向代理返回的 HTML 错误页会变成
   * "Unexpected token '<' ..." 这种对用户毫无意义的报错。
   */
  async function readJsonResponse(resp) {
    if (!resp) throw new Error('没有收到响应');
    if (resp.ok === false || resp.status >= 400) {
      let detail = '';
      try {
        detail = String(await resp.text()).slice(0, 120);
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${resp.status}${detail ? `：${detail}` : ''}`);
    }
    try {
      return await resp.json();
    } catch {
      throw new Error('服务返回的不是 JSON（可能有别的程序占用了端点）');
    }
  }

  async function runEnhance(st) {
    const editor = st.editor || findEditor(st.composer);
    if (!editor) return;
    const draft = readDraft(editor);
    if (!normalize(draft)) {
      setStatus(st, TEXT.empty, 'error');
      return;
    }

    // 每次运行带一个身份：写回是异步的（setText/execCommand 后还有两个 tick），
    // 期间用户可能已经取消或发起了新的一次，旧运行不能再改界面和草稿。
    const runId = Symbol('enhance-run');
    const controller = new AbortController();
    st.runId = runId;
    st.controller = controller;
    st.loading = true;
    setStatus(st, TEXT.busy);
    render(st);

    // 已被取消时不要停在「增强中…」；被新一次运行接管时则不要碰界面
    const stopIfDead = () => {
      if (st.runId === runId && !controller.signal.aborted) return false;
      if (st.runId === runId) setStatus(st, TEXT.cancelled);
      return true;
    };

    try {
      const resp = await fetch(`${ENDPOINT}/api/enhance`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ text: draft, model: currentModel(st.composer) || undefined }),
        signal: controller.signal,
      });
      const data = await readJsonResponse(resp);
      if (stopIfDead()) return;

      if (!data || data.success !== true || !String(data.text || '').trim()) {
        // 失败：保留草稿，只提示原因
        const reason = (data && (data.error || data.code)) || `HTTP ${resp.status}`;
        setStatus(st, TEXT.failedWith(reason), 'error');
        return;
      }

      const snapshot = draft;
      const wrote = await writeDraft(editor, data.text);
      if (st.runId !== runId) return; // 已被新一次运行接管，什么都不动
      if (!wrote.ok) {
        // 失败详情走信标，否则「写回失败」这四个字对排查毫无帮助
        beacon('write-failed', wrote);
        setStatus(st, `${TEXT.writeBackFailed}（策略：${(wrote.tried || []).join('/')}）`, 'error');
        return;
      }
      beacon('write-ok', { strategy: wrote.strategy, hasApi: wrote.hasApi });

      // 内容已经被改了，快照必须记下来 —— 即使这次运行刚刚被取消，
      // 也得给用户留一条「还原原文」的退路。
      st.original = snapshot;
      st.enhanced = data.text;
      if (controller.signal.aborted) {
        setStatus(st, `${TEXT.cancelled} · 结果已写入，可点「还原原文」`);
        return;
      }
      const bits = [TEXT.done(data.model)];
      if (data.channel && data.channel !== 'zcode') bits.push(`通道 ${data.channel}`);
      if (data.removedMetaLines) bits.push(`清理 ${data.removedMetaLines} 行元信息`);
      if (data.overLength) bits.push(TEXT.overLength(data.maxLength));
      setStatus(st, bits.join(' · '), data.overLength ? 'warn' : undefined);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus(st, TEXT.cancelled);
      } else if (err instanceof TypeError) {
        // fetch 抛 TypeError 通常是连不上，附带可操作提示
        setStatus(st, `${TEXT.failedWith(err.message)} · ${TEXT.offline}`, 'error');
      } else {
        setStatus(st, TEXT.failedWith(err && err.message ? err.message : String(err)), 'error');
      }
    } finally {
      // 只有「自己还是当前这次运行」时才收尾，否则会把新一次运行的状态清掉
      if (st.runId === runId) {
        st.loading = false;
        st.controller = null;
        render(st);
      }
    }
  }

  function build(st, actions) {
    const wrap = document.createElement('div');
    wrap.className = 'zce-wrap';

    const button = document.createElement('button');
    button.type = 'button'; // 关键：默认 submit 会直接把草稿发出去
    button.className = 'zce-btn';
    button.dataset.zceEnhance = 'true';

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'zce-btn';
    revert.dataset.zceRevert = 'true';
    revert.hidden = true;

    const status = document.createElement('span');
    status.className = 'zce-status';
    status.dataset.zceStatus = 'true';
    // 状态变化（增强中/失败/已增强）对读屏用户也要可见
    status.setAttribute('aria-live', 'polite');

    wrap.append(button, revert, status);
    actions.appendChild(wrap);

    st.button = button;
    st.revert = revert;
    st.status = status;

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (st.loading) st.controller?.abort();
      else runEnhance(st);
    });

    revert.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (st.original === null) return;
      const editor = st.editor || findEditor(st.composer);
      const restored = st.original;
      const wrote = await writeDraft(editor, restored);
      if (!wrote.ok) {
        beacon('write-failed', { ...wrote, phase: 'revert' });
        setStatus(st, '还原失败：写不回编辑器', 'error');
        return;
      }
      st.original = null; // 清空快照，允许基于当前内容再次增强
      st.enhanced = '';
      setStatus(st, '已还原原文');
      render(st);
    });

    render(st);
  }

  /** 抓取/重建当前 DOM 引用；工具栏被换掉时重挂按钮。 */
  function ensureUI(st) {
    const editor = findEditor(st.composer);
    if (editor) st.editor = editor;

    const existing = st.composer.querySelector(SEL.ownButton);
    if (existing) {
      st.button = existing;
      st.revert = st.composer.querySelector(SEL.ownRevert);
      st.status = st.composer.querySelector(SEL.ownStatus);
      render(st);
      return;
    }

    const actions = st.composer.querySelector(SEL.actions);
    if (!actions || !st.editor) return;
    build(st, actions);
  }

  function onKeydown(st, event) {
    if (event.key === 'E' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (st.loading) st.controller?.abort();
      else runEnhance(st);
    } else if (event.key === 'Escape' && st.loading) {
      event.preventDefault();
      st.controller?.abort();
    }
  }

  function attach(composer) {
    let st = states.get(composer);
    if (!st) {
      st = {
        composer,
        editor: null,
        button: null,
        revert: null,
        status: null,
        loading: false,
        original: null,
        enhanced: '',
        controller: null,
        runId: null,
        inputTimer: null,
        observer: null,
      };
      states.set(composer, st);

      // 每个 composer 只绑一次：DOM 变了只重建 UI，不重复挂监听。
      // 16ms 节流：Lexical 每敲一个字都会产生一串 childList 变更，
      // 逐个跑 ensureUI 等于每个按键都查一遍 DOM。
      let ensureScheduled = false;
      const scheduleEnsure = () => {
        if (ensureScheduled) return;
        ensureScheduled = true;
        setTimeout(() => {
          ensureScheduled = false;
          try {
            ensureUI(st);
          } catch (err) {
            console.warn('[zce] 重建按钮失败', err);
          }
        }, 16);
      };
      const composerObserver = new MutationObserver(scheduleEnsure);
      composerObserver.observe(composer, { childList: true, subtree: true });
      // 显式挂到状态上：观察中的 observer 本来就不会被回收，这里存一份只是为了
      // 调试时能确认"这个 composer 的观察器还在"，别当成无用字段删掉。
      st.observer = composerObserver;

      composer.addEventListener('keydown', (event) => onKeydown(st, event), true);

      // 草稿被改动后，增强前快照就失效了：否则用户改完再点「还原原文」，
      // 会把刚写的内容整个覆盖掉，而界面上看不出会发生什么。
      composer.addEventListener('input', () => {
        if (st.original === null) return;
        clearTimeout(st.inputTimer);
        st.inputTimer = setTimeout(() => {
          st.inputTimer = null;
          if (st.original === null) return;
          const now = readDraft(findEditor(st.composer));
          if (normalize(now) === normalize(st.enhanced || '')) return;
          st.original = null;
          st.enhanced = '';
          render(st);
        }, 300);
      }, true);

      // 首次接手时上报诊断，便于判断按钮到底卡在哪一步
      const anchor = readModelAnchor(composer);
      beacon('composer-seen', {
        hasActions: !!composer.querySelector(SEL.actions),
        hasEditor: !!findEditor(composer),
        // 三个锚点分开报：混在一起就看不出是哪一个失效了，
        // 而三种失效的处理方式完全不同（见 check_beacon 的结论分支）。
        hasModelConfig: !!modelScope(composer)?.querySelector?.(MODEL_CONFIG_SEL),
        hasModelValue: !!modelScope(composer)?.querySelector?.(SEL.modelValue),
        hasModelLabel: !!composer.querySelector(SEL.modelLabel),
        modelAnchor: anchor.anchor,
        modelFromDom: anchor.model,
        composerAttrs: Array.from(composer.attributes).map((a) => a.name).join(','),
      });
    }
    ensureUI(st);

    if (st.button && !st.reportedAttached) {
      st.reportedAttached = true;
      beacon('attached', { buttonParent: st.button.parentElement?.className || '' });
    } else if (!st.button && !st.reportedMissing) {
      st.reportedMissing = true;
      beacon('attach-failed', {
        hasActions: !!composer.querySelector(SEL.actions),
        hasEditor: !!findEditor(composer),
      });
    }
  }

  // ---------------------------------------------------------------- 全局扫描
  function scan() {
    ensureStyle();
    document.querySelectorAll(SEL.composer).forEach((composer) => {
      try {
        attach(composer);
      } catch (err) {
        console.warn('[zce] 注入失败', err);
      }
    });
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // 合并同一批 DOM 变更，避免流式输出时反复扫描
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 0);
  }

  // 只对「新增了 composer」的变更做响应；其余变更交给各自的 composer 观察器。
  const rootObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(SEL.composer) || node.querySelector?.(SEL.composer)) {
          scheduleScan();
          return;
        }
      }
    }
  });

  function boot() {
    // 样式表由 scan() → ensureStyle() 负责（带 id 去重），这里不重复调用
    scan();
    rootObserver.observe(document.documentElement, { childList: true, subtree: true });
    beacon('boot', {
      readyState: document.readyState,
      composers: document.querySelectorAll(SEL.composer).length,
      hasRoot: !!document.getElementById('root'),
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
