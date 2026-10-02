/** 划词/朗读回归：真实模块配模拟网络与 Chrome，验证取消、发音语言和音频资源释放。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
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
  assert.equal(backup.settings.ttsGeminiApiKey, '');
  assert.equal(ctx.LT.OptionsUI.importObject(backup, settings).ttsGeminiApiKey, 'private-test-key');
  assert.ok(!ctx.LT.Selection.safeError(new Error('private-test-key failed'), settings).includes('private-test-key'));
  assert.ok(ctx.LT.LiveLog.secretsFrom(settings).includes('private-test-key'));
  assert.equal(JSON.stringify(ctx.LT.LiveLog.safe(settings, [], 1000)).includes('private-test-key'), false);
});

function tasks({ settingsGate, synthesize, playerGate, failInjection } = {}) {
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
    permissions: { contains: async () => true },
    storage: { onChanged: { addListener: fn => storage.push(fn) }, session: {set:async value=>{transfers.push(value);}} },
    windows: {create:async value=>{windows.push(value);}},
    tabs: { onUpdated: { addListener: fn => updates.push(fn) }, sendMessage: async (...args) => { sent.push(args); }, create() {} },
  };
  const ctx = context({chrome});
  const defaults = ctx.LT.Settings.normalize({});
  ctx.LT.Settings.load = async () => settingsGate ? settingsGate.promise : defaults;
  ctx.LT.MicrosoftTTS.synthesize = synthesize || (async () => ({bytes:Uint8Array.from([1,2,3]),mime:'audio/mpeg'}));
  ctx.LT.TextModel = {resolve:()=>({key:'test',model:'test',baseUrl:'https://example.com'}),translate:async()=>({text:'译文'})};
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
  p.receive({type:'speak',text:'古い',requestId:1}); await flush();
  q.receive({type:'speak',text:'新しい',requestId:2}); await flush();
  gates[0].resolve({bytes:Uint8Array.from([1]),mime:'audio/mpeg'});
  gates[1].resolve({bytes:Uint8Array.from([2]),mime:'audio/mpeg'}); await flush();
  assert.equal(h.commands.filter(item=>item.command==='play').length,1);
  q.receive({type:'speak',text:'新しい',requestId:3}); await flush(); assert.equal(count,2);
  h.updates[0](7,{url:'https://example.com/new'}); await flush();
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
  for (const action of ['ttsStopPreview','ttsProvider']) {
    const gate=deferred(); let connections=0;
    const elements=new Map();
    const $=id=>{
      if (!elements.has(id)) elements.set(id,{value:'',disabled:false,textContent:'',listeners:{},
        append(){},addEventListener(event,fn){this.listeners[event]=fn;}});
      return elements.get(id);
    };
    const ctx=context({document:{createElement:()=>({})},window:{addEventListener(){}},
      chrome:{runtime:{connect(){connections++;throw new Error('迟到的连接');}}}});
    load(ctx,'src/ui/options-tts.js');
    const settings=ctx.LT.Settings.normalize({});
    ctx.LT.OptionsUI.mountSpeech({$,settings:()=>settings,save:patch=>Object.assign(settings,patch),flush:()=>gate.promise}).bind();
    const preview=$('ttsPreviewJa').listeners.click();
    $(action).value='gemini';
    $(action).listeners[action==='ttsProvider'?'change':'click']();
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
