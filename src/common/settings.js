/** chrome.storage.local 读写封装，所有上下文（SW / 内容脚本 / 设置页）共用。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const KEY = 'settings';
  const REQUEST_PATHS = ['auto', 'direct', 'relay'];
  // 0.2.0 开发期改过一次字段，旧字段不再读取，顺手从存储里清掉
  const RETIRED = ['textApiType', 'textBaseUrl', 'textApiKey', 'textModel', 'textConcurrency', 'textRequestPath', 'showSource'];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback);
  const newProviderId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** 一套文字模型接口配置的范围收敛；缺 id 时补一个。 */
  function normalizeProvider(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
      id: String(p.id || '').trim() || newProviderId(),
      name: String(p.name || '').trim(),
      apiType: p.apiType === 'openai' ? 'openai' : 'gemini',
      baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(p.apiKey || '').trim(),
      model: String(p.model || '').trim(),
      concurrency: clamp(Number(p.concurrency) || 3, 1, 6),
      requestPath: REQUEST_PATHS.includes(p.requestPath) ? p.requestPath : 'auto',
    };
  }

  /** 只做范围收敛，不做结构迁移——个人自用工具，字段变了直接恢复默认。 */
  function normalize(raw) {
    const s = Object.assign({}, LT.DEFAULTS, raw || {});
    for (const k of RETIRED) delete s[k];
    if (!Array.isArray(s.scenes) || s.scenes.length === 0) s.scenes = LT.DEFAULT_SCENES;
    if (!s.scenes.some((x) => x.id === s.sceneId)) s.sceneId = s.scenes[0].id;
    if (!s.baseUrl) s.baseUrl = LT.DEFAULT_BASE_URL;
    s.rotateSeconds = clamp(Number(s.rotateSeconds) || 505, 120, 580);
    s.stabIdleMs = clamp(Number(s.stabIdleMs) || 2500, 1000, 6000);
    s.stabMaxChars = clamp(Number(s.stabMaxChars) || 42, 20, 80);
    s.metadataLimit = clamp(Number(s.metadataLimit) || 1200, 0, 6000);
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
    // 文字模型接口配置：至少一套、id 不重复、选用的那套必须存在
    const ids = new Set();
    s.providers = (Array.isArray(s.providers) ? s.providers : [])
      .filter((p) => p && typeof p === 'object')
      .map((p) => normalizeProvider(p))
      .filter((p) => !ids.has(p.id) && ids.add(p.id));
    if (s.providers.length === 0) s.providers = LT.DEFAULTS.providers.map((p) => normalizeProvider(p));
    if (!s.providers.some((p) => p.id === s.subsProviderId)) s.subsProviderId = s.providers[0].id;
    return s;
  }

  LT.Settings = {
    normalize,
    normalizeProvider,

    async load() {
      const box = await chrome.storage.local.get(KEY);
      return normalize(box[KEY]);
    },

    /** 局部更新，返回合并后的完整设置。 */
    async save(patch) {
      const current = await this.load();
      const next = normalize(Object.assign({}, current, patch));
      await chrome.storage.local.set({ [KEY]: next });
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
      return normalizeProvider(Object.assign({}, patch || {}, { id: newProviderId() }));
    },

    /** 整片字幕选用的接口配置；传 id 可取指定的一套，找不到就退到第一套。 */
    provider(settings, id) {
      const list =
        Array.isArray(settings.providers) && settings.providers.length ? settings.providers : LT.DEFAULTS.providers;
      const want = id || settings.subsProviderId;
      return list.find((p) => p.id === want) || list[0];
    },
  };
})();
