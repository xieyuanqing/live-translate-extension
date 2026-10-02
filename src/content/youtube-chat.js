/** YouTube 聊天帧：Chrome Translator 本地翻译，状态送往扩展弹窗，有限队列与页面内缓存。 */
(() => {
  if (!/^\/live_chat(?:_replay)?\/?$/.test(location.pathname)) return;
  const LT = globalThis.LT;
  const T = LT.YouTubeText;
  const selector = 'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer';
  const language = code => code === 'zh-Hans' ? 'zh' : code;
  let settings = LT.DEFAULTS;
  let settingsRevision = 0;
  let signature = '';
  let generation = 0;
  let phase = 'off';
  let error = '';
  let translatedCount = 0;
  let dropped = 0;
  let downloadProgress = '';
  let scanTimer = null;
  let processing = false;
  let detector = null;
  let controller = null;
  let pendingLanguage = '';
  let seen = new WeakMap();
  const translators = new Map();
  const queue = [];
  const cache = new Map();
  let videoId = new URL(location.href).searchParams.get('v') || '';
  const isCurrent = run => run === generation && videoId === (new URL(location.href).searchParams.get('v') || '');

  const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const readText = node => T.readText(node);
  const active = () => settings.enableChatTranslation;

  function publish() {
    chrome.runtime.sendMessage({ type: LT.MSG.CHAT_STATUS, payload: { videoId, phase, enabled: active(),
      translated: translatedCount, pending: queue.length, dropped, error, pendingLanguage, downloadProgress } }).catch(() => {});
  }

  function stop({ remove = false } = {}) {
    generation++;
    controller?.abort();
    controller = null;
    for (const translator of translators.values()) { try { translator.destroy(); } catch (_) { /* 已关闭 */ } }
    translators.clear();
    try { detector?.destroy(); } catch (_) { /* 已关闭 */ }
    detector = null;
    processing = false;
    queue.length = 0;
    seen = new WeakMap();
    phase = 'off';
    error = '';
    downloadProgress = '';
    if (remove) {
      for (const node of document.querySelectorAll('.lt-yt-chat-result')) node.remove();
    }
    publish();
  }

  function progress(monitor, run, name) {
    monitor.addEventListener('downloadprogress', event => {
      if (!isCurrent(run)) return;
      const value = Number(event.loaded);
      downloadProgress = Number.isFinite(value) ? `${name} ${Math.round(value * 100)}%` : `${name}下载中`;
      publish();
    });
  }

  async function getTranslator(source, allowDownload, signal, run) {
    const target = language(settings.targetLang);
    const key = `${source}:${target}`;
    if (translators.has(key)) return translators.get(key);
    if (!globalThis.Translator?.availability || !globalThis.Translator?.create) {
      throw new Error('此 Chrome 未提供本地 Translator API，请使用支持此功能的桌面版 Chrome');
    }
    if (!allowDownload) {
      const availability = await globalThis.Translator.availability({ sourceLanguage: source, targetLanguage: target });
      if (!isCurrent(run) || signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (availability === 'unavailable') throw new Error(`Chrome 本地翻译不支持 ${source} → ${target}`);
      if (availability !== 'available') {
        pendingLanguage = source;
        throw new Error(`需要准备 ${source} → ${target} 的本地语言包，请点击「准备本地翻译」`);
      }
    }
    const translator = await globalThis.Translator.create({ sourceLanguage: source, targetLanguage: target,
      signal, monitor: monitor => progress(monitor, run, `${source} → ${target}`) });
    if (!isCurrent(run) || signal.aborted) { translator.destroy(); throw new DOMException('已取消', 'AbortError'); }
    translators.set(key, translator);
    return translator;
  }

  async function prepareLocal(allowDownload) {
    if (!active()) return { ok: false, error: '请先打开弹幕自动翻译' };
    if (phase === 'preparing' && !allowDownload) return { ok: false, error: '正在准备本地翻译' };
    const source = pendingLanguage || (settings.sourceLang === 'auto' ? 'ja' : language(settings.sourceLang));
    stop();
    const run = generation;
    controller = new AbortController();
    const signal = controller.signal;
    phase = 'preparing';
    error = '';
    publish();
    try {
      const prepareDetector = async () => {
        if (settings.sourceLang !== 'auto' || detector) return;
        if (!globalThis.LanguageDetector?.availability || !globalThis.LanguageDetector?.create) {
          throw new Error('此 Chrome 不支持本地语言检测，请先选择具体的源语言');
        }
        if (!allowDownload) {
          const availability = await globalThis.LanguageDetector.availability();
          if (!isCurrent(run) || signal.aborted) return;
          if (availability === 'unavailable') throw new Error('本地语言检测不可用，请先选择具体的源语言');
          if (availability !== 'available') throw new Error('请点击「准备本地翻译」下载语言检测模型和语言包');
        }
        const next = await globalThis.LanguageDetector.create({ signal, monitor: monitor => progress(monitor, run, '语言检测') });
        if (!isCurrent(run) || signal.aborted) { next.destroy(); return; }
        detector = next;
      };
      // 两项创建都由同一次点击启动，不能等一个模型下载完才请求另一个。
      await Promise.all([prepareDetector(), source === language(settings.targetLang)
        ? Promise.resolve() : getTranslator(source, allowDownload, signal, run)]);
      if (!isCurrent(run) || signal.aborted) return { ok: false, error: '已取消' };
      pendingLanguage = '';
      phase = 'ready';
      error = '';
      downloadProgress = '';
      publish();
      scheduleScan();
      return { ok: true };
    } catch (err) {
      if (!isCurrent(run) || signal.aborted) return { ok: false, error: '已取消' };
      const message = err?.message || '本地翻译初始化失败，请点击重试';
      stop();
      phase = allowDownload ? 'error' : 'waiting';
      error = message;
      publish();
      return { ok: false, error: message };
    }
  }

  function scheduleScan() {
    if (active() && !scanTimer) scanTimer = setTimeout(scan, 120);
  }

  function scan() {
    scanTimer = null;
    if (!active()) return;
    const nextId = new URL(location.href).searchParams.get('v') || '';
    if (nextId !== videoId) {
      videoId = nextId;
      stop({ remove: true });
      cache.clear();
      translatedCount = dropped = 0;
      pendingLanguage = '';
      phase = 'waiting';
      prepareLocal(false);
      return;
    }
    if (phase !== 'ready') return;
    for (const row of [...document.querySelectorAll(selector)].slice(-80)) {
      const source = row.querySelector('#message');
      if (!source || !T.visible(source)) continue;
      const text = readText(source);
      const previous = source.querySelector(':scope > .lt-yt-chat-result');
      if (previous && (previous.dataset.original !== text || previous.dataset.target !== settings.targetLang)) previous.remove();
      else if (previous) continue;
      if (!text || !T.shouldTranslateChat(T.readText(source, { includeImages: false })) || text.length > 2000 || seen.get(source) === text) continue;
      seen.set(source, text);
      queue.push({ source, text, generation });
      while (queue.length > 30) { queue.shift(); dropped++; }
    }
    pump();
  }

  function append(job, translated, run) {
    if (!isCurrent(run) || !job.source.isConnected || readText(job.source) !== job.text || !translated) return;
    const scroll = document.querySelector('#item-scroller');
    const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 30;
    let result = job.source.querySelector(':scope > .lt-yt-chat-result');
    if (result && result.dataset.original === job.text &&
        result.dataset.target === settings.targetLang) return;
    if (!result) {
      result = make('span');
      result.className = 'lt-yt-text lt-yt-chat-result notranslate';
      // 放进消息正文，避开聊天模板外层的 flex 布局，也保留付费留言原来的底色。
      job.source.append(result);
    }
    T.showResult(result, job.source, translated, settings.targetLang);
    T.applyResultStyle(result, settings, 'chat');
    result.dataset.original = job.text;
    result.dataset.target = settings.targetLang;
    // 页面重绘若移除了译文，下次扫描可以用缓存恢复；排队期间仍防止重复加入。
    seen.delete(job.source);
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
    translatedCount++;
  }

  async function pump() {
    if (processing || phase !== 'ready' || !queue.length) return;
    processing = true;
    const run = generation;
    const signal = controller?.signal;
    try {
      while (isCurrent(run) && active() && phase === 'ready' && queue.length) {
        const job = queue.shift();
        if (job.generation !== run || !T.visible(job.source) || readText(job.source) !== job.text) { dropped++; continue; }
        try {
          let source = language(settings.sourceLang);
          if (source === 'auto') {
            const detected = await detector.detect(job.text, { signal });
            if (!isCurrent(run) || signal?.aborted) return;
            source = detected[0]?.detectedLanguage;
            if (!source || source === 'und' || detected[0].confidence < .25) continue;
          }
          if (source === language(settings.targetLang)) continue;
          const key = JSON.stringify([source, language(settings.targetLang), job.text]);
          let text = cache.get(key);
          if (text === undefined) {
            const translator = await getTranslator(source, false, signal, run);
            text = await translator.translate(job.text, { signal });
            if (!isCurrent(run) || signal?.aborted) return;
            T.remember(cache, key, text, 500);
          }
          append(job, text, run);
        } catch (err) {
          if (!isCurrent(run) || signal?.aborted) return;
          seen.delete(job.source);
          phase = 'waiting';
          error = err?.message || '本地翻译失败，请点击准备按钮重试';
          queue.length = 0;
        }
      }
    } finally {
      if (isCurrent(run)) { processing = false; publish(); }
    }
  }

  async function loadSettings(autoPrepare = true) {
    const revision = ++settingsRevision;
    const next = await LT.Settings.load();
    if (revision !== settingsRevision) return;
    const nextSignature = JSON.stringify([next.enableChatTranslation, next.sourceLang, next.targetLang]);
    settings = next;
    if (signature !== nextSignature) {
      signature = nextSignature;
      stop({ remove: true });
      pendingLanguage = '';
      translatedCount = dropped = 0;
      cache.clear();
      if (active()) { phase = 'waiting'; publish(); if (autoPrepare) prepareLocal(false); }
    }
    for (const result of document.querySelectorAll('.lt-yt-chat-result')) T.applyResultStyle(result, settings, 'chat');
    scheduleScan();
  }

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) loadSettings().catch(() => {}); });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === LT.MSG.QUERY_CHAT_STATUS) { publish(); return; }
    if (msg?.type !== LT.MSG.PREPARE_CHAT) return;
    if (msg.payload?.videoId && msg.payload.videoId !== new URL(location.href).searchParams.get('v')) {
      reply({ ok: false, error: '聊天页面已切换，请重新打开扩展弹窗' });
      return;
    }
    loadSettings(false).then(() => {
      if (msg.payload?.sourceLang !== settings.sourceLang || msg.payload?.targetLang !== settings.targetLang) {
        return { ok: false, error: '语言设置已变化，请重新点击准备本地翻译' };
      }
      return prepareLocal(true);
    }).then(reply, err => reply({ ok: false, error: err?.message || '聊天页面未能准备本地翻译' }));
    return true;
  });
  const observer = new MutationObserver(records => { if (records.some(record => !T.ownMutation(record))) scheduleScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  loadSettings().catch(() => {});
  window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(scanTimer); stop(); });
})();
