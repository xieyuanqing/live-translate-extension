/** 聊天控制条迁移回归：模拟扩展消息与本地模型，不访问 YouTube 或下载模型。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const run = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('聊天帧只上报状态，弹窗消息可以准备模型，不向聊天区插入控制条', async () => {
  let onMessage;
  let created = 0;
  let inserted = 0;
  const updates = [];
  const ctx = vm.createContext({
    URL, AbortController, DOMException, setTimeout: () => 1, clearTimeout() {},
    location: { pathname: '/live_chat', href: 'https://www.youtube.com/live_chat?v=video-a' },
    document: { documentElement: {}, querySelectorAll: () => [], createElement: () => { inserted++; return {}; } },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Translator: { availability: async () => 'downloadable', create: async () => { created++; return { destroy() {} }; } },
    chrome: {
      runtime: { sendMessage: msg => { updates.push(msg); return Promise.resolve(); },
        onMessage: { addListener: fn => { onMessage = fn; } } },
      storage: { onChanged: { addListener() {} } },
    },
  });
  run(ctx, 'src/common/constants.js');
  ctx.LT.Settings = { load: async () => ({ ...ctx.LT.DEFAULTS, enableChatTranslation: true }) };
  ctx.LT.YouTubeText = { applyResultStyle() {} };
  run(ctx, 'src/content/youtube-chat.js');
  await flush();
  assert.equal(inserted, 0);
  assert.equal(updates.at(-1).payload.phase, 'waiting');
  const response = await new Promise(resolve => onMessage({ type: ctx.LT.MSG.PREPARE_CHAT,
    payload: { videoId: 'video-a', sourceLang: 'ja', targetLang: 'zh' } }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(created, 1);
  assert.equal(inserted, 0);
  assert.equal(updates.at(-1).payload.phase, 'ready');
  const stale = await new Promise(resolve => onMessage({ type: ctx.LT.MSG.PREPARE_CHAT,
    payload: { videoId: 'video-old', sourceLang: 'ja', targetLang: 'zh' } }, {}, resolve));
  assert.equal(stale.ok, false);
  assert.equal(created, 1);
});

test('云端聊天按所选接口和模型分批翻译，切换模型后重新请求', async () => {
  const timers = [], storageListeners = [], requests = [], statuses = [];
  const sources = ['次の曲が楽しみです', '今日はありがとう'].map(original => ({ original, isConnected: true, result: null,
    querySelector() { return this.result; }, append(result) { this.result = result; result.source = this; } }));
  const rows = sources.map(source => ({ querySelector: () => source }));
  const ctx = vm.createContext({
    URL, AbortController, DOMException, JSON,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    location: { pathname: '/live_chat', href: 'https://www.youtube.com/live_chat?v=video-a' },
    document: { documentElement: {}, querySelector: () => null,
      querySelectorAll: selector => selector.startsWith('yt-live-chat') ? rows
        : selector === '.lt-yt-chat-result' ? sources.map(source => source.result).filter(Boolean) : [],
      createElement: () => ({ dataset: {}, textContent: '', remove() { this.source.result = null; } }) },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { sendMessage: msg => { statuses.push(msg.payload); return Promise.resolve(); }, onMessage: { addListener() {} } },
      storage: { onChanged: { addListener: fn => storageListeners.push(fn) } } },
  });
  run(ctx, 'src/common/constants.js');
  let settings = { ...ctx.LT.DEFAULTS, enableChatTranslation: true, chatProviderId: 'deepseek', chatModel: 'Flash',
    providers: [{ id: 'deepseek', kind: 'text', apiKey: 'test-key', baseUrl: 'https://example.com/v1', models: ['Flash', 'Pro'] }] };
  ctx.LT.Settings = { load: async () => settings, normalize: value => value,
    provider: (value, id) => value.providers.find(provider => provider.id === id) };
  ctx.LT.TextModel = { resolve: (value, id, model) => ({ id, model, baseUrl: value.providers[0].baseUrl }),
    hasCredentials: () => true,
    translate: async args => { requests.push(args); const input = JSON.parse(args.user);
      return { text: JSON.stringify({ translations: input.map(item => ({ id: item.id, text: `译文 ${item.id}` })) }) }; } };
  ctx.LT.YouTubeText = { readText: source => source.original, visible: () => true, shouldTranslateChat: () => true,
    ownMutation: () => false, applyResultStyle() {}, showResult: (result, _source, text) => { result.textContent = text; },
    remember: (cache, key, value) => cache.set(key, value),
    parseComments: (output, entries) => { const items = JSON.parse(output).translations;
      assert.deepEqual(Array.from(items, item => item.id), Array.from(entries, item => item.id));
      return new Map(items.map(item => [item.id, item.text])); } };
  run(ctx, 'src/content/youtube-chat.js');
  await flush();
  assert.equal(statuses.at(-1).phase, 'ready');
  timers.splice(0).forEach(fn => fn());
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.model, 'Flash');
  assert.deepEqual(JSON.parse(requests[0].user).map(item => item.text), sources.map(source => source.original));
  assert.equal(sources[0].result.textContent, '译文 1');
  settings = { ...settings, chatModel: 'Pro' };
  storageListeners.forEach(fn => fn({ settings: {} }, 'local'));
  await flush();
  timers.splice(0).forEach(fn => fn());
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].config.model, 'Pro');
  assert.equal(sources[1].result.textContent, '译文 2');
});

class FakeNode {
  constructor() {
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.open = false;
    this.classList = { toggle() {} };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn({ target: this }))); }
  replaceChildren() {}
  appendChild() {}
  setAttribute() {}
}

test('弹窗点击先并行发起检测与待译语对的 create，再通知聊天帧', async () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new FakeNode()); return nodes.get(id); };
  const created = [];
  const messages = [];
  let reportProgress;
  let finishDetector;
  let finishTranslator;
  let refreshTick;
  let livePhase = 'idle', liveCaptionsVisible = true;
  const detectorReady = new Promise(resolve => { finishDetector = resolve; });
  const translatorReady = new Promise(resolve => { finishTranslator = resolve; });
  const ctx = vm.createContext({
    URL, AbortController, DOMException, setInterval: fn => { refreshTick = fn; return 1; }, clearInterval() {}, confirm: () => true,
    document: { getElementById: $, createElement: () => new FakeNode(), activeElement: null,
      documentElement: { dataset: { theme: 'light' } } },
    window: { addEventListener() {}, close() {} },
    LanguageDetector: { create: opts => {
      created.push('detector');
      opts.monitor({ addEventListener: (_event, listener) => { reportProgress = listener; } });
      return detectorReady;
    } },
    Translator: { create: opts => { created.push(`${opts.sourceLanguage}:${opts.targetLanguage}`); return translatorReady; } },
    chrome: {
      tabs: { query: async () => [{ id: 7, url: 'https://www.youtube.com/watch?v=video-a' }],
        sendMessage: async (_tabId, msg, opts) => {
          messages.push({ msg, opts });
          if (msg.type === 'lt:query-status') return { phase: livePhase, onWatchPage: true, isLive: true,
            liveCaptionsVisible, videoId: 'video-a', title: '直播', level: 0 };
          if (msg.type === 'lt:query-text-status') return { chat: { phase: 'waiting', pendingLanguage: 'ko' } };
          if (msg.type === 'lt:prepare-chat') return { ok: true };
          if (msg.type === 'lt:live-set-visible') { liveCaptionsVisible = !!msg.payload; return { ok: true }; }
          return null;
        } },
      runtime: { getManifest: () => ({ version: '0.4.0' }), getURL: path => path, openOptionsPage() {} },
      storage: { onChanged: { addListener() {} } },
    },
  });
  run(ctx, 'src/common/constants.js');
  const settings = { ...ctx.LT.DEFAULTS, sourceLang: 'auto', targetLang: 'zh', enableChatTranslation: true };
  ctx.LT.Settings = { load: async () => settings, save: async () => settings,
    keyList: () => ['test-key'], provider: () => ({ apiKey: 'test-key' }) };
  run(ctx, 'src/ui/popup.js');
  await flush();
  const clicked = $('prepareChatTranslation').fire('click');
  assert.deepEqual(created, ['detector', 'ko:zh']);
  assert.equal(messages.some(entry => entry.msg.type === 'lt:prepare-chat'), false);
  reportProgress({ loaded: .4 });
  assert.match($('chatPrepareProgress').textContent, /语言检测 40%/);
  finishDetector({ destroy() {} });
  finishTranslator({ destroy() {} });
  await clicked;
  assert.equal(messages.filter(entry => entry.msg.type === 'lt:prepare-chat').length, 1);
  const message = messages.find(entry => entry.msg.type === 'lt:prepare-chat');
  assert.equal(message.opts, undefined);
  assert.equal(message.msg.payload.videoId, 'video-a');
  livePhase = 'running';
  await refreshTick();
  assert.equal($('liveToggleCaptions').textContent, '隐藏直播字幕');
  await $('liveToggleCaptions').fire('click');
  assert.equal(messages.at(-3).msg.type, 'lt:live-set-visible');
  assert.equal(messages.at(-3).msg.payload, false);
  assert.equal($('liveToggleCaptions').textContent, '显示直播字幕');
});
