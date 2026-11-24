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
    hasCredentials: config => !!config.key,
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
  // 180 条 × 3s = 540s（9 分钟），按 [60, 180, 300, 1200] 分为 3 块：1..20、21..80、81..180
  const h = harness({ unitCount: 180 });
  h.video.currentTime = 330; // 第 111 条，落在第三块（81..180，共 100 条 > HEAD_UNITS * 1.5）
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.deepEqual(idsOf(h.calls[0]), range(111, 150));
  assert.equal(h.ctrl.texts.filter(Boolean).length, 180);
  assert.equal(h.chunkKeys().length, 3);
  const meta = h.storage.data.get('vs:m:vid-A');
  assert.equal(meta.complete, true);
  assert.equal((await h.LT.SubsCache.listIndex())['vid-A'].complete, true);
  h.ctrl.tick();
  assert.deepEqual(h.caption.shown.at(-1), ['译111', '原文111']);
  const s = h.ctrl.status();
  assert.equal(s.done, 3);
  assert.equal(s.frontierIdx, 179);
  assert.equal(s.overallProgress, 100);
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
  const h = harness({ unitCount: 180 });
  h.settings.textConcurrency = 1;
  h.video.currentTime = 330; // 第 111 条，第三块 81..180 会先翻 111..150，再翻 151..180
  h.translate = (user, signal, n) => (n === 1 ? okReply(idsOf(user)) : hang(signal));
  const pending = h.start();
  while (h.calls.length < 2) await flush();
  h.ctrl.cancel();
  await pending;
  assert.equal(h.ctrl.phase, 'partial');
  assert.equal(h.calls.length, 2);
  assert.equal(h.ctrl.texts[110], '译111');
  assert.equal(h.ctrl.texts[155], undefined);
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
  const h = harness({ unitCount: 180 });
  h.settings.textConcurrency = 1;
  h.video.currentTime = 330; // 第三块 81..180 拆 3 次请求（111..150, 151..180, 81..110）完成后落盘，第 4 次去翻前面的块时取消
  h.translate = (user, signal, n) => (n <= 3 ? okReply(idsOf(user)) : hang(signal));
  const pending = h.start();
  while (h.calls.length < 4) await flush();
  h.ctrl.cancel();
  await pending;
  assert.equal(h.chunkKeys().length, 1);

  const resume = harness({ unitCount: 180, storage: h.storage });
  resume.video.currentTime = 330; // 当前位置在已完成的第三块里，剩下前两块各 1 次请求
  await resume.ctrl.onVideoChanged('vid-A', resume.settings);
  assert.equal(resume.ctrl.phase, 'partial');
  assert.equal(resume.ctrl.texts[110], '译111');
  await resume.start();
  assert.equal(resume.ctrl.phase, 'ready');
  assert.equal(resume.calls.length, 2);
  assert.ok(resume.calls.every(u => idsOf(u).every(id => id <= 80)));
  assert.equal(resume.chunkKeys().length, 3);
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

test('VPS 模式完整流程：字符串上下文、0..100 进度、阶段映射与缓存衔接', async () => {
  const h = harness({ unitCount: 3 });
  const vpsCalls = [];
  const snapshots = [];
  h.ctrl.onStatus = () => snapshots.push(h.ctrl.status());
  h.LT.VpsAsr = {
    transcribe: async args => {
      vpsCalls.push(args);
      args.onProgress({ status: 'downloading', progress: 0, stage: '正在下载音频' });
      args.onProgress({ status: 'transcribing', progress: 65, stage: '正在转写 2/3 段' });
      return {
        model: 'gemini-3.5-transcribe',
        provider: 'gemini',
        lang: 'ja',
        cached: false,
        units: [
          { id: 1, start: 0, end: 1200, text: 'VPS原文1' },
          { id: 2, start: 1200, end: 2600, text: 'VPS原文2' },
        ],
      };
    },
  };
  h.settings.videoTranscriptMode = 'vps';
  h.settings.videoAsrBaseUrl = 'https://asr.example.com';
  h.settings.videoAsrModel = 'gemini-3.5-transcribe';
  h.settings.videoAsrModels = [{ id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe', provider: 'gemini', description: '' }];
  h.settings.videoAsrSendContext = true;
  h.settings.useMetadata = true;
  h.settings.manualContext = '专名：流译';

  await h.start({ meta: { title: '测试视频', author: '测试频道' }, tempContext: '临时补充' });
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(vpsCalls.length, 1);
  assert.equal(typeof vpsCalls[0].context, 'string');
  assert.match(vpsCalls[0].context, /测试视频/);
  assert.match(vpsCalls[0].context, /专名：流译/);
  assert.match(vpsCalls[0].context, /临时补充/);
  assert.equal(vpsCalls[0].url, 'https://www.youtube.com/watch?v=vid-A');

  const dlSnap = snapshots.find(s => s.stage === '正在下载音频');
  const trSnap = snapshots.find(s => s.stage === '正在转写 2/3 段');
  assert.equal(dlSnap.phase, 'downloading');
  assert.equal(trSnap.phase, 'transcribing');
  assert.equal(trSnap.progress, 65);
  assert.equal(h.ctrl.trackLabel, 'VPS 转写 · Gemini 3.5 Transcribe');
  assert.equal(h.ctrl.sourceKind, 'vps');
  assert.deepEqual([...h.ctrl.texts], ['译1', '译2']);
});

test('auto 模式：仅有自动字幕时走 VPS，有人工作字幕时走字幕轨；VPS 断线直接报错', async () => {
  const h = harness({ unitCount: 3 });
  let vpsUsed = 0;
  h.LT.VpsAsr = {
    transcribe: async () => {
      vpsUsed++;
      throw new Error('无法连接 VPS 转写服务，请检查服务是否在线、地址是否正确且域名已授权');
    },
  };
  h.settings.videoTranscriptMode = 'auto';
  h.settings.videoAsrBaseUrl = 'https://asr.example.com';

  await h.start();
  assert.equal(vpsUsed, 1);
  assert.equal(h.ctrl.phase, 'error');
  assert.match(h.ctrl.error, /无法连接 VPS/);

  // 换成人工字幕轨后，auto 模式直接走 YouTube 字幕轨
  h.LT.YouTube.captionTracks = async () => ({
    videoId: 'vid-A',
    defaultIndex: 0,
    tracks: [{ languageCode: 'ja', kind: '', name: '日本語', vssId: '.ja', baseUrl: '' }],
  });
  await h.start();
  assert.equal(vpsUsed, 1);
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(h.ctrl.sourceKind, 'youtube');
});

test('VPS 全异步边转边译：首段一转写完立刻翻译上屏，不等后段完成；乱序到达不串位且完整落盘缓存', async () => {
  const h = harness({ unitCount: 2 });
  let releaseSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  h.settings.videoTranscriptMode = 'vps';
  h.settings.videoAsrBaseUrl = 'https://asr.example.com';
  h.settings.videoAsrModel = 'gemini-3.5-transcribe';
  h.settings.textConcurrency = 2;

  // 自定义翻译返回：按原文内容回显，方便验证乱序到达绝不串位
  h.translate = user => {
    const section = user.split('【需要翻译】')[1].split('【后文参考')[0];
    const lines = [...section.matchAll(/^(\d+)\t(.+)$/gm)].map(m => `${m[1]}\t中:${m[2]}`);
    return { text: lines.join('\n'), finishReason: 'STOP' };
  };

  h.LT.VpsAsr = {
    transcribe: async args => {
      args.onProgress({ status: 'downloading', progress: 0, stage: '正在下载音频', totalChunks: 0, doneChunks: 0 });
      // 先吐出第 0 段（0..60s），此时第 1 段仍在转写中
      args.onChunk({
        seq: 1,
        index: 0,
        startMs: 0,
        endMs: 60000,
        units: [
          { id: 1, start: 1000, end: 3000, text: '首段第一句' },
          { id: 2, start: 4000, end: 6000, text: '首段第二句' },
        ],
      });
      args.onProgress({ status: 'transcribing', progress: 33, stage: '正在转写 1/3 段', totalChunks: 3, doneChunks: 1 });
      await secondGate;
      // 模拟乱序：第 2 段先于第 1 段到达
      args.onChunk({
        seq: 2,
        index: 2,
        startMs: 120000,
        endMs: 180000,
        units: [{ id: 1, start: 121000, end: 124000, text: '第三段句' }],
      });
      args.onChunk({
        seq: 3,
        index: 1,
        startMs: 60000,
        endMs: 120000,
        units: [{ id: 1, start: 61000, end: 64000, text: '第二段句' }],
      });
      return {
        model: 'gemini-3.5-transcribe',
        provider: 'gemini',
        lang: 'ja',
        cached: false,
        streamedChunks: 3,
        units: [],
      };
    },
  };

  const pending = h.start();
  // 等待首段翻译完成，此时 VPS 第 1、2 段还未放行！
  for (let i = 0; i < 40 && h.ctrl.texts[0] == null; i++) await flush();
  assert.equal(h.ctrl.phase, 'transcribing');
  assert.equal(h.ctrl.texts[0], '中:首段第一句', '首段必须在后段转写完前就翻译完成');
  h.video.currentTime = 2;
  h.ctrl.tick();
  assert.deepEqual(h.caption.shown.at(-1), ['中:首段第一句', '首段第一句']);
  assert.equal(h.ctrl.status().frontierIdx, 1);

  releaseSecond();
  await pending;
  assert.equal(h.ctrl.phase, 'ready');
  assert.deepEqual([...h.ctrl.texts], ['中:首段第一句', '中:首段第二句', '中:第二段句', '中:第三段句']);
  assert.deepEqual(Array.from(h.ctrl.units, u => u.text), ['首段第一句', '首段第二句', '第二段句', '第三段句']);

  // 再次打开同一视频：直接命中本机缓存，零请求
  const again = harness({ unitCount: 2, storage: h.storage });
  again.settings.videoTranscriptMode = 'vps';
  again.settings.videoAsrBaseUrl = 'https://asr.example.com';
  again.settings.videoAsrModel = 'gemini-3.5-transcribe';
  await again.ctrl.onVideoChanged('vid-A', again.settings);
  assert.equal(again.ctrl.phase, 'ready');
  assert.equal(again.ctrl.fromCache, true);
  assert.deepEqual([...again.ctrl.texts], ['中:首段第一句', '中:首段第二句', '中:第二段句', '中:第三段句']);
});

test('VPS 流式翻译期间文字模型致命错误会立即中止 VPS 任务', async () => {
  const h = harness({ unitCount: 2 });
  let vpsAborted = false;
  h.settings.videoTranscriptMode = 'vps';
  h.settings.videoAsrBaseUrl = 'https://asr.example.com';
  h.translate = () => { throw new h.RequestError('API Key 无效', { status: 401, fatal: true }); };
  h.LT.VpsAsr = {
    transcribe: async args => {
      args.onChunk({
        seq: 1,
        index: 0,
        startMs: 0,
        endMs: 60000,
        units: [{ id: 1, start: 1000, end: 2000, text: '触发 401' }],
      });
      await new Promise((_, reject) => {
        args.signal.addEventListener('abort', () => {
          vpsAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };

  await h.start();
  assert.equal(vpsAborted, true);
  assert.equal(h.ctrl.phase, 'error');
  assert.match(h.ctrl.error, /API Key 无效/);
});

test('前端翻译报错最多自动重试 3 次（含 HTTP 200 流内中断与 5xx），超限才标记失败', async () => {
  // 场景 1：前 3 次分别报 502、HTTP 200 流中断、网络错误，第 4 次（第 3 次重试）成功
  const okCase = harness({ unitCount: 15 });
  okCase.translate = (user, _signal, n) => {
    if (n === 1) throw new okCase.RequestError('服务暂时不可用', { status: 502 });
    if (n === 2) throw new okCase.RequestError('流式响应中断：Overloaded', { status: 200, retryable: true });
    if (n === 3) throw new Error('network reset');
    return okReply(idsOf(user));
  };
  await okCase.start();
  assert.equal(okCase.ctrl.phase, 'ready');
  assert.equal(okCase.calls.length, 4);

  // 场景 2：持续报错，首次 + 最多 3 次重试 = 共 4 次请求后停止并标为 partial
  const failCase = harness({ unitCount: 15 });
  failCase.translate = () => { throw new failCase.RequestError('服务异常', { status: 503 }); };
  await failCase.start();
  assert.equal(failCase.ctrl.phase, 'partial');
  assert.equal(failCase.calls.length, 4);
  assert.equal(failCase.ctrl.status().failed, 1);
});

test('大块同时发生尾部截断与前段零散漏条时，续翻尾部并补齐前段缺失不丢条', async () => {
  const h = harness({ unitCount: 20 });
  h.translate = (user, _signal, n) => {
    const ids = idsOf(user);
    // 第 1 次：返回 1..12 但漏了第 4 条，且以 MAX_TOKENS 截断（缺 13..20）
    if (n === 1) {
      const partial = ids.slice(0, 12).filter(id => id !== 4);
      return { text: partial.map(id => `${id}\t译${id}`).join('\n'), finishReason: 'MAX_TOKENS' };
    }
    return okReply(ids);
  };
  await h.start();
  assert.equal(h.ctrl.phase, 'ready');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(idsOf(h.calls[1]), range(13, 20));
  assert.deepEqual(idsOf(h.calls[2]), [4]);
  assert.equal(h.ctrl.texts[3], '译4');
  assert.equal(h.ctrl.texts[19], '译20');
});

test('VPS 边转边译：20 分钟大段同频单次翻译、总体进度单调递增且左上角含百分比与分段信息', async () => {
  const h = harness({ unitCount: 2 });
  const overallHistory = [];
  const statuses = [];
  h.ctrl.onStatus = () => {
    const s = h.ctrl.status();
    overallHistory.push(s.overallProgress);
  };
  const origSetStatus = h.caption.setStatus.bind(h.caption);
  h.caption.setStatus = (text, kind) => {
    statuses.push(text);
    origSetStatus(text, kind);
  };
  h.settings.videoTranscriptMode = 'vps';
  h.settings.videoAsrBaseUrl = 'https://asr.example.com';
  h.settings.videoAsrModel = 'gemini-3.5-transcribe';
  h.settings.textConcurrency = 1;

  // 造一个 20 分钟的大分片（400 条），确认前端不再按旧 60 条拆成 7 块
  const bigSegUnits = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1,
    start: 60000 + i * 3000,
    end: 60000 + i * 3000 + 2500,
    text: `长段原文${i + 1}`,
  }));

  let releaseSecond;
  const gate = new Promise(resolve => { releaseSecond = resolve; });

  h.LT.VpsAsr = {
    transcribe: async args => {
      assert.equal(typeof args.getPreferMs, 'function');
      args.onProgress({ status: 'downloading', progress: 0, downloadProgress: 50, stage: '正在下载音频 50%', totalChunks: 0, doneChunks: 0 });
      args.onProgress({ status: 'transcribing', progress: 0, downloadProgress: 100, durationMs: 1260000, doneDurationMs: 0, stage: '正在转写 0/2 段', totalChunks: 2, doneChunks: 0 });
      args.onChunk({
        seq: 1, index: 0, startMs: 0, endMs: 60000,
        units: [{ id: 1, start: 1000, end: 3000, text: '首段句' }],
      });
      args.onProgress({ status: 'transcribing', progress: 5, downloadProgress: 100, durationMs: 1260000, doneDurationMs: 60000, stage: '正在转写 1/2 段', totalChunks: 2, doneChunks: 1 });
      await gate;
      args.onChunk({ seq: 2, index: 1, startMs: 60000, endMs: 1260000, units: bigSegUnits });
      args.onProgress({ status: 'transcribing', progress: 99, downloadProgress: 100, durationMs: 1260000, doneDurationMs: 1260000, stage: '正在转写 2/2 段（备用模型）', usingFallback: true, totalChunks: 2, doneChunks: 2 });
      return { model: 'gemini-3.5-transcribe', provider: 'gemini', lang: 'ja', cached: false, streamedChunks: 2, units: [] };
    },
  };

  const pending = h.start();
  for (let i = 0; i < 40 && h.ctrl.texts[0] == null; i++) await flush();
  releaseSecond();
  await pending;

  assert.equal(h.ctrl.phase, 'ready');
  // 2 个 VPS 分片正好对应 2 次翻译请求（首段 1 次 + 20 分钟 400 条整段 1 次）
  assert.equal(h.calls.length, 2);
  assert.equal(idsOf(h.calls[1]).length, 400);
  // 总体进度严格单调不倒退，且终点为 100
  for (let i = 1; i < overallHistory.length; i++) {
    assert.ok(overallHistory[i] >= overallHistory[i - 1], `总体进度倒退：${overallHistory[i - 1]} -> ${overallHistory[i]}`);
  }
  assert.equal(overallHistory.at(-1), 100);
  assert.ok(statuses.some(t => /^流译：\d+% · 正在下载音频 50%/.test(t)), `未见下载总进度：${statuses.join(' | ')}`);
  assert.ok(statuses.some(t => /^流译：\d+% · 转写 \d+\/2 段.* · 翻译 \d+\/\d+ 块/.test(t)), `未见转写+翻译总进度：${statuses.join(' | ')}`);
});
