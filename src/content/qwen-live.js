/** 千问 3.8 LiveTranslate：沿用有界音频队列与会话代际，认证头由后台临时规则提供。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const MAX_QUEUE = 200;
  const OVERLAP_CHUNKS = 10;
  const MAX_BUFFERED = 512 * 1024;
  const HANDSHAKE_TIMEOUT_MS = 12000;
  const ROTATE_AFTER_MS = 120000;

  function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function urlForHost(host) {
    const value = String(host || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(value)) {
      throw new Error('千问业务空间域名无效，请填写百炼提供的完整域名');
    }
    return `wss://${value}/api-ws/v1/realtime?model=${LT.QWEN_MODEL}`;
  }

  class QwenLiveClient {
    constructor(opts) {
      this.opts = opts;
      this.listener = opts.listener;
      this.queue = [];
      this.sentRing = [];
      this.sourceByItem = new Map();
      this.outputIds = new Set();
      this.completedOutputIds = new Set();
      this.receivedEventIds = new Set();
      this.finishing = false;
      this.running = false;
      this.ready = false;
      this.ws = null;
      this.authPort = null;
      this.generation = 0;
      this.retryDelayMs = 1000;
      this.lastServerError = '';
      this.chunksSent = 0;
      this.droppedChunks = 0;
      this.drainTimer = null;
      this.rotateTimer = null;
      this.watchdogTimer = null;
      this.reconnectTimer = null;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.drainTimer = setInterval(() => this.#drain(), 100);
      this.#connect('connecting');
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      this.generation++;
      this.#clearTimers();
      clearInterval(this.drainTimer);
      this.#disconnectAuth();
      const ws = this.ws;
      this.ws = null;
      this.ready = false;
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('{"type":"session.finish"}');
            const close = () => { try { ws.close(1000, 'bye'); } catch (_) { /* 已关闭 */ } };
            const deadline = setTimeout(close, 3000);
            ws.onmessage = (event) => {
              try { if (JSON.parse(event.data).type === 'session.finished') { clearTimeout(deadline); close(); } }
              catch (_) { /* 忽略非 JSON 尾包 */ }
            };
            ws.onclose = () => clearTimeout(deadline);
          } else ws.close(1000, 'bye');
        } catch (_) { /* 已关闭 */ }
      }
      this.queue.length = 0;
      this.sentRing.length = 0;
      this.sourceByItem.clear();
      this.outputIds.clear();
      this.completedOutputIds.clear();
      this.receivedEventIds.clear();
      this.listener.onState('stopped');
    }

    feedChunk(u8) {
      if (!this.running) return;
      if (this.queue.length >= MAX_QUEUE) { this.queue.shift(); this.droppedChunks++; }
      this.queue.push(u8);
      this.#drain();
    }

    #clearTimers() {
      clearTimeout(this.rotateTimer);
      clearTimeout(this.watchdogTimer);
      clearTimeout(this.reconnectTimer);
    }

    #disconnectAuth() {
      const port = this.authPort;
      this.authPort = null;
      if (port) try { port.disconnect(); } catch (_) { /* 已断开 */ }
    }

    #connect(state = 'reconnecting') {
      if (!this.running) return;
      this.ready = false;
      this.#clearTimers();
      const wasFinishing = this.finishing;
      this.finishing = false;
      const gen = ++this.generation;
      this.lastServerError = '';
      this.sentRing.length = 0;
      this.sourceByItem.clear();
      this.outputIds.clear();
      this.completedOutputIds.clear();
      this.receivedEventIds.clear();
      const old = this.ws;
      this.ws = null;
      this.#disconnectAuth();
      try { if (old) old.close(1000, 'replace'); } catch (_) { /* 已关闭 */ }
      if (!(state === 'rotating' && wasFinishing)) this.listener.onState(state);

      let url;
      try {
        url = urlForHost(this.opts.workspaceHost);
        if (!this.opts.apiKey) throw new Error('未配置千问 API Key');
        if (this.opts.targetLang === 'zh-Hant') throw new Error('千问暂不支持繁体中文目标，请选择中文或简体中文');
      } catch (err) {
        this.listener.onState('error:' + err.message);
        return;
      }

      let port;
      try {
        port = chrome.runtime.connect({ name: LT.QWEN_AUTH_PORT });
      } catch (_) {
        this.listener.onState('error:无法向扩展后台申请千问连接');
        return;
      }
      this.authPort = port;
      port.onMessage.addListener((msg) => {
        if (!this.running || this.generation !== gen) return;
        if (msg.type === 'error') {
          this.#disconnectAuth();
          this.listener.onState('error:' + msg.message);
          // 授权或配置错误不会自行变好；改设置后重开即可。
          return;
        }
        if (msg.type !== 'prepared') return;
        let ws;
        try { ws = new WebSocket(url); }
        catch (err) {
          this.#disconnectAuth();
          this.listener.onState('error:' + (err && err.message ? err.message : '千问连接创建失败'));
          this.#scheduleReconnect(false);
          return;
        }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          if (!this.running || this.generation !== gen) return;
          // Authorization 只在握手时用；连接建立后马上移除带 Key 的临时规则。
          this.#disconnectAuth();
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              output_modalities: ['text'],
              translation: LT.LiveContext.translationConfig(this.opts.targetLang, this.opts.phrases),
            },
          }));
        };
        ws.onmessage = (e) => {
          if (!this.running || this.generation !== gen) return;
          this.#handle(gen, e.data);
        };
        ws.onclose = (e) => {
          if (!this.running || this.generation !== gen) return;
          this.#disconnectAuth();
          this.listener.onDiagnostic?.('connection_close', { code: e.code, reason: e.reason || '', serverError: this.lastServerError, finishing: this.finishing });
          if (this.finishing) { this.#connect('rotating'); return; }
          const repeat = e.code === 1007 && /repeat/i.test(`${e.reason || ''} ${this.lastServerError}`);
          if (repeat) {
            // 同一段重复口癖可能反复触发服务端 1007；跳过待发的故障音频，继续后面的直播。
            this.droppedChunks += this.queue.length;
            this.queue.length = 0;
            this.sentRing.length = 0;
            this.listener.onState('error:千问在重复语音处中断，已跳过故障段并重连');
          }
          this.#scheduleReconnect(!repeat, repeat);
        };
      });
      port.onDisconnect.addListener(() => {
        if (this.authPort === port && this.running && this.generation === gen && !this.ws) {
          this.authPort = null;
          this.#scheduleReconnect(false);
        }
      });
      try { port.postMessage({ type: 'prepare', url, key: this.opts.apiKey }); }
      catch (_) {
        this.#disconnectAuth();
        this.#scheduleReconnect(false);
        return;
      }
      this.watchdogTimer = setTimeout(() => {
        if (!this.running || this.generation !== gen || this.ready) return;
        this.generation++;
        this.#disconnectAuth();
        try { if (this.ws) this.ws.close(4000, 'handshake timeout'); } catch (_) { /* ignore */ }
        this.#scheduleReconnect(true);
      }, HANDSHAKE_TIMEOUT_MS);
    }

    #scheduleReconnect(withOverlap, preserveError = false) {
      if (!this.running) return;
      this.ready = false;
      this.#clearTimers();
      if (withOverlap && this.sentRing.length) {
        const queue = this.sentRing.concat(this.queue);
        this.droppedChunks += Math.max(0, queue.length - MAX_QUEUE);
        this.queue = queue.slice(-MAX_QUEUE);
      }
      this.sentRing.length = 0;
      this.sourceByItem.clear();
      this.outputIds.clear();
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(delay * 2, 15000);
      if (!preserveError) this.listener.onState('reconnecting');
      this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    }

    #handle(gen, data) {
      let event;
      try { event = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      catch (_) { return; }
      // 按协议事件编号去重，不能凭相同文字判断复读。
      if (event.event_id) {
        if (this.receivedEventIds.has(event.event_id)) return;
        this.receivedEventIds.add(event.event_id);
        if (this.receivedEventIds.size > 1000) this.receivedEventIds.delete(this.receivedEventIds.values().next().value);
      }
      if (event.type === 'session.updated') {
        this.ready = true;
        this.retryDelayMs = 1000;
        clearTimeout(this.watchdogTimer);
        this.rotateTimer = setTimeout(() => {
          if (!this.running || this.generation !== gen) return;
          this.ready = false;
          this.finishing = true;
          this.listener.onState('rotating');
          try { this.ws.send('{"type":"session.finish"}'); }
          catch (_) { this.#connect('rotating'); return; }
          this.rotateTimer = setTimeout(() => {
            if (this.running && this.generation === gen) this.#connect('rotating');
          }, 3000);
        }, ROTATE_AFTER_MS);
        this.listener.onState('ready');
        this.#drain();
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const id = event.item_id || 'current';
        const source = (this.sourceByItem.get(id) || '') + (event.delta || '');
        this.sourceByItem.set(id, source);
        if (source) this.listener.onInputText(source, { generation: gen, itemId: id, kind: 'delta', eventId: event.event_id });
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const id = event.item_id || 'current';
        const source = event.transcript || event.text || this.sourceByItem.get(id) || '';
        this.sourceByItem.delete(id);
        if (source) this.listener.onInputText(source, { generation: gen, itemId: id, kind: 'completed', eventId: event.event_id });
      } else if (event.type === 'response.text.delta') {
        const delta = event.delta || '';
        const id = event.response_id || event.item_id || 'current';
        if (id !== 'current' && this.completedOutputIds.has(id)) return;
        if (delta) {
          this.outputIds.add(id);
          this.listener.onOutputText(delta, { generation: gen, responseId: event.response_id, itemId: event.item_id, kind: 'delta', eventId: event.event_id });
        }
      } else if (event.type === 'response.text.done') {
        const id = event.response_id || event.item_id || 'current';
        if (id !== 'current' && this.completedOutputIds.has(id)) return;
        if (!this.outputIds.has(id) && event.text) this.listener.onOutputText(event.text, { generation: gen, responseId: event.response_id, itemId: event.item_id, kind: 'done' });
        this.outputIds.delete(id);
        if (id !== 'current') {
          this.completedOutputIds.add(id);
          if (this.completedOutputIds.size > 200) this.completedOutputIds.delete(this.completedOutputIds.values().next().value);
        }
        this.listener.onOutputComplete?.({ generation: gen, responseId: event.response_id, itemId: event.item_id });
      } else if (event.type === 'error') {
        const reason = event.error && (event.error.message || event.error.code) || '服务端返回错误';
        this.lastServerError = String(reason);
        this.listener.onState('error:千问：' + String(reason).slice(0, 120));
      } else if (event.type === 'session.finished') {
        if (this.running && this.generation === gen) this.#connect('rotating');
      }
    }

    #drain() {
      const ws = this.ws;
      if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      while (this.queue.length && ws.bufferedAmount <= MAX_BUFFERED) {
        const chunk = this.queue.shift();
        try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(chunk) })); }
        catch (_) { this.queue.unshift(chunk); break; }
        this.sentRing.push(chunk);
        if (this.sentRing.length > OVERLAP_CHUNKS) this.sentRing.shift();
        this.chunksSent++;
        if (this.chunksSent % 150 === 0) this.#audioStats();
      }
    }

    #audioStats() {
      this.listener.onDiagnostic?.('audio_sent', { sentChunks: this.chunksSent, queuedChunks: this.queue.length, droppedChunks: this.droppedChunks });
    }
  }

  LT.QwenLiveClient = QwenLiveClient;
  LT.QwenLiveUrl = urlForHost;
})();
