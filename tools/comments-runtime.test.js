/** 实际评论内容脚本回归：模拟 DOM、存储和模型，所有请求留在本机测试中。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message) {
  const limit = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > limit) assert.fail(message);
    await tick();
  }
}

class TextNode {
  constructor(text, parentElement) { this.nodeType = 3; this.textContent = text; this.parentElement = parentElement; }
}
class Node {
  constructor(tag = 'div') {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentElement = null;
    this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false;
    this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = { contains: name => this.className.split(' ').includes(name) };
  }
  get isConnected() { return this.root === true || !!this.parentElement?.isConnected; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = text ? [new TextNode(String(text), this)] : [];
  }
  append(...nodes) {
    for (const node of nodes) { node.remove?.(); node.parentElement = this; this.childNodes.push(node); }
  }
  prepend(node) { node.remove?.(); node.parentElement = this; this.childNodes.unshift(node); }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  remove() {
    if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(node => node !== this);
    this.parentElement = null;
  }
  after(node) {
    const parent = this.parentElement;
    node.remove?.(); node.parentElement = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node);
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(',').some(item => node.matches(item.trim()))) return node;
    }
    return null;
  }
  all(selector) {
    const result = [];
    for (const child of this.childNodes) if (child.nodeType === 1) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.all(selector));
    }
    return result;
  }
  querySelector(selector) { return this.all(selector)[0] || null; }
  getBoundingClientRect() { return { width: 200, height: 30, top: 20, bottom: 50, left: 0, right: 200 }; }
}

async function harness(patch = {}) {
  const root = new Node('html'); root.root = true;
  const comments = new Node(); comments.id = 'comments'; root.append(comments);
  const thread = new Node('ytd-comment-thread-renderer'); comments.append(thread);
  const expander = new Node('ytd-text-inline-expander'); thread.append(expander);
  const source = new Node('span'); source.id = 'content-text'; source.textContent = '次の曲も楽しみです'; expander.append(source);
  const messageListeners = [], storageListeners = [], pageHide = [], timers = new Map(), calls = [];
  let timerId = 0, raw, reads = 0;
  // 连续随机取 Key 时刻意交替，确保把随机有效 Key 当签名的回归一定会被发现。
  let randomPick = 0;
  const changingMath = Object.create(Math);
  changingMath.random = () => randomPick++ % 2 ? 0.99 : 0.01;
  const ctx = vm.createContext({
    console, URL, Date, JSON, Math: changingMath, AbortController,
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: node => ({ visibility: node.hidden ? 'hidden' : 'visible', color: 'rgb(15, 15, 15)',
      fontFamily: 'sans-serif', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal' }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    document: { documentElement: root, createElement: tag => new Node(tag),
      querySelector: selector => selector === '#comments' ? comments : root.querySelector(selector),
      querySelectorAll: selector => selector === '#comments #content-text' ? root.all('#content-text') : root.all(selector) },
    MutationObserver: class { observe() {} disconnect() {} },
    window: { addEventListener: (event, fn) => { if (event === 'pagehide') pageHide.push(fn); } },
    chrome: {
      storage: { local: { get: async () => { reads++; return { settings: raw }; } },
        onChanged: { addListener: fn => storageListeners.push(fn) } },
      runtime: { onMessage: { addListener: fn => messageListeners.push(fn) }, sendMessage: async () => ({}) },
    },
  });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/youtube-text.js', 'src/subs/text-model.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
  }
  const LT = ctx.LT;
  raw = LT.Settings.normalize({ enableCommentTranslation: true, enableChatTranslation: false, useMetadata: false,
    providers: [
      { id: 'subs', apiType: 'openai', apiKey: 'test-subs-key', model: 'subtitles-model' },
      { id: 'comments-a', apiType: 'openai', baseUrl: 'https://comments.example/v1', apiKey: 'test-comment-key', model: 'comment-model' },
      { id: 'comments-b', apiType: 'openai', baseUrl: 'https://comments.example/v1', apiKey: 'test-comment-key', model: 'comment-model' },
    ], subsProviderId: 'subs', commentProviderId: 'comments-a', ...patch });
  LT.YouTube = { isWatchPage: () => true, videoIdFromUrl: () => 'test-video', requestMeta: async () => null, onNavigate() {} };
  LT.LiveContext = { currentReview: () => null };
  LT.LiveLog = { safe: value => value, secretsFrom: () => [] };
  LT.Prompt = { formatMetadata: () => '' };
  LT.TextModel.translate = args => new Promise(resolve => calls.push({ ...args, resolve }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/youtube-comments.js'), 'utf8'), ctx);
  await until(() => timers.size > 0, '初始配置未完成读取');
  const runTimers = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  runTimers();
  const message = type => new Promise(resolve => {
    for (const listener of messageListeners) listener({ type }, {}, resolve);
  });
  return {
    LT, calls, root, source, reads: () => reads,
    results: () => root.all('.lt-yt-text-result'),
    status: () => message(LT.MSG.QUERY_TEXT_STATUS),
    translate: () => message(LT.MSG.TRANSLATE_VISIBLE_COMMENTS),
    async update(patch) {
      raw = LT.Settings.normalize({ ...raw, ...patch });
      for (const listener of storageListeners) listener({ settings: { newValue: raw } }, 'local');
      // 存储读取是立即兑现的 Promise；到下一个事件循环时本次读取、重置和扫描调度均已完成。
      await tick(); runTimers();
    },
    complete(index, text) {
      const input = JSON.parse(calls[index].user);
      calls[index].resolve({ text: JSON.stringify({ translations: input.map(item => ({ id: item.id, text })) }) });
    },
    dispose() { for (const callback of pageHide) callback(); timers.clear(); },
  };
}

test('实际评论请求使用独立评论接口，字幕接口变化不取消在途评论', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.translate();
  await until(() => h.calls.length === 1, '评论请求未发起');
  assert.equal(h.calls[0].config.id, 'comments-a');
  assert.equal(h.calls[0].config.model, 'comment-model');
  assert.equal(h.calls[0].config.baseUrl, 'https://comments.example/v1');
  await h.update({ subsProviderId: 'comments-b' });
  assert.equal(h.calls[0].signal.aborted, false);
  h.complete(0, '下一首歌也很期待');
  await until(() => h.results()[0]?.textContent === '下一首歌也很期待', '独立评论请求未完成显示');
  assert.equal((await h.status()).comments.translated, 1);
});

test('评论接口切换取消旧请求，迟到旧结果不会写入新的评论界面', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.translate();
  await until(() => h.calls.length === 1, '旧评论请求未发起');
  const oldResult = h.results()[0];
  await h.update({ commentProviderId: 'comments-b' });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(oldResult.isConnected, false);
  await h.translate();
  await until(() => h.calls.length === 2, '新评论请求未发起');
  assert.equal(h.calls[1].config.id, 'comments-b');
  h.complete(0, '旧接口迟到译文');
  await tick();
  assert.equal(h.results()[0].textContent, '');
  h.complete(1, '新接口译文');
  await until(() => h.results()[0]?.textContent === '新接口译文', '新接口结果未显示');
});

test('Gemini 复用多直播 Key 重读不取消，Key 列表变化取消旧请求', async t => {
  const h = await harness({ apiKeys: 'test-live-a, test-live-b', providers: [
    { id: 'comments-a', apiType: 'gemini', apiKey: '', model: 'gemini-comment-model' },
  ], subsProviderId: 'comments-a', commentProviderId: 'comments-a' });
  t.after(() => h.dispose());
  await h.translate();
  await until(() => h.calls.length === 1, 'Gemini 评论请求未发起');
  assert.ok(['test-live-a', 'test-live-b'].includes(h.calls[0].config.key));
  await h.update({}); await h.update({});
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.calls.length, 1);
  await h.update({ apiKeys: 'test-live-a, test-live-c' });
  assert.equal(h.calls[0].signal.aborted, true);
  h.complete(0, '旧 Key 列表的迟到译文');
  await tick();
  assert.equal(h.results()[0].textContent, '');
});

test('同地址同模型的不同接口 id 不复用另一接口的评论缓存', async t => {
  const h = await harness(); t.after(() => h.dispose());
  await h.translate();
  await until(() => h.calls.length === 1, '首条评论请求未发起');
  h.complete(0, '第一套接口译文');
  await until(() => h.results()[0]?.textContent === '第一套接口译文', '首条译文未完成');
  await h.update({ commentProviderId: 'comments-b' });
  await h.translate();
  await until(() => h.calls.length === 2, '切换接口后误用了旧接口缓存');
  assert.equal(h.calls[1].config.baseUrl, h.calls[0].config.baseUrl);
  assert.equal(h.calls[1].config.model, h.calls[0].config.model);
  assert.notEqual(h.calls[1].config.id, h.calls[0].config.id);
  h.complete(1, '第二套接口译文');
  await until(() => h.results()[0]?.textContent === '第二套接口译文', '第二套接口译文未完成');
});
