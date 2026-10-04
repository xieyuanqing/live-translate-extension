/** 开播整理与千问字幕：使用模拟文字模型和时间，不连接真实 API。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const ctx = vm.createContext({ setTimeout: () => 1, clearTimeout() {}, AbortController });
  for (const file of ['src/common/constants.js', 'src/common/live-context.js', 'src/content/stabilizer.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  }
  return ctx.LT;
}

test('主播名即使被模型遗漏也保留，术语总数不超过 12，不猜错误别名', () => {
  const LT = harness();
  const phrases = Object.fromEntries(Array.from({ length: 12 }, (_,i) => [`通用词${i}`, `译法${i}`]));
  const result = LT.LiveContext.preserveIdentity({ background: '生日直播', phrases }, { author: 'YuNi - official channel -' });
  assert.equal(result.phrases.YuNi, 'YuNi');
  assert.equal(Object.keys(result.phrases).length, 12);
  assert.equal(result.phrases.ゆり, undefined);
  assert.equal(result.phrases.ゆりら, undefined);
});

test('公开预览的整理输入与文字模型实际收到的 system/user 相同', async () => {
  const LT = harness(); let received;
  LT.Net = {};
  LT.TextModel = { hasCredentials: config => !!config.key, resolve: () => ({ key: 'placeholder', model: 'test' }),
    translate: async value => { received = value; return { text: '{"background":"生日直播","terms":[{"source":"ゆに","target":"YuNi"}]}' }; } };
  const settings = { generateLiveContext: true, sourceLang: 'ja', targetLang: 'zh' };
  const expected = LT.LiveContext.buildRequest(settings, '频道：YuNi', '保留主播名');
  const result = await LT.LiveContext.generate(settings, '频道：YuNi', '保留主播名');
  assert.equal(received.system, expected.system);
  assert.equal(received.user, expected.user);
  assert.equal(result.phrases.ゆに, 'YuNi');
});

test('千问增量字幕保留重复歌词和重复词，Gemini 保持原有去重行为', () => {
  const LT = harness();
  for (const qwen of [true, false]) {
    const committed = [];
    const s = new LT.SubtitleStabilizer({ idleCommitMs: 2500, maxCurrentChars: 42,
      detectOverlap: !qwen, suppressRepeats: !qwen, onRender: (_,lines) => committed.push(...lines) });
    s.onFragment('祝我生日快乐。'); s.onFragment('祝我生日快乐。');
    s.onFragment('很久'); s.onFragment('很久以前。');
    assert.deepEqual(committed, qwen ? ['祝我生日快乐。', '祝我生日快乐。', '很久很久以前。'] : ['祝我生日快乐。', '很久以前。']);
  }
});
