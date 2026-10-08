/** 会话竞态回归：模拟等待与时间推进，不访问浏览器、不连接真实 API。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const quiet = { info() {}, warn() {}, error() {} };
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

async function sessionHarness({ realSettings = false } = {}) {
  const video = { paused: false, muted: false, volume: 1 };
  const player = {};
  const clients = [], taps = [], statuses = [], subStarts = [], logs = [];
  let messageHandler, navigate;
  let videoId = 'video-A';
  const ctx = vm.createContext({ console: quiet, Date, setInterval() {},
    window: { addEventListener() {} },
    chrome: { runtime: {
      sendMessage: async (msg) => statuses.push(msg.payload),
      onMessage: { addListener(fn) { messageHandler = fn; } },
    } },
  });
  load(ctx, 'src/common/constants.js');
  load(ctx, 'src/common/settings.js');
  load(ctx, 'src/common/prompt.js');
  load(ctx, 'src/common/live-context.js');
  load(ctx, 'src/common/live-log.js');
  const LT = ctx.LT;
  LT.LiveLog = { ...LT.LiveLog, open(opts) {
    if (opts.level === 'off') return null;
    const log = { opts, events: [], detailsCalls: [], reason: '',
      event(type, value) { this.events.push({ type, value }); },
      audioChunk() {},
      details(value) { this.detailsCalls.push(value); },
      finish(reason) { this.reason = reason; return Promise.resolve(); },
    };
    logs.push(log);
    return log;
  } };
  let settings = { ...LT.DEFAULTS, autoStartLive: false, useMetadata: false, apiKeys: 'test-only' };
  const settingsAPI = LT.Settings;
  LT.Settings = {
    load: async () => settings,
    pickKey: s => s.apiKeys,
    keyList: s => s.apiKeys ? [s.apiKeys] : [],
    scene: s => s.scenes.find(x => x.id === s.sceneId),
    provider: (s, id) => s.providers.find(p => p.id === (id || s.subsProviderId)) || s.providers.find(p => !p.kind || p.kind === 'text'),
    serviceProvider: s => s.providers.find(p => p.kind === 'live' && p.id === s.liveProviderId) || { enabled: true },
  };
  if (realSettings) LT.Settings = { ...settingsAPI, load: async () => settingsAPI.normalize(settings) };
  LT.CaptionLayer = class {
    mount(p) { this.player = p; this.mounted = true; } unmount() { this.mounted = false; }
    applySettings() {} clear() {} setStatus() {} setVisible() {}
    pushCommitted() {} setCurrent() {} setSource() {} render() {}
  };
  LT.SubtitleStabilizer = class { reset() {} onFragment() {} };
  LT.VideoSubsController = class {
    status() { return { phase: 'idle' }; } start(args) { subStarts.push(args); } cancel() {} deactivate() {}
    onVideoChanged() {} tick() {} setVisible() {} updateSettings() {} async clearCache() {}
  };
  LT.PlayerControls = class { mount() {} unmount() {} update() {} };
  LT.GeminiLiveClient = class {
    constructor(opts) { this.opts = opts; this.starts = 0; this.running = false; clients.push(this); }
    start() { this.starts++; this.running = true; } stop() { this.running = false; }
    feedChunk() {}
  };
  LT.QwenLiveClient = class {
    constructor(opts) { this.opts = opts; this.starts = 0; this.running = false; clients.push(this); }
    start() { this.starts++; this.running = true; } stop() { this.running = false; }
    feedChunk() {}
  };
  LT.AudioTap = class {
    constructor() { this.detached = false; taps.push(this); }
    async attach() { return 'worklet'; } detach() { this.detached = true; } setGate() {}
  };
  LT.YouTube = {
    isWatchPage: () => true, videoIdFromUrl: () => videoId, player: () => player, video: () => video,
    waitForVideo: async () => video, waitForMeta: async () => ({ videoId, isLive: false }),
    onMetaPush() {}, onNavigate(fn) { navigate = fn; }, adShowing: () => false,
  };
  load(ctx, 'src/content/main.js');
  await flush();
  return { LT, video, clients, taps, statuses, subStarts, logs,
    setSettings: patch => { settings = { ...settings, ...patch }; },
    message: (type, payload, respond = () => {}) => messageHandler({ type, payload }, {}, respond),
    navigate: id => { videoId = id; navigate(); },
  };
}

test('等待播放器时停止，旧启动不会复活', async () => {
  const h = await sessionHarness();
  const wait = deferred();
  h.LT.YouTube.waitForVideo = () => wait.promise;
  const pending = h.LT.debug.start('test');
  await flush();
  assert.equal(h.LT.debug.session.phase, 'starting');
  await h.LT.debug.stop();
  wait.resolve(h.video);
  await pending;
  assert.equal(h.LT.debug.session.phase, 'idle');
  assert.equal(h.clients.length, 0);
});

test('取消后立即重新开始，旧任务失败不会清掉新会话', async () => {
  const h = await sessionHarness();
  const old = deferred();
  h.LT.YouTube.waitForVideo = () => old.promise;
  const pending = h.LT.debug.start('old');
  await flush();
  await h.LT.debug.stop();
  h.LT.YouTube.waitForVideo = async () => h.video;
  await h.LT.debug.start('new');
  old.reject(new Error('旧播放器已移除'));
  await pending;
  assert.equal(h.LT.debug.session.phase, 'running');
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].running, true);
});

test('切视频会作废仍在等待的启动', async () => {
  const h = await sessionHarness();
  const wait = deferred();
  h.LT.YouTube.waitForVideo = () => wait.promise;
  const pending = h.LT.debug.start('old-video');
  await flush();
  h.navigate('video-B');
  wait.resolve(h.video);
  await pending;
  await flush();
  assert.equal(h.LT.debug.session.phase, 'idle');
  assert.equal(h.clients.length, 0);
});

test('等待音频挂载时停止，客户端不启动并清理旁路', async () => {
  const h = await sessionHarness();
  const wait = deferred();
  h.LT.AudioTap.prototype.attach = () => wait.promise;
  const pending = h.LT.debug.start('test');
  await flush();
  await h.LT.debug.stop();
  wait.resolve('worklet');
  await pending;
  assert.equal(h.LT.debug.session.phase, 'idle');
  assert.equal(h.clients[0].starts, 0);
  assert.equal(h.taps[0].detached, true);
});

test('运行中修改配置不改变本场连接凭据和方向', async () => {
  const h = await sessionHarness();
  await h.LT.debug.start('test');
  h.setSettings({ apiKeys: 'new-test-key', targetLang: 'en' });
  h.message(h.LT.MSG.SETTINGS_CHANGED);
  await flush();
  assert.equal(h.clients[0].opts.keyProvider(), 'test-only');
  assert.equal(h.clients[0].opts.targetLang, 'zh');
});

test('统一直播配置按 ID 启动，切换同类型配置只影响重开，停用配置不创建连接', async () => {
  const h = await sessionHarness({ realSettings: true });
  const providers = [
    { id: 'text', kind: 'text', preset: 'openai' },
    { id: 'live-a', kind: 'live', preset: 'gemini-live', apiKey: 'live-a-key', baseUrl: 'wss://live-a.example' },
    { id: 'live-b', kind: 'live', preset: 'gemini-live', apiKey: 'live-b-key', baseUrl: 'wss://live-b.example' },
    { id: 'live-off', kind: 'live', preset: 'qwen-live', enabled: false, apiKey: 'off-key', workspaceHost: 'workspace.cn-beijing.maas.aliyuncs.com' },
    { id: 'speech', kind: 'speech', preset: 'microsoft-tts' },
  ];
  h.setSettings({ providers, liveProviderId: 'live-a' });
  await h.LT.debug.start('test');
  assert.equal(h.clients[0].opts.baseUrl, 'wss://live-a.example');
  assert.equal(h.clients[0].opts.keyProvider(), 'live-a-key');
  h.setSettings({ liveProviderId: 'live-b' });
  h.message(h.LT.MSG.SETTINGS_CHANGED); await flush();
  assert.equal(h.clients[0].opts.keyProvider(), 'live-a-key');
  h.LT.debug.stop(); await h.LT.debug.start('test');
  assert.equal(h.clients[1].opts.baseUrl, 'wss://live-b.example');
  assert.equal(h.clients[1].opts.keyProvider(), 'live-b-key');
  h.LT.debug.stop(); h.setSettings({ liveProviderId: 'live-off' });
  await h.LT.debug.start('test');
  assert.equal(h.clients.length, 2);
  assert.equal(h.LT.debug.session.phase, 'idle');
});

test('千问选项使用独立凭据并冻结本场连接', async () => {
  const h = await sessionHarness();
  h.setSettings({ liveProvider: 'qwen', qwenApiKey: 'sk-test-only', qwenWorkspaceHost: 'ws-test.cn-beijing.maas.aliyuncs.com' });
  await h.LT.debug.start('test');
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].opts.apiKey, 'sk-test-only');
  assert.equal(h.clients[0].opts.workspaceHost, 'ws-test.cn-beijing.maas.aliyuncs.com');
  h.setSettings({ qwenApiKey: 'sk-new-test', qwenWorkspaceHost: 'ws-new.cn-beijing.maas.aliyuncs.com' });
  h.message(h.LT.MSG.SETTINGS_CHANGED);
  await flush();
  assert.equal(h.clients[0].opts.apiKey, 'sk-test-only');
  assert.equal(h.clients[0].opts.workspaceHost, 'ws-test.cn-beijing.maas.aliyuncs.com');
});

test('开播背景整理进入 Gemini 提示词，千问只收到术语映射', async () => {
  for (const liveProvider of ['gemini', 'qwen']) {
    const h = await sessionHarness();
    h.setSettings({ liveProvider, useMetadata: true, qwenApiKey: 'sk-test-only', qwenWorkspaceHost: 'ws-test.cn-beijing.maas.aliyuncs.com' });
    h.LT.YouTube.waitForMeta = async () => ({ videoId: 'video-B', title: 'APEX 排位直播', description: '游戏直播' });
    h.navigate('video-B');
    await flush();
    h.LT.LiveContext.generate = async () => ({ background: 'APEX 排位赛', phrases: { アーマー: '护甲' } });
    await h.LT.debug.start('test');
    assert.equal(h.clients.length, 1);
    if (liveProvider === 'gemini') {
      assert.match(h.clients[0].opts.prompt, /APEX 排位赛/);
      assert.match(h.clients[0].opts.prompt, /アーマー＝护甲/);
    } else {
      assert.deepEqual(JSON.parse(JSON.stringify(h.clients[0].opts.phrases)), { アーマー: '护甲' });
    }
  }
});

test('停止时作废仍在等待的开播背景整理', async () => {
  const h = await sessionHarness();
  const wait = deferred();
  h.setSettings({ useMetadata: true });
  h.LT.YouTube.waitForMeta = async () => ({ videoId: 'video-B', title: 'APEX 排位直播' });
  h.navigate('video-B');
  await flush();
  h.LT.LiveContext.generate = () => wait.promise;
  const pending = h.LT.debug.start('test');
  await flush();
  await h.LT.debug.stop();
  wait.resolve({ background: '晚到的背景', phrases: {} });
  await pending;
  assert.equal(h.clients.length, 0);
  assert.equal(h.LT.debug.session.phase, 'idle');
});

test('详细调试在仅译文显示模式下仍记录原文与译文，停止时封存', async () => {
  const h = await sessionHarness();
  h.setSettings({ debugLogLevel: 'detailed', captionDisplayMode: 'translationOnly' });
  await h.LT.debug.start('test');
  assert.equal(h.logs.length, 1);
  h.clients[0].opts.listener.onInputText('こんにちは');
  h.clients[0].opts.listener.onOutputText('你好');
  await h.LT.debug.stop();
  assert.ok(h.logs[0].events.some((e) => e.type === 'source_text' && e.value.text === 'こんにちは'));
  assert.ok(h.logs[0].events.some((e) => e.type === 'translation_fragment' && e.value.text === '你好'));
  assert.equal(h.logs[0].reason, 'user');
});

test('开播前可预览且不开音频，开始复用相同结果，显示与实际配置一致', async () => {
  for (const liveProvider of ['gemini', 'qwen']) {
    const h = await sessionHarness();
    h.setSettings({ liveProvider, useMetadata: true, qwenApiKey: 'sk-test-only', qwenWorkspaceHost: 'ws-test.cn-beijing.maas.aliyuncs.com' });
    h.LT.YouTube.waitForMeta = async () => ({ videoId: 'video-B', author: 'YuNi - official channel -', title: '生日直播' });
    h.message(h.LT.MSG.SETTINGS_CHANGED);
    await flush();
    h.navigate('video-B'); await flush();
    let requests = 0;
    h.LT.LiveContext.generate = async () => { requests++; return { background: '生日直播', phrases: { ゆに: 'YuNi' } }; };
    const preview = await h.LT.debug.previewLiveContext();
    assert.equal(preview.ok, true);
    assert.equal(h.clients.length, 0);
    assert.equal(h.taps.length, 0);
    assert.equal(preview.review.phase, 'preview');
    assert.equal(preview.review.generated.phrases.YuNi, 'YuNi');
    h.setSettings({ commentTranslationStyle: 'quote', chatTranslationStyle: 'highlight', chatTranslationColor: '#123456' });
    h.message(h.LT.MSG.SETTINGS_CHANGED);
    await flush();
    await h.LT.debug.start('test');
    assert.equal(requests, 1);
    let response;
    h.message(h.LT.MSG.QUERY_LIVE_CONTEXT, undefined, value => { response = value; });
    assert.equal(response.review.phase, 'session');
    h.setSettings({ commentTranslationStyle: 'box', chatTranslationStyle: 'wavy' });
    h.message(h.LT.MSG.SETTINGS_CHANGED);
    await flush();
    assert.equal(h.clients.length, 1);
    assert.equal(requests, 1);
    if (liveProvider === 'gemini') assert.equal(response.review.prompt, h.clients[0].opts.prompt);
    else {
      assert.equal(response.review.prompt, '');
      assert.deepEqual(JSON.parse(JSON.stringify(response.review.translation.corpus.phrases)), JSON.parse(JSON.stringify(h.clients[0].opts.phrases)));
    }
  }
});

test('临时补充变化使预览失效，开始使用新输入重新整理', async () => {
  const h = await sessionHarness(); h.setSettings({ useMetadata: true });
  h.LT.YouTube.waitForMeta = async () => ({ videoId: 'video-B', title: '直播' });
  h.navigate('video-B'); await flush();
  let requests = 0;
  h.LT.LiveContext.generate = async (_,__,notes) => { requests++; return { background: notes || '旧背景', phrases: {} }; };
  await h.LT.debug.previewLiveContext();
  h.message(h.LT.MSG.SET_TEMP_CONTEXT, '新背景');
  let response;
  h.message(h.LT.MSG.QUERY_LIVE_CONTEXT, undefined, x => { response = x; });
  assert.equal(response.review.stale, true);
  await h.LT.debug.start('test');
  assert.equal(requests, 2);
  assert.match(h.clients[0].opts.prompt, /新背景/);
});

test('预览输出遮盖配置 Key，换视频后旧生成结果不能写回', async () => {
  const h = await sessionHarness();
  h.setSettings({ useMetadata: true, manualContext: '临时调试 key=test-only' });
  h.LT.YouTube.waitForMeta = async ({ videoId }) => ({ videoId, title: '直播' });
  h.navigate('video-B'); await flush();
  h.LT.LiveContext.generate = async () => ({ background: 'test-only', phrases: {} });
  const result = await h.LT.debug.previewLiveContext();
  assert.ok(!JSON.stringify(result).includes('test-only'));
  assert.match(JSON.stringify(result), /API_KEY/);
  const wait = deferred(); h.LT.LiveContext.generate = () => wait.promise;
  const pending = h.LT.debug.previewLiveContext(); await flush();
  h.navigate('video-C');
  wait.resolve({ background: '旧视频晚到的结果', phrases: {} });
  await assert.rejects(pending, /取消/);
  let response;
  h.message(h.LT.MSG.QUERY_LIVE_CONTEXT, undefined, x => { response = x; });
  assert.equal(response.review, null);
});

test('没有 API Key 时角标收到最终空闲状态', async () => {
  const h = await sessionHarness();
  h.setSettings({ apiKeys: '', debugLogLevel: 'basic' });
  await h.LT.debug.start('test');
  assert.equal(h.statuses.at(-1).phase, 'idle');
  assert.match(h.statuses.at(-1).error, /API Key/);
  assert.equal(h.logs[0].reason, 'missing_key');
  assert.ok(h.logs[0].events.some((e) => e.type === 'connection' && /API Key/.test(e.value.state)));
});

test('读取整片字幕设置时取消，旧启动不会复活', async () => {
  const h = await sessionHarness();
  const settings = await h.LT.Settings.load();
  const wait = deferred();
  h.LT.Settings.load = () => wait.promise;
  const pending = h.LT.debug.startVideoSubs(false);
  h.message(h.LT.MSG.VS_CANCEL);
  wait.resolve(settings);
  await pending;
  assert.equal(h.subStarts.length, 0);
});

test('读取整片字幕设置时切视频，不在新视频上启动旧任务', async () => {
  const h = await sessionHarness();
  const settings = await h.LT.Settings.load();
  const wait = deferred();
  h.LT.Settings.load = () => wait.promise;
  const pending = h.LT.debug.startVideoSubs(false);
  h.navigate('video-B');
  wait.resolve(settings);
  await pending;
  assert.equal(h.subStarts.length, 0);
});

test('整片字幕的旧设置晚到，不会停止后启动的实时翻译', async () => {
  const h = await sessionHarness();
  const settings = await h.LT.Settings.load();
  const wait = deferred();
  h.LT.Settings.load = () => wait.promise;
  const pending = h.LT.debug.startVideoSubs(false);
  h.LT.Settings.load = async () => settings;
  await h.LT.debug.start('new-live');
  wait.resolve(settings);
  await pending;
  assert.equal(h.subStarts.length, 0);
  assert.equal(h.LT.debug.session.phase, 'running');
  assert.equal(h.clients[0].running, true);
});

test('取消 AudioWorklet 加载后不再创建音频节点', async () => {
  const wait = deferred();
  let created = 0;
  const source = { connect() {}, disconnect() {} };
  const ctx = vm.createContext({ console: quiet,
    chrome: { runtime: { getURL: x => x } },
    AudioContext: class {
      state = 'running'; destination = {}; audioWorklet = { addModule: () => wait.promise };
      createGain() { return { gain: {}, connect() {} }; }
      createMediaElementSource() { return source; }
    },
    AudioWorkletNode: class { constructor() { created++; } },
  });
  load(ctx, 'src/content/audio-tap.js');
  const tap = new ctx.LT.AudioTap({ onChunk() {}, onLevel() {} });
  const pending = tap.attach({});
  tap.detach();
  wait.resolve();
  await pending;
  assert.equal(created, 0);
  assert.equal(tap.node, null);
  assert.equal(tap.graph, null);
});

function socketHarness() {
  let now = 0, seq = 0;
  const timers = new Map(), sockets = [], states = [];
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(x) { this.sent.push(x); }
    open() { this.readyState = 1; this.onopen(); this.onmessage({ data: '{"setupComplete":{}}' }); }
    close(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const ctx = vm.createContext({ console: quiet, WebSocket: Socket, setTimeout: setTimer,
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {},
    btoa: x => Buffer.from(x, 'binary').toString('base64'), LT: { MODEL: 'test', WS_PATH: '/test' },
  });
  load(ctx, 'src/content/gemini-live.js');
  const client = new ctx.LT.GeminiLiveClient({ keyProvider: () => 'test', baseUrl: 'wss://example.invalid',
    prompt: 'test', targetLang: 'zh', rotateAfterMs: 505000,
    listener: { onState: x => states.push(x), onInputText() {}, onOutputText() {} },
  });
  client.start(); sockets[0].open();
  return { client, sockets, states, advance };
}

test('断线撞上轮换只重连一次，停止后没有遗留连接', () => {
  const h = socketHarness();
  h.advance(504500);
  h.sockets[0].close(1006);
  assert.equal(h.states.at(-1), 'reconnecting');
  h.advance(500);
  assert.equal(h.sockets.length, 1);
  h.advance(500);
  h.sockets[1].open();
  assert.equal(h.sockets.length, 2);
  h.client.stop();
  assert.equal(h.sockets.filter(s => s.readyState !== 3).length, 0);
  h.advance(600000);
  assert.equal(h.sockets.length, 2);
});

test('正常轮换关闭旧连接并保留轮换提示', () => {
  const h = socketHarness();
  h.advance(505000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.states.at(-1), 'rotating');
  h.sockets[0].onmessage({ data: '{"goAway":{}}' });
  assert.equal(h.sockets.length, 2);
  h.client.stop();
});

test('异常断线仍保留最近音频回填', () => {
  const h = socketHarness();
  h.client.feedChunk(new Uint8Array([1, 2]));
  h.sockets[0].onerror();
  h.sockets[0].close(1006);
  assert.equal(h.client.queue.length, 1);
  h.advance(1000);
  h.sockets[1].open();
  assert.equal(h.client.queue.length, 0);
  assert.equal(h.sockets[1].sent.length, 2);
  h.client.stop();
});
