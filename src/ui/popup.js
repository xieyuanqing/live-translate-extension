(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let settings = LT.DEFAULTS;
  let status = null;
  let timer = null;
  let busy = false;
  let settingsSave = Promise.resolve();
  let contextReview = null;
  let contextRevision = -1;
  let contextTabVideoId = '';
  let contextLoading = false;
  let textStatus = null;
  let chatPreparing = false;
  let chatPrepareController = null;
  let chatPrepareMessage = '';
  let vsModelKey = '';

  const CONN_LABEL = {
    '': '未开始',
    connecting: '连接中…',
    reconnecting: '重连中…',
    rotating: '切换连接…',
    ready: '翻译中',
    stopped: '已停止',
  };

  function fillSelect(el, items, value) {
    el.replaceChildren();
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.id || it.code;
      opt.textContent = it.label;
      el.appendChild(opt);
    }
    el.value = value;
  }

  async function send(type, payload) {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type, payload }, { frameId: 0 });
    } catch (_) {
      return null; // 内容脚本还没注入（比如刚装完扩展没刷新页面）
    }
  }

  async function sendChat(type, payload) {
    if (tabId == null) return null;
    try {
      // 不指定 frameId：只有聊天帧响应此消息，主页面内容脚本会忽略。
      return await chrome.tabs.sendMessage(tabId, { type, payload });
    } catch (_) {
      return null;
    }
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  let bannerClickable = false;
  function banner(text, kind, clickable = false) {
    const el = $('banner');
    bannerClickable = !!text && !!clickable;
    el.classList.toggle('hidden', !text);
    el.classList.toggle('info', kind === 'info');
    el.classList.toggle('clickable', bannerClickable);
    el.textContent = text || '';
  }

  // ---------- 视频翻译区块 ----------

  const asrModels = () => (Array.isArray(settings.videoAsrModels) ? settings.videoAsrModels : []);

  function asrModelLabel() {
    const id = settings.videoAsrModel || '';
    return id ? asrModels().find(m => m.id === id)?.label || id : '后端默认';
  }

  /** 已同步模型清单且会走 VPS 时，弹窗里提供快捷切换。 */
  function canPickAsrModel() {
    return settings.videoTranscriptMode !== 'youtube' && Boolean(String(settings.videoAsrBaseUrl || '').trim()) && asrModels().length > 0;
  }

  function describeVideoSource(withModel = true) {
    const mode = settings.videoTranscriptMode || 'auto';
    const hasUrl = Boolean(String(settings.videoAsrBaseUrl || '').trim());
    const model = withModel ? ` · ${asrModelLabel()}` : '';
    if (mode === 'youtube') return { text: '原文：仅 YouTube 字幕轨', tone: 'neutral' };
    if (mode === 'vps') {
      return hasUrl
        ? { text: `原文：强制 VPS 转写${model}`, tone: 'ok' }
        : { text: '原文：VPS 未配置地址', tone: 'warn' };
    }
    return hasUrl
      ? { text: `原文：智能优先 · VPS${model}`, tone: 'ok' }
      : { text: '原文：智能优先 · 暂用字幕轨', tone: 'neutral' };
  }

  function renderAsrModelSelect(show) {
    const select = $('vsAsrModel');
    select.classList.toggle('hidden', !show);
    // 每秒刷新状态：内容不变或用户正在操作时不重建，避免下拉框被关掉。
    if (!show || document.activeElement === select) return;
    const current = settings.videoAsrModel || '';
    const key = JSON.stringify([asrModels(), current]);
    if (key === vsModelKey) return;
    vsModelKey = key;
    select.replaceChildren();
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    };
    add('', '后端默认模型');
    for (const m of asrModels()) add(m.id, m.label);
    if (current && !asrModels().some(m => m.id === current)) add(current, `${current}（自定义）`);
    select.value = current;
    select.setAttribute('title', `转写模型：${asrModelLabel()}`);
  }

  function renderHomeOverview() {
    const show = !status || !status.onWatchPage;
    $('homeOverview').classList.toggle('hidden', !show);
    $('coreSectionLabel').classList.toggle('hidden', show);
    $('otherSectionLabel').classList.toggle('hidden', show);
    $('liveCard').classList.toggle('hidden', show);
    if (!show) return;
    const liveReady = settings.liveProvider === 'qwen' ? !!settings.qwenApiKey : LT.Settings.keyList(settings).length > 0;
    const liveName = settings.liveProvider === 'qwen' ? '千问 3.8' : 'Gemini 3.5';
    $('homeLiveDesc').textContent = `${liveName} · ${liveReady ? '已配置' : '待配置接口'}`;
    const src = describeVideoSource();
    $('homeVideoDesc').textContent = src.text;
  }

  function renderVideo() {
    const v = status && status.video;
    const show = !!status && status.onWatchPage && !status.isLive && !!v;
    $('vsBox').classList.toggle('hidden', !show);
    if (!show) return;

    const picker = canPickAsrModel();
    const src = describeVideoSource(!picker);
    $('vsSourcePill').textContent = src.text;
    $('vsSourcePill').setAttribute('data-tone', src.tone);
    renderAsrModelSelect(picker);

    const working = ['downloading', 'transcribing', 'reading', 'translating'].includes(v.phase);
    const pct = v.phase === 'transcribing' || v.phase === 'downloading'
      ? (Number(v.progress) || 0)
      : (v.total ? Math.round((v.done / v.total) * 100) : (Number(v.progress) || 0));
    const target = LT.targetLabel(v.targetLang || settings.targetLang);
    const stale = v.staleConfig || (v.targetLang && v.targetLang !== settings.targetLang);
    let state = '';
    let hint = '';
    let startLabel = '开始视频翻译';
    switch (v.phase) {
      case 'downloading':
        state = v.stage || 'VPS 下载音频中…';
        hint = '正在由云端 VPS 拉取音频并准备首段切片';
        break;
      case 'transcribing':
        state = v.frontierIdx >= 0
          ? `边转边译 · ${v.stage || `${pct}%`} · 可看到 ${fmtClock(v.frontierMs)}`
          : (v.stage || `VPS 转写中${pct ? ` ${pct}%` : '…'}`);
        hint = v.frontierIdx >= 0
          ? '已并行边转边译：当前可正常观看双语字幕，后续段后台继续补全'
          : '云端按段异步转写，首段完成后将立刻翻译上屏';
        break;
      case 'reading':
        state = '读取原文中…';
        break;
      case 'translating':
        state = `翻译中 ${pct}%` + (v.frontierIdx >= 0 ? ` · 可看到 ${fmtClock(v.frontierMs)}` : ' · 正在翻译当前位置');
        hint = '步骤 2：边看边译，拖动进度条会优先翻译当前位置';
        break;
      case 'ready':
        state = `${v.fromCache ? '已就绪（缓存）' : '已就绪'} · ${v.trackLabel || '原文'} → ${target}`;
        hint = stale
          ? '设置已变化，按新设置翻译请点「重新翻译」'
          : v.saveError ? '缓存未保存' : '';
        break;
      case 'partial':
        state = `已译 ${v.done}/${v.total} 块` + (v.failed ? `（${v.failed} 块失败）` : '');
        startLabel = '继续翻译';
        hint = stale
          ? `当前缓存译成${target}，设置已变化；可点「重新翻译」应用新设置`
          : '';
        break;
      case 'error':
        state = '出错';
        startLabel = '重试';
        hint = v.error || '';
        break;
      default:
        if (v.hasCache) {
          state = v.cachedComplete ? '已有缓存' : '已有部分缓存';
          startLabel = v.cachedComplete ? '加载缓存字幕' : '继续翻译';
        } else {
          state = '未翻译';
        }
        break;
    }
    $('vsState').textContent = state;
    $('vsProgress').style.width = `${v.phase === 'ready' ? 100 : pct}%`;
    $('vsProgressBar').setAttribute('aria-valuenow', String(v.phase === 'ready' ? 100 : pct));
    $('vsStart').textContent = startLabel;
    $('vsStart').classList.toggle('hidden', working || v.phase === 'ready');
    $('vsStart').disabled = busy;
    $('vsCancel').classList.toggle('hidden', !working);
    const hasTexts = v.done > 0 || v.frontierIdx >= 0 || v.phase === 'translating';
    $('vsToggle').classList.toggle('hidden', !hasTexts);
    $('vsToggle').textContent = v.visible ? '隐藏字幕' : '显示字幕';
    $('vsRetranslate').classList.toggle('hidden', working || !(v.phase === 'ready' || v.phase === 'partial'));
    $('vsHint').textContent = hint;
    $('vsHint').classList.toggle('error', v.phase === 'error' && !!hint);
  }

  function renderStatus() {
    const running = !!status && status.phase !== 'idle';
    const liveFocus = running || !!status?.isLive;
    const nonLiveVideo = !!status?.onWatchPage && !status?.isLive && !running;
    $('liveDetails').classList.toggle('hidden', !running);
    $('liveCard').classList.toggle('compact', nonLiveVideo);
    $('liveCardHead').classList.toggle('hidden', nonLiveVideo);
    $('toggle').classList.toggle('primary', liveFocus);
    $('toggle').classList.toggle('ghost', !liveFocus);
    $('toggle').classList.toggle('secondary', !liveFocus);
    const dot = $('dot');
    // classList.add('') 会抛异常，所以先算出类名再决定加不加
    const dotKind = !status
      ? ''
      : status.error
        ? 'err'
        : status.conn === 'ready'
          ? 'ok'
          : running
            ? 'warn'
            : '';
    dot.className = dotKind ? `dot ${dotKind}` : 'dot';

    $('toggle').textContent = status?.phase === 'starting'
      ? '取消启动'
      : running
        ? '停止实时翻译'
        : nonLiveVideo
          ? '改用直播实时翻译（音频备选）'
          : '开始直播实时翻译';
    $('toggle').classList.toggle('on', running);
    $('toggle').disabled = busy || !status || !status.onWatchPage;
    $('liveToggleCaptions').classList.toggle('hidden', !running);
    $('liveToggleCaptions').textContent = status?.liveCaptionsVisible ? '隐藏直播字幕' : '显示直播字幕';
    $('liveToggleCaptions').disabled = busy;
    $('reloadPage').classList.toggle('hidden', !!status || tabId == null);
    $('restart').classList.toggle('hidden', !running);
    $('restart').disabled = busy;
    $('contextBox').classList.toggle('hidden', !status?.onWatchPage);
    $('previewContext').disabled = busy || running || !!status?.previewBusy;
    if (status?.previewBusy) $('contextState').textContent = '正在整理背景与术语…';

    $('stConn').textContent = status?.error || CONN_LABEL[status?.conn || ''] || status.conn;
    $('stConn').style.color = status?.error ? 'var(--err)' : '';
    $('stDir').textContent = status?.direction || `${LT.sourceLabel(settings.sourceLang)} → ${LT.targetLabel(settings.targetLang)}`;
    const qwen = (status?.liveProvider || settings.liveProvider) === 'qwen';
    $('stContext').textContent = status?.contextStatus === 'generated'
      ? `${qwen ? '词表' : 'AI 背景'} · ${status.generatedTerms || 0} 组术语`
      : status?.phase === 'starting' ? '准备中…'
      : status?.contextStatus === 'error' ? '整理失败'
      : qwen ? '无自动词表' : '基础规则';
    $('stTime').textContent = fmtTime(status?.elapsedMs);
    $('level').style.width = `${running ? status.level : 0}%`;

    renderHomeOverview();
    renderVideo();

    if (!status) {
      $('videoTitle').textContent = tabId == null ? '打开一个 YouTube 直播或视频' : '当前页面尚未连接';
      $('videoMeta').textContent = tabId == null ? '也可在任意网页选中文字右键使用「流译」' : '安装或更新插件后，刷新页面即可恢复';
      $('tempContext').disabled = true;
      $('tempHint').textContent = '';
      $('hint').textContent = '';
      banner('', '');
      return;
    }
    if (!status.onWatchPage) {
      $('videoTitle').textContent = '当前不是 YouTube 视频页';
      $('videoMeta').textContent = '打开一个视频或直播即可开始翻译';
    } else {
      $('videoTitle').textContent = status.title || '（正在读取视频信息…）';
      $('videoMeta').textContent = [
        status.isLive ? '直播中' : '点播视频',
        status.usedMetadata ? '已注入标题简介' : '',
        status.usedTemp ? '已注入临时补充' : '',
        status.mode === 'script-processor' ? '兼容音频模式' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    }

    // 临时补充输入框：状态里存的是内容脚本的当前值，没在打字时才回填，避免打断输入
    const ta = $('tempContext');
    const temp = status.tempContext || '';
    if (document.activeElement !== ta && ta.value !== temp) ta.value = temp;
    ta.disabled = !status.onWatchPage;
    $('tempHint').textContent = running ? '修改后点「应用当前设置并重新开始」生效' : '';

    const liveKey = settings.liveProvider === 'qwen' ? settings.qwenApiKey : LT.Settings.keyList(settings).length;
    if (!liveKey && !LT.Settings.provider(settings).apiKey) {
      const cached = !!status.video?.hasCache && !status.isLive;
      banner(
        cached ? '缓存可直接观看；翻译新内容请点击前往设置填入 API Key →' : '还没有配置 API Key，点击前往设置 →',
        cached ? 'info' : '',
        true
      );
    } else if (running && status.phase === 'running') {
      banner('', '');
    } else if (settings.autoStartLive && status.onWatchPage && status.isLive) {
      banner('直播页会自动开始翻译。', 'info');
    } else {
      banner('', '');
    }

    $('hint').textContent = running || !status.onWatchPage
      ? ''
      : '快捷键 Alt+T · 开始 / 停止音频实时翻译';
  }

  async function refresh() {
    status = await send(LT.MSG.QUERY_STATUS);
    textStatus = await send(LT.MSG.QUERY_TEXT_STATUS);
    renderStatus();
    renderTextStatus();
    if ($('contextBox').open) await refreshContext();
  }

  function renderTextStatus() {
    const show = !!status?.onWatchPage;
    $('textBox').classList.toggle('hidden', !show);
    $('chatTranslationToggle').checked = !!settings.enableChatTranslation;
    $('commentTranslationToggle').checked = !!settings.enableCommentTranslation;
    const comments = textStatus?.comments;
    const chat = textStatus?.chat;
    const hasChatContext = !status || !!status.isLive || !!chat;
    $('chatToggleRow').classList.toggle('hidden', !hasChatContext);
    $('commentActions').classList.toggle('hidden', !settings.enableCommentTranslation);
    $('translateVisibleComments').disabled = !show || !settings.enableCommentTranslation || !!comments?.busy;
    $('cancelCommentTranslation').disabled = !comments?.busy;
    $('cancelCommentTranslation').classList.toggle('hidden', !comments?.busy);
    const cloudChat = settings.chatProviderId !== 'local';
    const chatLabels = cloudChat
      ? { off: '已关闭', waiting: '连接云端接口中', preparing: '连接中', ready: '云端翻译中', error: '云端接口出错' }
      : { off: '已关闭', waiting: '请点击「准备本地翻译」', preparing: '下载语言包中', ready: '本地翻译中', error: '不可用' };
    $('prepareChatTranslation').textContent = cloudChat ? '重试云端翻译' : '准备本地翻译';
    $('chatPrepareActions').classList.toggle('hidden', !hasChatContext || !settings.enableChatTranslation ||
      (chat?.phase === 'ready' && !chatPreparing && !chatPrepareMessage));
    $('prepareChatTranslation').classList.toggle('hidden', !settings.enableChatTranslation || chat?.phase === 'ready');
    $('prepareChatTranslation').disabled = !show || chatPreparing || chat?.phase === 'preparing';
    $('chatPrepareProgress').textContent = chatPrepareMessage;
    const lines = [];
    if (hasChatContext && settings.enableChatTranslation) lines.push(chat
      ? `弹幕：${chat.error || chat.downloadProgress || chatLabels[chat.phase] || chat.phase}${chat.translated ? ` · 已译 ${chat.translated} 条` : ''}`
      : '弹幕：等待聊天室加载');
    if (settings.enableCommentTranslation && (comments?.error || comments?.busy || comments?.translated)) {
      lines.push(comments.error || (comments.busy ? `评论：翻译中（剩余 ${comments.pending || 0} 条）` : `评论：已译 ${comments.translated} 条`));
    }
    $('textState').textContent = lines.join('\n');
  }

  function cancelChatPreparation() {
    chatPrepareController?.abort();
    chatPrepareController = null;
    chatPreparing = false;
    chatPrepareMessage = '';
    renderTextStatus();
  }

  $('prepareChatTranslation').addEventListener('click', async () => {
    if (chatPreparing || !settings.enableChatTranslation || !status?.onWatchPage) return;
    if (settings.chatProviderId !== 'local') {
      chatPreparing = true;
      renderTextStatus();
      try {
        await settingsSave;
        const result = await sendChat(LT.MSG.PREPARE_CHAT, { videoId: status.videoId,
          sourceLang: settings.sourceLang, targetLang: settings.targetLang });
        if (!result?.ok) throw new Error(result?.error || '聊天页面未响应，请刷新 YouTube 页面');
        await refresh();
      } catch (err) { chatPrepareMessage = err?.message || '云端翻译重试失败'; }
      finally { chatPreparing = false; renderTextStatus(); }
      return;
    }
    const sourceLang = $('sourceLang').value;
    const targetLang = $('targetLang').value;
    const videoId = status.videoId;
    const requestedSource = sourceLang === 'auto' ? (textStatus?.chat?.pendingLanguage || 'ja') : sourceLang;
    const source = requestedSource === 'zh-Hans' ? 'zh' : requestedSource;
    const target = targetLang === 'zh-Hans' ? 'zh' : targetLang;
    const controller = new AbortController();
    chatPrepareController = controller;
    chatPreparing = true;
    chatPrepareMessage = '正在检查本地语言包…';
    renderTextStatus();

    const progress = new Map();
    const monitor = name => session => session.addEventListener('downloadprogress', event => {
      if (controller.signal.aborted) return;
      const value = Number(event.loaded);
      progress.set(name, Number.isFinite(value) ? `${name} ${Math.round(value * 100)}%` : `${name}下载中`);
      chatPrepareMessage = [...progress.values()].join(' · ');
      renderTextStatus();
    });
    let popupError = '';
    try {
      // Chrome 首次下载要求 create() 所在页面已有用户激活；两个 create 都在这次点击中发起。
      const needsDetector = sourceLang === 'auto';
      const needsTranslator = source !== target;
      if ((needsDetector && !globalThis.LanguageDetector?.create) ||
          (needsTranslator && !globalThis.Translator?.create)) {
        popupError = '扩展弹窗不支持 Chrome 本地模型 API';
      } else {
        const tasks = [];
        if (needsDetector) tasks.push(globalThis.LanguageDetector.create({ signal: controller.signal,
          monitor: monitor('语言检测') }).then(instance => instance.destroy()));
        if (needsTranslator) tasks.push(globalThis.Translator.create({ sourceLanguage: source, targetLanguage: target,
          signal: controller.signal, monitor: monitor(`${source} → ${target}`) }).then(instance => instance.destroy()));
        const results = await Promise.allSettled(tasks);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
    } catch (err) {
      popupError = err?.message || '扩展弹窗准备本地模型失败';
    }
    if (controller.signal.aborted || chatPrepareController !== controller) return;
    chatPrepareMessage = popupError ? '尝试由聊天页面准备模型…' : '语言包已准备，正在连接聊天…';
    renderTextStatus();
    try {
      await settingsSave;
      if (controller.signal.aborted || chatPrepareController !== controller) return;
      if (status?.videoId !== videoId) throw new Error('视频已切换，请在当前页面重新准备');
      if (settings.sourceLang !== sourceLang || settings.targetLang !== targetLang) throw new Error('语言设置尚未保存，请重试');
      const result = await sendChat(LT.MSG.PREPARE_CHAT, { videoId, sourceLang, targetLang });
      if (!result?.ok) throw new Error(result?.error || '聊天页面未响应，请刷新 YouTube 页面后重试');
      chatPrepareMessage = '';
      await refresh();
    } catch (err) {
      if (controller.signal.aborted || chatPrepareController !== controller) return;
      chatPrepareMessage = popupError ? `${popupError}；${err?.message || '聊天页面准备失败'}` : err?.message || '准备失败，请重试';
    } finally {
      if (chatPrepareController === controller) {
        chatPrepareController = null;
        chatPreparing = false;
        renderTextStatus();
      }
    }
  });

  for (const [id, key] of [['chatTranslationToggle', 'enableChatTranslation'], ['commentTranslationToggle', 'enableCommentTranslation']]) {
    $(id).addEventListener('change', event => {
      const checked = event.target.checked;
      if (key === 'enableChatTranslation' && !checked) cancelChatPreparation();
      settingsSave = settingsSave.then(async () => {
        settings = await LT.Settings.save({ [key]: checked });
        await send(LT.MSG.SETTINGS_CHANGED);
        await refresh();
      }).catch(() => { $('textState').textContent = '保存失败，请重新打开弹窗后重试。'; });
    });
  }
  $('translateVisibleComments').addEventListener('click', async () => {
    await settingsSave;
    const result = await send(LT.MSG.TRANSLATE_VISIBLE_COMMENTS);
    await refresh();
    if (!result?.ok) $('textState').textContent = result?.error || '页面未响应，请刷新 YouTube 后重试。';
    else if (!result.count) $('textState').textContent = '当前没有可见的文字评论，请滚到评论区或展开回复。';
  });
  $('cancelCommentTranslation').addEventListener('click', async () => {
    await send(LT.MSG.CANCEL_COMMENT_TRANSLATION);
    await refresh();
  });
  const openOptionsHash = (hash) => () => chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/options.html#${hash}`) });
  $('openTextOptions').addEventListener('click', openOptionsHash('text'));
  $('openLiveOptions').addEventListener('click', openOptionsHash('live'));
  $('openVideoOptions').addEventListener('click', openOptionsHash('video'));
  $('homeOpenLive').addEventListener('click', openOptionsHash('live'));
  $('homeOpenVideo').addEventListener('click', openOptionsHash('video'));
  $('homeOpenText').addEventListener('click', openOptionsHash('text'));
  $('homeOpenSpeech').addEventListener('click', openOptionsHash('speech'));

  function renderContext() {
    const r = contextReview;
    $('contextContent').classList.toggle('hidden', !r);
    $('copyContext').disabled = !r;
    if (!r) {
      $('contextState').textContent = status?.previewBusy ? '正在整理背景与术语…' : '';
      return;
    }
    const labels = { generated: '已生成背景和术语', disabled: '开播整理已关闭', no_metadata: '没有启用或读到页面资料', unavailable: '文字模型配置不完整，未生成', error: '整理失败，使用基础配置' };
    const statusLabel = r.reusedCache && r.contextStatus === 'generated' ? '已复用缓存背景和术语' : (labels[r.contextStatus] || r.contextStatus);
    $('contextState').textContent = (r.phase === 'preview' ? '开播预览 · 尚未开始翻译 · ' : '本场启动时冻结 · ') +
      statusLabel + (r.generatorModel ? ` · 整理模型：${r.generatorModel}` : '') +
      (r.contextTimeoutSeconds ? ` · 等待上限 ${r.contextTimeoutSeconds} 秒` : '') + (r.contextError ? `：${r.contextError}` : '');
    if (r.stale) $('contextState').textContent = '输入已变化，这份预览已失效；请重新生成，或开始时重新整理。';
    $('contextEffect').textContent = r.provider === 'qwen'
      ? '千问只接收下方术语映射和目标语言；背景说明、翻译偏好不发送给千问。'
      : '下方是本场 Gemini 使用的完整提示词。运行中修改设置需重新开始才生效。';
    const terms = Object.entries(r.generated?.phrases || {});
    $('generatedContext').value = [r.generated?.background || '没有生成背景', '', '候选术语：', ...terms.map(([a, b]) => `${a} → ${b}`), ...(terms.length ? [] : ['无'])].join('\n');
    $('effectivePromptLabel').textContent = r.provider === 'qwen' ? '发送给千问的目标语言与术语配置' : '发送给 Gemini 的完整提示词';
    $('effectivePrompt').value = r.provider === 'qwen' ? JSON.stringify({ type: 'session.update', session: { output_modalities: ['text'], translation: r.translation } }, null, 2) : r.prompt;
    $('generatorPrompt').value = r.generatorRequest ? `【系统提示词】\n${r.generatorRequest.system}\n\n【页面资料与补充】\n${r.generatorRequest.user}` : '本次未启用开播整理，没有整理模型输入。';
  }

  async function refreshContext(force = false) {
    if (!status || contextLoading) return;
    if (!force && contextRevision === status.liveReviewRevision && contextTabVideoId === status.videoId) return;
    contextLoading = true;
    const videoId = status.videoId;
    const revision = status.liveReviewRevision;
    try {
      const result = await send(LT.MSG.QUERY_LIVE_CONTEXT);
      if (videoId !== status?.videoId) return;
      contextReview = result?.review || null;
      contextRevision = revision;
      contextTabVideoId = videoId;
      renderContext();
    } finally { contextLoading = false; }
  }

  $('contextBox').addEventListener('toggle', () => { if ($('contextBox').open) refreshContext(true); });
  $('previewContext').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    renderStatus();
    $('contextState').textContent = '正在生成开播预览…';
    try {
      await settingsSave;
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      const result = await send(LT.MSG.PREVIEW_LIVE_CONTEXT);
      if (!result?.ok) throw new Error(result?.error || '页面没有响应，请刷新 YouTube 后重试');
      await refresh();
      await refreshContext(true);
    } catch (err) { $('contextState').textContent = err.message || '生成失败'; }
    finally { busy = false; renderStatus(); }
  });
  $('copyContext').addEventListener('click', async () => {
    if (!contextReview) return;
    try {
      await navigator.clipboard.writeText([$('contextState').textContent, $('contextEffect').textContent,
        $('generatedContext').value, $('effectivePrompt').value, $('generatorPrompt').value].join('\n\n'));
      $('contextState').textContent = '已复制背景、术语、整理输入和本场翻译配置。';
    } catch (_) { $('contextState').textContent = '复制失败，请在文本框中全选复制。'; }
  });

  async function init() {
    $('version').textContent = chrome.runtime.getManifest().version;
    settings = await LT.Settings.load();
    fillSelect($('sourceLang'), LT.SOURCE_LANGS, settings.sourceLang);
    fillSelect($('targetLang'), LT.TARGET_LANGS, settings.targetLang);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && /^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
      tabId = tab.id;
    }
    await refresh();
    timer = setInterval(refresh, 1000);
  }

  async function changeSession(restart = false) {
    if (busy) return;
    const context = $('tempContext').value;
    busy = true;
    renderStatus();
    try {
      await settingsSave;
      const running = !!status && status.phase !== 'idle';
      if (running) await send(LT.MSG.STOP);
      if (!running || restart) {
        await send(LT.MSG.SET_TEMP_CONTEXT, context);
        await send(LT.MSG.START);
      }
      await refresh();
    } finally {
      busy = false;
      renderStatus();
    }
  }
  $('toggle').addEventListener('click', () => changeSession());
  $('liveToggleCaptions').addEventListener('click', async () => {
    if (busy || !status || status.phase === 'idle') return;
    busy = true;
    renderStatus();
    try {
      await send(LT.MSG.LIVE_SET_VISIBLE, !status.liveCaptionsVisible);
      await refresh();
    } finally {
      busy = false;
      renderStatus();
    }
  });
  $('restart').addEventListener('click', () => changeSession(true));
  $('reloadPage').addEventListener('click', async () => {
    if (tabId == null) return;
    await chrome.tabs.reload(tabId);
    window.close();
  });

  // ---------- 整片字幕操作 ----------

  async function videoAction(fn) {
    if (busy) return;
    busy = true;
    renderStatus();
    try {
      await settingsSave;
      await fn();
      await refresh();
    } finally {
      busy = false;
      renderStatus();
    }
  }
  $('vsStart').addEventListener('click', () =>
    videoAction(async () => {
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      await send(LT.MSG.VS_START, { force: false });
    })
  );
  $('vsRetranslate').addEventListener('click', () => {
    if (!confirm('重新翻译会丢弃这份译文并重新调用模型，消耗额度。继续？')) return;
    videoAction(async () => {
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      await send(LT.MSG.VS_START, { force: true });
    });
  });
  $('vsCancel').addEventListener('click', () => videoAction(() => send(LT.MSG.VS_CANCEL)));
  $('vsAsrModel').addEventListener('change', (e) => {
    const value = e.target.value;
    settingsSave = settingsSave.then(async () => {
      settings = await LT.Settings.save({ videoAsrModel: value });
      await send(LT.MSG.SETTINGS_CHANGED);
      renderStatus();
    }).catch(() => banner('转写模型保存失败，请重新打开弹窗后重试。', ''));
  });
  $('vsToggle').addEventListener('click', () =>
    videoAction(() => send(LT.MSG.VS_SET_VISIBLE, !(status && status.video && status.video.visible)))
  );

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('banner').addEventListener('click', () => {
    if (bannerClickable) chrome.runtime.openOptionsPage();
  });
  $('toggleTheme').addEventListener('click', () => {
    const uiTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    const themeRevision = LT.UITheme.apply(uiTheme);
    settingsSave = settingsSave.then(async () => {
      settings = await LT.Settings.save({ uiTheme });
      LT.UITheme.settle(themeRevision, settings.uiTheme);
    }).catch(() => {
      LT.UITheme.settle(themeRevision, settings.uiTheme);
      banner('主题保存失败，请重新打开弹窗后重试。', '');
    });
  });

  for (const [id, key] of [
    ['sourceLang', 'sourceLang'],
    ['targetLang', 'targetLang'],
  ]) {
    $(id).addEventListener('change', (e) => {
      cancelChatPreparation();
      const value = e.target.value;
      settingsSave = settingsSave.then(async () => {
        settings = await LT.Settings.save({ [key]: value });
        await send(LT.MSG.SETTINGS_CHANGED);
        renderStatus();
      }).catch(() => banner('设置保存失败，请重新打开弹窗后重试。', ''));
    });
  }

  // 输入直接送到页面内存，避免立即关掉弹窗时防抖任务来不及执行。
  $('tempContext').addEventListener('input', (e) => {
    send(LT.MSG.SET_TEMP_CONTEXT, e.target.value);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settingsSave.then(async () => {
      settings = await LT.Settings.load();
      $('sourceLang').value = settings.sourceLang;
      $('targetLang').value = settings.targetLang;
      renderStatus();
      renderTextStatus();
    }).catch(() => {});
  });

  window.addEventListener('unload', () => { clearInterval(timer); chatPrepareController?.abort(); });
  init();
})();
