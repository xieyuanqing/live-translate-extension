/** 按需注入的划词浮窗；界面在 Shadow DOM 中，原文与返回文字均用 textContent。 */
(() => {
  const LT = globalThis.LT;
  if (LT.SelectionUI) return;
  const S = LT.Selection;
  let session = null;
  let sequence = 0;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(preference) {
    if (!session) return;
    session.theme = preference || 'system';
    session.panel.dataset.theme = session.theme === 'dark' || (session.theme === 'system' && systemTheme.matches) ? 'dark' : 'light';
  }
  systemTheme.addEventListener('change', () => { if (session) applyTheme(session.theme); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) applyTheme(changes.settings.newValue?.uiTheme);
  });
  const css = `
    :host { all:initial; position:fixed; z-index:2147483647; font-family:system-ui,'Microsoft YaHei',sans-serif; }
    * { box-sizing:border-box; } [hidden] { display:none!important; }
    .panel { --bg:#fff; --surface:#f5f5f5; --fg:#202020; --muted:#606060; --line:#ddd; --accent:#1267bd;
      width:min(400px,calc(100vw - 20px)); max-height:calc(100vh - 20px); overflow:hidden; display:flex; flex-direction:column;
      background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:14px; box-shadow:0 8px 32px #0003;
      font-size:13px; line-height:1.45; text-align:left; }
    .panel[data-theme=dark] { --bg:#303030; --surface:#383838; --fg:#ededed; --muted:#bbb; --line:#555; --accent:#8ab4f8; }
    header { display:flex; align-items:center; gap:8px; min-height:38px; padding:6px 10px; border-bottom:1px solid var(--line);
      cursor:grab; touch-action:none; user-select:none; } header:active { cursor:grabbing; }
    header strong { font-size:14px; flex:1; } .drag-hint { color:var(--muted); font-size:11px; }
    .content { min-height:0; overflow:auto; padding:8px 10px 9px; }
    .section-head { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:11px; }
    .section-head .copy { margin-left:auto; min-height:0; padding:0 2px; color:var(--accent); background:none; border:0; }
    button,select { font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:4px 7px; min-height:28px; }
    button { cursor:pointer; } button:hover { border-color:var(--accent); } button:disabled { opacity:.55; cursor:default; }
    button:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .close { border:0; background:none; font-size:20px; line-height:1; padding:0 3px; min-height:24px; }
    .original,.result { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
    .original { max-height:76px; overflow:auto; background:var(--surface); padding:6px 8px; border-radius:7px; margin:3px 0 8px; font-size:12px; }
    .result { max-height:min(34vh,180px); overflow:auto; padding:3px 0 5px; font-size:14px; line-height:1.5; }
    .row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
    .actions { margin-top:6px; }
    .meta { padding:7px 10px; border-top:1px solid var(--line); }
    .status,.label { color:var(--muted); font-size:11px; } .status { margin-top:4px; } .status:empty { display:none; }
    .settings { color:var(--accent); background:none; border:0; margin-left:auto; }
  `;
  function close() {
    if (!session) return;
    clearInterval(session.heartbeat);
    session.resize?.disconnect();
    window.removeEventListener('resize', session.place);
    window.removeEventListener('scroll', session.place, true);
    document.removeEventListener('fullscreenchange', session.fullscreen);
    try { session.port.disconnect(); } catch (_) { /* 已断开 */ }
    session.host.remove(); session = null;
  }
  function anchorFor(message) {
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0).cloneRange();
      const comparable = text => String(text).trim().replace(/\s+/g, ' ');
      if (comparable(range.toString()) === comparable(message.text)) return () => range.getBoundingClientRect();
    }
    // 跨域帧不能注入时，仍在当前网页显示，靠近承载该帧的元素。
    if (message.frameUrl) {
      const frame = [...document.querySelectorAll('iframe')].find(el => el.src === message.frameUrl);
      if (frame) return () => frame.getBoundingClientRect();
    }
    const input = document.activeElement;
    if (input?.matches('input,textarea') && input.selectionStart !== input.selectionEnd) return () => input.getBoundingClientRect();
    return () => ({ left: innerWidth / 2 - 190, top: innerHeight / 3, bottom: innerHeight / 3 });
  }
  const node = (tag, text = '') => { const el = document.createElement(tag); el.textContent = text; return el; };
  async function open(message) {
    const anchor = anchorFor(message);
    close();
    const host = node('div'); host.id = 'liuyi-selection-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet];
    const panel = node('section'); panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '流译划词');
    const header = node('header'); const title = node('strong', '流译 · 划词');
    header.title = '按住这里拖动窗口';
    const dragHint = node('span', '拖动'); dragHint.className = 'drag-hint';
    const cross = node('button', '×'); cross.className = 'close'; cross.setAttribute('aria-label', '关闭');
    header.append(title, dragHint, cross);
    const original = node('div', message.text); original.className = 'original'; original.setAttribute('translate', 'no');
    const originalHead = node('div', '原文'); originalHead.className = 'section-head';
    const language = node('span', S.language(message.text) === 'ja-JP' ? '日语原文' : '英语原文'); language.className = 'label';
    const provider = node('select'); provider.setAttribute('aria-label', '朗读供应商');
    for (const [value, label] of [['microsoft', '微软'], ['gemini', 'Gemini']]) { const opt = node('option', label); opt.value = value; provider.append(opt); }
    const rate = node('select'); rate.setAttribute('aria-label', '朗读速度');
    for (const [value, label] of [[0.85, '慢一点'], [1, '正常语速'], [1.15, '快一点']]) { const opt = node('option', label); opt.value = value; rate.append(opt); }
    const row = node('div'); row.className = 'row meta'; row.append(language, provider, rate);
    const read = node('button', '▶ 朗读'); const stop = node('button', '停止'); stop.disabled = true; stop.hidden = true;
    const translate = node('button', '重译'); translate.hidden = true; const settingsButton = node('button', '设置'); settingsButton.className = 'settings';
    read.disabled = translate.disabled = true;
    const controls = node('div'); controls.className = 'row actions'; controls.append(read, stop, translate);
    const status = node('div'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const result = node('div'); result.className = 'result'; result.hidden = true; result.setAttribute('translate', 'no');
    const translationStatus = node('div'); translationStatus.className = 'status'; translationStatus.setAttribute('role', 'status');
    const copy = node('button', '复制'); copy.className = 'copy'; copy.hidden = true;
    const resultHead = node('div'); resultHead.className = 'section-head'; resultHead.append(node('span', '译文'), copy);
    const content = node('div'); content.className = 'content';
    content.append(originalHead, original, resultHead, translationStatus, result, controls, status);
    row.append(settingsButton);
    panel.append(header, content, row); shadow.append(panel);
    const port = chrome.runtime.connect({ name: S.PORT });
    const current = { host, panel, port, speechId: 0, translationId: 0, heartbeat: null, switching: false, manual: false, place: null, fullscreen: null, resize: null };
    session = current;
    current.heartbeat = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) { close(); } }, 10000);
    document.documentElement.append(host);
    if (document.fullscreenElement) document.fullscreenElement.append(host);
    const placeAt = (left, top, size = panel.getBoundingClientRect()) => {
      host.style.left = `${Math.round(Math.max(10, Math.min(left, innerWidth - size.width - 10)))}px`;
      host.style.top = `${Math.round(Math.max(10, Math.min(top, innerHeight - size.height - 10)))}px`;
    };
    current.place = () => {
      if (current.manual) {
        placeAt(parseFloat(host.style.left) || 10, parseFloat(host.style.top) || 10);
        return;
      }
      const bounds = anchor(), size = panel.getBoundingClientRect();
      const left = Math.max(10, Math.min(bounds.left, innerWidth - size.width - 10));
      let top = bounds.bottom + 8;
      if (top + size.height > innerHeight - 10 && bounds.top - size.height - 8 >= 10) top = bounds.top - size.height - 8;
      placeAt(left, top, size);
    };
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: parseFloat(host.style.left) || 10, top: parseFloat(host.style.top) || 10 };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!current.manual && Math.abs(dx) + Math.abs(dy) < 3) return;
      current.manual = true;
      placeAt(drag.left + dx, drag.top + dy);
    });
    const endDrag = event => { if (drag?.id === event.pointerId) drag = null; };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    current.fullscreen = () => {
      (document.fullscreenElement || document.documentElement).append(host);
      current.place();
    };
    current.resize = new ResizeObserver(current.place); current.resize.observe(panel);
    window.addEventListener('resize', current.place);
    window.addEventListener('scroll', current.place, true);
    document.addEventListener('fullscreenchange', current.fullscreen);
    current.place();
    const post = value => { try { port.postMessage(value); } catch (_) { status.textContent = '扩展连接中断，请重新打开划词菜单'; stop.disabled = true; } };
    const speak = () => {
      current.speechId = ++sequence;
      read.disabled = true; stop.disabled = false; stop.hidden = false; status.textContent = '准备中…';
      post({ type: 'speak', text: message.text, provider: provider.value, rate: Number(rate.value), requestId: current.speechId });
    };
    const translateText = () => {
      current.translationId = ++sequence; translate.disabled = true;
      translationStatus.textContent = '翻译中…'; result.hidden = true; copy.hidden = true; translate.hidden = true;
      post({ type: 'translate', text: message.text, requestId: current.translationId });
    };
    port.onMessage.addListener(value => {
      if (session !== current) return;
      if (value.type === 'close') { close(); return; }
      if (value.type === 'speech' && value.requestId === current.speechId) {
        const busy = ['preparing', 'playing'].includes(value.phase);
        read.disabled = current.switching || value.phase === 'preparing'; stop.disabled = !busy; stop.hidden = !busy;
        read.textContent = value.phase === 'preparing' ? '准备中' : '重播原文';
        status.textContent = value.error || ({ preparing: '准备中…', playing: '播放中', stopped: '已停止', ended: '朗读完成' })[value.phase] || '';
      }
      if (value.type === 'translation' && value.requestId === current.translationId) {
        translate.disabled = false; translate.hidden = false; translationStatus.textContent = value.error || '';
        if (!value.error) { result.textContent = value.text; result.lang = value.target; result.hidden = false; copy.hidden = false; }
      }
    });
    port.onDisconnect.addListener(() => {
      clearInterval(current.heartbeat);
      if (session === current) { status.textContent = '连接已断开，请重新打开划词菜单'; read.disabled = translate.disabled = stop.disabled = true; }
    });
    cross.addEventListener('click', close);
    read.addEventListener('click', speak);
    stop.addEventListener('click', () => { post({ type: 'stop' }); });
    translate.addEventListener('click', translateText);
    provider.addEventListener('change', async () => {
      current.switching = true;
      post({ type: 'stop' }); read.disabled = true; stop.disabled = true; stop.hidden = true; status.textContent = '正在切换供应商…';
      try { await LT.Settings.save({ ttsProvider: provider.value }); status.textContent = '已切换供应商，点击朗读'; }
      catch (_) { status.textContent = '供应商保存失败，请重试'; }
      current.switching = false;
      read.disabled = false;
    });
    rate.addEventListener('change', () => post({ type: 'rate', rate: Number(rate.value) }));
    settingsButton.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'lt-open-speech-settings' }).catch(() => {}); });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(result.textContent); copy.textContent = '已复制'; }
      catch (_) { translationStatus.textContent = '复制失败，请手动选中译文复制'; }
    });
    shadow.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    const settings = await LT.Settings.load();
    if (session !== current) return;
    provider.value = settings.ttsProvider;
    rate.value = [0.85, 1, 1.15].includes(settings.ttsRate) ? String(settings.ttsRate) : '1';
    applyTheme(settings.uiTheme);
    read.disabled = translate.disabled = false;
    cross.focus({ preventScroll: true });
    // 菜单只打开原文/译文浮窗；朗读由用户点击播放，不自动出声。
    translateText();
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'lt-selection-open' || sender.id !== chrome.runtime.id) return;
    open(message).catch(() => close()); reply({ ok: true });
  });
  window.addEventListener('pagehide', close);
  window.addEventListener('yt-navigate-start', close);
  window.addEventListener('popstate', close);
  LT.SelectionUI = { open, close };
})();
