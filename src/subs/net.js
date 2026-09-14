/**
 * 文字模型请求的网络层：页面直连，或经 Service Worker 转发。
 *
 * - 内容脚本的 fetch 受页面同源策略约束：Gemini 与 OpenAI 官方接口放行跨域，第三方反代不一定。
 * - Service Worker 有 host_permissions 可以跨域，但空闲 30 秒、单请求 5 分钟会被杀，
 *   所以转发一律走流式响应，用端口把分块推回来，端口活动本身也让 SW 保持存活。
 * - 'auto'：先直连，遇到网络层错误（多半是 CORS）再转后台，并记住这次会话之后都走后台。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const relayOrigins = new Set(); // 本页内已确认直连失败的域名

  async function direct({ url, headers, body, signal }) {
    const res = await fetch(url, { method: 'POST', headers, body, signal });
    const retryAfter = res.headers.get('retry-after') || '';
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    } else {
      text = await res.text();
    }
    return { status: res.status, ok: res.ok, text, retryAfter };
  }

  function relay({ url, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: LT.RELAY_PORT });
      } catch (err) {
        reject(new Error('扩展后台不可用，请重新加载扩展并刷新页面'));
        return;
      }
      let status = 0;
      let ok = false;
      let retryAfter = '';
      let text = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        try {
          port.disconnect();
        } catch (_) {
          /* 已断开 */
        }
        fn(value);
      };
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'head') {
          status = m.status;
          ok = !!m.ok;
          retryAfter = m.retryAfter || '';
        } else if (m.type === 'chunk') {
          text += m.text || '';
        } else if (m.type === 'end') {
          finish(resolve, { status, ok, text, retryAfter });
        } else if (m.type === 'error') {
          finish(reject, new Error(m.message || '后台转发失败'));
        }
      });
      port.onDisconnect.addListener(() => finish(reject, new Error('后台连接中断，请重试')));
      if (signal) {
        if (signal.aborted) {
          finish(reject, new DOMException('已取消', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => finish(reject, new DOMException('已取消', 'AbortError')), { once: true });
      }
      port.postMessage({ type: 'fetch', url, headers, body });
    });
  }

  /**
   * @param {{url:string, headers:object, body:string, signal?:AbortSignal, path:'auto'|'direct'|'relay'}} req
   * @returns {Promise<{status:number, ok:boolean, text:string, retryAfter:string, via:string}>}
   */
  async function post(req) {
    const origin = new URL(req.url).origin;
    const path = req.path || 'auto';
    if (path === 'relay' || (path === 'auto' && relayOrigins.has(origin))) {
      return Object.assign(await relay(req), { via: 'relay' });
    }
    try {
      return Object.assign(await direct(req), { via: 'direct' });
    } catch (err) {
      // fetch 本身抛 TypeError 才是网络层 / CORS 失败；HTTP 错误码不会走到这里
      if (path !== 'auto' || !err || err.name === 'AbortError' || !(err instanceof TypeError)) throw err;
      relayOrigins.add(origin);
      return Object.assign(await relay(req), { via: 'relay' });
    }
  }

  /** 把 SSE 文本拆成 JSON 事件数组；不是 SSE（普通 JSON 响应）时整体解析。 */
  function parseSse(text) {
    const events = [];
    if (!/^\s*(data|event|id|retry):/m.test(text)) {
      try {
        const one = JSON.parse(text);
        return Array.isArray(one) ? one : [one];
      } catch (_) {
        return events;
      }
    }
    let buf = [];
    const flush = () => {
      if (buf.length === 0) return;
      const payload = buf.join('\n').trim();
      buf = [];
      if (!payload || payload === '[DONE]') return;
      try {
        events.push(JSON.parse(payload));
      } catch (_) {
        /* 半截事件（截断的流），忽略 */
      }
    };
    for (const line of text.split(/\r?\n/)) {
      if (line === '') {
        flush();
        continue;
      }
      if (line.startsWith('data:')) buf.push(line.slice(5).replace(/^ /, ''));
    }
    flush();
    return events;
  }

  LT.Net = { post, parseSse, relayOrigins };
})();
