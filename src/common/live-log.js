/** 直播诊断日志：默认关闭；基础级别只记状态，详细级别额外记文本与提示词。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const PREFIX = 'lt:live-log:';
  const MAX_EVENTS = 3000;
  const MAX_COMPLETED = 20;
  let pruneChain = Promise.resolve();

  function redact(value, secrets = []) {
    let text = String(value == null ? '' : value);
    for (const secret of secrets) {
      if (secret && secret.length >= 6) text = text.split(secret).join('[API_KEY]');
    }
    return text
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [API_KEY]')
      .replace(/sk-[a-z0-9._-]{8,}/gi, '[API_KEY]')
      .replace(/AIza[a-z0-9_-]{20,}/g, '[API_KEY]')
      .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[API_KEY]');
  }

  function safe(value, secrets, max = 2000) {
    if (typeof value === 'string') return redact(value, secrets).slice(0, max);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    if (Array.isArray(value)) return value.slice(0, 30).map((x) => safe(x, secrets, max));
    if (typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        if (/^(?:key|.*apiKeys?|authorization|token|headers)$/i.test(key)) continue;
        out[key] = safe(item, secrets, max);
      }
      return out;
    }
    return undefined;
  }

  async function list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key, value]) => key.startsWith(PREFIX) && value && value.format === 'liuyi-live-log-v1')
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async function prune() {
    const completed = (await list()).filter((item) => item.endedAt);
    const stale = completed.slice(MAX_COMPLETED).map((item) => item.key);
    if (stale.length) await chrome.storage.local.remove(stale);
  }

  class Recorder {
    constructor(opts) {
      this.level = opts.level;
      this.secrets = opts.secrets || [];
      this.key = PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      this.data = {
        format: 'liuyi-live-log-v1',
        startedAt: Date.now(),
        endedAt: null,
        reason: '',
        level: this.level,
        provider: opts.provider,
        model: opts.model,
        videoId: opts.videoId || '',
        sourceLang: opts.sourceLang,
        targetLang: opts.targetLang,
        events: [],
        droppedEvents: 0,
        audioChunks: 0,
        audioBytes: 0,
      };
      this.pendingAudioChunks = 0;
      this.pendingAudioBytes = 0;
      this.lastAudioEventAt = Date.now();
      this.timer = null;
      this.writes = Promise.resolve();
      this.closed = false;
      this.event('start', { reason: opts.reason });
      this.flush().catch(() => {});
    }

    details(value) {
      if (this.level !== 'detailed' || this.closed) return;
      this.data.details = { ...(this.data.details || {}), ...safe(value, this.secrets, 12000) };
      this.schedule();
    }

    event(type, value = {}, detailed = false) {
      if (this.closed || (detailed && this.level !== 'detailed')) return;
      this.data.events.push({ ms: Date.now() - this.data.startedAt, type, data: safe(value, this.secrets) });
      if (this.data.events.length > MAX_EVENTS) {
        this.data.events.shift();
        this.data.droppedEvents++;
      }
      this.schedule();
    }

    audioChunk(bytes) {
      if (this.closed) return;
      this.data.audioChunks++;
      this.data.audioBytes += bytes;
      this.pendingAudioChunks++;
      this.pendingAudioBytes += bytes;
      if (Date.now() - this.lastAudioEventAt >= 15000) this.flushAudio();
    }

    flushAudio() {
      if (!this.pendingAudioChunks) return;
      this.event('audio_stats', { chunks: this.pendingAudioChunks, bytes: this.pendingAudioBytes });
      this.pendingAudioChunks = 0;
      this.pendingAudioBytes = 0;
      this.lastAudioEventAt = Date.now();
    }

    schedule() {
      if (this.timer || this.closed) return;
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 2000);
    }

    flush() {
      clearTimeout(this.timer);
      this.timer = null;
      const snapshot = JSON.parse(JSON.stringify(this.data));
      this.writes = this.writes.catch(() => {}).then(() => chrome.storage.local.set({ [this.key]: snapshot }));
      return this.writes;
    }

    finish(reason) {
      if (this.closed) return this.writes;
      this.flushAudio();
      this.event('end', { reason });
      this.data.endedAt = Date.now();
      this.data.reason = String(reason || 'stopped');
      this.closed = true;
      const done = this.flush().catch(() => {});
      pruneChain = pruneChain.catch(() => {}).then(() => done).then(prune).catch(() => {});
      return done;
    }
  }

  function secretsFrom(settings) {
    return [
      ...(String(settings.apiKeys || '').split(',')),
      settings.qwenApiKey,
      settings.ttsGeminiApiKey,
      ...(settings.providers || []).map((p) => p.apiKey),
      ...(settings.providers || []).flatMap((p) => Object.values(p.headers || {})),
    ].map((x) => String(x || '').trim()).filter(Boolean);
  }

  /** 日志关闭时用它代替 null，调用方不必逐处判空。 */
  const NOOP = Object.freeze({
    details() {}, event() {}, audioChunk() {}, flushAudio() {},
    finish() { return Promise.resolve(); },
  });

  function open(opts, settings) {
    if (!['basic', 'detailed'].includes(opts.level)) return null;
    return new Recorder({ ...opts, secrets: secretsFrom(settings || {}) });
  }

  async function remove(key) {
    if (!String(key).startsWith(PREFIX)) throw new Error('日志编号无效');
    await chrome.storage.local.remove(key);
  }

  LT.LiveLog = { open, list, remove, redact, safe, secretsFrom, NOOP };
})();
