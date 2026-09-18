/** 页面桥回归：模拟播放器与 timedtext 响应，不连接 YouTube。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const captions = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '测试字幕' }] }] });
const reply = text => ({ ok: true, status: 200, text: async () => text, clone() { return this; } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const want = { videoId: 'vid-A', languageCode: 'ja', kind: 'asr' };
const url = 'https://www.youtube.com/api/timedtext?v=vid-A&lang=ja&kind=asr&fmt=json3';

function harness() {
  let handler;
  let resolve;
  const h = { fetch: async () => reply(captions), waits: 0, unloads: 0 };
  const location = { href: 'https://www.youtube.com/watch?v=vid-A' };
  const player = {
    getPlayerResponse: () => ({ videoDetails: { videoId: new URL(location.href).searchParams.get('v') } }),
    getOption: (_module, key) => key === 'tracklist' ? [] : null,
    isSubtitlesOn: () => false, loadModule() {}, setOption() {},
    unloadModule() { h.unloads++; },
  };
  const window = {
    fetch: (...args) => h.fetch(...args),
    addEventListener(_type, fn) { handler = fn; },
    postMessage(msg) { resolve(msg.payload); },
  };
  const ctx = vm.createContext({ window, location, URL, AbortController,
    document: { getElementById: () => player, addEventListener() {} },
    setTimeout(fn, ms) {
      if (ms === 200) { h.waits++; h.onWait?.(); return setTimeout(fn, 0); }
      const timer = setTimeout(fn, ms); timer.unref(); return timer;
    }, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main-world/page-bridge.js'), 'utf8'), ctx);
  return Object.assign(h, { location, window,
    request: () => new Promise(r => {
      resolve = r;
      handler({ source: window, data: { __lt: 'lt-bridge', dir: 'req', kind: 'captions', id: 1, args: want } });
    }),
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

test('等待字幕期间换视频，不关闭新视频的 CC，也不继续等待旧请求', async () => {
  const h = harness();
  h.onWait = () => { h.location.href = 'https://www.youtube.com/watch?v=vid-B'; };
  const result = await h.request();
  assert.match(result.error, /视频已切换/);
  assert.equal(h.unloads, 0);
  assert.ok(h.waits <= 1);
});
