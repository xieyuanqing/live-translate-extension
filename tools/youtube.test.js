/** 内容脚本侧的 YouTube 适配回归：轨道选择与页面桥协议，不访问浏览器。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

function harness() {
  const posted = [];
  const ctx = vm.createContext({
    window: { addEventListener() {}, postMessage: msg => posted.push(msg) },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    location: { href: 'https://www.youtube.com/watch?v=vid-A', pathname: '/watch' },
    URL, setTimeout, clearTimeout, setInterval() {},
  });
  for (const f of ['src/common/constants.js', 'src/content/youtube.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  }
  return { yt: ctx.LT.YouTube, posted };
}

const tracks = [
  { languageCode: 'en', kind: '', vssId: '.en', name: 'English' },
  { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', name: '日本語（自動生成）' },
  { languageCode: 'ja', kind: '', vssId: '.ja', name: '日本語' },
];

test('指定源语言：先人工轨再自动轨', () => {
  const { yt } = harness();
  assert.equal(yt.chooseTrack(tracks, 'ja', 0).vssId, '.ja');
  assert.equal(yt.chooseTrack(tracks.slice(0, 2), 'ja', 0).vssId, 'a.ja');
  assert.equal(yt.chooseTrack(tracks, 'ko', 0), null);
});

test('指定源语言：播放器里选中的同语言轨优先，别的语言不算', () => {
  const { yt } = harness();
  const selected = { languageCode: 'ja', kind: 'asr', vssId: 'a.ja', translated: false };
  assert.equal(yt.chooseTrack(tracks, 'ja', 0, selected).vssId, 'a.ja');
  const other = { languageCode: 'en', kind: '', vssId: '.en', translated: false };
  assert.equal(yt.chooseTrack(tracks, 'ja', 0, other).vssId, '.ja');
});

test('自动检测：选中轨 > 默认轨 > 人工轨 > 自动轨', () => {
  const { yt } = harness();
  assert.equal(yt.chooseTrack(tracks, 'auto', 1, { languageCode: 'ja', kind: '', vssId: '.ja' }).vssId, '.ja');
  assert.equal(yt.chooseTrack(tracks, 'auto', 1).vssId, 'a.ja');
  assert.equal(yt.chooseTrack(tracks, 'auto', -1).vssId, '.en');
  assert.equal(yt.chooseTrack([tracks[1]], 'auto', -1).vssId, 'a.ja');
});

test('自动翻译轨按原语言匹配；vssId 对不上时退到语言加类型', () => {
  const { yt } = harness();
  const translated = { languageCode: 'ja', kind: 'asr', vssId: '', translated: true };
  assert.equal(yt.chooseTrack(tracks, 'auto', -1, translated).vssId, 'a.ja');
  const stale = { languageCode: 'ja', kind: '', vssId: 'old', translated: false };
  assert.equal(yt.chooseTrack(tracks, 'auto', -1, stale).vssId, '.ja');
});

test('取消读取只发一条不等回复的消息', () => {
  const { yt, posted } = harness();
  yt.cancelCaptions();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'cancel');
  assert.notEqual(posted[0].id, 0);
});
