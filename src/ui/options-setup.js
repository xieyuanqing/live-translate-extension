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
  function connectionState(settings, kind, id) {
    const missing = [];
    let origins = [], route = '#models/text', label = '文字接口';
    if (kind === 'live') {
      route = '#models/live'; label = '实时翻译接口';
      if (settings.liveProvider === 'qwen') {
        if (!settings.qwenApiKey) missing.push('Key');
        if (!/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(settings.qwenWorkspaceHost)) missing.push('业务空间域名');
        origins = ['<all_urls>'];
      } else {
        if (!LT.Settings.keyList(settings).length) missing.push('Key');
        try { if (!['wss:', 'ws:'].includes(new URL(settings.baseUrl).protocol)) missing.push('连接地址'); }
        catch (_) { missing.push('连接地址'); }
      }
    } else if (kind === 'speech') {
      route = '#models/speech'; label = '朗读接口';
      if (settings.ttsProvider === 'microsoft') return { complete: true, origins, missing, route, label };
      const config = LT.Selection.resolve(settings);
      if (!config.key) missing.push('Key');
      if (!config.model) missing.push('模型');
      origins = httpOrigins(config.baseUrl);
      if (!origins) { missing.push('接口地址'); origins = []; }
    } else {
      const provider = LT.Settings.provider(settings, id);
      if (!provider.apiKey && !Object.keys(provider.headers).length && !(provider.apiType === 'gemini' && LT.Settings.keyList(settings).length)) missing.push('Key');
      if (LT.Settings.headerError(provider.headers)) missing.push('有效请求头');
      const model = provider.apiType === 'gemini' ? provider.model.replace(/^models\//, '') : provider.model;
      if (!model) missing.push('模型');
      origins = httpOrigins(provider.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType]);
      if (!origins) { missing.push('接口地址'); origins = []; }
    }
    return { complete: missing.length === 0, origins, missing, route, label };
  }
  // 签名只保留在设置页内存中；不导出、不记录日志，也不显示凭据。
  function providerSignature(settings, id) {
    const provider = LT.Settings.provider(settings, id);
    return JSON.stringify([provider, provider.apiType === 'gemini' && !provider.apiKey ? LT.Settings.keyList(settings) : []]);
  }
  LT.OptionsUI.connectionState = connectionState;
  LT.OptionsUI.providerSignature = providerSignature;
})();
