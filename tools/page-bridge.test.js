/** 页面桥回归：模拟播放器、CC 按钮与 timedtext 响应，不连接 YouTube。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const captions = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '测试字幕' }] }] });
const reply = text => ({ ok: true, status: 200, text: async () => text, clone() { return this; } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const want = { videoId: 'vid-A', languageCode: 'ja', kind: 'asr', vssId: 'a.ja' };
const url = 'https://www.youtube.com/api/timedtext?v=vid-A&lang=ja&kind=asr&fmt=json3';
const baseUrl = '/api/timedtext?v=vid-A&lang=ja&kind=asr&sparams=v%2Ccaps&signature=SIG';
const potUrl = (lang, kind) =>
  `https://www.youtube.com/api/timedtext?v=vid-A&lang=${lang}${kind ? `&kind=${kind}` : ''}&fmt=srv3&pot=POT1&potc=1`;

/** 时间是假的：每次 200 毫秒的轮询睡眠立刻返回并把时钟拨快 200 毫秒，截止时间逻辑因此可测。 */
function harness() {
  let handler;
  let seq = 1;
  const replies = new Map();
  const h = { fetch: async () => reply(captions), fetched: [], waits: 0, unloads: 0, toggles: 0, cc: false, now: 0, audioTracks: [] };
  const location = { href: 'https://www.youtube.com/watch?v=vid-A' };
  const player = {
    getPlayerResponse: () => ({ videoDetails: { videoId: new URL(location.href).searchParams.get('v') } }),
    getOption: (_module, key) => (key === 'tracklist' ? [] : null),
    isSubtitlesOn: () => h.cc, loadModule() {}, setOption() {},
    unloadModule() { h.unloads++; },
    toggleSubtitles() { h.toggles++; h.cc = !h.cc; },
    getAudioTrack: () => ({ captionTracks: h.audioTracks }),
    getWebPlayerContextConfig: () => ({ innertubeContextClientVersion: '2.20260101.00.00' }),
  };
  const button = {
    isConnected: true,
    getAttribute: name => (name === 'aria-pressed' ? String(h.cc) : null),
    click() { h.toggles++; h.cc = !h.cc; },
  };
  const window = {
    fetch: (...args) => {
      h.fetched.push(args[0] instanceof URL ? args[0].href : String(args[0]));
      return h.fetch(...args);
    },
    addEventListener(_type, fn) { handler = fn; },
    postMessage(msg) { const r = replies.get(msg.id); if (r) { replies.delete(msg.id); r(msg.payload); } },
    ytcfg: { get: key => (key === 'DEVICE' ? 'cbrand=apple&cbr=Chrome&cbrver=140&cos=Macintosh&cosver=10_15_7&cplatform=DESKTOP' : undefined) },
  };
  const ctx = vm.createContext({ window, location, URL, URLSearchParams, AbortController,
    Date: { now: () => h.now },
    document: {
      getElementById: () => player, addEventListener() {},
      querySelector: sel => (sel === '.ytp-subtitles-button' ? button : null),
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
    },
    setTimeout(fn, ms) {
      if (ms === 200) { h.waits++; h.now += 200; h.onWait?.(); return setTimeout(fn, 0); }
      const timer = setTimeout(fn, ms); timer.unref(); return timer;
    }, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main-world/page-bridge.js'), 'utf8'), ctx);
  const send = (kind, args) => new Promise(r => {
    const id = seq++;
    replies.set(id, r);
    handler({ source: window, data: { __lt: 'lt-bridge', dir: 'req', kind, id, args } });
  });
  return Object.assign(h, { location, window, player,
    request: (args = want) => send('captions', args),
    tracks: () => send('tracks'),
    cancel: () => send('cancel'),
  });
}

test('复用已捕获的字幕正文，不额外开启播放器 CC', async () => {
  const h = harness();
  await h.window.fetch(url);
  await flush();
  const result = await h.request();
  assert.equal(result.source, 'captured');
  assert.equal(result.text, captions);
  assert.equal(h.waits, 0);
  assert.equal(h.toggles, 0);
});

test('播放器传入 URL 对象时也能捕获字幕请求', async () => {
  const h = harness();
  await h.window.fetch(new URL(url));
  await flush();
  const result = await h.request();
  assert.equal(result.source, 'captured');
});

test('接口的 JSON 错误正文不能冒充字幕，继续补取真实字幕', async () => {
  const h = harness();
  h.fetch = async () => reply('{"error":"temporary"}');
  await h.window.fetch(url);
  await flush();
  h.fetch = async () => reply(captions);
  const result = await h.request();
  assert.equal(result.text, captions);
  assert.equal(result.source, 'refetch');
});

test('没有拦截到请求时，用播放器音轨里带 pot 的同轨道 URL 直接读取', async () => {
  const h = harness();
  h.audioTracks = [{ url: potUrl('ja', 'asr'), vssId: 'a.ja', kind: 'asr' }];
  const result = await h.request();
  assert.equal(result.source, 'audiotrack');
  assert.equal(result.text, captions);
  assert.equal(h.toggles, 0);
  const u = new URL(h.fetched[0]);
  assert.equal(u.searchParams.get('pot'), 'POT1');
  assert.equal(u.searchParams.get('fmt'), 'json3');
});

test('只有别的轨道有 pot 时，用 baseUrl 拼出带校验参数的请求', async () => {
  const h = harness();
  h.audioTracks = [{ url: potUrl('en', ''), vssId: '.en', kind: '' }];
  const result = await h.request({ ...want, baseUrl });
  assert.equal(result.source, 'composed');
  const u = new URL(h.fetched[0]);
  assert.equal(u.searchParams.get('pot'), 'POT1');
  assert.equal(u.searchParams.get('potc'), '1');
  assert.equal(u.searchParams.get('c'), 'WEB');
  assert.equal(u.searchParams.get('cver'), '2.20260101.00.00');
  assert.equal(u.searchParams.get('cbr'), 'Chrome');
  assert.equal(u.searchParams.get('lang'), 'ja');
  assert.equal(u.searchParams.get('fmt'), 'json3');
  assert.equal(u.searchParams.get('signature'), 'SIG');
  assert.equal(h.toggles, 0);
});

test('什么都没有时打开 CC 触发播放器加载，拿到后关回去', async () => {
  const h = harness();
  h.onWait = () => { if (h.cc && h.waits === 2) h.window.fetch(url); };
  const result = await h.request();
  assert.equal(result.source, 'triggered-captured');
  assert.equal(h.toggles, 2);
  assert.equal(h.cc, false);
  assert.ok(result.tried.some(t => t.source === 'trigger-cc' && t.method === 'toggleSubtitles' && t.changed));
});

test('等待期间用户自己关掉了 CC，结束时不再碰它', async () => {
  const h = harness();
  h.onWait = () => {
    if (h.waits === 2) h.cc = false;
    if (h.waits === 3) h.window.fetch(url);
  };
  const result = await h.request();
  assert.equal(result.source, 'triggered-captured');
  assert.equal(h.toggles, 1);
  assert.equal(h.cc, false);
});

test('用户原本开着 CC，触发路径不动它', async () => {
  const h = harness();
  h.cc = true;
  h.onWait = () => { if (h.waits === 1) h.window.fetch(url); };
  const result = await h.request();
  assert.equal(result.source, 'triggered-captured');
  assert.equal(h.toggles, 0);
  assert.equal(h.cc, true);
  assert.ok(result.tried.some(t => t.source === 'trigger-cc' && t.method === 'already-on'));
});

test('一直等不到时按截止时间返回，带上尝试记录，CC 已恢复', async () => {
  const h = harness();
  h.fetch = async () => reply('');
  const result = await h.request({ ...want, baseUrl });
  assert.match(result.error, /EMPTY/);
  assert.match(result.error, /已尝试 baseUrl/);
  assert.ok(h.waits >= 55 && h.waits <= 65, String(h.waits));
  assert.equal(h.toggles, 2);
  assert.equal(h.cc, false);
  assert.ok(result.tried.some(t => t.source === 'trigger-setoption'));
  assert.ok(result.tried.some(t => t.source === 'trigger-wait' && t.timedOut));
  assert.ok(result.tried.some(t => t.source === 'baseUrl' && t.error === 'EMPTY'));
});

test('同一个候选 URL 只请求一次，状态变化才重跑候选', async () => {
  const h = harness();
  h.fetch = async () => reply('');
  h.audioTracks = [{ url: potUrl('ja', 'asr'), vssId: 'a.ja', kind: 'asr' }];
  h.onWait = () => {
    if (h.waits === 2) h.window.fetch('https://www.youtube.com/api/timedtext?v=vid-A&lang=en&fmt=srv3&pot=POT2');
  };
  const result = await h.request();
  assert.ok(result.error);
  assert.equal(h.fetched.filter(u => u.includes('potc=1')).length, 1);
  assert.equal(h.fetched.filter(u => u.includes('pot=POT2') && u.includes('lang=ja')).length, 1);
});

test('取消后立刻停止等待并恢复 CC', async () => {
  const h = harness();
  h.onWait = () => { if (h.waits === 3) h.cancel(); };
  const result = await h.request();
  assert.match(result.error, /已取消/);
  assert.ok(h.waits <= 4);
  assert.equal(h.toggles, 2);
  assert.equal(h.cc, false);
});

test('等待字幕期间换视频，不关闭新视频的 CC，也不继续等待旧请求', async () => {
  const h = harness();
  h.onWait = () => { h.location.href = 'https://www.youtube.com/watch?v=vid-B'; };
  const result = await h.request();
  assert.match(result.error, /视频已切换/);
  assert.equal(h.unloads, 0);
  assert.equal(h.toggles, 1);
  assert.equal(h.cc, true);
  assert.ok(h.waits <= 1);
});

test('tracks 带上播放器选中轨、pot 状态和绝对 baseUrl', async () => {
  const h = harness();
  h.player.getPlayerResponse = () => ({
    videoDetails: { videoId: 'vid-A' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', baseUrl: '/api/timedtext?v=vid-A&lang=ja&kind=asr', name: { simpleText: '日本語（自動生成）' } },
    ] } },
  });
  h.player.getOption = (_m, key) => (key === 'track' ? { languageCode: 'ja', kind: 'asr', vssId: 'a.ja' } : []);
  h.audioTracks = [{ url: potUrl('ja', 'asr'), vssId: 'a.ja', kind: 'asr' }];
  const info = await h.tracks();
  assert.equal(info.hasPot, true);
  // 沙箱里的对象原型不同，比较前先转成普通 JSON
  assert.deepEqual(JSON.parse(JSON.stringify(info.selected)), { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', translated: false });
  assert.equal(info.tracks[0].baseUrl, 'https://www.youtube.com/api/timedtext?v=vid-A&lang=ja&kind=asr');
  assert.equal(info.tracks[0].name, '日本語（自動生成）');
});
