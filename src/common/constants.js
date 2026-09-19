/**
 * 全局常量与默认设置。
 *
 * 本扩展不使用打包工具：所有脚本都是普通脚本，统一往 globalThis.LT 上挂东西。
 * - 内容脚本：manifest 按顺序注入，共享同一个隔离世界的全局作用域
 * - Service Worker：importScripts 依次加载
 * - popup / options：<script> 标签依次加载
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  // ---------- Gemini Live Translate 协议常量 ----------
  // 字段层级依赖 Live 协议，改动前先看 docs/development.md。
  LT.MODEL = 'models/gemini-3.5-live-translate-preview';
  LT.WS_PATH =
    '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  LT.DEFAULT_BASE_URL = 'wss://generativelanguage.googleapis.com';

  // ---------- 语言 ----------
  LT.SOURCE_LANGS = [
    { code: 'ja', label: '日语' },
    { code: 'auto', label: '自动检测' },
    { code: 'en', label: '英语' },
    { code: 'zh', label: '中文' },
    { code: 'ko', label: '韩语' },
    { code: 'es', label: '西班牙语' },
    { code: 'fr', label: '法语' },
    { code: 'de', label: '德语' },
    { code: 'ru', label: '俄语' },
  ];

  LT.TARGET_LANGS = [
    { code: 'zh', label: '中文' },
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁体中文' },
    { code: 'en', label: '英语' },
    { code: 'ja', label: '日语' },
    { code: 'ko', label: '韩语' },
    { code: 'es', label: '西班牙语' },
    { code: 'fr', label: '法语' },
    { code: 'de', label: '德语' },
    { code: 'ru', label: '俄语' },
  ];

  LT.sourceLabel = (code) =>
    (LT.SOURCE_LANGS.find((l) => l.code === code) || { label: code }).label;
  LT.targetLabel = (code) =>
    (LT.TARGET_LANGS.find((l) => l.code === code) || { label: code }).label;

  // ---------- 场景库初始模板 ----------
  // 只用于首次初始化和「恢复默认」，运行时真源是 chrome.storage 里的 scenes。
  LT.DEFAULT_SCENES = [
    {
      id: 'vtuber',
      label: 'VTuber',
      instruction:
        '这是 VTuber 直播。优先使用圈内常见的人名、组合名和直播术语译法；' +
        '保留主播的口癖和语气，观众称呼按上下文自然翻译；不确定的专名保留原文。',
    },
    {
      id: 'livestream',
      label: '通用直播',
      instruction:
        '这是实时直播。适应口语、省略、互动和话题跳转，弹幕或观众称呼按上下文自然翻译。',
    },
    {
      id: 'game',
      label: '游戏实况',
      instruction:
        '这是游戏直播。准确处理游戏名、角色、技能、道具、地图和机制术语，保留玩家口语节奏。',
    },
    {
      id: 'talk',
      label: '杂谈 / 电台',
      instruction:
        '这是杂谈或聊天直播。以自然口语为主，保留玩笑、吐槽和语气词的味道，不要书面化。',
    },
    {
      id: 'music',
      label: '歌回 / 音乐',
      instruction:
        '这是歌回或音乐直播。歌曲演唱部分可以直译歌词大意，间隙的说话部分按日常口语翻译；' +
        '曲名和歌手名优先使用通行译名，不确定就保留原文。',
    },
    {
      id: 'news',
      label: '新闻 / 发布会',
      instruction:
        '这是新闻或发布会内容。保持客观和信息密度，准确翻译人名、地名、机构、数字、日期与引语。',
    },
    {
      id: 'general',
      label: '通用',
      instruction: '适用于一般视频内容。保持前后字幕连贯，准确处理标题、人物、组织和主题词。',
    },
  ];

  // ---------- 默认设置 ----------
  // 轮换 / 断句参数沿用已验证的默认值，变更时补真实运行验证。
  LT.DEFAULTS = {
    apiKeys: '', // 英文逗号分隔多个，会话开始时随机选一个
    baseUrl: LT.DEFAULT_BASE_URL,

    sourceLang: 'ja',
    targetLang: 'zh',
    sceneId: 'vtuber',
    scenes: LT.DEFAULT_SCENES,

    autoStartLive: true, // 打开直播页自动开始
    useMetadata: true, // 把标题/简介塞进 systemInstruction
    metadataLimit: 1200, // 简介截断长度
    manualContext: '', // 用户手填的长期背景（人名表等）

    echoTargetLanguage: true,
    rotateSeconds: 505,
    stabIdleMs: 2500,
    stabMaxChars: 42,

    captionLines: 2, // 保留几行已确认字幕（只影响实时翻译）
    captionScale: 1.0,
    captionBottom: 11, // 距播放器底部百分比
    captionOpacity: 60, // 背景不透明度 %
    // 显示模式只决定显示哪些行，不会停止正在进行的翻译；仅原文也要先有任务或缓存
    captionDisplayMode: 'translationOnly', // bilingual | translationOnly | originalOnly
    captionTranslationPosition: 'above', // 双语时译文在原文的上方还是下方：above | below
    captionFont: 'player', // 见 LT.CAPTION_FONTS
    captionWeight: 400, // 300 - 700
    captionColor: '#ffffff', // 译文颜色
    captionSourceColor: '#cfd8dc', // 原文颜色
    captionSourceScale: 0.78, // 原文字号相对译文的比例
    pauseOnAd: true,

    // ---- 整片字幕（视频 / 回放）用的文字模型：可保存多套接口配置，按 subsProviderId 选用 ----
    // 每套：{ id, name, apiType: gemini | openai, baseUrl（空用官方地址）, apiKey（Gemini 空则复用 Live Key）,
    //        model（用账号实际可用的名字，不预填）, concurrency（并发请求数）, requestPath: auto | direct | relay }
    providers: [
      { id: 'p-default', name: '', apiType: 'gemini', baseUrl: '', apiKey: '', model: '', concurrency: 3, requestPath: 'auto' },
    ],
    subsProviderId: 'p-default',
    autoShowCached: true, // 打开已翻译过的视频时自动显示缓存字幕
    subsExtraInstruction: '', // 只对整片字幕有意义的附加指令（错听规律、术语表），进系统提示词和缓存指纹
  };

  // ---------- 字幕外观 ----------
  LT.CAPTION_DISPLAY_MODES = [
    { code: 'bilingual', label: '双语' },
    { code: 'translationOnly', label: '仅译文' },
    { code: 'originalOnly', label: '仅原文' },
  ];
  // 只写 font-family 栈，不下载字体；机器上没有的字体自动落到后面的候选
  LT.CAPTION_FONTS = [
    { code: 'player', label: '跟随播放器', family: "Roboto, 'YouTube Noto', 'Microsoft YaHei', system-ui, sans-serif" },
    {
      code: 'sans',
      label: '黑体（思源 / Noto Sans）',
      family: "'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'Noto Sans JP', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    },
    {
      code: 'serif',
      label: '宋体（思源 / Noto Serif）',
      family: "'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC', 'Noto Serif JP', 'Songti SC', SimSun, serif",
    },
    { code: 'system', label: '系统默认', family: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif" },
  ];

  // ---------- 整片字幕：文字模型与分块参数 ----------
  LT.TEXT_API_TYPES = [
    { code: 'gemini', label: 'Gemini generateContent' },
    { code: 'openai', label: 'OpenAI 兼容 chat/completions' },
  ];
  LT.TEXT_DEFAULT_BASE = {
    gemini: 'https://generativelanguage.googleapis.com',
    openai: 'https://api.openai.com/v1',
  };
  LT.TEXT_REQUEST_PATHS = [
    { code: 'auto', label: '自动（先直连，失败改后台转发）' },
    { code: 'direct', label: '只页面直连' },
    { code: 'relay', label: '只经扩展后台转发' },
  ];
  LT.SUBS = {
    SEG_VERSION: 1, // 分句规则版本，进缓存指纹；改 segmenter 规则要升号
    CHUNK_UNITS: 60, // 每块最多条数
    CHUNK_CHARS: 2500, // 每块最多原文字符
    CONTEXT_UNITS: 15, // 每块附带的前后参考条数
    HEAD_UNITS: 20, // 含当前位置的块先翻这么多条，眼前的字幕先出来
    MIN_SPLIT_UNITS: 8, // 输出截断时拆块的最小粒度
    MAX_ATTEMPTS: 3, // 单个区间的最多尝试次数（限流等待不计）
    BACKOFF_MS: 4000, // 重试退避基数
    REQUEST_TIMEOUT_MS: 120000, // 整个文字模型请求的等待上限，包含流式正文
  };
  LT.RELAY_PORT = 'lt-relay'; // 内容脚本 ↔ Service Worker 的请求转发端口

  // ---------- 消息类型 ----------
  LT.MSG = {
    QUERY_STATUS: 'lt:query-status',
    STATUS: 'lt:status',
    START: 'lt:start',
    STOP: 'lt:stop',
    TOGGLE: 'lt:toggle',
    SETTINGS_CHANGED: 'lt:settings-changed',
    SET_TEMP_CONTEXT: 'lt:set-temp-context',
    // 整片字幕
    VS_START: 'lt:vs-start', // payload: { force?: boolean }
    VS_CANCEL: 'lt:vs-cancel',
    VS_SET_VISIBLE: 'lt:vs-set-visible', // payload: boolean
    VS_CLEAR: 'lt:vs-clear', // 删除当前视频的缓存
  };

  // 页面桥（MAIN world）与内容脚本之间的 window.postMessage 协议
  LT.BRIDGE = {
    REQ: 'lt-bridge:request',
    META: 'lt-bridge:meta',
    // 请求种类（page-bridge.js 里不能引用 LT，字符串要手动对上）
    KIND_META: 'meta',
    KIND_TRACKS: 'tracks',
    KIND_CAPTIONS: 'captions',
    KIND_CANCEL: 'cancel', // 放弃进行中的字幕读取并恢复 CC
  };
})();
