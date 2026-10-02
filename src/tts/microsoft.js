/**
 * 微软消费者鉴权签名适配自 Read Frog，commit 308a08d73091300c14fe2bf184d59895478174ef。
 * 原文件：src/utils/server/edge-tts/{constants,signature,endpoint,synthesize}.ts
 * https://github.com/mengxi-ream/read-frog — 版权归其原作者，GPL-3.0；见 LICENSE.read-frog。
 * 本文件是本机自用适配：普通 JS、取消/超时、中文错误、仅日英语音。
 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  const A = LT.TTSAudio;
  const ENDPOINT = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
  const APP = 'MSTranslatorAndroidApp';
  const SIGNING_MATERIAL = 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==';
  let cached = null;
  async function signature(now = new Date(), id = crypto.randomUUID().replace(/-/g, '')) {
    const date = `${now.toUTCString().replace('GMT', '').trim().toLowerCase()} GMT`;
    const payload = `${APP}${encodeURIComponent(ENDPOINT.split('://')[1])}${date}${id}`.toLowerCase();
    const key = await crypto.subtle.importKey('raw', A.decode(SIGNING_MATERIAL), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return `${APP}::${A.encode(new Uint8Array(hash))}::${date}::${id}`;
  }
  async function token(signal) {
    if (cached && cached.expires > Date.now() + 180000) return cached;
    const previous = cached;
    try {
      const signed = await signature();
      const data = await A.request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Accept-Language': 'zh-Hans',
        'X-ClientVersion': '4.0.530a 5fe1dc6c', 'X-UserId': '0f04d16a175c411e',
        'X-HomeGeographicRegion': 'zh-Hans-CN', 'X-ClientTraceId': crypto.randomUUID().replace(/-/g, ''),
        'X-MT-Signature': signed,
      }, body: '' }, signal, response => response.json());
      if (typeof data.t !== 'string' || !/^[a-z0-9-]+$/.test(data.r)) throw new Error('微软语音鉴权响应无效');
      let expires = Date.now() + 600000;
      try {
        const encoded = data.t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const exp = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))).exp;
        if (Number.isFinite(exp)) expires = exp * 1000;
      } catch (_) { /* 无过期信息时仅短暂缓存 */ }
      cached = { token: data.t, region: data.r, expires };
      return cached;
    } catch (error) {
      if (!signal?.aborted && previous?.expires > Date.now()) return previous;
      throw error;
    }
  }
  const xml = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
  function chunks(text, max = 1800) {
    const out = [];
    const encoder = new TextEncoder();
    let buffer = '';
    for (const char of text) {
      if (encoder.encode(buffer + char).length > max) {
        const boundary = [...buffer.matchAll(/[\s。！？.!?]/gu)].at(-1);
        const at = boundary ? boundary.index + boundary[0].length : buffer.length;
        out.push(buffer.slice(0, at)); buffer = buffer.slice(at);
      }
      buffer += char;
    }
    if (buffer) out.push(buffer);
    return out;
  }
  async function synthesize({ text, language, config, signal }) {
    const voice = language === 'en-US' ? config.enVoice : config.jaVoice;
    const data = [];
    for (const part of chunks(text)) {
      for (let attempt = 0; ; attempt++) {
        const auth = await token(signal);
        try {
          const bytes = await A.request(`https://${auth.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
            method: 'POST', headers: { Authorization: auth.token, 'Content-Type': 'application/ssml+xml',
              'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3' },
            body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}"><voice name="${xml(voice)}">${xml(part)}</voice></speak>`,
          }, signal, async response => new Uint8Array(await response.arrayBuffer()));
          data.push(bytes); break;
        } catch (error) {
          if (attempt === 0 && [401, 403].includes(error.status) && !signal?.aborted) { cached = null; continue; }
          throw error;
        }
      }
    }
    return { bytes: A.concat(data), mime: 'audio/mpeg' };
  }
  LT.MicrosoftTTS = { synthesize, signature, chunks };
})();
