/** 划词共用配置：语言只在本机分为英语和日语，不改写发送的原文。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  const PORT = 'lt-selection';
  const MAX_TEXT = 4000;
  const VOICES = {
    ja: [['ja-JP-NanamiNeural', 'Nanami · 女声'], ['ja-JP-MasaruMultilingualNeural', 'Masaru · 男声']],
    en: [['en-US-JennyNeural', 'Jenny · 女声'], ['en-US-AriaNeural', 'Aria · 女声'], ['en-US-GuyNeural', 'Guy · 男声']],
    gemini: ['Kore', 'Puck', 'Charon', 'Aoede', 'Zephyr', 'Leda', 'Orus'],
  };
  function language(text) {
    const letters = String(text).normalize('NFKC').match(/\p{L}/gu) || [];
    return letters.length && letters.every(letter => /\p{Script=Latin}/u.test(letter)) ? 'en-US' : 'ja-JP';
  }
  function cleanText(value) {
    const text = String(value || '').trim();
    if (!text) throw new Error('请先选中要朗读或翻译的文字');
    if (text.length > MAX_TEXT) throw new Error(`一次最多处理 ${MAX_TEXT} 字，请缩短选区`);
    return text;
  }
  function resolve(settings, provider = settings.ttsProvider) {
    if (provider !== 'microsoft' && provider !== 'gemini') throw new Error('请选择微软或 Gemini');
    let key = settings.ttsGeminiApiKey;
    if (settings.ttsGeminiReuseKey) key = LT.Settings.keyList(settings)[0] ||
      settings.providers.find(p => p.apiType === 'gemini' && p.apiKey)?.apiKey || '';
    return {
      provider, key: provider === 'gemini' ? key : '',
      baseUrl: settings.ttsGeminiBaseUrl, model: settings.ttsGeminiModel,
      voice: settings.ttsGeminiVoice, jaVoice: settings.ttsMicrosoftJaVoice,
      enVoice: settings.ttsMicrosoftEnVoice, rate: settings.ttsRate,
    };
  }
  function safeError(error, settings) {
    const secrets = [settings?.ttsGeminiApiKey, ...(LT.Settings.keyList(settings || {})),
      ...(settings?.providers || []).map(p => p.apiKey)].filter(Boolean);
    let message = String(error?.message || '请求失败，请重试');
    for (const key of secrets) message = message.split(key).join('[API_KEY]');
    return message.replace(/AIza[\w-]{20,}/g, '[API_KEY]').slice(0, 300);
  }
  LT.Selection = { PORT, MAX_TEXT, VOICES, language, cleanText, resolve, safeError };
})();
