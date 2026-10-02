/** 朗读设置和真实试听；使用与右键相同的后台合成、播放和取消链路。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};
  function mountSpeech(ctx) {
    const $ = ctx.$;
    let port = null, heartbeat = null, requestId = 0;
    function stop() {
      requestId++; // 同时取消尚未完成保存、还没送到后台的试听。
      try { port?.postMessage({ type: 'stop' }); } catch (_) { /* 已断开 */ }
      if (!$('ttsStopPreview').disabled) $('ttsPreviewState').textContent = '已停止';
      $('ttsStopPreview').disabled = true;
    }
    function render() {
      const s = ctx.settings();
      $('ttsMicrosoftFields').hidden = s.ttsProvider !== 'microsoft';
      $('ttsGeminiFields').hidden = s.ttsProvider !== 'gemini';
      $('ttsGeminiApiKey').disabled = s.ttsGeminiReuseKey;
    }
    async function preview(text) {
      $('ttsPreviewState').textContent = '准备中…'; $('ttsStopPreview').disabled = false;
      const id = ++requestId;
      try {
        await ctx.flush();
        if (id !== requestId) return;
        if (!port) {
          port = chrome.runtime.connect({ name: LT.Selection.PORT });
          heartbeat = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) { /* 断线回调处理 */ } }, 10000);
          port.onMessage.addListener(message => {
            if (message.type !== 'speech' || message.requestId !== requestId) return;
            $('ttsPreviewState').textContent = message.error || ({ preparing: '准备中…', playing: '播放中', ended: '试听完成', stopped: '已停止' })[message.phase] || '';
            $('ttsStopPreview').disabled = !['preparing', 'playing'].includes(message.phase);
          });
          port.onDisconnect.addListener(() => { clearInterval(heartbeat); port = null; $('ttsStopPreview').disabled = true; $('ttsPreviewState').textContent = '连接已断开，请重新试听'; });
        }
        port.postMessage({ type: 'speak', text, requestId: id, rate: ctx.settings().ttsRate });
      } catch (_) { $('ttsPreviewState').textContent = '无法连接朗读服务，请保存设置后重试'; $('ttsStopPreview').disabled = true; }
    }
    function bind() {
      const lists = { ttsProvider: [['microsoft', '微软（默认）'], ['gemini', 'Gemini TTS']],
        ttsMicrosoftJaVoice: LT.Selection.VOICES.ja, ttsMicrosoftEnVoice: LT.Selection.VOICES.en,
        ttsGeminiVoice: LT.Selection.VOICES.gemini.map(voice => [voice, voice]),
        ttsRate: [[0.85, '慢一点 · 0.85×'], [1, '正常 · 1×'], [1.15, '快一点 · 1.15×']] };
      for (const [field, values] of Object.entries(lists)) {
        for (const [value, label] of values) { const option = document.createElement('option'); option.value = value; option.textContent = label; $(field).append(option); }
        $(field).value = ctx.settings()[field];
        $(field).addEventListener('change', () => { stop(); ctx.save({ [field]: field === 'ttsRate' ? Number($(field).value) : $(field).value }); render(); });
      }
      for (const field of ['ttsGeminiApiKey', 'ttsGeminiBaseUrl', 'ttsGeminiModel']) {
        $(field).value = ctx.settings()[field];
        $(field).addEventListener('input', () => { stop(); ctx.save({ [field]: $(field).value }); });
      }
      $('ttsGeminiReuseKey').checked = ctx.settings().ttsGeminiReuseKey;
      $('ttsGeminiReuseKey').addEventListener('change', () => { stop(); ctx.save({ ttsGeminiReuseKey: $('ttsGeminiReuseKey').checked }); render(); });
      $('ttsGrantGemini').addEventListener('click', async () => {
        try {
          const origin = new URL(ctx.settings().ttsGeminiBaseUrl).origin;
          const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
          $('ttsPermissionState').textContent = granted ? '已授权' : '未授权';
        } catch (_) { $('ttsPermissionState').textContent = '请检查接口地址'; }
      });
      $('ttsPreviewJa').addEventListener('click', () => preview('今日はいい天気ですね。東京で友達と会います。'));
      $('ttsPreviewEn').addEventListener('click', () => preview('Hello! This is a short reading test. How are you today?'));
      $('ttsStopPreview').addEventListener('click', stop);
      window.addEventListener('pagehide', () => { clearInterval(heartbeat); port?.disconnect(); });
      render();
    }
    return { bind, stop };
  }
  LT.OptionsUI.mountSpeech = mountSpeech;
})();
