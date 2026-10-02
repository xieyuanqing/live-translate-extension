/** 语音网络与音频格式小工具；后台使用，不读取网页音频。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  const abort = () => new DOMException('已取消', 'AbortError');
  async function request(url, init, signal, read, timeout = 30000) {
    if (signal?.aborted) throw abort();
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeout);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, credentials: 'omit' });
      if (!response.ok) {
        const error = new Error(response.status === 429 ? '语音接口限流或额度不足，请稍后重试或切换供应商' : `语音接口请求失败（HTTP ${response.status}）`);
        error.status = response.status;
        throw error;
      }
      const out = await read(response);
      if (signal?.aborted) throw abort();
      return out;
    } catch (error) {
      if (expired && !signal?.aborted) throw new Error('语音接口超时，请重试或切换供应商');
      if (error instanceof TypeError && !signal?.aborted) throw new Error('无法连接语音接口，请检查网络或切换供应商');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
  function decode(data) { return Uint8Array.from(atob(data), char => char.charCodeAt(0)); }
  function encode(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  }
  function concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!total || total > 16 * 1024 * 1024) throw new Error('语音结果为空或过大，请缩短选区');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  function wav(pcm, rate = 24000) {
    if (!pcm.length || pcm.length % 2 || rate < 8000 || rate > 96000) throw new Error('语音 PCM 格式无效');
    const bytes = new Uint8Array(44 + pcm.length);
    const view = new DataView(bytes.buffer);
    const tag = (at, str) => [...str].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
    return bytes;
  }
  LT.TTSAudio = { request, decode, encode, concat, wav };
})();
