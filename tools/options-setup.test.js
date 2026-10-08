/** 配置引导判定回归：检查实际有效配置与签名，不请求权限或真实接口。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const ctx = vm.createContext({ URL, Date, Math, JSON });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/selection.js', 'src/ui/options-setup.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  }
  const LT = ctx.LT;
  return { LT, normalize: LT.Settings.normalize, state: LT.OptionsUI.connectionState, signature: LT.OptionsUI.providerSignature };
}

test('文字 Gemini 接口使用有效的复用直播 Key，已有独立 Key 时不依赖直播 Key', () => {
  const h = harness();
  const reused = h.normalize({ apiKeys: ' , test-live-a, test-live-b , ',
    providers: [{ id: 'g', apiType: 'gemini', apiKey: '', model: 'gemini-test' }] });
  assert.equal(h.state(reused, 'text', 'g', reused.subsModel).complete, true);
  assert.deepEqual(Array.from(h.state(reused, 'text', 'g', reused.subsModel).origins), ['https://generativelanguage.googleapis.com/*']);
  const absent = h.normalize({ ...reused, providers: reused.providers.map(p => p.kind === 'live' ? { ...p, apiKey: '' } : p) });
  assert.equal(h.state(absent, 'text', 'g', absent.subsModel).complete, false);
  assert.ok(h.state(absent, 'text', 'g', absent.subsModel).missing.includes('Key'));
  const independent = h.normalize({ ...absent, providers: [{ id: 'g', apiType: 'gemini', apiKey: 'test-own-key', model: 'gemini-test' }] });
  assert.equal(h.state(independent, 'text', 'g', independent.subsModel).complete, true);
});

test('统一列表按指定配置校验类型，未选中的直播和朗读不借用当前接口凭据', () => {
  const h = harness();
  const settings = h.normalize({ providers: [
    { id: 'text', kind: 'text', preset: 'openai', apiKey: 'text-key', model: 'text-model' },
    { id: 'live-good', kind: 'live', preset: 'gemini-live', apiKey: 'live-key' },
    { id: 'live-empty', kind: 'live', preset: 'qwen-live', apiKey: '', workspaceHost: '' },
    { id: 'speech-good', kind: 'speech', preset: 'microsoft-tts' },
    { id: 'speech-empty', kind: 'speech', preset: 'gemini-tts', reuseKey: false, apiKey: '' },
  ], liveProviderId: 'live-good', ttsProviderId: 'speech-good' });
  assert.equal(h.state(settings, 'live', 'live-good').complete, true);
  assert.equal(h.state(settings, 'speech', 'speech-good').complete, true);
  assert.ok(h.state(settings, 'live', 'live-empty').missing.includes('Key'));
  assert.ok(h.state(settings, 'speech', 'speech-empty').missing.includes('Key'));
  assert.equal(h.state(settings, 'text', 'speech-good').complete, false);
  assert.equal(h.state(settings, 'speech', 'live-good').complete, false);
  settings.providers.find(p => p.id === 'speech-good').enabled = false;
  assert.ok(h.state(settings, 'speech', 'speech-good').missing.includes('启用提供商'));
});

test('微软朗读无需 Key，但不会把缺 Key 的文字接口算成配置完成', () => {
  const h = harness();
  const settings = h.normalize({ ttsProvider: 'microsoft', apiKeys: '',
    providers: [{ id: 'o', apiType: 'openai', apiKey: '', model: 'model-test' }] });
  assert.equal(h.state(settings, 'speech').complete, true);
  assert.deepEqual(Array.from(h.state(settings, 'speech').origins), []);
  assert.equal(h.state(settings, 'text', 'o', settings.subsModel).complete, false);
  assert.deepEqual(Array.from(h.state(settings, 'text', 'o', settings.subsModel).missing), ['Key']);
});

test('文字配置区分缺模型和无效地址，空地址回落官方且端口不进入域名权限', () => {
  const h = harness();
  const settings = h.normalize({ providers: [{ id: 'o', apiType: 'openai', apiKey: 'test-key', model: '', baseUrl: 'ftp://bad.example' }] });
  const incomplete = h.state(settings, 'text', 'o', settings.subsModel);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(Array.from(incomplete.missing), ['模型', '接口地址']);
  assert.deepEqual(Array.from(incomplete.origins), []);
  const valid = h.normalize({ ...settings, providers: [{ ...settings.providers[0], baseUrl: '' }], subsModel: 'model-test' });
  assert.equal(h.state(valid, 'text', 'o', valid.subsModel).complete, true);
  assert.deepEqual(Array.from(h.state(valid, 'text', 'o', valid.subsModel).origins), ['https://api.openai.com/*']);
  valid.providers[0].baseUrl = 'http://127.0.0.1:23000/v1';
  assert.deepEqual(Array.from(h.state(valid, 'text', 'o', valid.subsModel).origins), ['http://127.0.0.1/*']);
  const geminiWithoutModel = h.normalize({ providers: [{ id: 'g', apiType: 'gemini', apiKey: 'test-key', model: 'models/' }] });
  assert.equal(h.state(geminiWithoutModel, 'text', 'g', geminiWithoutModel.subsModel).complete, false);
  assert.ok(h.state(geminiWithoutModel, 'text', 'g', geminiWithoutModel.subsModel).missing.includes('模型'));
});

test('直播引导校验千问业务空间域名和 Key，授权范围始终是所有网站', () => {
  const h = harness();
  for (const qwenWorkspaceHost of ['workspace.cn-beijing.maas.aliyuncs.com', 'workspace-123.ap-southeast-1.maas.aliyuncs.com']) {
    const settings = h.normalize({ liveProvider: 'qwen', qwenApiKey: 'test-qwen-key', qwenWorkspaceHost });
    const state = h.state(settings, 'live');
    assert.equal(state.complete, true);
    assert.deepEqual(Array.from(state.origins), ['<all_urls>']);
  }
  for (const qwenWorkspaceHost of ['', 'api.example.com', 'workspace.cn-beijing.maas.aliyuncs.com.evil.example']) {
    const settings = h.normalize({ liveProvider: 'qwen', qwenApiKey: '', qwenWorkspaceHost });
    const state = h.state(settings, 'live');
    assert.equal(state.complete, false);
    assert.ok(state.missing.includes('Key'));
    assert.ok(state.missing.includes('业务空间域名'));
    assert.deepEqual(Array.from(state.origins), ['<all_urls>']);
  }
});

test('多 Key 复用签名重复读取稳定，改变 Key 列表或模型会使旧测试失效', () => {
  const h = harness();
  const settings = h.normalize({ apiKeys: 'test-live-a, test-live-b',
    providers: [{ id: 'g', apiType: 'gemini', apiKey: '', model: 'gemini-test' }] });
  const signature = h.signature(settings, 'g');
  assert.equal(h.signature(h.normalize(JSON.parse(JSON.stringify(settings))), 'g'), signature);
  assert.equal(h.signature({ ...settings, apiKeys: ' test-live-a , test-live-b ' }, 'g'), signature);
  assert.notEqual(h.signature({ ...settings, apiKeys: 'test-live-a, test-live-c' }, 'g'), signature);
  const changed = h.normalize({ ...settings, providers: [{ ...settings.providers[0], model: 'gemini-other' }] });
  assert.notEqual(h.signature(changed, 'g'), signature);
  const independent = h.normalize({ ...settings, providers: [{ ...settings.providers[0], apiKey: 'test-own-key' }] });
  assert.equal(h.signature({ ...independent, apiKeys: 'other-live-key' }, 'g'), h.signature(independent, 'g'));
});
