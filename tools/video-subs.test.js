/** 整片字幕任务回归：模拟字幕轨、模型与存储，不访问浏览器、不连接真实 API。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const quiet = { info() {}, warn() {}, error() {} };
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const clone = v => JSON.parse(JSON.stringify(v));

function memoryStorage() {
  const data = new Map();
  const list = keys => (Array.isArray(keys) ? keys : [keys]);
  return {
    data,
    local: {
      async get(keys) {
        const out = {};
        if (keys == null) { for (const [k, v] of data) out[k] = clone(v); return out; }
        for (const k of list(keys)) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, clone(v)); },
      async remove(keys) { for (const k of list(keys)) data.delete(k); },
    },
  };
}

/** 从请求文本里取出「需要翻译」的编号。 */
function idsOf(user) {
  const section = user.split('【需要翻译】')[1].split('【后文参考')[0];
  return [...section.matchAll(/^(\d+)\t/gm)].map(m => Number(m[1]));
}
const okReply = (ids, extra = '') => ({ text: ids.map(id => `${id}\t译${id}`).join('\n') + extra, finishReason: 'STOP' });
const hang = signal => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function harness({ unitCount = 100, storage = memoryStorage(), translate } = {}) {
  const video = { currentTime: 0 };
  let videoId = 'vid-A';
  const ctx = vm.createContext({ console: quiet, Date, setTimeout, clearTimeout, DOMException, AbortController,
    chrome: { storage } });
  for (const f of ['src/common/constants.js', 'src/common/prompt.js', 'src/subs/chunker.js', 'src/subs/scheduler.js',
    'src/subs/cache.js', 'src/content/video-subs.js']) load(ctx, f);
  const LT = ctx.LT;
  LT.SUBS.BACKOFF_MS = 1;
  LT.Settings = { pickKey: s => s.apiKeys, scene: s => s.scenes.find(x => x.id === s.sceneId) };
  LT.Json3 = { parse: x => x };
  LT.Segmenter = { build: events => events };
  const calls = [];
  const h = { translate: translate || (user => okReply(idsOf(user))) };
  class RequestError extends Error {
    constructor(message, opts = {}) { super(message); this.name = 'RequestError'; Object.assign(this, opts); }
  }
  LT.TextModel = {
    RequestError,
    resolve: s => ({ apiType: 'gemini', baseUrl: '', key: s.apiKeys, model: s.textModel, concurrency: s.textConcurrency, path: 'auto' }),
    translate: async ({ user, signal }) => { calls.push(user); return h.translate(user, signal, calls.length); },
  };
  const units = [];
  for (let i = 0; i < unitCount; i++) units.push({ id: i + 1, start: i * 3000, end: i * 3000 + 2800, text: `原文${i + 1}` });
  LT.YouTube = {
    videoIdFromUrl: () => videoId,
    adShowing: () => false,
    captionTracks: async () => ({ videoId, defaultIndex: 0,
      tracks: [{ languageCode: 'ja', kind: 'asr', name: '日本語', vssId: 'a.ja', baseUrl: '' }] }),
    chooseTrack: tracks => tracks[0],
    fetchCaptions: async () => ({ text: units, source: 'test' }),
  };
  const caption = { statuses: [], shown: [], setStatus(t, k) { this.statuses.push([t, k]); }, showTimed(t, s) { this.shown.push([t, s]); } };
  const ctrl = new LT.VideoSubsController({ caption, getVideo: () => video, onStatus() {} });
  const settings = { ...LT.DEFAULTS, apiKeys: 'k', textModel: 'm', textConcurrency: 2, useMetadata: false, autoShowCached: true };
  Object.assign(h, { LT, ctrl, calls, video, storage, caption, settings, units, RequestError,
    setVideoId: id => { videoId = id; },
    start: extra => ctrl.start({ settings, meta: { title: 'T' }, tempContext: '', ...extra }),
    chunkKeys: () => [...storage.data.keys()].filter(k => k.startsWith('vs:c:')),
  });
  return h;
}

test('从当前位置先翻小段，翻好即可显示，全部完成后按块写缓存', async () => {
  const h = harness();
  h.video.currentTime = 200; // 第 67 条，落在第二块（61-100）
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.deepEqual(idsOf(h.calls[0]), range(67, 86));
  assert.equal(h.ctrl.texts.filter(Boolean).length, 100);
  assert.equal(h.chunkKeys().length, 2);
  const meta = h.storage.data.get('vs:m:vid-A');
  assert.equal(meta.complete, true);
  assert.equal((await h.LT.SubsCache.listIndex())['vid-A'].complete, true);
  h.ctrl.tick();
  assert.deepEqual(h.caption.shown.at(-1), ['译67', '原文67']);
  const s = h.ctrl.status();
  assert.equal(s.done, 2);
  assert.equal(s.frontierIdx, 99);
});

test('输出被截断时只补结尾一段，块完整后才写缓存', async () => {
  const h = harness({ unitCount: 30 });
  h.translate = (user, _signal, n) => {
    const ids = idsOf(user);
    if (n === 1) return { text: ids.slice(0, 12).map(id => `${id}\t译${id}`).join('\n'), finishReason: 'MAX_TOKENS' };
    return okReply(ids);
  };
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(idsOf(h.calls[1]), range(13, 30));
  assert.equal(h.chunkKeys().length, 1);
  assert.equal(h.storage.data.get(h.chunkKeys()[0]).length, 30);
});

test('零散缺漏只补缺的编号', async () => {
  const h = harness({ unitCount: 30 });
  h.translate = (user, _signal, n) => {
    const ids = idsOf(user);
    if (n === 1) return okReply(ids.filter(id => id !== 5 && id !== 9), '\n9\t');
    return okReply(ids);
  };
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(idsOf(h.calls[1]), [5, 9]);
  assert.equal(h.ctrl.texts[4], '译5');
  assert.equal(h.ctrl.texts[8], '译9');
});

test('限流后按提示等待再试', async () => {
  const h = harness({ unitCount: 30 });
  h.translate = (user, _signal, n) => {
    if (n === 1) throw new h.RequestError('触发限流', { status: 429, retryAfterMs: 5 });
    return okReply(idsOf(user));
  };
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(h.calls.length, 2);
});

test('Key 无效这类致命错误立即停止全部并报错', async () => {
  const h = harness();
  h.translate = () => { throw new h.RequestError('API Key 无效', { status: 401, fatal: true }); };
  await h.start();
  assert.equal(h.ctrl.phase, 'error');
  assert.match(h.ctrl.error, /Key 无效/);
  assert.ok(h.calls.length <= 2);
  assert.ok(h.ctrl.states.every(s => s === 'pending'));
  assert.equal(h.chunkKeys().length, 0);
});

test('取消后作废进行中的请求，已翻好的条目保留，不完整的块不入缓存', async () => {
  const h = harness();
  h.settings.textConcurrency = 1;
  h.video.currentTime = 200;
  h.translate = (user, signal, n) => (n === 1 ? okReply(idsOf(user)) : hang(signal));
  const pending = h.start();
  while (h.calls.length < 2) await flush();
  h.ctrl.cancel();
  await pending;
  assert.equal(h.ctrl.phase, 'partial');
  assert.equal(h.calls.length, 2);
  assert.equal(h.ctrl.texts[66], '译67');
  assert.equal(h.ctrl.texts[89], undefined);
  assert.equal(h.chunkKeys().length, 0);
  assert.ok(h.ctrl.states.every(s => s === 'pending'));
});

test('换视频后旧任务的结果不落到新视频上', async () => {
  const h = harness();
  h.settings.textConcurrency = 1;
  let release;
  h.translate = user => new Promise(resolve => { release = () => resolve(okReply(idsOf(user))); });
  const pending = h.start();
  while (!release) await flush();
  h.setVideoId('vid-B');
  const changed = h.ctrl.onVideoChanged('vid-B', h.settings);
  release();
  await pending;
  await changed;
  assert.equal(h.ctrl.videoId, 'vid-B');
  assert.equal(h.ctrl.units, null);
  assert.equal(h.ctrl.phase, 'idle');
  assert.equal(h.chunkKeys().length, 0);
});

test('缓存命中零请求；配置变化时保留旧缓存并标注，重新翻译才替换', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  assert.equal(h.calls.length, 1);
  const oldChunkKey = h.chunkKeys()[0];

  // 再次打开：自动加载缓存，不发请求
  const again = harness({ unitCount: 30, storage: h.storage });
  await again.ctrl.onVideoChanged('vid-A', again.settings);
  assert.equal(again.ctrl.phase, 'ready');
  assert.equal(again.ctrl.fromCache, true);
  assert.equal(again.ctrl.texts[0], '译1');
  await again.start();
  assert.equal(again.calls.length, 0);

  // 换模型：旧的完整缓存照用，标注旧设置，仍不发请求
  again.settings.textModel = 'm2';
  await again.start();
  assert.equal(again.calls.length, 0);
  assert.equal(again.ctrl.staleConfig, true);
  assert.equal(again.ctrl.phase, 'ready');

  // 明确要求重新翻译：新指纹、新请求，旧块被清掉
  await again.start({ force: true });
  assert.equal(again.calls.length, 1);
  assert.equal(again.ctrl.phase, 'ready');
  assert.equal(again.ctrl.staleConfig, false);
  assert.equal(again.storage.data.has(oldChunkKey), false);
  assert.equal(again.chunkKeys().length, 1);
});

test('续翻只翻没完成的块，已缓存的块直接复用', async () => {
  const h = harness();
  h.settings.textConcurrency = 1;
  h.video.currentTime = 200;
  h.translate = (user, signal, n) => (n <= 3 ? okReply(idsOf(user)) : hang(signal));
  const pending = h.start();
  while (h.calls.length < 4) await flush();
  h.ctrl.cancel();
  await pending;
  assert.equal(h.chunkKeys().length, 1);

  const resume = harness({ storage: h.storage });
  resume.video.currentTime = 200; // 当前位置在已完成的块里，剩下的块整块一次请求
  await resume.ctrl.onVideoChanged('vid-A', resume.settings);
  assert.equal(resume.ctrl.phase, 'partial');
  assert.equal(resume.ctrl.texts[66], '译67');
  await resume.start();
  assert.equal(resume.ctrl.phase, 'ready');
  assert.equal(resume.calls.length, 1);
  assert.ok(idsOf(resume.calls[0]).every(id => id <= 60));
  assert.equal(resume.chunkKeys().length, 2);
});

test('分句规则版本变化后不复用旧原文，重新读取字幕轨', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const src = h.storage.data.get('vs:s:vid-A:ja|asr');
  src.segVersion = 0;
  h.storage.data.set('vs:s:vid-A:ja|asr', src);
  let reads = 0;
  const again = harness({ unitCount: 30, storage: h.storage });
  const fetchCaptions = again.LT.YouTube.fetchCaptions;
  again.LT.YouTube.fetchCaptions = async (...a) => { reads++; return fetchCaptions(...a); };
  await again.start();
  assert.equal(reads, 1);
  assert.equal(again.ctrl.phase, 'ready');
});

test('分句版本变化并改变编号后，不能把旧译文套在新原文上', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const again = harness({ unitCount: 20, storage: h.storage });
  again.LT.SUBS.SEG_VERSION++;
  await again.ctrl.onVideoChanged('vid-A', again.settings);
  assert.equal(again.ctrl.units, null, '不自动显示旧分句缓存');
  await again.start();
  assert.equal(again.ctrl.units.length, 20);
  assert.equal(again.ctrl.texts.length, 20);
  assert.ok(again.calls.length > 0, '新编号必须重新翻译');
});

test('完整缓存无需 API Key 也可以手动加载', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const again = harness({ unitCount: 30, storage: h.storage });
  again.settings.apiKeys = '';
  await again.start();
  assert.equal(again.ctrl.phase, 'ready');
  assert.equal(again.calls.length, 0);
});

test('不同视频同时保存缓存，不会相互覆盖缓存列表', async () => {
  const h = harness({ unitCount: 30 });
  const other = harness({ unitCount: 30, storage: h.storage });
  other.setVideoId('vid-B');
  await Promise.all([h.start(), other.start()]);
  assert.deepEqual(Object.keys(await h.LT.SubsCache.listIndex()).sort(), ['vid-A', 'vid-B']);
});

test('缓存写入完成得晚，不能覆盖新视频的状态提示', async () => {
  const h = harness({ unitCount: 30 });
  const original = h.LT.SubsCache.setMeta;
  let release;
  h.LT.SubsCache.setMeta = async meta => {
    await original(meta);
    if (meta.complete) await new Promise(resolve => { release = resolve; });
  };
  const pending = h.start();
  while (!release) await flush();
  h.setVideoId('vid-B');
  await h.ctrl.onVideoChanged('vid-B', h.settings);
  const count = h.caption.statuses.length;
  release();
  await pending;
  assert.equal(h.ctrl.phase, 'idle');
  assert.equal(h.caption.statuses.length, count, '旧完成回调不得提示新视频已就绪');
});

test('长度正确但包含空译文的缓存块不能算完整，续翻会修复', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const key = h.chunkKeys()[0];
  const chunk = h.storage.data.get(key);
  chunk[2] = null;
  h.storage.data.set(key, chunk);
  const again = harness({ unitCount: 30, storage: h.storage });
  await again.start();
  assert.equal(again.calls.length, 1);
  assert.equal(again.ctrl.phase, 'ready');
  assert.equal(again.ctrl.texts[2], '译3');
});

test('部分缓存遇到配置变化也保留，不自动花额度重翻或混用模型', async () => {
  const h = harness();
  await h.start();
  h.storage.data.delete(h.chunkKeys()[0]);
  const record = h.storage.data.get('vs:m:vid-A');
  record.complete = false;
  h.storage.data.set('vs:m:vid-A', record);
  const again = harness({ storage: h.storage });
  again.settings.textModel = 'm2';
  await again.start();
  assert.equal(again.calls.length, 0);
  assert.equal(again.ctrl.phase, 'partial');
  assert.equal(again.ctrl.staleConfig, true);
});

test('缺少 Key 时点重新翻译，报错但保留已有缓存', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const oldKeys = h.chunkKeys();
  h.settings.apiKeys = '';
  await h.start({ force: true });
  assert.equal(h.ctrl.phase, 'error');
  assert.deepEqual(h.chunkKeys(), oldKeys);
  assert.match(h.ctrl.error, /API Key/);
});

test('缓存原文变化但条数相同，也不能复用原来的译文', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const src = h.storage.data.get('vs:s:vid-A:ja|asr');
  src.units[0][2] = '原文已变更';
  h.storage.data.set('vs:s:vid-A:ja|asr', src);
  const again = harness({ unitCount: 30, storage: h.storage });
  await again.start();
  assert.equal(again.calls.length, 1);
  assert.equal(again.ctrl.staleConfig, false);
});

test('修改背景后自动加载缓存会标记旧配置，字幕仍显示原目标语言', async () => {
  const h = harness({ unitCount: 30 });
  await h.start();
  const again = harness({ unitCount: 30, storage: h.storage });
  again.settings.manualContext = '新的背景资料';
  await again.ctrl.onVideoChanged('vid-A', again.settings);
  assert.equal(again.ctrl.staleConfig, true);
  again.settings.targetLang = 'en';
  again.ctrl.updateSettings(again.settings);
  assert.equal(again.ctrl.status().targetLang, 'zh');
  assert.equal(again.calls.length, 0);
});

test('读取字幕轨期间取消，会通知页面桥放弃读取', async () => {
  const h = harness();
  let cancelled = 0;
  let release;
  h.LT.YouTube.cancelCaptions = () => { cancelled++; };
  h.LT.YouTube.fetchCaptions = () => new Promise(r => { release = r; });
  const pending = h.start();
  await flush();
  assert.equal(h.ctrl.phase, 'reading');
  h.ctrl.cancel();
  assert.equal(cancelled, 1);
  assert.equal(h.ctrl.phase, 'idle');
  release({ error: '读取已取消', tried: [] });
  await pending;
  assert.equal(h.ctrl.phase, 'idle');
  assert.equal(h.calls.length, 0);
});
