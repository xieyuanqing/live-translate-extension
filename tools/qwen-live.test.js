/** 千问协议回归：模拟浏览器握手与服务端事件，不调用真实接口。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const ports = [];
  const sockets = [];
  const states = [];
  const sources = [];
  const outputs = [];
  const diagnostics = [];
  const completed = [];
  const timers = new Map();
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    event(value) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const ctx = vm.createContext({
    console, WebSocket: Socket, TextDecoder, btoa,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => -1, clearInterval() {},
    chrome: { runtime: { connect({ name }) {
      const port = { name, messages: [], disconnected: false, onMessage: { addListener(fn) { port.receive = fn; } },
        onDisconnect: { addListener(fn) { port.didDisconnect = fn; } },
        postMessage(msg) { port.messages.push(msg); },
        disconnect() { port.disconnected = true; port.didDisconnect(); } };
      ports.push(port);
      return port;
    } } },
  });
  for (const file of ['src/common/constants.js', 'src/common/live-context.js', 'src/content/qwen-live.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  }
  const client = new ctx.LT.QwenLiveClient({
    workspaceHost: 'ws-example.cn-beijing.maas.aliyuncs.com', apiKey: 'sk-test-only',
    targetLang: 'zh', phrases: { エペ: 'APEX' },
    listener: { onState: s => states.push(s), onInputText: s => sources.push(s), onOutputText: s => outputs.push(s),
      onOutputComplete: info => completed.push(info), onDiagnostic: (type, value) => diagnostics.push({ type, value }) },
  });
  return { client, ports, sockets, states, sources, outputs, diagnostics, completed, timers,
    fireTimer(ms) { const entry = [...timers].find(([,t]) => t.ms === ms); assert.ok(entry, `缺少 ${ms} ms 定时器`); timers.delete(entry[0]); entry[1].fn(); } };
}

test('认证留在后台端口，WebSocket URL 不含 Key，握手后撤销规则', () => {
  const h = harness();
  h.client.start();
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].messages[0].key, 'sk-test-only');
  h.ports[0].receive({ type: 'prepared' });
  assert.equal(h.sockets.length, 1);
  assert.ok(!h.sockets[0].url.includes('sk-test-only'));
  h.sockets[0].open();
  assert.equal(h.ports[0].disconnected, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.sockets[0].sent[0])), {
    type: 'session.update', session: { output_modalities: ['text'], translation: { language: 'zh', corpus: { phrases: { エペ: 'APEX' } } } },
  });
  h.client.stop();
  assert.equal(h.sockets[0].sent.at(-1).type, 'session.finish');
  h.sockets[0].event({ type: 'session.finished' });
  assert.equal(h.sockets[0].readyState, 3);
});

test('收到 ready 才送 PCM，原文和译文事件进入字幕监听器', () => {
  const h = harness();
  h.client.start();
  h.client.feedChunk(Uint8Array.from([1, 2, 3]));
  h.ports[0].receive({ type: 'prepared' });
  const ws = h.sockets[0];
  ws.open();
  assert.equal(ws.sent.length, 1);
  ws.event({ type: 'session.updated' });
  assert.equal(ws.sent[1].type, 'input_audio_buffer.append');
  assert.equal(ws.sent[1].audio, 'AQID');
  ws.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'こん' });
  ws.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'こんにちは' });
  ws.event({ type: 'response.text.delta', response_id: 'r1', delta: '你好' });
  ws.event({ type: 'response.text.done', response_id: 'r1', text: '你好' });
  assert.deepEqual(h.sources, ['こん', 'こんにちは']);
  assert.deepEqual(h.outputs, ['你好']);
  h.client.stop();
});

test('停止后迟到的授权回复不会创建连接', () => {
  const h = harness();
  h.client.start();
  h.client.stop();
  h.ports[0].receive({ type: 'prepared' });
  assert.equal(h.sockets.length, 0);
});

test('120 秒轮换先结束旧会话，保留尾部结果，再只建立一次新连接', () => {
  const h = harness(); h.client.start(); h.ports[0].receive({ type: 'prepared' });
  const ws = h.sockets[0]; ws.open(); ws.event({ type: 'session.updated' });
  h.fireTimer(120000);
  assert.equal(ws.sent.at(-1).type, 'session.finish');
  assert.equal(ws.readyState, 1);
  h.client.feedChunk(Uint8Array.from([3, 4]));
  assert.equal(h.client.queue.length, 1);
  ws.event({ type: 'response.text.delta', response_id: 'tail', delta: '旧会话尾句。' });
  assert.deepEqual(h.outputs, ['旧会话尾句。']);
  ws.event({ type: 'session.finished' });
  assert.equal(h.ports.length, 2);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(h.states, ['connecting', 'ready', 'rotating']);
  assert.ok(![...h.timers.values()].some(t => t.ms === 3000));
  ws.event({ type: 'session.finished' });
  assert.equal(h.ports.length, 2);
  h.ports[1].receive({ type: 'prepared' });
  h.sockets[1].open(); h.sockets[1].event({ type: 'session.updated' });
  assert.equal(h.sockets[1].sent[1].type, 'input_audio_buffer.append');
  h.client.stop();
});

test('结束确认超时或等待期间停止，轮换定时器不会复活会话', () => {
  for (const stop of [false, true]) {
    const h = harness(); h.client.start(); h.ports[0].receive({ type: 'prepared' });
    h.sockets[0].open(); h.sockets[0].event({ type: 'session.updated' });
    h.fireTimer(120000);
    const timeout = [...h.timers.values()].find(t => t.ms === 3000).fn;
    if (stop) h.client.stop();
    timeout();
    assert.equal(h.ports.length, stop ? 1 : 2);
    h.client.stop();
  }
});

test('不同输出编号的相同文本照常输出，重发同一事件或 done 不重复显示', () => {
  const h = harness(); h.client.start(); h.ports[0].receive({ type: 'prepared' });
  const ws = h.sockets[0]; ws.open(); ws.event({ type: 'session.updated' });
  const delta = { type: 'response.text.delta', response_id: 'r1', event_id: 'e1', delta: '祝我生日快乐。' };
  ws.event(delta); ws.event(delta);
  ws.event({ type: 'response.text.done', response_id: 'r1', text: '祝我生日快乐。' });
  ws.event({ type: 'response.text.done', response_id: 'r1', text: '祝我生日快乐。' });
  ws.event({ ...delta, response_id: 'r2', event_id: 'e2' });
  ws.event({ type: 'response.text.done', response_id: 'r2', text: '祝我生日快乐。' });
  assert.deepEqual(h.outputs, ['祝我生日快乐。', '祝我生日快乐。']);
  assert.equal(h.completed.length, 2);
  ws.onclose({ code: 1006, reason: '测试断线' });
  const closed = h.diagnostics.find(d => d.type === 'connection_close');
  assert.equal(closed.value.code, 1006);
  assert.equal(closed.value.reason, '测试断线');
  h.client.stop();
});
