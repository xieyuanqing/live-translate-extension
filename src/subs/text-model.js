/**
 * 文字翻译模型客户端：Gemini generateContent 与 OpenAI 兼容 chat/completions。
 * 只负责一次请求：拼请求、发出去、把流式响应合成完整文本和结束原因。重试与分块在 video-subs.js。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  class RequestError extends Error {
    constructor(message, { status = 0, retryAfterMs = 0, fatal = false } = {}) {
      super(message);
      this.name = 'RequestError';
      this.status = status;
      this.retryAfterMs = retryAfterMs;
      this.fatal = fatal;
    }
  }

  /** 从设置里整理出本次任务用的模型配置；Gemini 没单独填 Key 时复用 Live 的 Key。 */
  function resolve(settings) {
    const apiType = settings.textApiType === 'openai' ? 'openai' : 'gemini';
    const baseUrl = String(settings.textBaseUrl || LT.TEXT_DEFAULT_BASE[apiType]).replace(/\/+$/, '');
    let key = String(settings.textApiKey || '').trim();
    let keySource = 'text';
    if (!key && apiType === 'gemini') {
      key = LT.Settings.pickKey(settings);
      keySource = 'live';
    }
    return {
      apiType,
      baseUrl,
      key,
      keySource,
      model: String(settings.textModel || '').trim(),
      concurrency: settings.textConcurrency,
      path: settings.textRequestPath || 'auto',
    };
  }

  function buildRequest(config, system, user) {
    if (config.apiType === 'openai') {
      return {
        url: `${config.baseUrl}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: true,
          temperature: 0.4,
        }),
      };
    }
    return {
      url: `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    };
  }

  /** 把流式事件合成文本；Gemini 与 OpenAI 的事件结构不同，其他兼容接口按 OpenAI 处理。 */
  function collect(apiType, events) {
    let text = '';
    let finishReason = '';
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (apiType === 'openai') {
        const choice = Array.isArray(ev.choices) ? ev.choices[0] : null;
        if (!choice) continue;
        const delta = choice.delta || choice.message || {};
        if (typeof delta.content === 'string') text += delta.content;
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } else {
        const cand = Array.isArray(ev.candidates) ? ev.candidates[0] : null;
        if (!cand) continue;
        const parts = (cand.content && cand.content.parts) || [];
        for (const p of parts) if (typeof p.text === 'string' && !p.thought) text += p.text;
        if (cand.finishReason) finishReason = cand.finishReason;
      }
    }
    return { text, finishReason };
  }

  function parseRetryAfter(header, body) {
    const sec = Number(header);
    if (header && Number.isFinite(sec)) return Math.max(1000, sec * 1000);
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body || '');
    if (m) return Math.max(1000, Number(m[1]) * 1000);
    return 0;
  }

  function errorMessage(status, body) {
    let detail = '';
    try {
      const o = JSON.parse(body);
      const e = Array.isArray(o) ? o[0] && o[0].error : o && o.error;
      detail = (e && (e.message || e.status)) || '';
    } catch (_) {
      detail = String(body || '').slice(0, 160);
    }
    let hint = `HTTP ${status}`;
    if (status === 401 || status === 403) hint = 'API Key 无效或没有该模型的权限';
    else if (status === 404) hint = '模型名不存在或接口地址不对';
    else if (status === 429) hint = '触发限流';
    else if (status === 400) hint = '请求被拒绝';
    return detail ? `${hint}：${detail}` : hint;
  }

  /**
   * @param {{config:object, system:string, user:string, signal?:AbortSignal}} args
   * @returns {Promise<{text:string, finishReason:string, via:string}>}
   */
  async function translate({ config, system, user, signal }) {
    if (!config.key) throw new RequestError('未配置 API Key，请在扩展设置里填写', { fatal: true });
    if (!config.model) throw new RequestError('未填写文字模型名，请在扩展设置里填写', { fatal: true });
    try {
      new URL(config.baseUrl); // eslint-disable-line no-new
    } catch (_) {
      throw new RequestError(`接口地址无效：${config.baseUrl}`, { fatal: true });
    }
    const req = buildRequest(config, system, user);
    const res = await LT.Net.post({ ...req, signal, path: config.path });
    if (!res.ok) {
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.retryAfter, res.text) : 0;
      const fatal = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
      throw new RequestError(errorMessage(res.status, res.text), { status: res.status, retryAfterMs, fatal });
    }
    const out = collect(config.apiType, LT.Net.parseSse(res.text));
    if (!out.text.trim()) throw new RequestError('模型没有返回内容', { status: res.status });
    return { text: out.text, finishReason: out.finishReason, via: res.via };
  }

  LT.TextModel = { RequestError, resolve, buildRequest, collect, translate };
})();
