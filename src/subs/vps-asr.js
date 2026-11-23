/**
 * VPS 云端音频转写客户端：与自建 vps-asr-server 通信。
 * 约定接口：GET /health、GET /api/models、POST /api/transcribe、GET /api/jobs/:id?afterSeq=N、POST /api/jobs/:id/cancel。
 * 支持增量流式回调 onChunk：VPS 每转写完一个音频分片就立即交给扩展端并行翻译并上屏，无需等全片结束。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const abortError = () => new DOMException('已取消', 'AbortError');
  const NON_RETRYABLE_POLL_STATUS = new Set([400, 401, 403, 404, 422]);

  function normalizeBaseUrl(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    let url;
    try {
      url = new URL(text);
    } catch (_) {
      throw new Error('VPS 服务地址无效，请填写 http 或 https 地址');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('VPS 服务地址必须使用 http 或 https');
    }
    return url.toString().replace(/\/+$/, '');
  }

  function authHeaders(token) {
    const value = String(token || '').trim();
    return value ? { Authorization: `Bearer ${value}` } : {};
  }

  function normalizeModels(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(item => {
        if (typeof item === 'string') {
          return { id: item, label: item, provider: '', description: '', supportsContext: false };
        }
        if (!item || !item.id) return null;
        return {
          id: String(item.id),
          label: String(item.label || item.name || item.id),
          provider: String(item.provider || ''),
          description: String(item.description || ''),
          supportsContext: item.supportsContext !== false,
        };
      })
      .filter(Boolean);
  }

  function normalizeUnits(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let last = 0;
    for (const item of raw) {
      if (!item) continue;
      const text = String(item.text || '').trim();
      if (!text) continue;
      const start = Number(item.startMs ?? item.start);
      const end = Number(item.endMs ?? item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const s = Math.max(last, Math.round(start), 0);
      const e = Math.max(s, Math.round(end));
      out.push({ id: out.length + 1, start: s, end: e, text });
      last = s;
    }
    return out;
  }

  function normalizeChunk(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const seq = Number(raw.seq);
    const index = Number(raw.index);
    if (!Number.isFinite(index) || index < 0) return null;
    return {
      seq: Number.isFinite(seq) ? seq : 0,
      index: Math.trunc(index),
      startMs: Math.max(0, Math.round(Number(raw.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(raw.endMs) || 0)),
      units: normalizeUnits(raw.units),
    };
  }

  function parseResponse(res) {
    let data = {};
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch (_) {
      data = {};
    }
    return { res, data };
  }

  function httpError(status, data) {
    const detail = data && data.error ? `：${data.error}` : '';
    let message;
    if (status === 401 || status === 403) message = `VPS 访问令牌无效或未授权（HTTP ${status}）`;
    else if (status === 404) message = 'VPS 接口路径不匹配，请检查服务地址';
    else if (status >= 500) message = `VPS 服务内部错误（HTTP ${status}）${detail}`;
    else message = `VPS 请求失败（HTTP ${status}）${detail}`;
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function networkError(err) {
    if (err && err.name === 'TimeoutError') return new Error('连接 VPS 转写服务超时，请检查网络或服务状态');
    if (err && err.name === 'AbortError') return err;
    return new Error('无法连接 VPS 转写服务，请检查服务是否在线、地址是否正确且域名已授权');
  }

  async function request(base, path, options) {
    try {
      const res = await LT.Net.request({ url: `${base}${path}`, path: 'auto', ...options });
      const parsed = parseResponse(res);
      if (!res.ok) throw httpError(res.status, parsed.data);
      return parsed;
    } catch (err) {
      if (err && (err.name === 'AbortError' || Number.isInteger(err.status))) throw err;
      throw networkError(err);
    }
  }

  function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', aborted);
        resolve();
      }
      function aborted() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        reject(abortError());
      }
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  /**
   * 探测 VPS 状态与可用模型清单：
   * 优先请求 GET /health（单次往返即可拿到版本和模型列表）；若 /health 未携带 models 或返回 404，再请求 GET /api/models。
   */
  async function fetchServerInfo({ baseUrl, token, signal, timeoutMs = 12000 }) {
    const started = Date.now();
    const base = normalizeBaseUrl(baseUrl);
    const headers = authHeaders(token);
    let data = {};
    let via = '';
    let models = [];

    try {
      const health = await request(base, '/health', { method: 'GET', headers, signal, timeoutMs });
      if (health.data && health.data.ok === false) {
        throw new Error(health.data.error || 'VPS 健康检查返回异常');
      }
      data = health.data || {};
      via = health.res.via || '';
      models = normalizeModels(data.models);
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    if (!models.length) {
      const extra = await request(base, '/api/models', { method: 'GET', headers, signal, timeoutMs });
      data = { ...data, ...(extra.data || {}) };
      via = via || extra.res.via || '';
      models = normalizeModels(data.models);
    }

    return {
      ok: true,
      version: data.version || '',
      service: data.service || data.name || '',
      defaultModel: data.defaultModel || data.default_model || '',
      models,
      via,
      ms: Date.now() - started,
    };
  }

  async function transcribe({
    baseUrl,
    token,
    videoId,
    url,
    sourceLang,
    model,
    context,
    force,
    preferMs,
    signal,
    onProgress,
    onChunk,
    pollIntervalMs = 1000,
    maxWaitMs = 1800000,
  }) {
    const base = normalizeBaseUrl(baseUrl);
    const headers = { ...authHeaders(token), 'Content-Type': 'application/json' };
    const payload = {
      videoId,
      url,
      sourceLang,
      model,
      context,
      force: !!force,
      ...(Number.isFinite(preferMs) && preferMs > 0 ? { preferMs: Math.round(preferMs) } : {}),
    };

    const created = await request(base, '/api/transcribe', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    let data = created.data || {};
    if (data.status === 'done' && Array.isArray(data.units)) {
      const units = normalizeUnits(data.units);
      if (!units.length) throw new Error('VPS 转写结果为空');
      return {
        units,
        model: data.model || model || '',
        provider: data.provider || '',
        lang: data.lang || sourceLang || '',
        cached: !!data.cached,
      };
    }

    const jobId = data.jobId || data.job_id;
    if (!jobId) {
      throw new Error(`VPS 转写响应缺少任务编号${data.error ? `：${data.error}` : ''}`);
    }

    const notifyCancel = () => {
      request(base, `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers,
        body: '{}',
        timeoutMs: 5000,
      }).catch(() => {});
    };

    const seenIndexes = new Set();
    let lastSeq = 0;
    const emitChunks = (rawChunks, meta) => {
      if (!Array.isArray(rawChunks) || !rawChunks.length) return;
      for (const item of rawChunks) {
        const chunk = normalizeChunk(item);
        if (!chunk) continue;
        if (chunk.seq > lastSeq) lastSeq = chunk.seq;
        if (seenIndexes.has(chunk.index)) continue;
        seenIndexes.add(chunk.index);
        onChunk?.(chunk, meta);
      }
    };

    const started = Date.now();
    let disconnects = 0;
    let firstPoll = true;
    while (Date.now() - started < maxWaitMs) {
      if (signal?.aborted) {
        notifyCancel();
        throw abortError();
      }
      if (!firstPoll) {
        try {
          await sleepAbortable(pollIntervalMs, signal);
        } catch (err) {
          notifyCancel();
          throw err;
        }
      }
      firstPoll = false;

      try {
        const query = lastSeq > 0 ? `?afterSeq=${lastSeq}` : '';
        const polled = await request(base, `/api/jobs/${encodeURIComponent(jobId)}${query}`, {
          method: 'GET',
          headers,
          signal,
        });
        disconnects = 0;
        data = polled.data || {};
      } catch (err) {
        if (err.name === 'AbortError') {
          notifyCancel();
          throw err;
        }
        if (NON_RETRYABLE_POLL_STATUS.has(err.status)) throw err;
        disconnects += 1;
        if (disconnects >= 3) throw new Error(`VPS 转写服务连接中断：${err.message}`);
        continue;
      }

      if (Number.isFinite(Number(data.seq)) && Number(data.seq) > lastSeq && (!Array.isArray(data.chunks) || !data.chunks.length)) {
        lastSeq = Number(data.seq);
      }

      const progressInfo = {
        status: data.status || '',
        progress: Number(data.progress || 0),
        stage: data.stage || '',
        model: data.model || model || '',
        provider: data.provider || '',
        lang: data.lang || sourceLang || '',
        totalChunks: Number(data.totalChunks || 0),
        doneChunks: Number(data.doneChunks || 0),
      };
      emitChunks(data.chunks, progressInfo);
      onProgress?.(progressInfo);

      if (data.status === 'error') {
        throw new Error(`VPS 转写失败：${data.error || '未知错误'}`);
      }
      if (data.status === 'cancelled') {
        throw new Error('VPS 转写任务已取消');
      }
      if (data.status === 'done') {
        const units = normalizeUnits(data.units);
        if (!units.length && seenIndexes.size === 0) throw new Error('VPS 转写结果为空');
        return {
          units,
          model: data.model || model || '',
          provider: data.provider || '',
          lang: data.lang || sourceLang || '',
          cached: !!data.cached,
          streamedChunks: seenIndexes.size,
        };
      }
    }

    notifyCancel();
    throw new Error('VPS 转写服务超时，请检查网络或服务状态');
  }

  LT.VpsAsr = { normalizeBaseUrl, authHeaders, normalizeModels, normalizeUnits, fetchServerInfo, transcribe };
})();
