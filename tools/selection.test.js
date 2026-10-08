/** 划词/朗读回归：真实模块配模拟网络与 Chrome，验证取消、发音语言和音频资源释放。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
// 原生 WebCrypto 在线程池中完成，不能用固定事件循环轮数判断任务已到达某阶段。
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function context(extra = {}) {
  const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    URL, Blob, DOMException, AbortController, AbortSignal, crypto: webcrypto, atob, btoa,
    setTimeout, clearTimeout, setInterval, clearInterval, ...extra });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/selection.js',
    'src/tts/audio.js', 'src/tts/microsoft.js', 'src/tts/gemini.js']) load(ctx, file);
  return ctx;
}
function load(ctx, file) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file }); }

test('只选日语/英语：标点、全角拉丁、纯汉字、混合和数字遵守规则', () => {
  const ctx = context();
  for (const text of ['Hello, world! 2026', "Don't worry.", 'ＡＰＥＸ', 'café', 'Hello 👋']) assert.equal(ctx.LT.Selection.language(text), 'en-US');
  for (const text of ['東京', '花芽すみれ', 'APEXお疲れ様', '2026']) assert.equal(ctx.LT.Selection.language(text), 'ja-JP');
  assert.throws(() => ctx.LT.Selection.cleanText(' '));
  assert.throws(() => ctx.LT.Selection.cleanText('a'.repeat(4001)));
});
test('微软分块按 UTF-8 限制，保持原文和 emoji 完整', () => {
  const ctx = context();
  const text = ('東京で会いましょう！ hello 👋 ' + 'a'.repeat(2000)).repeat(2);
  const pieces = ctx.LT.MicrosoftTTS.chunks(text);
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every(piece => new TextEncoder().encode(piece).length <= 1800));
  assert.ok(pieces.every(piece => !/[\uD800-\uDBFF]$/.test(piece)));
});
test('Gemini 请求冻结原文和日英语种；旧/新型号使用相应 schema', () => {
  const ctx = context();
  for (const [model, modern] of [['gemini-3.1-flash-tts-preview', false], ['gemini-3.8-flash-lite-tts', true]]) {
    const request = ctx.LT.GeminiTTS.buildRequest({ text: '東京', language: 'ja-JP',
      config: { key: 'test-only', baseUrl: 'https://generativelanguage.googleapis.com', voice: 'Kore', model } });
    const body = JSON.parse(request.body);
    assert.equal(body.generationConfig.speechConfig.languageCode, 'ja-JP');
    assert.ok(body.contents[0].parts[0].text.endsWith('東京'));
    assert.equal(!!body.contents[0].parts[0].speechMetadata, modern);
    assert.ok(!request.url.includes('test-only'));
  }
});
test('Gemini 裸 PCM 正确封装 WAV，已带 WAV 不重复包装，空结果/混合格式拒绝', () => {
  const ctx = context();
  const pcm = Uint8Array.from([1, 0, 2, 0]);
  const response = (entries) => ({ candidates: [{ content: { parts: entries.map(item => ({ inlineData: item })) } }] });
  const wrapped = ctx.LT.GeminiTTS.audio(response([{ data: btoa(String.fromCharCode(...pcm)), mimeType: 'audio/L16;codec=pcm;rate=24000' }]));
  assert.equal(new TextDecoder().decode(wrapped.bytes.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(wrapped.bytes.buffer).getUint32(24, true), 24000);
  assert.equal(wrapped.bytes.length, 48);
  const existing = ctx.LT.GeminiTTS.audio(response([{ data: ctx.LT.TTSAudio.encode(wrapped.bytes), mimeType: 'audio/wav' }]));
  assert.equal(existing.bytes.length, 48);
  assert.throws(() => ctx.LT.GeminiTTS.audio({}));
  assert.throws(() => ctx.LT.GeminiTTS.audio(response([{data:'AAAA',mimeType:'audio/wav'}, {data:'AAAA',mimeType:'audio/mpeg'}])));
});
test('新增 Gemini Key 导出默认剔除、导入保留，错误与日志脱敏', () => {
  const ctx = context(); load(ctx, 'src/ui/options-data.js'); load(ctx, 'src/common/live-log.js');
  const settings = ctx.LT.Settings.normalize({ ttsGeminiApiKey: 'private-test-key', ttsProvider: 'gemini' });
  const backup = ctx.LT.OptionsUI.exportObject(settings, false, '0.4.0');
  assert.equal(backup.settings.ttsGeminiApiKey, undefined);
  assert.ok(backup.settings.providers.every(p => !p.apiKey));
  assert.equal(ctx.LT.OptionsUI.importObject(backup, settings).providers.find(p => p.preset === 'gemini-tts').apiKey, 'private-test-key');
  assert.ok(!ctx.LT.Selection.safeError(new Error('private-test-key failed'), settings).includes('private-test-key'));
  assert.ok(ctx.LT.LiveLog.secretsFrom(settings).includes('private-test-key'));
  assert.equal(JSON.stringify(ctx.LT.LiveLog.safe(settings, [], 1000)).includes('private-test-key'), false);
});

test('划词翻译模型独立于整片字幕模型，旧设置首次沿用原选择', () => {
  const ctx = context();
  const providers = [
    { id: 'first', apiType: 'gemini', model: 'first-model' },
    { id: 'second', apiType: 'openai', model: 'second-model' },
  ];
  const old = ctx.LT.Settings.normalize({ providers, subsProviderId: 'second' });
  assert.equal(old.selectionProviderId, 'second');
  const independent = ctx.LT.Settings.normalize({ ...old, subsProviderId: 'first' });
  assert.equal(independent.selectionProviderId, 'second');
  const removed = ctx.LT.Settings.normalize({ ...old, providers: providers.slice(0, 1) });
  assert.equal(removed.selectionProviderId, 'first');
});

function tasks({ settingsGate, synthesize, playerGate, failInjection, customSettings, translateResolve, permissionContains } = {}) {
  const connect = [], messages = [], updates = [], storage = [], clicks = [];
  const commands = [], injections = [], sent = [], transfers = [], windows = [];
  let playerExists = false;
  const chrome = {
    contextMenus: { removeAll: fn => fn(), create() {}, onClicked: { addListener: fn => clicks.push(fn) } },
    scripting: { executeScript: async value => { injections.push(value); if (failInjection && value.target.frameIds[0] !== 0) throw new Error('受限帧'); } },
    runtime: { id:'test-extension', getURL: file => 'chrome-extension://test-extension/' + file,
      onConnect: { addListener: fn => connect.push(fn) }, onMessage: { addListener: fn => messages.push(fn) },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getContexts: async () => playerExists ? [{}] : [],
      sendMessage: async message => { commands.push(message); return {ok:true}; } },
    offscreen: { createDocument: async () => { if (playerGate) await playerGate.promise; playerExists = true; } },
    permissions: { contains: permissionContains || (async () => true) },
    storage: { onChanged: { addListener: fn => storage.push(fn) }, session: {set:async value=>{transfers.push(value);}} },
    windows: {create:async value=>{windows.push(value);}},
    tabs: { onUpdated: { addListener: fn => updates.push(fn) }, sendMessage: async (...args) => { sent.push(args); }, create() {} },
  };
  const ctx = context({chrome});
  const defaults = ctx.LT.Settings.normalize(customSettings || {});
  ctx.LT.Settings.load = async () => settingsGate ? settingsGate.promise : defaults;
  ctx.LT.MicrosoftTTS.synthesize = synthesize || (async () => ({bytes:Uint8Array.from([1,2,3]),mime:'audio/mpeg'}));
  load(ctx, 'src/subs/text-model.js');
  ctx.LT.TextModel = {...ctx.LT.TextModel,resolve:translateResolve || (()=>({key:'test',model:'test',baseUrl:'https://example.com'})),translate:async()=>({text:'译文'})};
  load(ctx, 'src/background/selection.js');
  function port(frameId = 0) {
    const received = [], disconnect = [];
    const value = { name:'lt-selection', sender:{id:'test-extension',tab:{id:7,url:'https://example.com'},frameId}, replies:[],
      onMessage:{addListener:fn=>received.push(fn)}, onDisconnect:{addListener:fn=>disconnect.push(fn)},
      postMessage: message => value.replies.push(message),
      receive: message => received.forEach(fn => fn(message)), disconnect:()=>disconnect.forEach(fn=>fn()) };
    connect.forEach(fn=>fn(value)); return value;
  }
  return {ctx,port,commands,defaults,updates,messages,clicks,injections,sent,transfers,windows};
}

test('后台按浮窗指定的配置发送翻译，不把无效 id 悄悄退到另一模型', async () => {
  const selected = [];
  const providers = [
    { id: 'first', apiType: 'gemini', model: 'first-model' },
    { id: 'second', apiType: 'openai', model: 'second-model' },
  ];
  const h = tasks({ customSettings: { providers, subsProviderId: 'first', selectionProviderId: 'second' },
    translateResolve: (_settings, id, model) => { selected.push([id, model]); return { key:'test', model:'test', baseUrl:'https://example.com' }; } });
  const port = h.port();
  port.receive({ type:'translate', text:'東京', providerId:'second', model: 'selection-flash', requestId:1 });
  await waitFor(() => port.replies.some(item => item.type === 'translation' && item.requestId === 1), '应收到所选模型的译文');
  assert.deepEqual(selected, [['second', 'selection-flash']]);
  port.receive({ type:'translate', text:'東京', providerId:'removed', requestId:2 });
  await waitFor(() => port.replies.some(item => item.type === 'translation' && item.requestId === 2), '应收到无效模型错误');
  assert.equal(selected.length, 1);
  assert.match(port.replies.at(-1).error, /已删除/);
});

test('同类型朗读配置按 ID 冻结不同 Key、模型及声线，不共享合成缓存', async () => {
  const calls = [];
  const h = tasks({ customSettings: { providers: [
    { id: 'text', kind: 'text', preset: 'openai', model: 'text-model' },
    { id: 'speech-a', kind: 'speech', preset: 'gemini-tts', reuseKey: false, apiKey: 'key-a', model: 'gemini-a-tts', voice: 'Kore' },
    { id: 'speech-b', kind: 'speech', preset: 'gemini-tts', reuseKey: false, apiKey: 'key-b', model: 'gemini-b-tts', voice: 'Puck' },
  ], ttsProviderId: 'speech-a' } });
  h.ctx.LT.GeminiTTS.synthesize = async ({ config }) => {
    calls.push(config);
    return { bytes: Uint8Array.from([1, 2, 3]), mime: 'audio/mpeg' };
  };
  const frozen = h.ctx.LT.Selection.resolve(h.defaults, 'speech-a');
  h.defaults.providers.find(p => p.id === 'speech-a').voice = 'Charon';
  assert.equal(frozen.voice, 'Kore');
  const port = h.port();
  for (const [index, providerId] of ['speech-a', 'speech-b', 'speech-a'].entries()) {
    port.receive({ type: 'speak', text: '東京', providerId, requestId: index + 1 });
    await waitFor(() => h.commands.filter(item => item.command === 'play').length === index + 1, '指定朗读配置应开始播放');
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(config => [config.provider, config.key, config.model, config.voice]), [
    ['gemini', 'key-a', 'gemini-a-tts', 'Charon'], ['gemini', 'key-b', 'gemini-b-tts', 'Puck'],
  ]);
});

test('朗读与文字翻译拒绝跨类型 ID 及停用配置，错误不进入请求客户端', async () => {
  const h = tasks({ customSettings: { providers: [
    { id: 'text', kind: 'text', preset: 'openai', apiKey: 'text-key', model: 'text-model' },
    { id: 'text-off', kind: 'text', preset: 'openai', enabled: false, apiKey: 'off-key', model: 'text-model' },
    { id: 'live', kind: 'live', preset: 'gemini-live', apiKey: 'live-key' },
    { id: 'speech', kind: 'speech', preset: 'microsoft-tts' },
    { id: 'speech-off', kind: 'speech', preset: 'gemini-tts', enabled: false, reuseKey: false, apiKey: 'speech-key' },
  ], selectionProviderId: 'text', ttsProviderId: 'speech' } });
  let calls = 0;
  h.ctx.LT.MicrosoftTTS.synthesize = h.ctx.LT.GeminiTTS.synthesize = async () => { calls++; throw new Error('不应请求'); };
  h.ctx.LT.TextModel.resolve = () => { calls++; throw new Error('不应请求'); };
  const port = h.port();
  for (const [index, providerId] of ['text', 'live', 'speech-off', 'missing'].entries()) {
    const requestId = 20 + index;
    port.receive({ type: 'speak', text: '東京', providerId, requestId });
    await waitFor(() => port.replies.some(item => item.requestId === requestId && item.phase === 'error'), '无效朗读配置应返回错误');
  }
  for (const [index, providerId] of ['speech', 'live', 'text-off'].entries()) {
    const requestId = 30 + index;
    port.receive({ type: 'translate', text: '東京', providerId, requestId });
    await waitFor(() => port.replies.some(item => item.requestId === requestId && item.error), '无效文字配置应返回错误');
  }
  assert.equal(calls, 0);
  assert.equal(h.commands.some(item => item.command === 'play'), false);
});

test('划词面板按类型列出配置，切换朗读保存并发送供应商 ID', async () => {
  const nodes = [], sent = [], saved = [];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.dataset = {}; this.className = ''; this.value = ''; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name]; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
    removeEventListener() {}
    async fire(event) { await Promise.all((this.listeners[event] || []).map(fn => fn({ target: this }))); }
    get selectedOptions() { return this.children.filter(item => item.value === this.value); }
    get classList() { return { add: name => { this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); }, contains: name => this.className.split(' ').includes(name) }; }
    getBoundingClientRect() { return { width: 440, height: 350 }; }
    attachShadow() { return new Node('shadow'); }
    focus() {} remove() {}
  }
  const port = { postMessage: message => sent.push(message), disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
  const ctx = context({
    innerWidth: 1200, innerHeight: 900, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    CSSStyleSheet: class { replaceSync() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    document: { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), documentElement: new Node('html'), addEventListener() {}, removeEventListener() {} },
    window: { getSelection: () => null, addEventListener() {}, removeEventListener() {} },
    chrome: { storage: { onChanged: { addListener() {} } }, runtime: { connect: () => port, onMessage: { addListener() {} } } },
  });
  const settings = ctx.LT.Settings.normalize({ providers: [
    { id: 'text', kind: 'text', preset: 'openai', model: 'text-model' },
    { id: 'live', kind: 'live', preset: 'gemini-live', apiKey: 'live-key' },
    { id: 'speech-a', kind: 'speech', preset: 'gemini-tts', name: '朗读 A' },
    { id: 'speech-b', kind: 'speech', preset: 'gemini-tts', name: '朗读 B' },
  ], ttsProviderId: 'speech-a' });
  ctx.LT.Settings.load = async () => settings;
  ctx.LT.Settings.save = async patch => { saved.push(patch); Object.assign(settings, patch); return settings; };
  load(ctx, 'src/content/selection.js');
  await ctx.LT.SelectionUI.open({ text: '東京' });
  const textSelect = nodes.find(item => item.attrs['aria-label'] === '划词翻译模型');
  const speechSelect = nodes.find(item => item.attrs['aria-label'] === '朗读接口');
  assert.deepEqual(textSelect.children.map(item => JSON.parse(item.value)), [['text', 'text-model']]);
  assert.deepEqual(speechSelect.children.map(item => item.value), ['speech-a', 'speech-b']);
  speechSelect.value = 'speech-b'; await speechSelect.fire('change');
  assert.equal(saved[0].ttsProviderId, 'speech-b');
  assert.equal(saved[0].ttsProvider, undefined);
  await nodes.find(item => item.attrs['aria-label'] === '朗读原文').fire('click');
  assert.equal(sent.at(-1).providerId, 'speech-b');
  assert.equal(sent.at(-1).type, 'speak');
  ctx.LT.SelectionUI.close();
});
test('划词翻译允许只用请求头鉴权，服务错误中的请求头凭据会脱敏', async () => {
  const headers = { 'x-api-key': 'private-header-token' };
  const h = tasks({ customSettings: { providers: [{ id: 'p', apiType: 'openai', model: 'm', headers }] },
    translateResolve: () => ({ key: '', model: 'm', headers, baseUrl: 'https://example.com' }) });
  const port = h.port();
  port.receive({ type: 'translate', text: '東京', requestId: 1 });
  await waitFor(() => port.replies.some(item => item.requestId === 1), '请求头鉴权应收到译文');
  assert.equal(port.replies.at(-1).text, '译文');
  h.ctx.LT.TextModel.translate = async () => { throw new Error('server echoed private-header-token'); };
  port.receive({ type: 'translate', text: '東京', requestId: 2 });
  await waitFor(() => port.replies.some(item => item.requestId === 2), '应收到脱敏错误');
  assert.equal(port.replies.at(-1).error.includes('private-header-token'), false);
});

test('划词切换目标语言时按请求冻结语言，无效语言不会进入模型', async () => {
  const h = tasks();
  const prompts = [];
  h.ctx.LT.TextModel.translate = async args => { prompts.push(args.system); return { text: 'translated' }; };
  const port = h.port();
  port.receive({ type:'translate', text:'今日はいい天気ですね。', targetLang:'en', requestId:11 });
  await waitFor(() => port.replies.some(item => item.requestId === 11), '应收到英语译文');
  assert.match(prompts[0], /英语/);
  assert.equal(port.replies.at(-1).target, 'en');
  port.receive({ type:'translate', text:'今日はいい天気ですね。', targetLang:'invalid', requestId:12 });
  await waitFor(() => port.replies.some(item => item.requestId === 12), '应收到无效语言错误');
  assert.equal(prompts.length, 1);
  assert.match(port.replies.at(-1).error, /目标语言无效/);
});

test('带端口的本地接口在划词翻译和 Gemini 朗读后台使用与设置页相同的域名权限', async () => {
  const checked = [];
  const h = tasks({ customSettings: { ttsProvider: 'gemini', ttsGeminiReuseKey: false,
    ttsGeminiApiKey: 'mock-key', ttsGeminiBaseUrl: 'http://127.0.0.1:23000' },
    translateResolve: () => ({ key: 'mock-key', model: 'mock-model', baseUrl: 'http://127.0.0.1:23000/v1' }),
    permissionContains: async ({ origins }) => { checked.push(origins[0]); return origins[0] === 'http://127.0.0.1/*'; } });
  h.ctx.LT.GeminiTTS.synthesize = async () => ({ bytes: Uint8Array.from([1, 2, 3]), mime: 'audio/mpeg' });
  const p = h.port();
  p.receive({ type: 'translate', text: '東京', requestId: 71 });
  await waitFor(() => p.replies.some(item => item.type === 'translation' && item.requestId === 71), '本地接口翻译应完成');
  assert.equal(p.replies.at(-1).text, '译文');
  p.receive({ type: 'speak', text: '東京', requestId: 72 });
  await waitFor(() => h.commands.some(item => item.command === 'play'), '本地 Gemini 接口应进入播放');
  assert.deepEqual(checked, ['http://127.0.0.1/*', 'http://127.0.0.1/*']);
});
test('准备时停止，迟到的设置和合成结果不能开始播放', async () => {
  const settingsGate = deferred(); const h = tasks({settingsGate}); const p = h.port();
  p.receive({type:'speak',text:'東京',requestId:1});
  p.receive({type:'stop'}); settingsGate.resolve(h.defaults); await flush();
  assert.equal(h.commands.some(item=>item.command==='play'), false);
  const gate = deferred(); const second = tasks({synthesize:()=>gate.promise}); const q = second.port();
  q.receive({type:'speak',text:'東京',requestId:2}); await flush(); q.receive({type:'stop'});
  gate.resolve({bytes:Uint8Array.from([1]),mime:'audio/mpeg'}); await flush();
  assert.equal(second.commands.some(item=>item.command==='play'), false);
});
test('offscreen 创建期间取消，不会在文档创建完成后突然播放', async () => {
  const playerGate=deferred(); const h=tasks({playerGate}); const p=h.port();
  p.receive({type:'speak',text:'東京',requestId:1}); await flush(); p.receive({type:'stop'});
  playerGate.resolve(); await flush();
  assert.equal(h.commands.some(item=>item.command==='play'), false);
});
test('快速跨页面启动只播放最新请求；重播复用音频，断开/导航停止', async () => {
  const gates=[deferred(),deferred()]; let count=0;
  const h=tasks({synthesize:()=>gates[count++].promise}); const p=h.port(), q=h.port(4);
  p.receive({type:'speak',text:'古い',requestId:1});
  await waitFor(() => count === 1, '旧任务应进入合成阶段');
  q.receive({type:'speak',text:'新しい',requestId:2});
  await waitFor(() => count === 2, '新任务应进入合成阶段');
  gates[0].resolve({bytes:Uint8Array.from([1]),mime:'audio/mpeg'});
  gates[1].resolve({bytes:Uint8Array.from([2]),mime:'audio/mpeg'});
  await waitFor(() => h.commands.some(item=>item.command==='play'), '最新任务应开始播放');
  assert.equal(h.commands.filter(item=>item.command==='play').length,1);
  q.receive({type:'speak',text:'新しい',requestId:3});
  await waitFor(() => h.commands.filter(item=>item.command==='play').length === 2, '重播应复用缓存开始播放');
  assert.equal(count,2);
  h.updates[0](7,{url:'https://example.com/new'});
  await waitFor(() => h.commands.at(-1).command === 'stop', '导航应停止播放');
  assert.equal(q.replies.at(-1).type,'close'); assert.equal(h.commands.at(-1).command,'stop');
});
test('右键按准确 frame 注入和投递，没有永久全站内容脚本', async () => {
  const h=tasks(); await h.clicks[0]({menuItemId:'lt-selection-speak',selectionText:'東京',frameId:42},{id:7});
  assert.equal(h.injections[0].target.frameIds[0],42);
  assert.equal(h.sent[0][2].frameId,42);
  assert.equal(h.sent[0][1].text,'東京');
});
test('无法注入选区 frame 时仍在同一网页顶部 frame 展示，不创建窗口或转存原文', async () => {
  const h=tasks({failInjection:true});
  await h.clicks[0]({menuItemId:'lt-selection-translate',selectionText:'東京',frameId:42,frameUrl:'https://example.com/chat'},{id:7});
  assert.equal(h.injections[1].target.frameIds[0],0);
  assert.equal(h.sent[0][2].frameId,0);
  assert.equal(h.sent[0][1].text,'東京'); assert.equal(h.sent[0][1].frameUrl,'https://example.com/chat');
  assert.equal(h.transfers.length,0);assert.equal(h.windows.length,0);
});

test('设置试听等待保存时切换供应商或停止，不会迟到发起朗读', async () => {
  for (const action of ['stop', 'providerChange']) {
    const gate=deferred(); let connections=0;
    const elements=new Map();
    const node=()=>({value:'',disabled:false,textContent:'',listeners:{},
      append(){},setAttribute(){},addEventListener(event,fn){this.listeners[event]=fn;}});
    const $=id=>{
      if (!elements.has(id)) elements.set(id,node());
      return elements.get(id);
    };
    const ctx=context({document:{createElement:node},window:{addEventListener(){}},
      chrome:{permissions:{contains:async()=>false,request:async()=>true},
        runtime:{connect(){connections++;throw new Error('迟到的连接');}}}});
    load(ctx,'src/ui/options-access.js');
    load(ctx,'src/ui/options-tts.js');
    const settings=ctx.LT.Settings.normalize({});
    const ui=ctx.LT.OptionsUI.mountSpeech({$,settings:()=>settings,save:patch=>Object.assign(settings,patch),flush:()=>gate.promise});
    ui.bind();
    const preview=$('ttsPreviewJa').listeners.click();
    if (action === 'providerChange') {
      settings.ttsProviderId = settings.providers.find(p => p.kind === 'speech' && p.id !== settings.ttsProviderId).id;
      ui.render();
    } else $('ttsStopPreview').listeners.click();
    gate.resolve(); await preview;
    assert.equal(connections,0); assert.equal($('ttsPreviewState').textContent,'已停止');
  }
});
test('offscreen 忽略旧停止和迟到播放回调，并释放旧音频 URL', async () => {
  let listener; const plays=[], revoked=[], reports=[];
  class FakeAudio {
    constructor(url) {this.url=url;this.promise=deferred();plays.push(this);}
    play(){return this.promise.promise;} pause(){this.paused=true;} removeAttribute(){} load(){}
  }
  const fakeURL={createObjectURL:()=>`blob:${plays.length}`,revokeObjectURL:url=>revoked.push(url)};
  const ctx=context({Audio:FakeAudio,URL:fakeURL,window:{addEventListener(){}},
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>reports.push(msg)}}});
  load(ctx,'src/tts/offscreen.js');
  const sender={id:'test'}; const command=(id,cmd)=>listener({target:'lt-speech-player',command:cmd,id,data:'AAE=',mime:'audio/mpeg'},sender,()=>{});
  command(10,'play'); command(11,'play'); command(10,'stop');
  assert.equal(plays[0].paused,true); assert.equal(plays[1].paused,undefined);
  plays[0].promise.resolve(); plays[1].promise.resolve(); await flush();
  assert.equal(reports.filter(item=>item.phase==='playing').length,1);
  command(12,'stop'); assert.equal(revoked.length,2); assert.equal(plays[1].paused,true);
});
