/**
 * 文字模型请求的网络层：页面直连，或经 Service Worker 转发。
 *
 * - 内容脚本的 fetch 受页面同源策略约束：Gemini 与 OpenAI 官方接口放行跨域，第三方反代不一定。
 * - Service Worker 有 host_permissions 可以跨域，但空闲 30 秒、单请求 5 分钟会被杀，
 *   所以转发一律走流式响应，用端口把分块推回来，端口活动本身也让 SW 保持存活。
 * - 'auto'：先直连，遇到网络层错误（多半是 CORS）再转后台，并记住这次会话之后都走后台。
 * - 方法默认 POST；设置页查模型信息用 GET，两条路径都按 method 发，GET 不带正文。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const relayOrigins = new Set(); // 本页内已确认直连失败的域名
  const bodyFor = (method, body) => (method === 'GET' || method === 'HEAD' ? undefined : body);

  async function direct({ url, method, headers, body, signal }) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: bodyFor(method, body), signal });
    } catch (err) {
      // 只允许尚未收到响应的网络错误尝试另一条路径。
      if (err instanceof TypeError) err.canRelay = true;
      throw err;
    }
    const retryAfter = res.headers.get('retry-after') || '';
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
        }
        text += dec.decode();
      } finally {
        reader.releaseLock();
      }
    } else {
      text = await res.text();
    }
    return { status: res.status, ok: res.ok, text, retryAfter };
  }

  function relay({ url, method, headers, body, signal }) {
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
      const onAbort = () => finish(reject, new DOMException('已取消', 'AbortError'));
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
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
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        port.postMessage({ type: 'fetch', method, url, headers, body: bodyFor(method, body) });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /**
   * @param {{url:string, method:string, headers:object, body?:string, signal?:AbortSignal, path:'auto'|'direct'|'relay'}} req
   * @returns {Promise<{status:number, ok:boolean, text:string, retryAfter:string, via:string}>}
   */
  async function route(req) {
    const origin = new URL(req.url).origin;
    const path = req.path || 'auto';
    if (path === 'relay' || (path === 'auto' && relayOrigins.has(origin))) {
      return Object.assign(await relay(req), { via: 'relay' });
    }
    try {
      return Object.assign(await direct(req), { via: 'direct' });
    } catch (err) {
      // fetch 本身抛 TypeError 才是网络层 / CORS 失败；HTTP 错误码不会走到这里
      if (path !== 'auto' || !err || !err.canRelay || (req.signal && req.signal.aborted)) throw err;
      relayOrigins.add(origin);
      return Object.assign(await relay(req), { via: 'relay' });
    }
  }

  /**
   * 发一次请求。整个请求（包括读取流）默认最多等两分钟，可用 timeoutMs 缩短；用户取消和超时分别处理。
   * @param {{url:string, method?:string, headers:object, body?:string, signal?:AbortSignal, path?:string, timeoutMs?:number}} req
   */
  async function request(req) {
    const method = String(req.method || 'POST').toUpperCase();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const external = req.signal;
    if (external && external.aborted) throw new DOMException('已取消', 'AbortError');
    if (external) external.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs || LT.SUBS.REQUEST_TIMEOUT_MS);
    try {
      return await route({ ...req, method, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new Error(method === 'GET' ? '请求超时，接口没有响应' : '文字模型请求超时，请重试或降低并发请求数');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  const post = (req) => request({ ...req, method: 'POST' });

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

  LT.Net = { request, post, parseSse, relayOrigins };
})();
