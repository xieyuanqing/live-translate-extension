/** 配置引导只检查填写和浏览器权限，不把已保存的 Key 当成账号验证成功。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};
  function httpOrigins(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      return [LT.Settings.hostPattern(url.href)];
    } catch (_) { return null; }
  }
  function connectionState(settings, kind, id, selectedModel) {
    const missing = [];
    let origins = [], label = '文字接口';
    const route = '#models/providers';
    if (kind === 'live') label = '实时翻译接口';
    if (kind === 'speech') label = '朗读接口';
    let provider;
    try {
      provider = kind === 'text' ? LT.Settings.provider(settings, id) : LT.Settings.serviceProvider(settings, kind, id);
    } catch (_) {
      return { complete: false, origins, missing: ['选择对应类型的提供商'], route, label };
    }
    if (provider.enabled === false) missing.push('启用提供商');
    if (kind === 'live') {
      if (provider.preset === 'qwen-live') {
        if (!provider.apiKey) missing.push('Key');
        if (!/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(provider.workspaceHost)) missing.push('业务空间域名');
        origins = ['<all_urls>'];
      } else {
        if (!String(provider.apiKey || '').split(',').some(key => key.trim())) missing.push('Key');
        try { if (!['wss:', 'ws:'].includes(new URL(provider.baseUrl).protocol)) missing.push('连接地址'); }
        catch (_) { missing.push('连接地址'); }
      }
    } else if (kind === 'speech') {
      if (provider.preset !== 'microsoft-tts') {
        const reused = provider.reuseKey && (LT.Settings.keyList(settings).length ||
          LT.Settings.providersFor(settings, 'text').some(p => p.enabled !== false && p.apiType === 'gemini' && p.apiKey));
        if (provider.reuseKey ? !reused : !provider.apiKey) missing.push('Key');
        if (!provider.model) missing.push('模型');
        origins = httpOrigins(provider.baseUrl);
        if (!origins) { missing.push('接口地址'); origins = []; }
      }
    } else {
      if (!provider.apiKey && !Object.keys(provider.headers).length && !(provider.apiType === 'gemini' && LT.Settings.keyList(settings).length)) missing.push('Key');
      if (LT.Settings.headerError(provider.headers)) missing.push('有效请求头');
      if (selectedModel !== null && !String(selectedModel || '').replace(/^models\//, '')) missing.push('模型');
      origins = httpOrigins(provider.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType]);
      if (!origins) { missing.push('接口地址'); origins = []; }
    }
    return { complete: missing.length === 0, origins, missing, route, label };
  }
  // 签名只保留在设置页内存中；不导出、不记录日志，也不显示凭据。
  function providerSignature(settings, id) {
    const provider = settings.providers.find(p => p.id === id) || LT.Settings.provider(settings, id);
    const reuse = provider.kind === 'speech' ? provider.reuseKey : provider.apiType === 'gemini' && !provider.apiKey;
    return JSON.stringify([provider, reuse ? LT.Settings.keyList(settings) : [],
      provider.kind === 'speech' && reuse ? LT.Settings.providersFor(settings, 'text').filter(p => p.enabled !== false && p.apiType === 'gemini').map(p => p.apiKey) : []]);
  }
  LT.OptionsUI.connectionState = connectionState;
  LT.OptionsUI.providerSignature = providerSignature;
})();
