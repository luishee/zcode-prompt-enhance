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

  // 打补丁时会替换成实际端点
  const ENDPOINT = '__ZCE_ENDPOINT__';

  // 文案对齐 ZCode 自带的 chat.promptEnhance.* 与 WorkBuddy 的 input.enhance.*
  const TEXT = {
    idle: '增强提示词',
    busy: '增强中…',
    revert: '还原原文',
    empty: '请先输入需要增强的提示词',
    cancelled: '已取消本次提示词增强',
    failedWith: (e) => `提示词增强失败：${e}`,
    offline: '增强服务未响应：确认插件「增强提示词服务」已启用，且 127.0.0.1:8770 在监听',
    done: (model) => (model ? `已增强 · ${model}` : '已增强'),
    overLength: '结果超过 800 字，可再点一次让模型收敛',
    writeBackFailed: '已生成增强结果，但写回输入框失败（编辑器结构可能已变）',
  };

  const SEL = {
    composer: '[data-composer-layout]',
    actions: '[data-composer-leading-actions]',
    editor: '[data-lexical-editor="true"]',
    modelLabel: '[data-composer-open-label]',
    ownButton: '[data-zce-enhance]',
    ownRevert: '[data-zce-revert]',
    ownStatus: '[data-zce-status]',
  };

  const BEACON_RETRY_MS = 3000;
  const BEACON_MAX_TRIES = 20;

  /**
   * 诊断信标：把「脚本是否加载、有没有找到 composer、锚点是否命中」回报给插件服务。
   *
   * 为什么需要重试：渲染层的启动早于插件 MCP server 绑定 8770，所以 boot 那次上报
   * 常常直接失败（实测：改造为插件后信标一条都收不到）。只发一次等于诊断能力作废，
   * 因此在失败时按 3s 间隔重试，最多 20 次（约 60s），足够等插件起来。
   * 成功即停；上报失败本身不影响增强功能。
   */
  function beacon(stage, extra, attempt = 1) {
    const payload = JSON.stringify({ stage, url: location.href, ts: Date.now(), ...(extra || {}) });

    const retry = () => {
      if (attempt >= BEACON_MAX_TRIES) return;
      setTimeout(() => beacon(stage, extra, attempt + 1), BEACON_RETRY_MS);
    };

    try {
      fetch(`${ENDPOINT}/api/beacon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  // ZCode 发请求时会把真实 model id 放进 body，抓它最准；DOM 标签只是显示名，作次选。
  let lastRequestModel = '';
  (() => {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && typeof init.body === 'string' ? init.body : null;
        if (body && /chat\/completions|completions|\/messages/.test(url)) {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
            lastRequestModel = parsed.model.trim();
          }
        }
      } catch {
        /* 探测失败不影响请求本身 */
      }
      return originalFetch.apply(this, arguments);
    };
  })();

  function currentModel() {
    let label = '';
    try {
      // 用 textContent：标签可能被 truncate 或按布局隐藏，innerText 会拿到空串
      label = (document.querySelector(SEL.modelLabel)?.textContent || '').trim();
    } catch {
      /* ignore */
    }
    // 可能是 "DeepSeek-V4.1-Flash · 经济模式" 这类复合文案，取首段
    label = label.split(/[·|｜]/)[0].trim();
    return lastRequestModel || label || '';
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

  function render(st) {
    if (!st.button) return;
    if (st.button.disabled !== st.loading) st.button.disabled = st.loading;
    const active = st.loading ? 'true' : 'false';
    if (st.button.dataset.active !== active) st.button.dataset.active = active;

    const html = st.loading
      ? `<span class="zce-spin"></span><span class="zce-label">${TEXT.busy}</span>`
      : `<span class="zce-icon">✨</span><span class="zce-label">${TEXT.idle}</span>`;
    // 与「当前真实 DOM」比较，而不是记一个 lastHtml：按钮被重建时也能立刻写对内容，
    // 且写完后二者相等，不会再触发观察器。
    if (st.button.innerHTML !== html) {
      st.button.innerHTML = html;
    }

    const tip = st.loading ? '再次点击可取消当前这次增强' : `${TEXT.idle}（Ctrl+Shift+E）`;
    if (st.button.title !== tip) st.button.title = tip;

    if (st.revert) {
      setHidden(st.revert, !(st.original !== null && !st.loading));
      setText(st.revert, TEXT.revert);
      if (st.revert.title !== '恢复到增强前的原文') st.revert.title = '恢复到增强前的原文';
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

    st.controller = new AbortController();
    st.loading = true;
    setStatus(st, TEXT.busy);
    render(st);

    try {
      const resp = await fetch(`${ENDPOINT}/api/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft, model: currentModel() || undefined }),
        signal: st.controller.signal,
      });
      const data = await resp.json();

      if (!data || data.success !== true || !String(data.text || '').trim()) {
        // 失败：保留草稿，只提示原因
        const reason = (data && (data.error || data.code)) || `HTTP ${resp.status}`;
        setStatus(st, TEXT.failedWith(reason), 'error');
        return;
      }

      const snapshot = draft;
      const wrote = await writeDraft(editor, data.text);
      if (!wrote.ok) {
        // 失败详情走信标，否则「写回失败」这四个字对排查毫无帮助
        beacon('write-failed', wrote);
        setStatus(st, `${TEXT.writeBackFailed}（策略：${(wrote.tried || []).join('/')}）`, 'error');
        return;
      }
      beacon('write-ok', { strategy: wrote.strategy, hasApi: wrote.hasApi });

      st.original = snapshot;
      const bits = [TEXT.done(data.model)];
      if (data.channel && data.channel !== 'zcode') bits.push(`通道 ${data.channel}`);
      if (data.removedMetaLines) bits.push(`清理 ${data.removedMetaLines} 行元信息`);
      if (data.overLength) bits.push(TEXT.overLength);
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
      st.loading = false;
      st.controller = null;
      render(st);
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
        controller: null,
      };
      states.set(composer, st);

      // 每个 composer 只绑一次：DOM 变了只重建 UI，不重复挂监听
      const composerObserver = new MutationObserver(() => {
        try {
          ensureUI(st);
        } catch (err) {
          console.warn('[zce] 重建按钮失败', err);
        }
      });
      composerObserver.observe(composer, { childList: true, subtree: true });
      st.observer = composerObserver;

      composer.addEventListener('keydown', (event) => onKeydown(st, event), true);

      // 首次接手时上报诊断，便于判断按钮到底卡在哪一步
      beacon('composer-seen', {
        hasActions: !!composer.querySelector(SEL.actions),
        hasEditor: !!findEditor(composer),
        hasModelLabel: !!composer.querySelector(SEL.modelLabel),
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
    ensureStyle();
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
