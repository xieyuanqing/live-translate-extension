/** 直播日志：本地保存、脱敏、限量与档位回归，不接触真实直播数据。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const data = new Map();
  const ctx = vm.createContext({ console, Date, Math, JSON, setTimeout, clearTimeout,
    chrome: { storage: { local: {
      async get(key) {
        if (key === null) return Object.fromEntries(data);
        return { [key]: data.get(key) };
      },
      async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, value); },
      async remove(keys) { for (const key of [].concat(keys)) data.delete(key); },
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/common/live-log.js'), 'utf8'), ctx);
  return { api: ctx.LT.LiveLog, data };
}

const opts = { provider: 'qwen', model: 'qwen-test', videoId: 'video-1', sourceLang: 'ja', targetLang: 'zh', reason: 'test' };

test('关闭时不保存；基础日志不包含文字，状态里的凭据被去除', async () => {
  const h = harness();
  assert.equal(h.api.open({ ...opts, level: 'off' }, {}), null);
  const recorder = h.api.open({ ...opts, level: 'basic' }, { qwenApiKey: 'sk-dummy-secret-value' });
  recorder.details({ prompt: '私人提示词' });
  recorder.event('source_text', { text: 'こんにちは' }, true);
  recorder.event('connection', { state: 'error: Bearer sk-dummy-secret-value' });
  await recorder.finish('user');
  const [log] = await h.api.list();
  assert.equal(log.level, 'basic');
  assert.equal(log.details, undefined);
  assert.ok(!log.events.some((e) => e.type === 'source_text'));
  assert.ok(!JSON.stringify(log).includes('sk-dummy-secret-value'));
  assert.ok(JSON.stringify(log).includes('[API_KEY]'));
});

test('详细模式保存文本与提示词，事件超限后记录丢弃数量', async () => {
  const h = harness();
  const recorder = h.api.open({ ...opts, level: 'detailed' }, { apiKeys: 'AIzaDummySecretValue123456789012345' });
  recorder.details({ prompt: '术语：APEX；Key=AIzaDummySecretValue123456789012345', metadata: { title: '排位直播' } });
  recorder.event('source_text', { text: 'アーマー' }, true);
  recorder.event('translation_fragment', { text: '护甲' }, true);
  recorder.audioChunk(3200);
  for (let i = 0; i < 3005; i++) recorder.event('connection', { n: i });
  await recorder.finish('navigation');
  const [log] = await h.api.list();
  assert.equal(log.details.metadata.title, '排位直播');
  assert.ok(!JSON.stringify(log).includes('AIzaDummySecretValue123456789012345'));
  assert.equal(log.events.length, 3000);
  assert.ok(log.droppedEvents > 0);
  assert.equal(log.audioChunks, 1);
  assert.equal(log.audioBytes, 3200);
  assert.equal(log.reason, 'navigation');
  await h.api.remove(log.key);
  assert.equal((await h.api.list()).length, 0);
});

test('完成的日志超过 20 场后只保留最近 20 场', async () => {
  const h = harness();
  for (let i = 0; i < 21; i++) {
    const recorder = h.api.open({ ...opts, level: 'basic', videoId: `video-${i}` }, {});
    await recorder.finish('user');
  }
  let logs;
  for (let i = 0; i < 30; i++) {
    logs = await h.api.list();
    if (logs.length === 20) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(logs.length, 20);
  assert.ok(logs.every((log) => log.endedAt));
});
