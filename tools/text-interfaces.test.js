/** 文字接口鉴权回归：实际请求构建配合网络替身，不连接外部服务。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(apiType = 'openai') {
  const ctx = vm.createContext({ URL, Date, Math, JSON });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/live-log.js',
    'src/ui/options-data.js', 'src/subs/text-model.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  }
  const LT = ctx.LT, requests = [];
  LT.Net = {
    async request(req) {
      requests.push(req);
      return { ok: true, status: 200, text: JSON.stringify(apiType === 'openai'
        ? { data: [{ id: 'm-a' }] } : { models: [{ name: 'models/m-a' }], displayName: 'm-a' }) };
    },
    async post(req) {
      requests.push(req);
      return { ok: true, status: 200, text: JSON.stringify(apiType === 'openai'
        ? { choices: [{ message: { content: '1\t你好' }, finish_reason: 'stop' }] }
        : { candidates: [{ content: { parts: [{ text: '1\t你好' }] }, finishReason: 'STOP' }] }) };
    },
    parseSse: text => [JSON.parse(text)],
  };
  const settings = LT.Settings.normalize({ apiKeys: '', providers: [{ id: 'p', apiType, model: 'm-a',
    headers: { 'X-Api-Key': 'private-header-token', 'X-Tenant': 'team-a' } }] });
  return { LT, requests, settings, config: () => LT.TextModel.resolve(settings, 'p', settings.subsModel) };
}

for (const apiType of ['openai', 'gemini']) test(`${apiType} 只用自定义头鉴权，列表、查询和生成均携带同一份请求头`, async () => {
  const h = harness(apiType), config = h.config();
  assert.equal(config.key, '');
  assert.equal(h.LT.TextModel.hasCredentials(config), true);
  assert.deepEqual(Array.from(await h.LT.TextModel.listModels(config)), ['m-a']);
  await h.LT.TextModel.probe(config);
  await h.LT.TextModel.generateTest(config);
  assert.equal(h.requests.length, 3);
  for (const req of h.requests) {
    assert.equal(req.headers['x-api-key'], 'private-header-token');
    assert.equal(req.headers['x-tenant'], 'team-a');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-goog-api-key'], undefined);
  }
});

test('请求头大小写归一化后覆盖默认鉴权，运行快照不随设置修改', () => {
  const h = harness();
  h.settings.providers[0].apiKey = 'original';
  h.settings.providers[0].headers = { Authorization: 'Bearer custom', 'Content-Type': 'application/custom' };
  const config = h.config();
  h.settings.providers[0].headers.Authorization = 'Bearer later';
  const request = h.LT.TextModel.buildRequest(config, 'system', 'user');
  assert.equal(request.headers.authorization, 'Bearer custom');
  assert.equal(request.headers['content-type'], 'application/custom');
  assert.equal(Object.keys(request.headers).filter(name => name.toLowerCase() === 'authorization').length, 1);
});

test('外部导入的非法请求头在发送前报告，不把值写进错误', async () => {
  const h = harness();
  h.settings.providers[0].headers = { 'Bad Header': 'secret-invalid-header' };
  await assert.rejects(h.LT.TextModel.listModels(h.config()), error => /请求头名称/.test(error.message) && !error.message.includes('secret'));
  h.settings.providers[0].headers = { 'x-api-key': 'secret\nvalue' };
  await assert.rejects(h.LT.TextModel.generateTest(h.config()), /请求头值/);
  assert.equal(h.requests.length, 0);
});

test('默认备份剔除请求头，完整备份保留；无凭据导入保留同 id 的本机请求头', () => {
  const h = harness();
  const plain = h.LT.OptionsUI.exportObject(h.settings, false, 'test');
  assert.equal(JSON.stringify(plain).includes('private-header-token'), false);
  const full = h.LT.OptionsUI.exportObject(h.settings, true, 'test');
  assert.equal(full.settings.providers[0].headers['x-api-key'], 'private-header-token');
  assert.equal(h.LT.OptionsUI.importObject(plain, h.settings).providers[0].headers['x-api-key'], 'private-header-token');
  assert.equal(h.LT.OptionsUI.importObject(full, h.settings).providers[0].headers['x-tenant'], 'team-a');
});

test('日志删除完整请求头字段，并在其他文本中遮住请求头凭据', () => {
  const h = harness();
  const value = h.LT.LiveLog.safe({ headers: h.settings.providers[0].headers, detail: 'server echoed private-header-token' },
    h.LT.LiveLog.secretsFrom(h.settings));
  assert.equal(value.headers, undefined);
  assert.equal(value.detail.includes('private-header-token'), false);
});

test('旧接口按实际协议地址保留身份、凭据和用途，自定义配置保持独立', () => {
  const h = harness();
  const settings = h.LT.Settings.normalize({ providers: [
    { id: 'deep', name: '我的翻译', apiType: 'openai', baseUrl: 'https://api.deepseek.com/', apiKey: 'local-key', model: 'my-model' },
    { id: 'proxy', apiType: 'gemini', baseUrl: 'https://proxy.example', enabled: false },
  ], subsProviderId: 'deep', selectionProviderId: 'proxy' });
  assert.equal(settings.providers[0].preset, 'deepseek');
  assert.equal(settings.providers[0].apiKey, 'local-key');
  assert.deepEqual(Array.from(settings.providers[0].models), ['my-model']);
  assert.equal(settings.providers[0].enabled, true);
  assert.equal(settings.providers[1].preset, 'custom');
  assert.equal(settings.providers[1].enabled, false);
  assert.equal(settings.selectionProviderId, 'proxy');
});

test('提供商协议由类型决定，待接入项不能新增，停用配置不能发起任务', () => {
  const h = harness();
  const provider = h.LT.Settings.newProvider({ preset: 'deepseek', apiType: 'gemini', description: '字幕专用' });
  assert.equal(provider.apiType, 'openai');
  assert.equal(provider.preset, 'deepseek');
  assert.equal(provider.description, '字幕专用');
  for (const preset of ['deepl', 'deeplx']) assert.throws(() => h.LT.Settings.newProvider({ preset }), /尚未接入/);
  h.settings.providers[0].enabled = false;
  assert.throws(() => h.config(), /已停用/);
  assert.equal(h.requests.length, 0);
});

test('兼容列表只保留一个自定义入口，旧第三方配置转自定义而不丢字段', () => {
  const h = harness();
  assert.deepEqual(Array.from(h.LT.PROVIDER_PRESETS.filter(p => p.group === 'compatible'), p => p.code), ['custom']);
  for (const preset of ['ark', 'openrouter', 'siliconflow', 'custom-openai', 'custom-gemini']) {
    const p = h.LT.Settings.normalizeProvider({ preset, apiType: 'openai', name: '个人接口', baseUrl: 'https://own.example/v1',
      apiKey: 'saved-key', model: 'my-model', headers: { 'X-Api-Key': 'saved-header' } });
    assert.equal(p.preset, 'custom');
    assert.equal(p.kind, 'text');
    assert.equal(p.baseUrl, 'https://own.example/v1');
    assert.equal(p.apiKey, 'saved-key');
    assert.deepEqual(Array.from(p.models), ['my-model']);
    assert.equal(p.headers['x-api-key'], 'saved-header');
  }
});

test('旧直播与朗读连接一次迁入统一列表，保留类型、凭据、音色和选用', () => {
  const h = harness();
  const migrated = h.LT.Settings.normalize({ providers: [{ id: 'text', apiType: 'gemini', model: 'text-model' }],
    subsProviderId: 'text', apiKeys: 'live-a,live-b', baseUrl: 'wss://live.example', liveProvider: 'qwen',
    qwenApiKey: 'qwen-saved', qwenWorkspaceHost: 'ws-one.cn-beijing.maas.aliyuncs.com',
    ttsProvider: 'gemini', ttsGeminiApiKey: 'speech-saved', ttsGeminiReuseKey: false,
    ttsGeminiBaseUrl: 'https://speech.example', ttsGeminiModel: 'my-tts', ttsGeminiVoice: 'Puck',
    ttsMicrosoftJaVoice: 'ja-JP-KeitaNeural' });
  assert.equal(migrated.providerSchema, 3);
  assert.equal(migrated.providers.length, 5);
  assert.equal(h.LT.Settings.serviceProvider(migrated, 'live').preset, 'qwen-live');
  assert.equal(h.LT.Settings.serviceProvider(migrated, 'live').apiKey, 'qwen-saved');
  assert.equal(h.LT.Settings.serviceProvider(migrated, 'speech').apiKey, 'speech-saved');
  assert.equal(h.LT.Settings.serviceProvider(migrated, 'speech').voice, 'Puck');
  assert.equal(migrated.providers.find(p => p.preset === 'gemini-live').apiKey, 'live-a,live-b');
  assert.equal(migrated.providers.find(p => p.preset === 'microsoft-tts').jaVoice, 'ja-JP-KeitaNeural');
  const stored = h.LT.Settings.persistable(migrated);
  assert.equal('apiKeys' in stored, false);
  assert.equal('ttsGeminiApiKey' in stored, false);
  assert.equal('liveProvider' in stored, false);
  assert.equal('model' in stored.providers[0], false);
  assert.equal(stored.subsModel, 'text-model');
  const again = h.LT.Settings.normalize(stored);
  assert.deepEqual(JSON.parse(JSON.stringify(h.LT.Settings.persistable(again).providers)), JSON.parse(JSON.stringify(stored.providers)));
  assert.equal(again.subsModel, 'text-model');
  assert.equal(again.liveProviderId, migrated.liveProviderId);
  assert.equal(again.ttsProviderId, migrated.ttsProviderId);
  assert.equal(again.apiKeys, 'live-a,live-b');
  assert.equal(again.qwenApiKey, 'qwen-saved');
  assert.equal(again.ttsGeminiApiKey, 'speech-saved');
});

test('同一文字接口为聊天与评论选 Flash、字幕选 Pro，保存后互不覆盖', () => {
  const h = harness();
  const raw = { providerSchema: 3, providers: [{ id: 'deepseek', preset: 'custom', apiType: 'openai',
    baseUrl: 'https://api.deepseek.example/v1', apiKey: 'test-key', models: ['Flash', 'Pro'] }],
    chatProviderId: 'deepseek', chatModel: 'Flash', commentProviderId: 'deepseek', commentModel: 'Flash',
    subsProviderId: 'deepseek', subsModel: 'Pro', selectionProviderId: 'deepseek', selectionModel: 'Flash' };
  const settings = h.LT.Settings.normalize(raw);
  assert.equal(h.LT.TextModel.resolve(settings, settings.chatProviderId, settings.chatModel).model, 'Flash');
  assert.equal(h.LT.TextModel.resolve(settings, settings.subsProviderId, settings.subsModel).model, 'Pro');
  const saved = h.LT.Settings.persistable(settings);
  assert.deepEqual(Array.from(saved.providers[0].models), ['Flash', 'Pro']);
  assert.equal('model' in saved.providers[0], false);
  const restored = h.LT.Settings.normalize(saved);
  assert.equal(restored.chatModel, 'Flash');
  assert.equal(restored.commentModel, 'Flash');
  assert.equal(restored.subsModel, 'Pro');
  assert.equal(restored.selectionModel, 'Flash');
});

test('同类型多套连接独立保存，选用投影不取排序第一条，也不改变冻结快照', () => {
  const h = harness();
  const raw = { providerSchema: 2, providers: [
    { id: 'text', preset: 'custom', apiType: 'openai' },
    { id: 'live-a', preset: 'gemini-live', apiKey: 'key-a', baseUrl: 'wss://a.example' },
    { id: 'live-b', preset: 'gemini-live', apiKey: 'key-b', baseUrl: 'wss://b.example' },
    { id: 'speech-a', preset: 'gemini-tts', apiKey: 'tts-a', reuseKey: false, model: 'a-model', voice: 'Kore' },
    { id: 'speech-b', preset: 'gemini-tts', apiKey: 'tts-b', reuseKey: false, model: 'b-model', voice: 'Puck' },
  ], liveProviderId: 'live-b', ttsProviderId: 'speech-b' };
  const frozen = h.LT.Settings.normalize(raw);
  assert.equal(frozen.apiKeys, 'key-b');
  assert.equal(frozen.baseUrl, 'wss://b.example');
  assert.equal(frozen.ttsGeminiApiKey, 'tts-b');
  assert.equal(frozen.ttsGeminiModel, 'b-model');
  raw.providers[2].apiKey = 'later-key';
  assert.equal(frozen.apiKeys, 'key-b');
  const switched = h.LT.Settings.normalize({ ...frozen, liveProviderId: 'live-a', ttsProviderId: 'speech-a' });
  assert.equal(switched.apiKeys, 'key-a');
  assert.equal(switched.ttsGeminiApiKey, 'tts-a');
  assert.equal(frozen.ttsGeminiApiKey, 'tts-b');
  assert.throws(() => h.LT.Settings.provider(frozen, 'live-a'), /类型不匹配/);
  assert.throws(() => h.LT.Settings.serviceProvider(frozen, 'speech', 'live-a'), /类型不匹配/);
});

test('统一配置的无凭据备份移除每类全部Key，导入按id保留本机凭据', () => {
  const h = harness();
  const settings = h.LT.Settings.normalize({ apiKeys: 'first-live-key,second-live-key', qwenApiKey: 'qwen-key',
    ttsGeminiApiKey: 'tts-key', ttsGeminiReuseKey: false,
    providers: [{ id: 'text', preset: 'custom', apiType: 'openai', apiKey: 'text-key', headers: { 'X-Key': 'header-key' } }] });
  const backup = h.LT.OptionsUI.exportObject(settings, false, 'test');
  const body = JSON.stringify(backup);
  for (const key of ['first-live-key', 'second-live-key', 'qwen-key', 'tts-key', 'text-key', 'header-key']) assert.equal(body.includes(key), false);
  const restored = h.LT.OptionsUI.importObject(backup, settings);
  for (const profile of settings.providers) {
    const own = restored.providers.find(p => p.id === profile.id);
    assert.equal(own.apiKey, profile.apiKey);
    if (profile.kind === 'text') assert.deepEqual(JSON.parse(JSON.stringify(own.headers)), JSON.parse(JSON.stringify(profile.headers)));
  }
  assert.equal(restored.liveProviderId, settings.liveProviderId);
  assert.equal(restored.ttsProviderId, settings.ttsProviderId);
  const full = h.LT.OptionsUI.exportObject(settings, true, 'test');
  assert.equal(full.settings.providers.find(p => p.preset === 'gemini-live').apiKey, 'first-live-key,second-live-key');
  assert.equal('apiKeys' in full.settings, false);
});
