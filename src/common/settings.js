/** chrome.storage.local 读写封装，所有上下文（SW / 内容脚本 / 设置页）共用。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const KEY = 'settings';
  const REQUEST_PATHS = ['auto', 'direct', 'relay'];
  const CONNECTION_FIELDS = ['apiKeys', 'baseUrl', 'liveProvider', 'qwenWorkspaceHost', 'qwenApiKey',
    'ttsProvider', 'ttsMicrosoftJaVoice', 'ttsMicrosoftEnVoice', 'ttsGeminiApiKey', 'ttsGeminiReuseKey',
    'ttsGeminiBaseUrl', 'ttsGeminiModel', 'ttsGeminiVoice'];
  const BINDINGS = { text: ['subsProviderId', 'selectionProviderId', 'commentProviderId', 'liveContextProviderId', 'chatProviderId'],
    live: ['liveProviderId'], speech: ['ttsProviderId'] };
  const TEXT_PURPOSES = [
    ['subsProviderId', 'subsModel'], ['selectionProviderId', 'selectionModel'],
    ['commentProviderId', 'commentModel'], ['liveContextProviderId', 'liveContextModel'],
  ];
  // 0.2.0 开发期改过一次字段，旧字段不再读取，顺手从存储里清掉
  const RETIRED = ['textApiType', 'textBaseUrl', 'textApiKey', 'textModel', 'textConcurrency', 'textRequestPath', 'showSource'];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 0 是合法值时不能写 `|| 默认值`
  const numOr = (v, dflt) => (v === '' || v == null || !Number.isFinite(Number(v)) ? dflt : Number(v));
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback);
  const newProviderId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** 请求头名称不区分大小写；兼容旧设置中没有 headers 的情况。 */
  function normalizeHeaders(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw)
      .filter(([name, value]) => name.trim() && typeof value === 'string' && value.trim())
      .map(([name, value]) => [name.trim().toLowerCase(), value.trim()]));
  }

  function headerError(headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) return '请求头名称只能使用英文字母、数字和 HTTP 允许的符号';
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) return '请求头值不能包含换行或非 Latin-1 字符';
    }
    return '';
  }

  /** 统一提供商配置，按类型保留实际客户端支持的字段。 */
  function normalizeProvider(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const apiType = p.apiType === 'openai' ? 'openai' : 'gemini';
    const baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
    const available = LT.PROVIDER_PRESETS.filter(item => !item.pending);
    // 旧配置按实际协议和地址识别，无法识别的保留为同协议的自定义提供商。
    const preset = available.find(item => item.code === p.preset) ||
      (!p.preset && available.find(item => item.kind === 'text' && item.baseUrl && item.apiType === apiType && item.baseUrl === (baseUrl || LT.TEXT_DEFAULT_BASE[apiType]))) ||
      available.find(item => item.code === 'custom');
    const common = {
      id: String(p.id || '').trim() || newProviderId(),
      name: String(p.name || '').trim(),
      kind: preset.kind,
      preset: preset.code,
      enabled: p.enabled !== false,
      description: String(p.description || '').trim(),
      baseUrl: baseUrl || preset.baseUrl || '',
      apiKey: String(p.apiKey || '').trim(),
      model: preset.kind === 'live' ? preset.model : String(p.model || preset.model || '').trim(),
    };
    if (preset.kind === 'live') return { ...common,
      workspaceHost: String(p.workspaceHost || '').trim().replace(/^wss?:\/\//i, '').replace(/\/$/, '') };
    if (preset.kind === 'speech') return { ...common,
      reuseKey: p.reuseKey !== false,
      voice: /^[A-Za-z]{2,30}$/.test(p.voice || '') ? p.voice : 'Kore',
      jaVoice: /^ja-JP-[A-Za-z]+Neural$/.test(p.jaVoice || '') ? p.jaVoice : LT.DEFAULTS.ttsMicrosoftJaVoice,
      enVoice: /^en-US-[A-Za-z]+Neural$/.test(p.enVoice || '') ? p.enVoice : LT.DEFAULTS.ttsMicrosoftEnVoice,
      model: common.model.replace(/^models\//, ''),
    };
    return { ...common,
      apiType: preset.code === 'custom' ? apiType : preset.apiType,
      models: [...new Set([...(Array.isArray(p.models) ? p.models : []), common.model]
        .filter(model => typeof model === 'string' && model.trim()).map(model => model.trim().replace(/^models\//, '')))],
      headers: normalizeHeaders(p.headers),
      concurrency: clamp(Number(p.concurrency) || 3, 1, 6),
      requestPath: REQUEST_PATHS.includes(p.requestPath) ? p.requestPath : 'auto',
    };
  }

  function providersFor(settings, kind) {
    return (settings.providers || []).filter(p => (p.kind || 'text') === kind);
  }

  function serviceProvider(settings, kind, id) {
    const selected = id || settings[BINDINGS[kind][0]];
    const provider = providersFor(settings, kind).find(p => p.id === selected);
    if (!provider) throw new Error('所选提供商已删除或类型不匹配，请重新选择');
    return provider;
  }

  /** 只生成运行快照；存储和备份以统一列表为唯一连接配置来源。 */
  function projectConnections(s) {
    const live = serviceProvider(s, 'live');
    const geminiLive = live.preset === 'gemini-live' ? live : providersFor(s, 'live').find(p => p.preset === 'gemini-live' && p.enabled);
    const qwenLive = live.preset === 'qwen-live' ? live : providersFor(s, 'live').find(p => p.preset === 'qwen-live');
    s.liveProvider = live.preset === 'qwen-live' ? 'qwen' : 'gemini';
    s.apiKeys = geminiLive?.apiKey || '';
    s.baseUrl = geminiLive?.baseUrl || LT.DEFAULT_BASE_URL;
    s.qwenApiKey = qwenLive?.apiKey || '';
    s.qwenWorkspaceHost = qwenLive?.workspaceHost || '';
    const speech = serviceProvider(s, 'speech');
    const geminiSpeech = speech.preset === 'gemini-tts' ? speech : providersFor(s, 'speech').find(p => p.preset === 'gemini-tts');
    const microsoftSpeech = speech.preset === 'microsoft-tts' ? speech : providersFor(s, 'speech').find(p => p.preset === 'microsoft-tts');
    s.ttsProvider = speech.preset === 'gemini-tts' ? 'gemini' : 'microsoft';
    s.ttsGeminiApiKey = geminiSpeech?.apiKey || '';
    s.ttsGeminiReuseKey = geminiSpeech?.reuseKey ?? true;
    s.ttsGeminiBaseUrl = geminiSpeech?.baseUrl || LT.DEFAULTS.ttsGeminiBaseUrl;
    s.ttsGeminiModel = geminiSpeech?.model || LT.DEFAULTS.ttsGeminiModel;
    s.ttsGeminiVoice = geminiSpeech?.voice || LT.DEFAULTS.ttsGeminiVoice;
    s.ttsMicrosoftJaVoice = microsoftSpeech?.jaVoice || LT.DEFAULTS.ttsMicrosoftJaVoice;
    s.ttsMicrosoftEnVoice = microsoftSpeech?.enVoice || LT.DEFAULTS.ttsMicrosoftEnVoice;
  }

  /** 收敛范围并补齐新增字段，保留现有接口类型和各用途的选择。 */
  function normalize(raw) {
    const s = Object.assign({}, LT.DEFAULTS, raw || {});
    if (!['system', 'light', 'dark'].includes(s.uiTheme)) s.uiTheme = LT.DEFAULTS.uiTheme;
    for (const k of RETIRED) delete s[k];
    if (!Array.isArray(s.scenes) || s.scenes.length === 0) s.scenes = LT.DEFAULT_SCENES;
    if (!s.scenes.some((x) => x.id === s.sceneId)) s.sceneId = s.scenes[0].id;
    if (!s.baseUrl) s.baseUrl = LT.DEFAULT_BASE_URL;
    if (!LT.LIVE_PROVIDERS.some((p) => p.code === s.liveProvider)) s.liveProvider = 'gemini';
    s.qwenWorkspaceHost = String(s.qwenWorkspaceHost || '').trim().replace(/^wss?:\/\//i, '').replace(/\/$/, '');
    s.qwenApiKey = String(s.qwenApiKey || '').trim();
    s.generateLiveContext = s.generateLiveContext !== false;
    s.enableChatTranslation = s.enableChatTranslation === true;
    s.enableCommentTranslation = s.enableCommentTranslation === true;
    s.ttsProvider = s.ttsProvider === 'gemini' ? 'gemini' : 'microsoft';
    s.ttsGeminiReuseKey = s.ttsGeminiReuseKey !== false;
    s.ttsGeminiApiKey = String(s.ttsGeminiApiKey || '').trim();
    s.ttsGeminiBaseUrl = String(s.ttsGeminiBaseUrl || LT.DEFAULTS.ttsGeminiBaseUrl).trim().replace(/\/+$/, '');
    s.ttsGeminiModel = String(s.ttsGeminiModel || LT.DEFAULTS.ttsGeminiModel).trim().replace(/^models\//, '');
    s.ttsGeminiVoice = /^[A-Za-z]{2,30}$/.test(s.ttsGeminiVoice || '') ? s.ttsGeminiVoice : 'Kore';
    for (const [field, prefix] of [['ttsMicrosoftJaVoice', 'ja-JP'], ['ttsMicrosoftEnVoice', 'en-US']]) {
      if (!new RegExp(`^${prefix}-[A-Za-z]+Neural$`).test(s[field] || '')) s[field] = LT.DEFAULTS[field];
    }
    s.ttsRate = clamp(Number(s.ttsRate) || 1, 0.75, 1.25);
    for (const scope of ['comment', 'chat']) {
      const styleKey = `${scope}TranslationStyle`, colorKey = `${scope}TranslationColor`;
      if (!LT.TEXT_STYLES.some(style => style.code === s[styleKey])) s[styleKey] = LT.DEFAULTS[styleKey];
      s[colorKey] = color(s[colorKey], LT.DEFAULTS[colorKey]);
    }
    s.liveContextTimeoutSeconds = [30, 60, 120].includes(Number(s.liveContextTimeoutSeconds))
      ? Number(s.liveContextTimeoutSeconds) : 60;
    if (!LT.LOG_LEVELS.some((level) => level.code === s.debugLogLevel)) s.debugLogLevel = 'off';
    s.rotateSeconds = clamp(Number(s.rotateSeconds) || 505, 120, 580);
    s.stabIdleMs = clamp(Number(s.stabIdleMs) || 2500, 1000, 6000);
    s.stabMaxChars = clamp(Number(s.stabMaxChars) || 42, 20, 80);
    s.metadataLimit = clamp(numOr(s.metadataLimit, 1200), 0, 6000);
    s.captionLines = clamp(Number(s.captionLines) || 2, 1, 5);
    s.captionScale = clamp(Number(s.captionScale) || 1, 0.6, 2.5);
    s.captionBottom = clamp(Number(s.captionBottom) || 11, 2, 60);
    s.captionOpacity = clamp(Number(s.captionOpacity), 0, 100);
    if (!LT.CAPTION_DISPLAY_MODES.some((m) => m.code === s.captionDisplayMode)) s.captionDisplayMode = 'translationOnly';
    if (s.captionTranslationPosition !== 'below') s.captionTranslationPosition = 'above';
    if (!LT.CAPTION_FONTS.some((f) => f.code === s.captionFont)) s.captionFont = 'player';
    s.captionWeight = clamp(Math.round((Number(s.captionWeight) || 400) / 100) * 100, 300, 700);
    s.captionColor = color(s.captionColor, LT.DEFAULTS.captionColor);
    s.captionSourceColor = color(s.captionSourceColor, LT.DEFAULTS.captionSourceColor);
    s.captionSourceScale = clamp(Number(s.captionSourceScale) || 0.78, 0.6, 1);
    s.subsExtraInstruction = String(s.subsExtraInstruction || '');
    // 旧版独立的直播/朗读连接一次性并入列表，后续只读取列表里的配置。
    const ids = new Set();
    s.providers = (Array.isArray(s.providers) ? s.providers : [])
      .filter((p) => p && typeof p === 'object')
      .map((p) => normalizeProvider(p))
      .filter((p) => !ids.has(p.id) && ids.add(p.id));
    if (s.providers.length === 0) s.providers = LT.DEFAULTS.providers.map((p) => normalizeProvider(p));
    const unified = Number(raw?.providerSchema) >= 2 || raw?.providers?.some(p => p?.kind === 'live' || p?.kind === 'speech');
    const legacy = [
      { id: 'p-live-gemini', preset: 'gemini-live', name: 'Gemini 直播翻译', apiKey: s.apiKeys, baseUrl: s.baseUrl },
      { id: 'p-live-qwen', preset: 'qwen-live', name: '千问直播翻译', apiKey: s.qwenApiKey, workspaceHost: s.qwenWorkspaceHost },
      { id: 'p-speech-microsoft', preset: 'microsoft-tts', name: '微软朗读', jaVoice: s.ttsMicrosoftJaVoice, enVoice: s.ttsMicrosoftEnVoice },
      { id: 'p-speech-gemini', preset: 'gemini-tts', name: 'Gemini 朗读', apiKey: s.ttsGeminiApiKey, reuseKey: s.ttsGeminiReuseKey,
        baseUrl: s.ttsGeminiBaseUrl, model: s.ttsGeminiModel, voice: s.ttsGeminiVoice },
    ];
    const append = value => {
      const provider = normalizeProvider(value);
      if (s.providers.some(p => p.id === provider.id)) provider.id = newProviderId();
      s.providers.push(provider);
      return provider.id;
    };
    if (!unified) {
      const migrated = legacy.map(append);
      s.liveProviderId = migrated[s.liveProvider === 'qwen' ? 1 : 0];
      s.ttsProviderId = migrated[s.ttsProvider === 'gemini' ? 3 : 2];
    }
    for (const kind of ['text', 'live', 'speech']) {
      if (!providersFor(s, kind).length) append(kind === 'text' ? LT.DEFAULTS.providers[0] : legacy[kind === 'live' ? 0 : 2]);
      const list = providersFor(s, kind);
      const first = (list.find(p => p.enabled) || list[0]).id;
      for (const key of BINDINGS[kind]) {
        if (key === 'chatProviderId' && s.chatProviderId === 'local') continue;
        if (!s[key] && kind === 'text') s[key] = s.subsProviderId;
        if (!list.some(p => p.id === s[key])) s[key] = first;
      }
    }
    for (const [providerField, modelField] of TEXT_PURPOSES) {
      const oldModel = providersFor(s, 'text').find(p => p.id === s[providerField])?.model || '';
      s[modelField] = String(raw?.providerSchema === 3 ? s[modelField] || '' : oldModel).trim().replace(/^models\//, '');
    }
    for (const provider of providersFor(s, 'text')) delete provider.model;
    if (s.chatProviderId !== 'local') {
      const chat = providersFor(s, 'text').find(p => p.id === s.chatProviderId);
      if (!chat) s.chatProviderId = 'local';
    }
    s.chatModel = String(s.chatModel || '').trim().replace(/^models\//, '');
    s.providerSchema = 3;
    projectConnections(s);
    return s;
  }

  function persistable(settings) {
    const copy = normalize(settings);
    for (const field of CONNECTION_FIELDS) delete copy[field];
    for (const provider of copy.providers) if (provider.kind === 'text') delete provider.model;
    return copy;
  }

  LT.Settings = {
    normalize,
    normalizeProvider,
    normalizeHeaders,
    headerError,
    providersFor,
    serviceProvider,
    persistable,

    /** HTTP 接口的 Chrome 主机权限不包含端口；设置授权、后台检查必须使用同一模式。 */
    hostPattern(value) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址需使用 https://；本地网关也可使用 http://');
      return `${url.protocol}//${url.hostname}/*`;
    },

    async load() {
      const box = await chrome.storage.local.get(KEY);
      return normalize(box[KEY]);
    },

    /** 局部更新，返回合并后的完整设置。 */
    async save(patch) {
      const current = await this.load();
      const next = normalize(Object.assign({}, current, patch));
      await chrome.storage.local.set({ [KEY]: persistable(next) });
      return next;
    },

    /** 逗号分隔的多 key，每次新建连接时随机取一个。 */
    keyList(settings) {
      return String(settings.apiKeys || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    },

    pickKey(settings) {
      const list = this.keyList(settings);
      if (list.length === 0) return '';
      return list[Math.floor(Math.random() * list.length)];
    },

    scene(settings) {
      return (
        settings.scenes.find((s) => s.id === settings.sceneId) || settings.scenes[0]
      );
    },

    /** 新建一套接口配置（带新 id），patch 里的字段覆盖默认值。 */
    newProvider(patch) {
      if (LT.PROVIDER_PRESETS.some(item => item.code === patch?.preset && item.pending)) throw new Error('该提供商尚未接入');
      const provider = normalizeProvider(Object.assign({ apiType: 'openai' }, patch || {}, { id: newProviderId() }));
      if (provider.kind === 'text') delete provider.model;
      return provider;
    },

    /** 整片字幕选用的接口配置；传 id 可取指定的一套，找不到就退到第一套。 */
    provider(settings, id) {
      const list = providersFor(settings, 'text');
      const want = id || settings.subsProviderId;
      if (id && !list.some(p => p.id === id)) throw new Error('所选文字提供商已删除或类型不匹配，请重新选择');
      return list.find((p) => p.id === want) || list[0];
    },
  };
})();
