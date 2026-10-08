/** 朗读设置和真实试听；使用与右键相同的后台合成、播放和取消链路。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};
  function mountSpeech(ctx) {
    const $ = ctx.$;
    let port = null, heartbeat = null, requestId = 0, renderedSignature = '';
    function stop() {
      requestId++; // 同时取消尚未完成保存、还没送到后台的试听。
      try { port?.postMessage({ type: 'stop' }); } catch (_) { /* 已断开 */ }
      if (!$('ttsStopPreview').disabled) $('ttsPreviewState').textContent = '已停止';
      $('ttsStopPreview').disabled = true;
    }
    function render() {
      const snapshot = LT.Settings.normalize(ctx.settings());
      let signature;
      try { signature = JSON.stringify(LT.Selection.resolve(snapshot)); }
      catch (error) { signature = JSON.stringify([snapshot.ttsProviderId, error.message]); }
      if (renderedSignature && signature !== renderedSignature) stop();
      renderedSignature = signature;
      $('ttsRate').value = String(snapshot.ttsRate);
    }
    async function preview(text) {
      $('ttsPreviewState').textContent = '准备中…'; $('ttsStopPreview').disabled = false;
      const id = ++requestId;
      try {
        const snapshot = LT.Settings.normalize(ctx.settings());
        const config = LT.Selection.resolve(snapshot);
        if (config.provider === 'gemini') {
          const origins = [LT.Settings.hostPattern(config.baseUrl)];
          // 点击内直接请求，保留 Chrome 的用户手势；已经授权时会直接返回。
          const granted = await chrome.permissions.request({ origins });
          if (id !== requestId) return;
          if (!granted) {
            $('ttsPreviewState').textContent = '未获得接口域名权限，请在「API 提供商」中授权后重试。';
            $('ttsStopPreview').disabled = true;
            return;
          }
        }
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
        port.postMessage({ type: 'speak', text, requestId: id, rate: config.rate });
      } catch (error) {
        if (id !== requestId) return;
        $('ttsPreviewState').textContent = LT.Selection.safeError(error, ctx.settings());
        $('ttsStopPreview').disabled = true;
      }
    }
    function bind() {
      for (const [value, label] of [[0.85, '慢一点 · 0.85×'], [1, '正常 · 1×'], [1.15, '快一点 · 1.15×']]) {
        const choice = document.createElement('option'); choice.value = value; choice.textContent = label; $('ttsRate').append(choice);
      }
      $('ttsRate').addEventListener('change', () => { stop(); ctx.save({ ttsRate: Number($('ttsRate').value) }); render(); });
      $('ttsPreviewJa').addEventListener('click', () => preview('今日はいい天気ですね。東京で友達と会います。'));
      $('ttsPreviewEn').addEventListener('click', () => preview('Hello! This is a short reading test. How are you today?'));
      $('ttsStopPreview').addEventListener('click', stop);
      window.addEventListener('pagehide', () => { clearInterval(heartbeat); port?.disconnect(); });
      render();
    }
    return { bind, stop, render };
  }
  LT.OptionsUI.mountSpeech = mountSpeech;
})();
