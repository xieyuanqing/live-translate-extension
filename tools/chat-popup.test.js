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
  const detectorReady = new Promise(resolve => { finishDetector = resolve; });
  const translatorReady = new Promise(resolve => { finishTranslator = resolve; });
  const ctx = vm.createContext({
    URL, AbortController, DOMException, setInterval: () => 1, clearInterval() {}, confirm: () => true,
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
          if (msg.type === 'lt:query-status') return { phase: 'idle', onWatchPage: true, isLive: true,
            videoId: 'video-a', title: '直播', level: 0 };
          if (msg.type === 'lt:query-text-status') return { chat: { phase: 'waiting', pendingLanguage: 'ko' } };
          if (msg.type === 'lt:prepare-chat') return { ok: true };
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
});
