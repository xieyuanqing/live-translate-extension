/** YouTube 评论按需翻译：单条/当前可见内容，独立文字接口、取消与页面内缓存。 */
(() => {
  const LT = globalThis.LT;
  const T = LT.YouTubeText;
  const sources = () => [...document.querySelectorAll('#comments #content-text')]
    .filter(node => !node.closest('.lt-yt-text'));
  let settings = LT.DEFAULTS;
  let settingsRevision = 0;
  let signature = '';
  let generation = 0;
  let videoId = '';
  let scanTimer = null;
  let toolbar = null;
  let processing = false;
  let error = '';
  let chat = null;
  let chatQueryAt = 0;
  const entries = new Map();
  const cache = new Map();
  const queue = [];
  const controllers = new Set();

  const make = (tag, text = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const active = () => settings.enableCommentTranslation && LT.YouTube.isWatchPage();
  const isCurrent = run => run === generation && videoId === LT.YouTube.videoIdFromUrl();
  const currentText = node => T.readText(node);
  const safeError = (err, snapshot = settings) => String(LT.LiveLog.safe(err?.message || '评论翻译失败', LT.LiveLog.secretsFrom(snapshot), 400));
  const pending = () => [...entries.values()].filter(entry => entry.pending).length;

  function status() {
    return { comments: { enabled: settings.enableCommentTranslation, busy: processing || pending() > 0,
      pending: pending(), translated: [...entries.values()].filter(entry => entry.translated).length, error }, chat };
  }

  function refreshToolbar() {
    if (!toolbar) return;
    toolbar.visible.disabled = !active();
    toolbar.cancel.disabled = !processing && !pending();
    toolbar.state.textContent = error || (pending() ? `正在翻译 ${pending()} 条…` : '选择单条评论，或翻译当前可见内容');
  }

  function reset({ remove = false } = {}) {
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    queue.length = 0;
    processing = false;
    error = '';
    for (const entry of entries.values()) {
      entry.pending = false;
      entry.button.disabled = false;
      entry.button.textContent = entry.translated ? '重新翻译' : '翻译';
      entry.state.textContent = '';
      if (remove) entry.host.remove();
    }
    if (remove) {
      entries.clear();
      toolbar?.host.remove();
      toolbar = null;
    }
    refreshToolbar();
  }

  function mountEntry(source) {
    const original = currentText(source);
    if (!original || !T.hasWords(T.readText(source, { includeImages: false }))) return null;
    let entry = entries.get(source);
    if (entry && entry.original === original && entry.host.isConnected) {
      T.applySourceColor(entry.host, source);
      return entry;
    }
    if (entry) entry.host.remove();
    const host = make('div');
    host.className = 'lt-yt-text lt-yt-comment';
    T.applySourceColor(host, source);
    const actions = make('div');
    actions.className = 'lt-yt-text-actions';
    const button = make('button', '翻译');
    button.type = 'button';
    const toggle = make('button', '收起译文');
    toggle.type = 'button';
    toggle.hidden = true;
    toggle.setAttribute('aria-expanded', 'true');
    const state = make('span');
    state.setAttribute('role', 'status');
    const translated = make('span');
    translated.className = 'lt-yt-text-result notranslate';
    translated.hidden = true;
    actions.append(button, toggle, state);
    host.append(translated, actions);
    // YouTube 会限制 #expander 的高度，译文必须在它外面，否则长评论/回复会裁掉译文。
    const anchor = source.closest('ytd-text-inline-expander, ytd-expander, #expander') || source;
    anchor.after(host);
    entry = { source, host, button, toggle, state, result: translated, original, pending: false, translated: '' };
    entries.set(source, entry);
    button.addEventListener('click', () => enqueue([entry], { force: !!entry.translated }));
    toggle.addEventListener('click', () => {
      translated.hidden = !translated.hidden;
      toggle.textContent = translated.hidden ? '显示译文' : '收起译文';
      toggle.setAttribute('aria-expanded', String(!translated.hidden));
    });
    return entry;
  }

  function scan() {
    scanTimer = null;
    if (!active()) return;
    const box = document.querySelector('#comments');
    if (!box) return;
    if (!toolbar?.host.isConnected) {
      const host = make('div');
      host.className = 'lt-yt-text lt-yt-comment-toolbar';
      const visible = make('button', '翻译当前可见评论');
      const cancel = make('button', '停止评论翻译');
      const state = make('span');
      visible.type = cancel.type = 'button';
      state.setAttribute('role', 'status');
      host.append(visible, cancel, state);
      box.prepend(host);
      toolbar = { host, visible, cancel, state };
      visible.addEventListener('click', translateVisible);
      cancel.addEventListener('click', () => reset());
    }
    for (const [source, entry] of entries) if (!source.isConnected) { entry.host.remove(); entries.delete(source); }
    for (const source of sources()) mountEntry(source);
    refreshToolbar();
  }

  function scheduleScan() {
    if (active() && !scanTimer) scanTimer = setTimeout(scan, 150);
  }

  function translateVisible() {
    if (!active()) return { ok: false, error: '请先开启评论翻译' };
    scan();
    const selected = sources().filter(T.visible).map(mountEntry).filter(Boolean);
    enqueue(selected);
    return { ok: true, count: selected.length };
  }

  function enqueue(selected, { force = false } = {}) {
    if (!active()) return;
    const snapshot = LT.Settings.normalize(JSON.parse(JSON.stringify(settings)));
    for (const entry of selected) {
      if (entry.pending || (!force && entry.translated) || !entry.source.isConnected) continue;
      if (entry.original.length > 6000) { entry.state.textContent = '这条评论超过 6000 字，第一版暂不支持'; continue; }
      entry.pending = true;
      entry.button.disabled = true;
      entry.state.textContent = '等待翻译…';
      queue.push({ entry, snapshot, force, generation });
    }
    error = '';
    refreshToolbar();
    pump();
  }

  function parentText(entry) {
    const thread = entry.source.closest('ytd-comment-thread-renderer');
    const first = thread?.querySelector('#content-text');
    return first && first !== entry.source ? currentText(first).slice(0, 3000) : '';
  }

  async function pump() {
    if (processing || !queue.length) return;
    processing = true;
    const run = generation;
    try {
      while (queue.length && isCurrent(run) && active()) {
        const batch = [];
        let chars = 0;
        while (queue.length && batch.length < 8 && (chars < 6000 || !batch.length)) {
          if (batch.length && chars + queue[0].entry.original.length > 6000) break;
          const job = queue.shift();
          if (job.generation !== run || !job.entry.source.isConnected) continue;
          batch.push(job);
          chars += job.entry.original.length;
        }
        if (!batch.length) continue;
        const snapshot = batch[0].snapshot;
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const config = LT.TextModel.resolve(snapshot, snapshot.commentProviderId);
          if (!config.key || !config.model) throw new Error('请在「聊天与评论」选择接口，并在「接口」配置 Key 和模型名');
          const meta = snapshot.useMetadata ? await LT.YouTube.requestMeta() : null;
          if (!isCurrent(run) || controller.signal.aborted) return;
          const review = LT.LiveContext.currentReview?.();
          const phrases = review && review.videoId === videoId && !review.stale && review.targetLang === snapshot.targetLang
            ? review.generated?.phrases || {} : {};
          const system = T.commentPrompt(snapshot, snapshot.useMetadata ? LT.Prompt.formatMetadata(meta, snapshot.metadataLimit) : '', phrases);
          const todo = [];
          for (const job of batch) {
            job.key = JSON.stringify([config.id, config.apiType, config.baseUrl, config.model, system, job.entry.original, parentText(job.entry)]);
            if (!job.force && cache.has(job.key)) apply(job, cache.get(job.key), run);
            else todo.push(job);
          }
          if (todo.length) {
            const input = todo.map((job, i) => ({ id: i + 1, text: job.entry.original, parent: parentText(job.entry) }));
            for (const job of todo) job.entry.state.textContent = '翻译中…';
            const out = await LT.TextModel.translate({ config, system, user: JSON.stringify(input), signal: controller.signal });
            if (!isCurrent(run) || controller.signal.aborted) return;
            const translated = T.parseComments(out.text, input);
            for (let i = 0; i < todo.length; i++) {
              const text = translated.get(i + 1);
              T.remember(cache, todo[i].key, text);
              apply(todo[i], text, run);
            }
          }
        } catch (err) {
          if (!isCurrent(run)) return;
          error = safeError(err, snapshot);
          for (const job of batch) {
            if (!job.entry.source.isConnected) continue;
            job.entry.state.textContent = error;
            job.entry.button.textContent = '重试';
          }
          // 单次批量翻译遇到错误就停下来，不自动重复请求或继续消耗后续批次额度。
          for (const job of queue.splice(0)) {
            job.entry.pending = false;
            job.entry.button.disabled = false;
            job.entry.state.textContent = '已停止，请解决接口问题后重试';
          }
        } finally {
          controllers.delete(controller);
          if (run === generation) for (const job of batch) { job.entry.pending = false; job.entry.button.disabled = false; }
          refreshToolbar();
        }
      }
    } finally {
      if (run === generation) { processing = false; refreshToolbar(); }
    }
  }

  function apply(job, translated, run) {
    const entry = job.entry;
    if (!isCurrent(run) || entries.get(entry.source) !== entry || !entry.host.isConnected ||
        !entry.source.isConnected || currentText(entry.source) !== entry.original) return;
    entry.translated = translated;
    T.showResult(entry.result, entry.source, translated, job.snapshot.targetLang);
    T.applyResultStyle(entry.result, settings, 'comment');
    entry.toggle.hidden = false;
    entry.toggle.textContent = '收起译文';
    entry.toggle.setAttribute('aria-expanded', 'true');
    entry.state.textContent = '';
    entry.button.textContent = '重新翻译';
  }

  async function loadSettings() {
    const revision = ++settingsRevision;
    const next = await LT.Settings.load();
    if (revision !== settingsRevision) return;
    const provider = LT.Settings.provider(next, next.commentProviderId);
    // 复用的多个直播 Key 在请求时随机选；比较完整列表，避免每次读取都误判设置变化。
    const reusedKeys = provider.apiType === 'gemini' && !provider.apiKey ? LT.Settings.keyList(next) : [];
    const nextSignature = JSON.stringify([next.enableCommentTranslation, next.sourceLang, next.targetLang,
      provider, reusedKeys, next.manualContext, next.useMetadata, next.metadataLimit]);
    if (settings.enableChatTranslation !== next.enableChatTranslation) { chat = null; chatQueryAt = 0; }
    settings = next;
    if (signature !== nextSignature) { signature = nextSignature; reset({ remove: true }); }
    for (const entry of entries.values()) T.applyResultStyle(entry.result, settings, 'comment');
    scheduleScan();
  }

  function navigate() {
    const nextId = LT.YouTube.videoIdFromUrl();
    if (nextId === videoId) return;
    videoId = nextId;
    chat = null;
    chatQueryAt = 0;
    reset({ remove: true });
    cache.clear();
    scheduleScan();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === LT.MSG.QUERY_TEXT_STATUS) {
      if (settings.enableChatTranslation && (!chat || chat.phase === 'off') && Date.now() - chatQueryAt > 5000) {
        chatQueryAt = Date.now();
        chrome.runtime.sendMessage({ type: LT.MSG.QUERY_CHAT_STATUS }).catch(() => {});
      }
      reply(status());
      return;
    }
    if (msg?.type === LT.MSG.TRANSLATE_VISIBLE_COMMENTS) {
      loadSettings().then(() => reply(translateVisible()), err => reply({ ok: false, error: safeError(err) }));
      return true;
    }
    if (msg?.type === LT.MSG.CANCEL_COMMENT_TRANSLATION) { reset(); reply({ ok: true }); return; }
    if (msg?.type === LT.MSG.CHAT_STATUS && (!msg.payload?.videoId || msg.payload.videoId === videoId)) chat = msg.payload;
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) loadSettings().catch(() => {}); });
  const observer = new MutationObserver(records => { if (records.some(record => !T.ownMutation(record))) scheduleScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // YouTube 深浅色切换只改 html 属性，不一定重绘评论正文；重采样字色，不重新翻译。
  const themeObserver = new MutationObserver(scheduleScan);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'class', 'style'] });
  LT.YouTube.onNavigate(navigate);
  videoId = LT.YouTube.videoIdFromUrl();
  loadSettings().catch(() => {});
  window.addEventListener('pagehide', () => { observer.disconnect(); themeObserver.disconnect(); clearTimeout(scanTimer); reset(); });
})();
