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
  LT.QWEN_MODEL = 'qwen3.8-livetranslate-flash-realtime';
  LT.QWEN_AUTH_PORT = 'lt-qwen-auth';
  LT.LIVE_PROVIDERS = [
    { code: 'gemini', label: 'Gemini 3.5 Live Translate' },
    { code: 'qwen', label: '千问 3.8 LiveTranslate' },
  ];
  LT.LOG_LEVELS = [
    { code: 'off', label: '关闭' },
    { code: 'basic', label: '基础日志（状态与耗时）' },
    { code: 'detailed', label: '详细调试（含原文、译文和提示词）' },
  ];

  // 评论与聊天共用预设，选择和装饰色分别保存。
  LT.TEXT_STYLES = [
    { code: 'plain', label: '原样' },
    { code: 'textColor', label: '文字颜色' },
    { code: 'underline', label: '下划线' },
    { code: 'dotted', label: '点状线' },
    { code: 'dashed', label: '虚线' },
    { code: 'wavy', label: '波浪线' },
    { code: 'highlight', label: '背景高亮' },
    { code: 'marker', label: '荧光笔' },
    { code: 'quote', label: '引用' },
    { code: 'box', label: '边框' },
    { code: 'bold', label: '加粗' },
    { code: 'muted', label: '淡化' },
  ];

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
    uiTheme: 'system', // 设置页和弹窗共用，跟随系统或手动选择深浅色
    apiKeys: '', // 英文逗号分隔多个，会话开始时随机选一个
    baseUrl: LT.DEFAULT_BASE_URL,
    liveProvider: 'gemini',
    liveProviderId: '', // 直播功能绑定统一提供商配置
    qwenWorkspaceHost: '', // 只存工作空间域名，不存用户专属地址到源码
    qwenApiKey: '',
    generateLiveContext: true, // 开播前用选中的文字模型整理短背景和术语
    liveContextProviderId: '', // AI 整理独立选用；首次读取旧设置时保留原来的接口选择
    liveContextTimeoutSeconds: 60, // 包含连接、模型等待和收完整个回答
    debugLogLevel: 'off', // 显式开启后才把直播诊断记录写入本机扩展存储
    enableChatTranslation: false, // YouTube 聊天：默认 Chrome 本机翻译，也可显式选择文字接口
    chatProviderId: 'local',
    chatModel: '',
    enableCommentTranslation: false, // YouTube 评论：独立选用文字接口，按需翻译
    commentTranslationStyle: 'plain',
    chatTranslationStyle: 'plain',
    commentTranslationColor: '#3478b8',
    chatTranslationColor: '#3478b8',
    ttsProvider: 'microsoft',
    ttsProviderId: '', // 朗读功能绑定统一提供商配置
    ttsMicrosoftJaVoice: 'ja-JP-NanamiNeural',
    ttsMicrosoftEnVoice: 'en-US-JennyNeural',
    ttsGeminiApiKey: '',
    ttsGeminiReuseKey: true,
    ttsGeminiBaseUrl: 'https://generativelanguage.googleapis.com',
    ttsGeminiModel: 'gemini-3.1-flash-tts-preview',
    ttsGeminiVoice: 'Kore',
    ttsRate: 1,
    selectionProviderId: '', // 划词翻译独立选用文字模型；旧设置首次沿用整片字幕模型
    commentProviderId: '', // 评论独立选用文字接口；旧设置首次沿用整片字幕接口
    selectionModel: '',
    commentModel: '',
    liveContextModel: '',

    sourceLang: 'ja',
    targetLang: 'zh',
    sceneId: 'vtuber',
    scenes: LT.DEFAULT_SCENES,

    autoStartLive: true, // 打开直播页自动开始
    useMetadata: true, // 实时提示词或开播术语整理、整片字幕的标题/简介资料
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

    // ---- 文字接口仅保存连接和模型目录；每项功能单独保存所用模型 ----
    // 每套：{ id, name, apiType: gemini | openai, baseUrl（空用官方地址）, apiKey（Gemini 空则复用 Live Key）,
    //        models（可用模型 ID 目录）, concurrency（并发请求数）, requestPath: auto | direct | relay }
    providers: [
      { id: 'p-default', name: '', kind: 'text', preset: 'custom', apiType: 'openai', baseUrl: '', apiKey: '', models: [], concurrency: 3, requestPath: 'auto' },
    ],
    subsProviderId: 'p-default',
    subsModel: '',
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
    { code: 'openai', label: 'OpenAI 兼容 chat/completions' },
    { code: 'gemini', label: 'Gemini generateContent' },
  ];
  // 提供商身份与请求协议分开；各功能引用配置 id，待接入项只出现在添加列表。
  LT.PROVIDER_PRESETS = [
    { code: 'openai', label: 'OpenAI', kind: 'text', apiType: 'openai', baseUrl: 'https://api.openai.com/v1', group: 'llm' },
    { code: 'deepseek', label: 'DeepSeek', kind: 'text', apiType: 'openai', baseUrl: 'https://api.deepseek.com', group: 'llm' },
    { code: 'gemini', label: 'Gemini', kind: 'text', apiType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', group: 'llm' },
    { code: 'bailian', label: '阿里百炼（北京）', kind: 'text', apiType: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', group: 'llm' },
    { code: 'bailian-intl', label: '阿里百炼（新加坡）', kind: 'text', apiType: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', group: 'llm' },
    { code: 'groq', label: 'Groq', kind: 'text', apiType: 'openai', baseUrl: 'https://api.groq.com/openai/v1', group: 'llm' },
    { code: 'moonshot', label: '月之暗面', kind: 'text', apiType: 'openai', baseUrl: 'https://api.moonshot.cn/v1', group: 'llm' },
    { code: 'custom', label: '自定义 API', kind: 'text', apiType: 'openai', baseUrl: '', group: 'compatible' },
    { code: 'gemini-live', label: 'Gemini 直播翻译', kind: 'live', baseUrl: LT.DEFAULT_BASE_URL, model: LT.MODEL, group: 'live' },
    { code: 'qwen-live', label: '千问直播翻译', kind: 'live', model: LT.QWEN_MODEL, group: 'live' },
    { code: 'microsoft-tts', label: '微软朗读', kind: 'speech', group: 'speech' },
    { code: 'gemini-tts', label: 'Gemini 朗读', kind: 'speech', baseUrl: 'https://generativelanguage.googleapis.com', model: LT.DEFAULTS.ttsGeminiModel, group: 'speech' },
    { code: 'deeplx', label: 'DeepLX', group: 'translation', pending: true },
    { code: 'deepl', label: 'DeepL', group: 'translation', pending: true },
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
    QUERY_LIVE_CONTEXT: 'lt:query-live-context',
    PREVIEW_LIVE_CONTEXT: 'lt:preview-live-context',
    QUERY_TEXT_STATUS: 'lt:query-text-status',
    TRANSLATE_VISIBLE_COMMENTS: 'lt:translate-visible-comments',
    CANCEL_COMMENT_TRANSLATION: 'lt:cancel-comment-translation',
    CHAT_STATUS: 'lt:chat-status',
    QUERY_CHAT_STATUS: 'lt:query-chat-status',
    PREPARE_CHAT: 'lt:prepare-chat',
    // 整片字幕
    VS_START: 'lt:vs-start', // payload: { force?: boolean }
    VS_CANCEL: 'lt:vs-cancel',
    VS_SET_VISIBLE: 'lt:vs-set-visible', // payload: boolean
    LIVE_SET_VISIBLE: 'lt:live-set-visible', // payload: boolean
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
