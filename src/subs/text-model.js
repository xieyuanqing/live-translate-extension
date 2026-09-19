/**
 * 文字翻译模型客户端：Gemini generateContent 与 OpenAI 兼容 chat/completions。
 * 只负责一次请求：拼请求、发出去、把流式响应合成完整文本和结束原因。重试与分块在 video-subs.js。
 * 另外提供设置页用的三件事：查模型信息（不花额度）、列出可用模型、按翻译的完整路径做一次生成测试。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const PROBE_TIMEOUT_MS = 15000;

  class RequestError extends Error {
    constructor(message, { status = 0, retryAfterMs = 0, fatal = false } = {}) {
      super(message);
      this.name = 'RequestError';
      this.status = status;
      this.retryAfterMs = retryAfterMs;
      this.fatal = fatal;
    }
  }

  /**
   * 从设置里整理出本次任务用的模型配置；传 providerId 可取指定的一套。
   * Gemini 没单独填 Key 时复用 Live 的 Key；模型名允许带 models/ 前缀，这里去掉。
   */
  function resolve(settings, providerId) {
    const p = LT.Settings.provider(settings, providerId);
    const apiType = p.apiType === 'openai' ? 'openai' : 'gemini';
    const baseUrl = String(p.baseUrl || LT.TEXT_DEFAULT_BASE[apiType]).replace(/\/+$/, '');
    let key = String(p.apiKey || '').trim();
    let keySource = 'provider';
    if (!key && apiType === 'gemini') {
      key = LT.Settings.pickKey(settings);
      keySource = 'live';
    }
    let model = String(p.model || '').trim();
    if (apiType === 'gemini') model = model.replace(/^models\//, '');
    return {
      id: p.id,
      name: p.name || (LT.TEXT_API_TYPES.find((t) => t.code === apiType) || {}).label || apiType,
      apiType,
      baseUrl,
      key,
      keySource,
      model,
      concurrency: p.concurrency,
      path: p.requestPath || 'auto',
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

  function checkConfig(config) {
    if (!config.key) throw new RequestError('未配置 API Key，请在扩展设置里填写', { fatal: true });
    try {
      new URL(config.baseUrl); // eslint-disable-line no-new
    } catch (_) {
      throw new RequestError(`接口地址无效：${config.baseUrl}`, { fatal: true });
    }
  }

  /**
   * @param {{config:object, system:string, user:string, signal?:AbortSignal}} args
   * @returns {Promise<{text:string, finishReason:string, via:string}>}
   */
  async function translate({ config, system, user, signal }) {
    checkConfig(config);
    if (!config.model) throw new RequestError('未填写文字模型名，请在扩展设置里填写', { fatal: true });
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

  // ---------- 设置页用：查模型、列模型、生成测试 ----------

  /** 从模型列表响应里取模型名；Gemini 只留支持 generateContent 的，并去掉 models/ 前缀。 */
  function modelIds(apiType, text) {
    let o;
    try {
      o = JSON.parse(text);
    } catch (_) {
      return [];
    }
    if (apiType === 'openai') {
      return (Array.isArray(o && o.data) ? o.data : [])
        .map((m) => m && m.id)
        .filter((id) => typeof id === 'string' && id);
    }
    return (Array.isArray(o && o.models) ? o.models : [])
      .filter((m) => m && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent')))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  function listRequest(config) {
    return config.apiType === 'openai'
      ? { url: `${config.baseUrl}/models`, headers: { authorization: `Bearer ${config.key}` } }
      : { url: `${config.baseUrl}/v1beta/models?pageSize=200`, headers: { 'x-goog-api-key': config.key } };
  }

  /** 列出账号实际可用的模型名。 */
  async function listModels(config, signal) {
    checkConfig(config);
    const res = await LT.Net.request({ method: 'GET', ...listRequest(config), signal, path: config.path, timeoutMs: PROBE_TIMEOUT_MS });
    if (!res.ok) throw new RequestError(errorMessage(res.status, res.text), { status: res.status });
    return modelIds(config.apiType, res.text);
  }

  /**
   * 第一级测试：只查模型信息或模型列表，不消耗生成额度。
   * 通过只说明 Key 能访问查询接口、模型名存在；不证明生成请求、额度和流式响应可用。
   * @returns {Promise<{ok:boolean, message:string, ms:number, via?:string, models?:string[], listed?:boolean}>}
   */
  async function probe(config, signal) {
    const t0 = Date.now();
    checkConfig(config);
    const ms = () => Date.now() - t0;
    if (config.apiType === 'gemini' && config.model) {
      const res = await LT.Net.request({
        method: 'GET',
        url: `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}`,
        headers: { 'x-goog-api-key': config.key },
        signal,
        path: config.path,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (!res.ok) return { ok: false, ms: ms(), via: res.via, message: errorMessage(res.status, res.text) };
      let name = '';
      try {
        const o = JSON.parse(res.text);
        name = o.displayName || '';
      } catch (_) {
        /* 不是 JSON 也算通过，状态码已经是 200 */
      }
      return { ok: true, ms: ms(), via: res.via, message: `连接及模型查询通过${name ? `：${name}` : ''}` };
    }
    const res = await LT.Net.request({ method: 'GET', ...listRequest(config), signal, path: config.path, timeoutMs: PROBE_TIMEOUT_MS });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { ok: false, ms: ms(), via: res.via, message: '接口不提供模型列表，请用「生成测试」验证' };
    }
    if (!res.ok) return { ok: false, ms: ms(), via: res.via, message: errorMessage(res.status, res.text) };
    const models = modelIds(config.apiType, res.text);
    if (!config.model) {
      return { ok: true, ms: ms(), via: res.via, models, message: `连接通过，共 ${models.length} 个可用模型；还没填模型名` };
    }
    const listed = models.includes(config.model);
    return {
      ok: true,
      ms: ms(),
      via: res.via,
      models,
      listed,
      message: listed
        ? `连接及模型查询通过（列表共 ${models.length} 个）`
        : `连接通过，但列表里没有该模型（共 ${models.length} 个），仍可能可用`,
    };
  }

  /** 第二级测试：走和翻译完全相同的请求路径发一条极短请求，会消耗少量额度。 */
  async function generateTest(config, signal) {
    const t0 = Date.now();
    const out = await translate({
      config,
      system: '你是字幕翻译助手。收到「编号<TAB>原文」后，只输出「编号<TAB>中文译文」一行，不要输出其他内容。',
      user: '1\tこんにちは',
      signal,
    });
    return { ok: true, ms: Date.now() - t0, via: out.via, sample: out.text.trim().replace(/\s+/g, ' ').slice(0, 40) };
  }

  LT.TextModel = { RequestError, resolve, buildRequest, collect, translate, modelIds, listModels, probe, generateTest };
})();
