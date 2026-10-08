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
  function resolve(settings, providerId = settings.ttsProviderId) {
    // 兼容旧页面传来的协议名；新页面始终传独立配置 ID。
    if (providerId === 'microsoft' || providerId === 'gemini') {
      const preset = `${providerId}-tts`;
      const selected = LT.Settings.serviceProvider(settings, 'speech');
      providerId = selected.preset === preset ? selected.id
        : LT.Settings.providersFor(settings, 'speech').find(p => p.enabled !== false && p.preset === preset)?.id;
      if (!providerId) throw new Error('所选朗读提供商已删除，请重新选择');
    }
    const profile = LT.Settings.serviceProvider(settings, 'speech', providerId);
    if (profile.enabled === false) throw new Error(`提供商「${profile.name || profile.id}」已停用，请在设置中启用或选择其他提供商`);
    const provider = profile.preset === 'gemini-tts' ? 'gemini' : 'microsoft';
    let key = profile.apiKey;
    if (profile.reuseKey) key = LT.Settings.keyList(settings)[0] ||
      LT.Settings.providersFor(settings, 'text').find(p => p.enabled !== false && p.apiType === 'gemini' && p.apiKey)?.apiKey || '';
    return {
      provider, key: provider === 'gemini' ? key : '',
      baseUrl: profile.baseUrl, model: profile.model,
      voice: profile.voice, jaVoice: profile.jaVoice,
      enVoice: profile.enVoice, rate: settings.ttsRate,
    };
  }
  function safeError(error, settings) {
    const secrets = [settings?.ttsGeminiApiKey, ...(LT.Settings.keyList(settings || {})),
      ...(settings?.providers || []).flatMap(p => [...String(p.apiKey || '').split(','), ...Object.values(p.headers || {})])]
      .map(value => String(value || '').trim()).filter(Boolean);
    let message = String(error?.message || '请求失败，请重试');
    for (const key of secrets) message = message.split(key).join('[API_KEY]');
    return message.replace(/AIza[\w-]{20,}/g, '[API_KEY]').slice(0, 300);
  }
  LT.Selection = { PORT, MAX_TEXT, VOICES, language, cleanText, resolve, safeError };
})();
