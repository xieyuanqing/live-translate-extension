/** 按需注入的划词浮窗；原文与返回文字均用 textContent，避免把网页内容当成 HTML。 */
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
    .panel { --bg:#fff; --source:#f7f7f8; --target:#f1f5fd; --fg:#25272c; --muted:#6b707b;
      --line:#e5e6ea; --accent:#3265a8; --hover:#e9edf4;
      position:relative; width:min(440px,calc(100vw - 20px)); max-height:calc(100vh - 20px); overflow:hidden;
      display:flex; flex-direction:column; background:var(--bg); color:var(--fg); border:1px solid var(--line);
      border-radius:16px; box-shadow:0 12px 38px #0003; font-size:14px; line-height:1.5; text-align:left; }
    .panel[data-theme=dark] { --bg:#292b30; --source:#34363c; --target:#303b4d; --fg:#f0f0f2;
      --muted:#b8bac2; --line:#474951; --accent:#a5c8ff; --hover:#454951; }
    button,select { font:inherit; color:inherit; }
    button { cursor:pointer; } button:disabled { opacity:.55; cursor:default; }
    button:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    header { display:flex; align-items:center; gap:4px; min-height:48px; padding:6px 10px 6px 14px;
      border-bottom:1px solid var(--line); cursor:grab; touch-action:none; user-select:none; }
    header:active { cursor:grabbing; }
    header strong { flex:1; font-size:15px; font-weight:650; }
    .target-choice { position:relative; display:flex; max-width:130px; min-width:0; color:var(--muted); }
    .target-language { appearance:none; width:100%; min-width:0; padding:5px 27px 5px 10px; border:0; border-radius:7px;
      background:var(--source); color:var(--fg); cursor:pointer; }
    .icon-button { display:inline-flex; flex:none; align-items:center; justify-content:center; width:30px; height:30px;
      border:0; border-radius:8px; background:transparent; color:var(--muted); padding:4px;
      transition:background-color .15s,color .15s; }
    .icon-button:hover:not(:disabled) { background:var(--hover); color:var(--fg); }
    .icon-button svg,.select-chevron { display:block; width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.75;
      stroke-linecap:round; stroke-linejoin:round; }
    .pin svg { transform:rotate(32deg); transition:transform .18s ease; }
    .pin[aria-pressed=true] { color:var(--accent); background:var(--target); }
    .pin[aria-pressed=true] svg { transform:rotate(0); }
    .pin[aria-pressed=true] .pin-body { fill:currentColor; fill-opacity:.14; }
    .select-chevron { position:absolute; right:7px; top:50%; width:16px; height:16px; transform:translateY(-50%); pointer-events:none; }
    .content { min-height:0; overflow:auto; padding:10px; }
    .card { padding:10px 12px 11px; border-radius:12px; }
    .source-card { background:var(--source); }
    .target-card { background:var(--target); margin-top:8px; }
    .card-head { display:flex; align-items:center; min-height:28px; gap:4px; color:var(--muted); font-size:12px; }
    .card-head .heading { flex:1; }
    .original,.result { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
    .original { font-size:13px; line-height:1.5; max-height:7.5em; overflow:hidden; }
    .original.expanded { max-height:none; }
    .expand { border:0; background:transparent; color:var(--accent); padding:2px 0; margin-top:3px; font-size:12px; }
    .expand:hover { text-decoration:underline; }
    .result { min-height:42px; font-size:15px; line-height:1.55; padding:4px 0 2px; }
    .result.loading { color:var(--muted); }
    .result.error { color:var(--fg); }
    .speaker[data-state=preparing],.speaker[data-state=playing] { color:var(--accent); background:var(--hover); }
    .speaker[data-state=playing] .wave-outer { display:none; }
    .speaker[data-state=preparing] svg { animation:speech-pulse 1.1s ease-in-out infinite; }
    .refresh.busy svg { animation:spin 1s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @keyframes speech-pulse { 50% { opacity:.45; } }
    @media (prefers-reduced-motion:reduce) {
      .speaker[data-state=preparing] svg,.refresh.busy svg { animation:none; }
      .icon-button,.pin svg { transition:none; }
    }
    footer { display:flex; align-items:center; gap:5px; min-height:46px; padding:5px 9px;
      border-top:1px solid var(--line); color:var(--muted); }
    .footer-choice { display:flex; align-items:center; min-width:0; gap:3px; }
    .footer-choice.model { flex:1 1 48%; }
    .footer-choice.speech { flex:1 1 36%; }
    .footer-choice span { flex:none; font-size:12px; }
    .footer-choice .select-wrap { position:relative; display:flex; min-width:0; flex:1; }
    .footer-choice select { appearance:none; width:100%; min-width:0; border:0; background:transparent; color:var(--fg);
      padding:4px 20px 4px 1px; font-size:12px; text-overflow:ellipsis; cursor:pointer; }
    .footer-choice .select-chevron { right:2px; }
    .separator { width:1px; height:20px; background:var(--line); flex:none; }
    .settings { margin-left:auto; }
    .toast { position:absolute; right:10px; bottom:49px; max-width:calc(100% - 20px); padding:7px 10px;
      border-radius:8px; background:var(--fg); color:var(--bg); box-shadow:0 3px 14px #0003;
      font-size:12px; pointer-events:none; }
  `;
  const node = (tag, value = '') => { const el = document.createElement(tag); el.textContent = value; return el; };
  const paths = {
    // 统一 24 × 24 网格；圆角轮廓保留足够留白，适配 20 px 显示。
    sound: ['M11 5 6 9H3.5v6H6l5 4V5Z', 'M15.25 8.75a4.6 4.6 0 0 1 0 6.5', 'M18.25 5.75a8.85 8.85 0 0 1 0 12.5'],
    copy: ['M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'],
    refresh: ['M18.5 8.25a7.5 7.5 0 1 0 0 7.5', 'M18.5 3.75v4.5H14'],
    pin: ['M9 3.5v5.8c0 1.4-.7 2.1-1.7 2.9L6 13.3V15h12v-1.7l-1.3-1.1C15.7 11.4 15 10.7 15 9.3V3.5', 'M8 3.5h8', 'M12 15v6'],
    settings: ['M9.54 5.55Q9.95 5.31 10.06 4.84L10.43 3.28Q10.55 2.81 11.03 2.81L12.97 2.81Q13.45 2.81 13.57 3.28L13.94 4.84Q14.05 5.31 14.46 5.55L16.36 6.64Q16.77 6.88 17.23 6.74L18.77 6.28Q19.23 6.15 19.47 6.56L20.44 8.25Q20.68 8.67 20.33 9L19.17 10.1Q18.82 10.43 18.82 10.91L18.82 13.09Q18.82 13.57 19.17 13.9L20.33 15Q20.68 15.33 20.44 15.75L19.47 17.44Q19.23 17.85 18.77 17.72L17.23 17.26Q16.77 17.12 16.36 17.36L14.46 18.45Q14.05 18.69 13.94 19.16L13.57 20.72Q13.45 21.19 12.97 21.19L11.03 21.19Q10.55 21.19 10.43 20.72L10.06 19.16Q9.95 18.69 9.54 18.45L7.64 17.36Q7.23 17.12 6.77 17.26L5.23 17.72Q4.77 17.85 4.53 17.44L3.56 15.75Q3.32 15.33 3.67 15L4.83 13.9Q5.18 13.57 5.18 13.09L5.18 10.91Q5.18 10.43 4.83 10.1L3.67 9Q3.32 8.67 3.56 8.25L4.53 6.56Q4.77 6.15 5.23 6.28L6.77 6.74Q7.23 6.88 7.64 6.64Z', 'M15.25 12a3.25 3.25 0 1 1-6.5 0 3.25 3.25 0 0 1 6.5 0Z'],
    close: ['M6 6l12 12M18 6 6 18'],
    chevron: ['m6 9 6 6 6-6'],
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (const [index, d] of paths[name].entries()) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      if (name === 'sound' && index === 2) path.classList.add('wave-outer');
      if (name === 'pin' && index === 0) path.classList.add('pin-body');
      svg.append(path);
    }
    return svg;
  }
  function iconButton(name, label) {
    const button = node('button'); button.type = 'button'; button.className = `icon-button ${name}`;
    button.setAttribute('aria-label', label); button.title = label; button.append(icon(name));
    return button;
  }
  function close() {
    if (!session) return;
    clearInterval(session.heartbeat); clearTimeout(session.toastTimer);
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
    return () => ({ left: innerWidth / 2 - 210, top: innerHeight / 3, bottom: innerHeight / 3 });
  }
  async function open(message) {
    const anchor = anchorFor(message);
    close();
    const host = node('div'); host.id = 'liuyi-selection-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet];
    const panel = node('section'); panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '流译划词');
    const header = node('header'); header.title = '按住标题栏拖动窗口';
    const title = node('strong', '流译');
    const targetLanguage = node('select'); targetLanguage.className = 'target-language'; targetLanguage.setAttribute('aria-label', '翻译目标语言'); targetLanguage.disabled = true;
    for (const item of LT.TARGET_LANGS) { const option = node('option', item.label); option.value = item.code; targetLanguage.append(option); }
    const pin = iconButton('pin', '固定位置'); pin.setAttribute('aria-pressed', 'false');
    const cross = iconButton('close', '关闭');
    const targetChoice = node('label'); targetChoice.className = 'target-choice';
    const targetArrow = icon('chevron'); targetArrow.classList.add('select-chevron');
    targetChoice.append(targetLanguage, targetArrow);
    header.append(title, targetChoice, pin, cross);

    const sourceCard = node('section'); sourceCard.className = 'card source-card';
    const originalHead = node('div'); originalHead.className = 'card-head';
    const language = node('span', `原文 · ${S.language(message.text) === 'ja-JP' ? '日语' : '英语'}`); language.className = 'heading';
    const read = iconButton('sound', '朗读原文'); read.classList.add('speaker'); read.dataset.state = 'idle'; read.disabled = true;
    originalHead.append(language, read);
    const original = node('div', message.text); original.className = 'original'; original.setAttribute('translate', 'no');
    const expand = node('button', '展开'); expand.type = 'button'; expand.className = 'expand'; expand.hidden = true;
    sourceCard.append(originalHead, original, expand);

    const targetCard = node('section'); targetCard.className = 'card target-card';
    const resultHead = node('div'); resultHead.className = 'card-head';
    const resultLabel = node('span', '译文'); resultLabel.className = 'heading';
    const copy = iconButton('copy', '复制译文'); copy.hidden = true;
    const translate = iconButton('refresh', '重新翻译'); translate.classList.add('busy'); translate.disabled = true;
    resultHead.append(resultLabel, copy, translate);
    const result = node('div', '翻译中…'); result.className = 'result loading'; result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite'); result.setAttribute('translate', 'no');
    targetCard.append(resultHead, result);
    const content = node('div'); content.className = 'content'; content.append(sourceCard, targetCard);

    const footer = node('footer');
    const translationProvider = node('select'); translationProvider.setAttribute('aria-label', '划词翻译模型'); translationProvider.disabled = true;
    const provider = node('select'); provider.setAttribute('aria-label', '朗读接口'); provider.disabled = true;
    for (const [value, label] of [['microsoft', '微软'], ['gemini', 'Gemini']]) { const option = node('option', label); option.value = value; provider.append(option); }
    const footerChoice = (label, select, className) => {
      const wrap = node('label'); wrap.className = `footer-choice ${className}`;
      const selectWrap = node('span'); selectWrap.className = 'select-wrap';
      const arrow = icon('chevron'); arrow.classList.add('select-chevron');
      selectWrap.append(select, arrow); wrap.append(node('span', label), selectWrap); return wrap;
    };
    const separator = node('span'); separator.className = 'separator'; separator.setAttribute('aria-hidden', 'true');
    const settingsButton = iconButton('settings', '打开设置');
    footer.append(footerChoice('模型', translationProvider, 'model'), separator,
      footerChoice('朗读', provider, 'speech'), settingsButton);
    const toast = node('div'); toast.className = 'toast'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); toast.hidden = true;
    panel.append(header, content, footer, toast); shadow.append(panel);

    const port = chrome.runtime.connect({ name: S.PORT });
    const current = { host, panel, port, speechId: 0, translationId: 0, heartbeat: null,
      speechState: 'idle', rate: 1, selectionRevision: 0, speechRevision: 0,
      choiceSave: Promise.resolve(), savedSpeechProvider: '', savedTranslationProviderId: '', savedTargetLang: '',
      manual: false, place: null, fullscreen: null, resize: null, toastTimer: null };
    session = current;
    current.heartbeat = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) { close(); } }, 10000);
    document.documentElement.append(host);
    if (document.fullscreenElement) document.fullscreenElement.append(host);
    const placeAt = (left, top, size = panel.getBoundingClientRect()) => {
      host.style.left = `${Math.round(Math.max(10, Math.min(left, innerWidth - size.width - 10)))}px`;
      host.style.top = `${Math.round(Math.max(10, Math.min(top, innerHeight - size.height - 10)))}px`;
    };
    current.place = () => {
      if (current.manual) { placeAt(parseFloat(host.style.left) || 10, parseFloat(host.style.top) || 10); return; }
      const bounds = anchor(), size = panel.getBoundingClientRect();
      const left = Math.max(10, Math.min(bounds.left, innerWidth - size.width - 10));
      let top = bounds.bottom + 8;
      if (top + size.height > innerHeight - 10 && bounds.top - size.height - 8 >= 10) top = bounds.top - size.height - 8;
      placeAt(left, top, size);
    };
    const setPinned = pinned => {
      current.manual = pinned;
      pin.setAttribute('aria-pressed', String(pinned));
      pin.setAttribute('aria-label', pinned ? '取消固定位置' : '固定位置'); pin.title = pin.getAttribute('aria-label');
      current.place();
    };
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button,select,label')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: parseFloat(host.style.left) || 10, top: parseFloat(host.style.top) || 10 };
      header.setPointerCapture(event.pointerId); event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!current.manual && Math.abs(dx) + Math.abs(dy) < 3) return;
      setPinned(true); placeAt(drag.left + dx, drag.top + dy);
    });
    const endDrag = event => { if (drag?.id === event.pointerId) drag = null; };
    header.addEventListener('pointerup', endDrag); header.addEventListener('pointercancel', endDrag);
    current.fullscreen = () => { (document.fullscreenElement || document.documentElement).append(host); current.place(); };
    const updateExpand = () => { expand.hidden = !original.classList.contains('expanded') && original.scrollHeight <= original.clientHeight + 1; };
    current.resize = new ResizeObserver(() => { current.place(); updateExpand(); }); current.resize.observe(panel);
    window.addEventListener('resize', current.place); window.addEventListener('scroll', current.place, true);
    document.addEventListener('fullscreenchange', current.fullscreen);
    current.place();
    updateExpand();
    const showToast = (text, duration = 2000) => {
      clearTimeout(current.toastTimer); toast.textContent = text; toast.hidden = false;
      current.toastTimer = setTimeout(() => { if (session === current) toast.hidden = true; }, duration);
    };
    const post = value => {
      try { port.postMessage(value); return true; }
      catch (_) { showToast('扩展连接中断，请重新打开划词菜单', 3500); return false; }
    };
    const saveChoice = patch => {
      current.choiceSave = current.choiceSave.catch(() => {}).then(() => LT.Settings.save(patch));
      return current.choiceSave;
    };
    const setSpeechState = state => {
      current.speechState = state; read.dataset.state = state;
      const label = ['preparing', 'playing'].includes(state) ? '停止朗读' : '朗读原文';
      read.setAttribute('aria-label', label); read.title = label;
    };
    const speak = () => {
      if (['preparing', 'playing'].includes(current.speechState)) { post({ type: 'stop' }); setSpeechState('idle'); return; }
      current.speechId = ++sequence; setSpeechState('preparing');
      post({ type: 'speak', text: message.text, provider: provider.value, rate: current.rate, requestId: current.speechId });
    };
    const beginTranslation = () => {
      result.textContent = '翻译中…'; result.className = 'result loading'; result.removeAttribute('lang');
      copy.hidden = true; translate.disabled = true; translate.classList.add('busy');
    };
    const translateText = () => {
      current.translationId = ++sequence; beginTranslation();
      post({ type: 'translate', text: message.text, providerId: translationProvider.value,
        targetLang: targetLanguage.value, requestId: current.translationId });
    };
    port.onMessage.addListener(value => {
      if (session !== current) return;
      if (value.type === 'close') { close(); return; }
      if (value.type === 'speech' && value.requestId === current.speechId) {
        if (value.error) showToast(value.error, 3500);
        setSpeechState(['preparing', 'playing'].includes(value.phase) ? value.phase : 'idle');
      }
      if (value.type === 'translation' && value.requestId === current.translationId) {
        translate.disabled = false; translate.classList.remove('busy');
        result.textContent = value.error || value.text; result.className = value.error ? 'result error' : 'result';
        if (!value.error) { result.lang = value.target; copy.hidden = false; }
      }
    });
    port.onDisconnect.addListener(() => {
      clearInterval(current.heartbeat);
      if (session === current) { showToast('连接已断开，请重新打开划词菜单', 3500); read.disabled = translate.disabled = true; }
    });
    cross.addEventListener('click', close);
    pin.addEventListener('click', () => setPinned(!current.manual));
    expand.addEventListener('click', () => {
      const expanded = original.classList.toggle('expanded'); expand.textContent = expanded ? '收起' : '展开'; updateExpand();
    });
    read.addEventListener('click', speak);
    translate.addEventListener('click', translateText);
    provider.addEventListener('change', async () => {
      const chosen = provider.value, revision = ++current.speechRevision;
      current.speechId = ++sequence;
      post({ type: 'stop' }); setSpeechState('idle'); read.disabled = true;
      try {
        await saveChoice({ ttsProvider: chosen }); current.savedSpeechProvider = chosen;
        if (session === current && revision === current.speechRevision) showToast(`已切换至${chosen === 'gemini' ? ' Gemini' : '微软'}`);
      } catch (_) {
        if (session === current && revision === current.speechRevision) {
          provider.value = current.savedSpeechProvider; showToast('朗读服务保存失败，请重试', 3500);
        }
      }
      if (session !== current || revision !== current.speechRevision) return;
      read.disabled = false;
    });
    translationProvider.addEventListener('change', async () => {
      const chosen = translationProvider.value, revision = ++current.selectionRevision;
      current.translationId = ++sequence; post({ type: 'cancel-translation' }); beginTranslation();
      try {
        await saveChoice({ selectionProviderId: chosen }); current.savedTranslationProviderId = chosen;
        if (session === current && revision === current.selectionRevision) translateText();
      } catch (_) {
        if (session === current) translationProvider.value = current.savedTranslationProviderId;
        if (session === current && revision === current.selectionRevision) {
          result.textContent = '翻译模型保存失败，请重试'; result.className = 'result error';
          translate.disabled = false; translate.classList.remove('busy');
        }
      }
    });
    targetLanguage.addEventListener('change', async () => {
      const chosen = targetLanguage.value, revision = ++current.selectionRevision;
      current.translationId = ++sequence; post({ type: 'cancel-translation' }); beginTranslation();
      try {
        await saveChoice({ targetLang: chosen }); current.savedTargetLang = chosen;
        if (session === current && revision === current.selectionRevision) translateText();
      } catch (_) {
        if (session === current) targetLanguage.value = current.savedTargetLang;
        if (session === current && revision === current.selectionRevision) {
          result.textContent = '目标语言保存失败，请重试'; result.className = 'result error';
          translate.disabled = false; translate.classList.remove('busy');
        }
      }
    });
    settingsButton.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'lt-open-speech-settings' }).catch(() => {}); });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(result.textContent); if (session === current) showToast('已复制'); }
      catch (_) { if (session === current) showToast('复制失败，请手动选中译文复制', 3500); }
    });
    shadow.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    const settings = await LT.Settings.load();
    if (session !== current) return;
    for (const item of settings.providers) {
      const name = item.name || (item.apiType === 'gemini' ? 'Gemini' : 'OpenAI 兼容');
      const option = node('option', `${name} · ${item.model || '未填写模型名'}`);
      option.value = item.id; translationProvider.append(option);
    }
    translationProvider.value = settings.selectionProviderId; current.savedTranslationProviderId = settings.selectionProviderId;
    provider.value = settings.ttsProvider; current.savedSpeechProvider = settings.ttsProvider;
    targetLanguage.value = settings.targetLang; current.savedTargetLang = settings.targetLang;
    current.rate = settings.ttsRate;
    applyTheme(settings.uiTheme);
    read.disabled = targetLanguage.disabled = translationProvider.disabled = provider.disabled = false;
    cross.focus({ preventScroll: true });
    // 打开时先显示轻量的翻译状态；朗读只由用户点击扬声器启动。
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
