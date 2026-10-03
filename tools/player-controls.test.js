/** 播放器入口与字幕显隐回归：假 DOM、假模型；不访问 YouTube 或真实接口。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.css = {};
    this.style = { setProperty: (key, value) => { this.css[key] = value; } };
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 280;
    this.clientHeight = 170;
  }
  get isConnected() { return !!(this.connected || this.parent?.isConnected); }
  get parentElement() { return this.parent; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  insertBefore(child, before) {
    child.parent = this;
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
  querySelector(selector) { return selector === '.ytp-right-controls' ? this.controlBar || null : null; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() { this.focused = true; }
  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler({
      key: '', target: this, stopPropagation() {}, preventDefault() {}, ...event,
    });
  }
}

test('流译按钮只插入底部控制栏，按直播/整片状态切换并适应控制栏重建', () => {
  const document = { createElement: tag => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag) };
  const ctx = vm.createContext({ document, chrome: { runtime: { getURL: path => `extension://${path}` } } });
  load(ctx, 'src/content/player-controls.js');
  let captions = 0, translation = 0;
  const controls = new ctx.LT.PlayerControls({
    onToggleCaptions: () => captions++, onToggleTranslation: () => translation++,
  });
  const player = new FakeNode('div');
  player.connected = true;
  // 控制栏未出现时，视频画面不能出现独立悬浮按钮。
  controls.mount(player);
  assert.equal(player.children.length, 0);
  assert.equal(controls.root, null);
  const bar = new FakeNode('div');
  const nativeCc = new FakeNode('button');
  player.appendChild(bar);
  player.controlBar = bar;
  bar.appendChild(nativeCc);
  controls.mount(player);
  assert.equal(player.children.length, 1);
  assert.equal(bar.children[0], controls.root);
  assert.equal(bar.children[1], nativeCc);
  assert.equal(controls.button.children[0].tag, 'svg');
  assert.equal(controls.root.children.length, 1);
  assert.equal(controls.root.style.position, undefined);
  controls.update({ modeKnown: false, isLive: false, phase: 'idle', liveCaptionsVisible: true, video: { phase: 'idle', visible: true } });
  assert.equal(controls.button.disabled, true);
  controls.update({ modeKnown: true, isLive: true, phase: 'idle', liveCaptionsVisible: true, video: { phase: 'idle' } });
  assert.equal(controls.button.attributes['aria-label'], '开始实时翻译');
  controls.update({ modeKnown: true, isLive: true, phase: 'running', liveCaptionsVisible: true, video: { phase: 'idle' } });
  assert.equal(controls.button.attributes['aria-label'], '停止实时翻译');
  assert.equal(controls.button.attributes['aria-pressed'], 'true');
  controls.button.fire('click');
  assert.deepEqual([captions, translation], [0, 1]);
  let stopped = false, prevented = false;
  controls.root.fire('click', { stopPropagation() { stopped = true; } });
  controls.root.fire('dblclick', { preventDefault() { prevented = true; } });
  assert.equal(stopped, true);
  assert.equal(prevented, true);

  controls.update({ modeKnown: true, isLive: false, phase: 'idle', video: { phase: 'translating', visible: false, done: 3, total: 10 } });
  assert.equal(controls.button.attributes['aria-label'], '取消整片翻译');
  controls.button.fire('click');
  assert.equal(translation, 2);

  controls.mount(player);
  assert.equal(bar.children.length, 2);
  const oldRoot = controls.root;
  const newBar = new FakeNode('div');
  player.controlBar = newBar;
  player.appendChild(newBar);
  controls.mount(player);
  assert.equal(bar.children.length, 1);
  assert.equal(newBar.children.length, 1);
  assert.notEqual(controls.root, oldRoot);
  assert.equal(controls.button.attributes['aria-label'], '取消整片翻译');

  controls.update({ modeKnown: true, isLive: false, phase: 'idle', video: { phase: 'ready', visible: true } });
  assert.equal(controls.button.attributes['aria-label'], '隐藏整片字幕');
  controls.button.fire('click');
  assert.equal(captions, 1);
  controls.update({ modeKnown: true, isLive: false, phase: 'idle', video: { phase: 'ready', visible: false } });
  assert.equal(controls.button.attributes['aria-label'], '显示整片字幕');
  controls.button.fire('click');
  assert.equal(captions, 2);
  controls.unmount();
  assert.equal(newBar.children.length, 0);
});

test('直播手动隐藏在定时门控及广告结束后仍隐藏，音频采集继续', async () => {
  const intervals = [];
  const captionVisible = [];
  let controls, client, tap, onMessage;
  let ad = false;
  const video = { paused: false, muted: false, volume: 1, currentTime: 0 };
  const player = {};
  const ctx = vm.createContext({
    console: { info() {}, warn() {}, error() {} }, Date,
    setInterval(fn) { intervals.push(fn); },
    window: { addEventListener() {} },
    chrome: { runtime: { sendMessage: async () => {}, onMessage: { addListener(fn) { onMessage = fn; } } } },
  });
  load(ctx, 'src/common/constants.js');
  load(ctx, 'src/common/prompt.js');
  load(ctx, 'src/common/live-context.js');
  load(ctx, 'src/common/live-log.js');
  const LT = ctx.LT;
  const settings = { ...LT.DEFAULTS, apiKeys: 'test-only', autoStartLive: false, useMetadata: false, generateLiveContext: false };
  LT.Settings = { load: async () => settings, pickKey: () => 'test-only', keyList: () => ['test-only'] };
  LT.CaptionLayer = class {
    mount(p) { this.player = p; this.mounted = true; }
    unmount() { this.mounted = false; }
    applySettings() {} clear() {} setStatus() {}
    setVisible(visible) { captionVisible.push(visible); }
    showTimed() {} pushCommitted() {} setCurrent() {} setSource() {} render() {}
  };
  LT.VideoSubsController = class {
    constructor() { this.visible = true; }
    status() { return { phase: 'idle', visible: this.visible }; }
    onVideoChanged() {} deactivate() {} cancel() {} tick() {} updateSettings() {}
  };
  LT.PlayerControls = class {
    constructor(callbacks) { controls = callbacks; }
    mount() {} unmount() {} update() {}
  };
  LT.SubtitleStabilizer = class { reset() {} };
  LT.GeminiLiveClient = class {
    constructor() { client = this; this.running = false; }
    start() { this.running = true; }
    stop() { this.running = false; }
  };
  LT.AudioTap = class {
    constructor() { tap = this; this.detached = false; }
    async attach() { return 'worklet'; }
    detach() { this.detached = true; }
    setGate(enabled) { this.gate = enabled; }
  };
  LT.YouTube = {
    isWatchPage: () => true, videoIdFromUrl: () => 'live-A', player: () => player, video: () => video,
    waitForVideo: async () => video, waitForMeta: async () => ({ videoId: 'live-A', isLive: true }),
    onMetaPush() {}, onNavigate() {}, adShowing: () => ad,
  };
  load(ctx, 'src/content/main.js');
  await flush();
  await LT.debug.start('test');
  assert.equal(LT.debug.session.phase, 'running');
  assert.equal(client.running, true);
  assert.equal(tap.gate, true);
  controls.onToggleCaptions();
  assert.equal(captionVisible.at(-1), false);
  intervals[0]();
  assert.equal(captionVisible.at(-1), false);
  ad = true;
  intervals[0]();
  ad = false;
  intervals[0]();
  assert.equal(captionVisible.at(-1), false);
  assert.equal(tap.detached, false);
  assert.equal(client.running, true);
  controls.onToggleCaptions();
  assert.equal(captionVisible.at(-1), true);
  onMessage({ type: LT.MSG.LIVE_SET_VISIBLE, payload: false }, {}, () => {});
  assert.equal(captionVisible.at(-1), false);
  onMessage({ type: LT.MSG.LIVE_SET_VISIBLE, payload: true }, {}, () => {});
  assert.equal(captionVisible.at(-1), true);
  controls.onToggleTranslation();
  assert.equal(client.running, false);
  assert.equal(tap.detached, true);
});

test('扩展 manifest 注入单个中性播放器控件', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const content = manifest.content_scripts.find(item => item.js?.includes('src/content/main.js'));
  assert.ok(content.js.indexOf('src/content/player-controls.js') < content.js.indexOf('src/content/main.js'));
  assert.ok(content.css.includes('src/content/player-controls.css'));
  const style = fs.readFileSync(path.join(ROOT, 'src/content/player-controls.css'), 'utf8');
  assert.match(style, /width: 48px/);
  assert.doesNotMatch(style, /#2670d5|__badge|__action/);
});
