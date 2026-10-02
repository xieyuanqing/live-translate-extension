/** 扩展独立播放器：一次只播一个请求；旧消息不能停止或重新启动新播放。 */
(() => {
  const LT = globalThis.LT;
  let current = null;
  let latest = 0;
  function clear() {
    if (!current) return;
    const { audio, url, heartbeat } = current;
    current = null;
    clearInterval(heartbeat);
    audio.onended = audio.onerror = null;
    audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
  }
  const report = (id, phase, error = '') => chrome.runtime.sendMessage({ target: 'lt-speech-event', id, phase, error }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== 'lt-speech-player' || sender.id !== chrome.runtime.id || sender.tab) return;
    if (!Number.isSafeInteger(msg.id) || msg.id < latest) { reply({ ok: false, stale: true }); return; }
    if (msg.command === 'stop') { latest = msg.id; clear(); reply({ ok: true }); return; }
    if (msg.command === 'rate') {
      if (current?.id === msg.id) current.audio.playbackRate = Math.min(1.25, Math.max(0.75, Number(msg.rate) || 1));
      reply({ ok: true }); return;
    }
    if (msg.command !== 'play' || msg.id === latest) { reply({ ok: false }); return; }
    latest = msg.id; clear();
    try {
      const bytes = LT.TTSAudio.decode(msg.data);
      const url = URL.createObjectURL(new Blob([bytes], { type: msg.mime }));
      const audio = new Audio(url);
      const heartbeat = setInterval(() => chrome.runtime.sendMessage({ target: 'lt-speech-heartbeat' }).catch(() => {}), 10000);
      current = { id: msg.id, audio, url, heartbeat };
      audio.preservesPitch = true;
      audio.playbackRate = Math.min(1.25, Math.max(0.75, Number(msg.rate) || 1));
      audio.onended = () => { if (current?.id === msg.id) { clear(); report(msg.id, 'ended'); } };
      audio.onerror = () => { if (current?.id === msg.id) { clear(); report(msg.id, 'error', '音频无法播放，请重试'); } };
      audio.play().then(() => {
        if (current?.id === msg.id) { report(msg.id, 'playing'); reply({ ok: true }); }
        else reply({ ok: false, stale: true });
      }, () => {
        if (current?.id === msg.id) { clear(); report(msg.id, 'error', '浏览器未能开始播放，请再次点击朗读'); }
        reply({ ok: false });
      });
      return true;
    } catch (_) { clear(); reply({ ok: false }); report(msg.id, 'error', '音频格式无效，请重试'); }
  });
  window.addEventListener('pagehide', clear);
})();
