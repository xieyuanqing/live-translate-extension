/**
 * 会话总控：串起「视频元素 → 音频旁路 → Live 翻译 → 字幕层」。
 *
 * 会话约定：**开始翻译前冻结快照**。
 * Prompt、语言、整理结果、元数据在 start() 时算好并固定，之后重连、轮换、
 * 用户改设置都不会影响本场会话——要生效就重开一场。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  const caption = new LT.CaptionLayer();
  let settings = LT.DEFAULTS;

  // 整片字幕（视频 / 回放）：读字幕轨、文字模型翻译、缓存、按播放时间显示。
  // 和直播会话共用字幕层，两者互斥：开始一边就让另一边让位。
  const videoSubs = new LT.VideoSubsController({
    caption,
    getVideo: () => LT.YouTube.video(),
    onStatus: () => pushStatus(),
  });

  const playerControls = new LT.PlayerControls({
    onToggleCaptions: () => {
      if (!LT.YouTube.isWatchPage() || currentVideoId !== LT.YouTube.videoIdFromUrl()) return;
      if (session.phase !== 'idle' || currentMeta?.isLive) setLiveCaptionsVisible(!liveCaptionsVisible);
      else videoSubs.setVisible(!videoSubs.visible);
    },
    onToggleTranslation: () => {
      if (!LT.YouTube.isWatchPage() || currentVideoId !== LT.YouTube.videoIdFromUrl()) return;
      if (session.phase !== 'idle' || currentMeta?.isLive) {
        if (session.phase === 'idle') {
          userStoppedFor = '';
          start('播放器控制栏');
        } else {
          userStoppedFor = currentVideoId;
          stop();
        }
      } else if (videoStartPending || ['reading', 'translating'].includes(videoSubs.status().phase)) {
        cancelVideoSubs();
      } else if (videoSubs.status().phase !== 'ready') {
        startVideoSubs(false);
      }
    },
  });

  const session = {
    phase: 'idle', // idle | starting | running
    conn: '',
    error: '',
    mode: '',
    level: 0,
    startedAt: 0,
    lastOutputAt: 0,
    snapshot: null, // 本场冻结的 Prompt、语言、模型与背景/术语配置
    client: null,
    tap: null,
    stabilizer: null,
    debugLog: LT.LiveLog.NOOP,
  };

  let currentVideoId = '';
  let currentMeta = null;
  let autoStartedFor = '';
  let userStoppedFor = '';
  let liveCaptionsVisible = true; // 仅影响本场直播的字幕显示，不停止音频采集或模型请求
  let gateHint = ''; // applyGate 自己挂上去的提示，条件消失后要由它负责收掉
  let sessionGeneration = 0; // 停止后作废仍在等待播放器 / 音频挂载的启动操作
  let videoStartPending = false; // 读取设置也属于可取消的整片字幕启动过程
  // 本场临时补充（弹窗输入）：只活在内容脚本内存里，不进 storage，
  // 换视频 / 刷新页面即消失。开始翻译时冻结进快照，运行中改动要重开一场才生效。
  let tempContext = '';
  // 预览只活在当前页面；开始时校验全部输入，匹配才复用，换视频作废。
  let liveReview = null;
  let liveReviewRevision = 0;
  let previewCache = null;
  let previewGeneration = 0;
  let previewBusy = false;
  // 同页评论翻译可复用已核对的术语；公开的 review 已脱敏，按视频和目标语言再校验。
  LT.LiveContext.currentReview = () => liveReview;

  // ---------- 与扩展其他部分通信 ----------

  function statusSnapshot() {
    return {
      onWatchPage: LT.YouTube.isWatchPage(),
      phase: session.phase,
      conn: session.conn,
      error: session.error,
      mode: session.mode,
      level: session.level,
      elapsedMs: session.startedAt ? Date.now() - session.startedAt : 0,
      videoId: currentVideoId,
      title: currentMeta ? currentMeta.title : '',
      isLive: currentMeta ? currentMeta.isLive : false,
      modeKnown: (currentMeta?.videoId === currentVideoId) || session.phase !== 'idle',
      liveCaptionsVisible,
      liveProvider: session.snapshot ? session.snapshot.provider : settings.liveProvider,
      contextStatus: session.snapshot ? session.snapshot.contextStatus : '',
      generatedTerms: session.snapshot ? session.snapshot.generatedTerms : 0,
      direction: session.snapshot
        ? `${LT.sourceLabel(session.snapshot.sourceLang)} → ${LT.targetLabel(
            session.snapshot.targetLang
          )}`
        : '',
      usedMetadata: session.snapshot ? !!session.snapshot.metaUsed : false,
      usedTemp: session.snapshot ? !!session.snapshot.tempUsed : false,
      tempContext,
      liveReviewRevision,
      previewBusy,
      video: videoStartPending ? { ...videoSubs.status(), phase: 'reading' } : videoSubs.status(),
    };
  }

  function pushStatus() {
    const snapshot = statusSnapshot();
    playerControls.update(snapshot);
    try {
      chrome.runtime
        .sendMessage({ type: LT.MSG.STATUS, payload: snapshot })
        .catch(() => {});
    } catch (_) {
      // 扩展被重新加载后旧内容脚本会失效，忽略
    }
  }

  // ---------- 连接状态 → 播放器角标 ----------

  function onConnState(raw) {
    session.debugLog.event('connection', { state: raw });
    session.conn = raw;
    if (raw.startsWith('error:')) {
      session.error = raw.slice(6);
      caption.setStatus(`流译：${session.error}`, 'err', false);
    } else {
      session.error = '';
      switch (raw) {
        case 'connecting':
          caption.setStatus('流译：连接中…', 'warn', false);
          break;
        case 'reconnecting':
          caption.setStatus('流译：重连中…', 'warn', false);
          break;
        case 'rotating':
          caption.setStatus('流译：切换连接…', 'warn', true);
          break;
        case 'ready':
          caption.setStatus('流译：翻译中', 'ok', true);
          break;
        case 'stopped':
          caption.setStatus('', 'ok', false);
          break;
        default:
          break;
      }
    }
    gateHint = ''; // 连接状态换了，让 applyGate 下一拍重新判断要不要挂提示
    pushStatus();
  }

  // ---------- 启停 ----------

  function contextKey(runSettings, meta, notes) {
    // 包含凭据以便配置改变后作废；只在页面内存比较，绝不传到弹窗或日志。
    // 聊天/评论开关、字幕外观和整片场景不影响本场整理，避免无关操作触发重复模型调用。
    const contextProvider = (runSettings.providers || []).find(p => p.id === runSettings.liveContextProviderId)
      || (runSettings.providers || []).find(p => p.id === runSettings.subsProviderId) || runSettings.providers?.[0];
    const config = [runSettings.liveProvider, runSettings.apiKeys, runSettings.baseUrl,
      runSettings.qwenApiKey, runSettings.qwenWorkspaceHost, runSettings.sourceLang, runSettings.targetLang,
      runSettings.useMetadata, runSettings.metadataLimit, runSettings.manualContext, runSettings.generateLiveContext,
      runSettings.liveContextTimeoutSeconds, contextProvider];
    return JSON.stringify([LT.YouTube.videoIdFromUrl(), config, meta, notes]);
  }

  async function prepareContext(runSettings, meta, notes, debugLog = LT.LiveLog.NOOP) {
    const provider = runSettings.liveProvider === 'qwen' ? 'qwen' : 'gemini';
    const metadataText = runSettings.useMetadata ? LT.Prompt.formatMetadata(meta, runSettings.metadataLimit) : '';
    const userNotes = [runSettings.manualContext, notes].filter(Boolean).join('\n');
    const key = contextKey(runSettings, meta, notes);
    const cached = previewCache;
    previewCache = null; // 同一份预览只用于接下来的一次启动。
    if (cached && cached.key === key) {
      const result = cached.result;
      debugLog.event('context_result', { result: result.review.contextStatus, reusedPreview: true, ms: 0, terms: Object.keys(result.generated?.phrases || {}).length });
      return result;
    }
    let generated = null;
    let contextStatus = !runSettings.generateLiveContext ? 'disabled' : !metadataText ? 'no_metadata' : 'unavailable';
    let contextError = '';
    let generatorModel = '';
    let generatorProvider = '';
    const contextTimeoutSeconds = LT.LiveContext.timeoutMs(runSettings) / 1000;
    const generatorRequest = metadataText && runSettings.generateLiveContext ? LT.LiveContext.buildRequest(runSettings, metadataText, userNotes) : null;
    debugLog.event('context_start', { enabled: !!generatorRequest, metadataChars: metadataText.length,
      providerId: runSettings.liveContextProviderId, timeoutSeconds: contextTimeoutSeconds });
    if (generatorRequest) {
      const started = Date.now();
      try {
        const config = LT.TextModel?.resolve?.(runSettings, runSettings.liveContextProviderId);
        generatorModel = config?.model || '';
        generatorProvider = config?.name || '';
        generated = LT.LiveContext.preserveIdentity(await LT.LiveContext.generate(runSettings, metadataText, userNotes), meta);
        contextStatus = generated ? 'generated' : 'unavailable';
      } catch (err) {
        contextStatus = 'error';
        contextError = err && err.message || '背景整理失败';
        console.warn('[流译] 本场背景整理失败，继续使用基础配置', contextError);
      }
      debugLog.event('context_result', { result: contextStatus, ms: Date.now() - started,
        model: generatorModel, timeoutSeconds: contextTimeoutSeconds, terms: Object.keys(generated?.phrases || {}).length, error: contextError });
    }
    const prompt = LT.Prompt.build({ sourceLang: runSettings.sourceLang, targetLang: runSettings.targetLang,
      metadataText: generated ? '' : metadataText, generatedContext: LT.LiveContext.asPromptContext(generated),
      manualContext: runSettings.manualContext, tempContext: notes });
    const review = {
      provider, videoId: meta?.videoId || LT.YouTube.videoIdFromUrl(), sourceLang: runSettings.sourceLang,
      targetLang: runSettings.targetLang, contextStatus, contextError,
      generated, generatorRequest, generatorModel, generatorProvider, contextTimeoutSeconds, prompt: provider === 'gemini' ? prompt : '',
      translation: provider === 'qwen' ? LT.LiveContext.translationConfig(runSettings.targetLang, generated?.phrases || {}) : null,
    };
    return { key, metadataText, prompt, generated, review };
  }

  function saveReview(review, runSettings, phase) {
    liveReview = LT.LiveLog.safe({ ...review, phase }, LT.LiveLog.secretsFrom(runSettings), Infinity);
    liveReviewRevision++;
  }

  function invalidatePreview() {
    previewGeneration++;
    previewBusy = false;
    previewCache = null;
    if (liveReview?.phase === 'preview') {
      liveReview = { ...liveReview, stale: true };
      liveReviewRevision++;
    }
  }

  async function previewLiveContext() {
    if (!LT.YouTube.isWatchPage()) throw new Error('请先打开 YouTube 视频页');
    if (session.phase !== 'idle') throw new Error('请先停止翻译，再生成开播预览');
    const generation = ++previewGeneration;
    const videoId = LT.YouTube.videoIdFromUrl();
    const notes = tempContext;
    const isCurrent = () => generation === previewGeneration && videoId === LT.YouTube.videoIdFromUrl() && session.phase === 'idle';
    previewBusy = true;
    previewCache = null;
    pushStatus();
    try {
      const runSettings = await LT.Settings.load();
      if (!isCurrent()) throw new Error('预览已取消');
      let meta = currentMeta;
      if (runSettings.useMetadata && (!meta || meta.videoId !== videoId)) meta = await LT.YouTube.waitForMeta({ videoId, tries: 4 });
      if (!isCurrent()) throw new Error('预览已取消');
      const result = await prepareContext(runSettings, meta, notes);
      if (!isCurrent()) throw new Error('预览已取消');
      if (meta) currentMeta = meta;
      previewCache = { key: result.key, result };
      saveReview(result.review, runSettings, 'preview');
      return { ok: true, review: liveReview };
    } finally {
      if (generation === previewGeneration) { previewBusy = false; pushStatus(); }
    }
  }

  async function resolveRunInputs({ reason, videoId, runTempContext }, isCurrent) {
    const runSettings = await LT.Settings.load();
    if (!isCurrent()) return null;
    settings = runSettings;

    const liveProvider = runSettings.liveProvider === 'qwen' ? 'qwen' : 'gemini';
    session.debugLog = LT.LiveLog.open({
      level: runSettings.debugLogLevel,
      provider: liveProvider,
      model: liveProvider === 'qwen' ? LT.QWEN_MODEL : LT.MODEL,
      videoId,
      sourceLang: runSettings.sourceLang,
      targetLang: runSettings.targetLang,
      reason,
    }, runSettings) || LT.LiveLog.NOOP;
    const key = liveProvider === 'qwen' ? runSettings.qwenApiKey : LT.Settings.pickKey(runSettings);
    if (!key) {
      onConnState(`error:未配置${liveProvider === 'qwen' ? '千问' : ' Gemini'} API Key，请在扩展设置里填写`);
      session.debugLog.finish('missing_key').catch(() => {});
      session.debugLog = LT.LiveLog.NOOP;
      session.phase = 'idle';
      return null;
    }

    const video = await LT.YouTube.waitForVideo();
    if (!isCurrent()) return null;
    const player = LT.YouTube.player();
    if (!player || !video) {
      onConnState('error:没有找到播放器');
      session.debugLog.finish('no_player').catch(() => {});
      session.debugLog = LT.LiveLog.NOOP;
      session.phase = 'idle';
      return null;
    }
    caption.mount(player);
    caption.applySettings(settings);
    caption.clear();
    return { runSettings, liveProvider, key, video, reason, videoId, runTempContext };
  }

  async function freezeSnapshot(run, isCurrent) {
    const { runSettings, liveProvider, videoId, reason, runTempContext } = run;
    let meta = currentMeta;
    if (runSettings.useMetadata && (!meta || meta.videoId !== videoId)) {
      meta = await LT.YouTube.waitForMeta({ videoId: LT.YouTube.videoIdFromUrl(), tries: 4 });
      if (!isCurrent()) return null;
      if (meta) currentMeta = meta;
    }
    // 等待期间设置页可能发来新配置，本场继续使用启动时读取的那一份。
    session.debugLog.details({ metadata: meta, manualContext: runSettings.manualContext, tempContext: runTempContext });
    if (runSettings.generateLiveContext && runSettings.useMetadata && meta) {
      caption.setStatus(`流译：整理本场背景和术语…（最多等待 ${LT.LiveContext.timeoutMs(runSettings) / 1000} 秒）`, 'warn', false);
    }
    const { metadataText, prompt, generated, review } = await prepareContext(runSettings, meta, runTempContext, session.debugLog);
    if (!isCurrent()) return null;
    saveReview(review, runSettings, 'session');
    session.debugLog.details({ generatedContext: generated, generatorRequest: review.generatorRequest,
      generatorModel: review.generatorModel, generatorProvider: review.generatorProvider,
      contextTimeoutSeconds: review.contextTimeoutSeconds, contextStatus: review.contextStatus, contextError: review.contextError,
      prompt: liveProvider === 'gemini' ? prompt : '', qwenPhrases: liveProvider === 'qwen' && generated ? generated.phrases : {}, translation: review.translation });
    session.debugLog.event('session_config', { provider: liveProvider, generatedTerms: generated ? Object.keys(generated.phrases).length : 0 });
    session.snapshot = {
      prompt: liveProvider === 'gemini' ? prompt : '',
      provider: liveProvider,
      generatedTerms: generated ? Object.keys(generated.phrases).length : 0,
      contextStatus: review.contextStatus,
      sourceLang: runSettings.sourceLang,
      targetLang: runSettings.targetLang,
      metaUsed: liveProvider === 'gemini' && !!metadataText,
      tempUsed: liveProvider === 'gemini' && !!runTempContext,
      videoId: LT.YouTube.videoIdFromUrl(),
    };
    console.info(
      `[流译] 开始（${reason}）｜${liveProvider === 'qwen' ? '千问 3.8' : 'Gemini 3.5'}｜${LT.sourceLabel(
        runSettings.sourceLang
      )} → ${LT.targetLabel(runSettings.targetLang)}｜元数据 ${
        metadataText ? liveProvider === 'qwen' ? '仅供术语整理' : '已注入' : '未使用'
      }｜术语整理 ${generated ? `${Object.keys(generated.phrases).length} 条` : '未生成'}｜临时补充 ${runTempContext
        ? liveProvider === 'qwen' ? generated ? '已供词表整理' : '未应用' : '已注入' : '未使用'}`
    );
    return { prompt, generated };
  }

  function buildStabilizer({ runSettings, liveProvider, video }, isCurrent) {
    return new LT.SubtitleStabilizer({
      idleCommitMs: runSettings.stabIdleMs,
      maxCurrentChars: runSettings.stabMaxChars,
      detectOverlap: liveProvider !== 'qwen',
      suppressRepeats: liveProvider !== 'qwen',
      onRender: (current, committed) => {
        if (!isCurrent()) return;
        if (committed.length) session.debugLog.event('caption_commit', { lines: committed, videoMs: Math.round(video.currentTime * 1000) }, true);
        caption.pushCommitted(committed);
        caption.setCurrent(current);
        caption.render();
      },
    });
  }

  function buildClient({ runSettings, liveProvider, key, video }, { prompt, generated }, isCurrent) {
    const Client = liveProvider === 'qwen' ? LT.QwenLiveClient : LT.GeminiLiveClient;
    return new Client({
      ...(liveProvider === 'qwen'
        ? {
            workspaceHost: runSettings.qwenWorkspaceHost,
            apiKey: key,
            phrases: generated ? generated.phrases : {},
          }
        : {
            keyProvider: () => LT.Settings.pickKey(runSettings),
            baseUrl: runSettings.baseUrl,
            prompt,
            echoTargetLanguage: runSettings.echoTargetLanguage,
            rotateAfterMs: runSettings.rotateSeconds * 1000,
          }),
      targetLang: runSettings.targetLang,
      listener: {
        onState: (state) => { if (isCurrent()) onConnState(state); },
        onInputText: (t, info = {}) => {
          if (isCurrent()) session.debugLog.event('source_text', { text: t, ...info, videoMs: Math.round(video.currentTime * 1000) }, true);
          // 仅译文模式不记原文；双语和仅原文都要，显示由字幕层按模式过滤
          if (!isCurrent() || settings.captionDisplayMode === 'translationOnly') return;
          caption.setSource(t);
          caption.render();
        },
        onOutputText: (t, info = {}) => {
          if (!isCurrent()) return;
          session.debugLog.event('translation_fragment', { text: t, ...info, videoMs: Math.round(video.currentTime * 1000) }, true);
          session.lastOutputAt = Date.now();
          session.stabilizer.onFragment(t);
        },
        onOutputComplete: (info) => {
          if (!isCurrent()) return;
          session.debugLog.event('translation_done', { ...info, videoMs: Math.round(video.currentTime * 1000) }, true);
          session.stabilizer.flush();
        },
        onDiagnostic: (type, value) => { if (isCurrent()) session.debugLog.event(type, value); },
      },
    });
  }

  async function start(reason) {
    if (session.phase !== 'idle') return;
    videoStartPending = false;
    videoSubs.deactivate(); // 实时翻译和整片字幕共用字幕层，开始实时翻译时整片字幕让位
    const generation = ++sessionGeneration;
    previewGeneration++;
    previewBusy = false;
    const videoId = LT.YouTube.videoIdFromUrl();
    const runTempContext = tempContext;
    const isCurrent = () => generation === sessionGeneration && videoId === LT.YouTube.videoIdFromUrl();
    session.phase = 'starting';
    session.error = '';
    pushStatus();

    try {
      const run = await resolveRunInputs({ reason, videoId, runTempContext }, isCurrent);
      if (!run || !isCurrent()) return;

      const frozen = await freezeSnapshot(run, isCurrent);
      if (!frozen || !isCurrent()) return;

      session.stabilizer = buildStabilizer(run, isCurrent);

      session.client = buildClient(run, frozen, isCurrent);

      // ---- 音频旁路 ----
      const tap = new LT.AudioTap({
        onChunk: (u8) => {
          if (!isCurrent() || !session.client) return;
          session.debugLog.audioChunk(u8.byteLength);
          session.client.feedChunk(u8);
        },
        onLevel: (pct) => {
          if (!isCurrent()) return;
          session.level = pct;
        },
      });
      session.tap = tap;
      const mode = await tap.attach(run.video);
      if (!isCurrent()) { tap.detach(); return; }
      session.mode = mode;
      session.debugLog.event('audio_capture', { mode });
      session.startedAt = Date.now();
      session.lastOutputAt = 0;
      session.phase = 'running';
      session.client.start();
      applyGate();
      pushStatus();
    } catch (err) {
      if (!isCurrent()) return;
      console.error('[流译] 启动失败', err);
      session.debugLog.event('start_error', { message: err && err.message ? err.message : String(err) });
      // 先把半成品拆干净，再报错——client.stop() 会发 'stopped'，
      // 顺序反了的话报错提示会立刻被它清掉，用户什么都看不到。
      teardown('start_error');
      session.phase = 'idle';
      onConnState(`error:${err && err.message ? err.message : '启动失败'}`);
      pushStatus();
    } finally {
      if (generation === sessionGeneration) {
        if (session.phase === 'starting') session.phase = 'idle';
        pushStatus();
      }
    }
  }

  function teardown(reason = 'stopped') {
    if (session.client) session.debugLog.event('audio_sent', {
      sentChunks: session.client.chunksSent || 0, queuedChunks: session.client.queue?.length || 0,
      droppedChunks: session.client.droppedChunks || 0,
    });
    if (session.tap) session.tap.detach();
    if (session.client) session.client.stop();
    if (session.stabilizer) session.stabilizer.reset();
    session.debugLog.finish(reason).catch(() => {});
    session.tap = null;
    session.client = null;
    session.stabilizer = null;
    session.debugLog = LT.LiveLog.NOOP;
    session.mode = '';
    session.level = 0;
    session.startedAt = 0;
    session.snapshot = null;
    gateHint = '';
  }

  async function stop(reason = 'user') {
    sessionGeneration++;
    previewGeneration++;
    previewBusy = false;
    videoStartPending = false;
    if (session.phase === 'idle') return;
    teardown(reason);
    session.phase = 'idle';
    session.conn = 'stopped';
    session.error = '';
    caption.clear();
    caption.setVisible(true); // 广告期间停止的话字幕层还藏着，整片字幕接着用得先亮回来
    caption.setStatus('', 'ok', false);
    pushStatus();
  }

  function setLiveCaptionsVisible(visible) {
    liveCaptionsVisible = !!visible;
    caption.setVisible(liveCaptionsVisible && !(settings.pauseOnAd && LT.YouTube.adShowing()));
    pushStatus();
  }

  // ---------- 广告 / 暂停 / 静音时不发音频 ----------

  function applyGate() {
    if (session.phase !== 'running' || !session.tap) return;
    const video = LT.YouTube.video();
    const ad = settings.pauseOnAd && LT.YouTube.adShowing();
    const paused = !video || video.paused;
    const silent = !!video && (video.muted || video.volume === 0);
    session.tap.setGate(!ad && !paused && !silent);
    if (ad || paused || silent) session.level = 0;
    caption.setVisible(liveCaptionsVisible && !ad);

    // 连接本身有问题时以连接状态为准，不抢它的提示位
    if (session.conn !== 'ready' && session.conn !== 'rotating') {
      gateHint = '';
      return;
    }

    let hint = '';
    if (ad) hint = '流译：广告中，已暂停';
    else if (silent) hint = '流译：视频已静音，收不到声音';
    else if (paused) hint = '流译：视频暂停中';
    else if (session.startedAt && !session.lastOutputAt && Date.now() - session.startedAt > 25000) {
      // 长时间静音本来就没有输出，是正常的；只在音量条也没动静时才提示
      hint = session.level > 2 ? '流译：等待可翻译的语音…' : '流译：没有检测到声音';
    }

    if (hint === gateHint) return;
    session.debugLog.event('gate', { ad, paused, muted: silent, hint });
    gateHint = hint;
    caption.setStatus(hint, 'warn', false);
  }

  // ---------- 页面生命周期 ----------

  function ensureMounted() {
    if (!LT.YouTube.isWatchPage()) {
      if (caption.mounted) caption.unmount();
      playerControls.unmount();
      return;
    }
    const player = LT.YouTube.player();
    if (player && (!caption.mounted || caption.player !== player)) {
      caption.mount(player);
      caption.applySettings(settings);
      if (session.phase === 'running') applyGate();
    }
    if (player) {
      playerControls.mount(player);
      playerControls.update(statusSnapshot());
    } else playerControls.unmount();
  }

  async function handleVideoChanged() {
    const id = LT.YouTube.videoIdFromUrl();
    if (id === currentVideoId) return;
    currentVideoId = id;
    currentMeta = null;
    liveCaptionsVisible = true;
    tempContext = ''; // 临时补充跟着视频走，换视频即作废
    previewCache = null;
    liveReview = null;
    liveReviewRevision++;
    stop('navigation'); // 同步作废待启动操作，不能在换视频处理中留下异步空档
    videoSubs.onVideoChanged(id, settings); // 作废旧任务；有缓存会按设置自动加载
    ensureMounted();
    if (!id) {
      pushStatus();
      return;
    }
    const meta = await LT.YouTube.waitForMeta({ videoId: id, tries: 8 });
    if (id !== currentVideoId || id !== LT.YouTube.videoIdFromUrl()) return;
    currentMeta = meta;
    pushStatus();
    maybeAutoStart();
  }

  function maybeAutoStart() {
    if (session.phase !== 'idle') return;
    if (previewBusy) return;
    if (!settings.autoStartLive) return;
    if (!currentVideoId || currentVideoId === userStoppedFor) return;
    if (currentVideoId === autoStartedFor) return;
    if (!currentMeta || !currentMeta.isLive) return;
    if (settings.liveProvider === 'qwen' ? !settings.qwenApiKey : LT.Settings.keyList(settings).length === 0) return;
    autoStartedFor = currentVideoId;
    start('自动·直播');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case LT.MSG.QUERY_STATUS:
        sendResponse(statusSnapshot());
        return true;
      case LT.MSG.QUERY_LIVE_CONTEXT:
        sendResponse({ review: liveReview, pending: previewBusy });
        return true;
      case LT.MSG.PREVIEW_LIVE_CONTEXT:
        previewLiveContext().then(sendResponse, err => sendResponse({ ok: false, error: err && err.message || '预览失败' }));
        return true;
      case LT.MSG.START:
        userStoppedFor = '';
        start('手动');
        break;
      case LT.MSG.STOP:
        userStoppedFor = currentVideoId;
        stop();
        break;
      case LT.MSG.TOGGLE:
        if (session.phase === 'idle') {
          userStoppedFor = '';
          start('快捷键');
        } else {
          userStoppedFor = currentVideoId;
          stop();
        }
        break;
      case LT.MSG.SETTINGS_CHANGED:
        LT.Settings.load().then((s) => {
          if (contextKey(settings, currentMeta, tempContext) !== contextKey(s, currentMeta, tempContext)) invalidatePreview();
          settings = s;
          caption.applySettings(s);
          videoSubs.updateSettings(s);
          pushStatus();
        });
        break;
      case LT.MSG.SET_TEMP_CONTEXT:
        if (tempContext !== String(msg.payload || '').trim()) invalidatePreview();
        tempContext = String(msg.payload || '').trim();
        sendResponse({ ok: true });
        break;
      case LT.MSG.VS_START:
        startVideoSubs(!!(msg.payload && msg.payload.force));
        break;
      case LT.MSG.VS_CANCEL:
        cancelVideoSubs();
        break;
      case LT.MSG.VS_SET_VISIBLE:
        videoSubs.setVisible(!!msg.payload);
        break;
      case LT.MSG.LIVE_SET_VISIBLE:
        if (session.phase !== 'idle') setLiveCaptionsVisible(!!msg.payload);
        break;
      case LT.MSG.VS_CLEAR:
        if (videoStartPending) sessionGeneration++;
        videoStartPending = false;
        videoSubs.clearCache().then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: err && err.message })
        );
        return true;
      default:
        break;
    }
    return undefined;
  });

  function cancelVideoSubs() {
    if (videoStartPending) sessionGeneration++;
    videoStartPending = false;
    videoSubs.cancel();
    pushStatus();
  }

  /** 整片字幕：读取当前设置作为本次任务的快照；正在实时翻译就先停掉。 */
  async function startVideoSubs(force) {
    if (videoStartPending || ['reading', 'translating'].includes(videoSubs.status().phase)) return;
    const videoId = LT.YouTube.videoIdFromUrl();
    if (!videoId || !LT.YouTube.isWatchPage() || (currentMeta?.videoId === videoId && currentMeta.isLive)) return;
    stop('switch_to_subtitles');
    const generation = ++sessionGeneration;
    const isCurrent = () => generation === sessionGeneration && videoId === LT.YouTube.videoIdFromUrl();
    const runMeta = currentMeta?.videoId === videoId ? currentMeta : null;
    const runTempContext = currentVideoId === videoId ? tempContext : '';
    videoStartPending = true;
    pushStatus();
    try {
      const runSettings = await LT.Settings.load();
      if (!isCurrent()) return;
      settings = runSettings;
      videoStartPending = false;
      await videoSubs.start({ settings: runSettings, meta: runMeta, tempContext: runTempContext, force });
    } catch (err) {
      if (!isCurrent()) return;
      videoSubs.phase = 'error';
      videoSubs.error = `读取设置失败：${err && err.message ? err.message : '请重新加载扩展并刷新页面'}`;
    } finally {
      if (isCurrent()) {
        videoStartPending = false;
        pushStatus();
      }
    }
  }

  window.addEventListener('pagehide', () => {
    stop('pagehide');
    videoSubs.cancel();
  });

  LT.YouTube.onMetaPush((meta) => {
    if (meta && meta.videoId === currentVideoId && meta.videoId === LT.YouTube.videoIdFromUrl()) {
      currentMeta = meta;
      pushStatus();
      if (meta.videoId === LT.YouTube.videoIdFromUrl()) maybeAutoStart();
    }
  });

  LT.YouTube.onNavigate(() => {
    handleVideoChanged();
  });

  setInterval(() => {
    ensureMounted();
    applyGate();
  }, 500);
  // 整片字幕按播放时间挑当前条；200ms 足够跟上一般字幕的节奏
  setInterval(() => videoSubs.tick(), 200);

  (async () => {
    settings = await LT.Settings.load();
    ensureMounted();
    await handleVideoChanged();
  })();

  /**
   * 诊断：只走读轨与解析，不调用模型、不写缓存、不改任务状态。
   * 真机验证第一步在内容脚本的控制台跑 await LT.debug.probeCaptions()，把返回对象整个复制下来。
   */
  async function probeCaptions() {
    const t0 = Date.now();
    const clock = LT.fmtClock || ((ms) => String(ms));
    const out = { videoId: LT.YouTube.videoIdFromUrl(), sourceLang: settings.sourceLang };
    const info = await LT.YouTube.captionTracks();
    if (!info) return { ...out, error: '播放器没就绪或页面桥没响应' };
    Object.assign(out, {
      tracks: info.tracks.map((t) => ({ languageCode: t.languageCode, kind: t.kind, vssId: t.vssId, name: t.name })),
      defaultIndex: info.defaultIndex,
      selected: info.selected,
      hasPot: info.hasPot,
    });
    const track = LT.YouTube.chooseTrack(info.tracks, settings.sourceLang, info.defaultIndex, info.selected);
    if (!track) return { ...out, error: info.tracks.length ? '没有匹配「听什么」的字幕轨' : '这个视频没有字幕轨' };
    out.chosen = { languageCode: track.languageCode, kind: track.kind, vssId: track.vssId, name: track.name };
    const res = await LT.YouTube.fetchCaptions({
      videoId: info.videoId,
      languageCode: track.languageCode,
      kind: track.kind,
      vssId: track.vssId,
      baseUrl: track.baseUrl,
    });
    out.ms = Date.now() - t0;
    if (!res) return { ...out, error: '页面桥 25 秒内没有回复' };
    Object.assign(out, { source: res.source, error: res.error, tried: res.tried });
    if (res.text) {
      const isAsr = track.kind === 'asr';
      out.format = LT.Json3.detectFormat(res.text);
      out.bytes = res.text.length;
      const events = LT.Json3.parse(res.text);
      const units = LT.Segmenter.build(events, { isAsr, lang: track.languageCode });
      out.eventCount = events.length;
      out.unitCount = units.length;
      out.sampleUnits = units.slice(0, 8).map((u) => `${clock(u.start)}–${clock(u.end)} ${u.text}`);
    }
    return out;
  }

  // 方便在控制台手动调试：LT.debug.start() / LT.debug.stop() / LT.debug.videoSubs / LT.debug.probeCaptions()
  LT.debug = { start, stop, session, status: statusSnapshot, videoSubs, startVideoSubs, probeCaptions, previewLiveContext };
})();
