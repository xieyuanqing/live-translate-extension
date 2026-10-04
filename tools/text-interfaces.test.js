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
  return { LT, requests, settings, config: () => LT.TextModel.resolve(settings, 'p') };
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
