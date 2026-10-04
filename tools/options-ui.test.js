/** 设置页接口编辑和授权回归：用极简的假 DOM，不开浏览器、不发网络请求。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.textContent = ''; this.disabled = false; this.placeholder = ''; this.style = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; cs.forEach(c => this.appendChild(c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 100, bottom: 140 }; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...extra }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byText(text) { return this.all(n => n.textContent === text)[0]; }
  byClass(cls) { return this.all(n => n.className.split(' ').includes(cls)); }
}

function harness({ probe, generateTest, listModels, contains, request } = {}) {
  const ctx = vm.createContext({
    console, URL, Date, Math, JSON, AbortController, setTimeout, clearTimeout, confirm: () => true,
    document: { createElement: tag => new FakeNode(tag) },
    window: { innerHeight: 1000 },
    chrome: { permissions: { contains: contains || (async () => false), request: request || (async () => true) } },
  });
  for (const f of ['src/common/constants.js', 'src/common/settings.js', 'src/common/selection.js', 'src/subs/text-model.js',
    'src/ui/options-setup.js', 'src/ui/options-access.js', 'src/ui/options-providers.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  }
  const LT = ctx.LT;
  const probes = [];
  LT.TextModel.probe = async cfg => { probes.push(cfg); return probe ? probe(cfg) : { ok: true, ms: 12, message: '连接及模型查询通过' }; };
  LT.TextModel.generateTest = async cfg => (generateTest ? generateTest(cfg) : { ok: true, ms: 30, via: 'direct', sample: '1\t你好' });
  LT.TextModel.listModels = async cfg => (listModels ? listModels(cfg) : ['m-a', 'm-b']);
  const settings = LT.Settings.normalize({
    apiKeys: 'live-key',
    providers: [
      { id: 'g', name: '', apiType: 'gemini', model: 'gem' },
      { id: 'o', name: '本地网关', apiType: 'openai', baseUrl: 'http://127.0.0.1:23000/v1', apiKey: 'sk', model: 'local' },
    ],
    subsProviderId: 'g',
  });
  const box = new FakeNode('div');
  const list = new FakeNode('div');
  const picker = new FakeNode('select');
  let saves = 0;
  const selected = [];
  const testResults = [];
  const ui = LT.OptionsUI.mountProviders({
    box,
    list,
    picker,
    settings: () => settings,
    save: () => { saves++; },
    select: id => { selected.push(id); settings.subsProviderId = id; },
    onTest: result => testResults.push(result),
  });
  ui.render();
  return { LT, settings, box, list, picker, ui, probes, testResults, saves: () => saves, selected, cards: () => box.children,
    edit: id => list.children.find(item => item.attrs['data-provider-id'] === id).fire('click') };
}

test('配置列表只展开正在编辑的一套，保留用途标记；只剩一套时不能删', () => {
  const h = harness();
  assert.equal(h.cards().length, 1);
  assert.equal(h.list.children.length, 2);
  assert.equal(h.cards()[0].className, 'provider');
  assert.ok(h.list.children[0].all(node => node.textContent.includes('字幕') && node.textContent.includes('划词')).length);
  assert.equal(h.cards()[0].byText('删除').disabled, false);
  h.settings.providers.pop();
  h.ui.render();
  assert.equal(h.cards()[0].byText('删除').disabled, true);
});

test('编辑模型原位保存；切换编辑的接口不会改变各功能选用', () => {
  const h = harness();
  h.edit('o');
  const model = h.cards()[0].all(n => n.tag === 'input' && n.attrs['aria-controls'] === 'models-o')[0];
  model.value = 'local-2';
  model.fire('input');
  assert.equal(h.settings.providers[1].model, 'local-2');
  assert.equal(h.saves(), 1);
  assert.equal(h.settings.subsProviderId, 'g');
  assert.equal(h.settings.selectionProviderId, 'g');
  h.edit('g');
  assert.equal(h.cards()[0].className, 'provider');
});

test('复制得到新 id 的副本，删除当前选用的会切到第一套', () => {
  const h = harness();
  h.cards()[0].byText('复制').fire('click');
  assert.equal(h.settings.providers.length, 3);
  assert.equal(h.settings.providers[1].name, 'Gemini 副本');
  assert.notEqual(h.settings.providers[1].id, 'g');
  h.edit('g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.providers.length, 2);
  assert.equal(h.settings.subsProviderId, h.settings.providers[0].id);
  assert.equal(h.settings.selectionProviderId, h.settings.providers[0].id);
});

test('查询接口按该卡片归一化后的配置发起，结果写在卡片上', async () => {
  const h = harness({ probe: cfg => ({ ok: cfg.apiType === 'openai', ms: 5, via: 'relay', message: cfg.apiType === 'openai' ? '连接及模型查询通过' : 'API Key 无效' }) });
  h.edit('o');
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].apiType, 'openai');
  assert.equal(h.probes[0].key, 'sk');
  assert.equal(h.probes[0].baseUrl, 'http://127.0.0.1:23000/v1');
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /^✓ 连接及模型查询通过 · 5 ms · 经后台转发$/);
  h.edit('g');
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.equal(h.probes[1].key, 'live-key');
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /^✗ API Key 无效/);
});

test('生成测试的失败会带上原因；列出模型填进候选并计数', async () => {
  const h = harness({
    generateTest: async () => { throw new Error('模型名不存在或接口地址不对'); },
    listModels: async () => ['gemini-x', 'gemini-y', 'gemini-z'],
  });
  h.cards()[0].byText('生成测试').fire('click');
  await flush();
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /^✗ 生成测试失败：模型名不存在/);
  assert.equal(h.testResults.length, 1);
  assert.equal(h.testResults[0].ok, false);
  h.cards()[0].byText('获取模型').fire('click');
  await flush();
  const list = h.cards()[0].byClass('model-options')[0];
  assert.equal(list.children.length, 3);
  assert.equal(list.children[0].textContent, 'gemini-x');
  assert.match(h.cards()[0].byClass('model-list-state')[0].textContent, /已获取 3 个模型/);
});

test('跨域直连失败时给出授权与改走后台的提示', async () => {
  const h = harness({ probe: async () => { const err = new TypeError('Failed to fetch'); err.canRelay = true; throw err; } });
  h.edit('o');
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /不允许浏览器直连/);
});

test('模型箭头显示全部，输入筛选、键盘选择和手填未知模型都能保存', async () => {
  const h = harness({ listModels: async () => ['gem', 'second-model', 'third-model'] });
  const card = h.cards()[0], input = card.all(n => n.tag === 'input' && n.attrs.role === 'combobox')[0];
  card.byText('获取模型').fire('click'); await flush();
  const list = card.byClass('model-options')[0];
  assert.equal(list.children.length, 3);
  input.value = 'second'; input.fire('input');
  assert.equal(list.children.length, 1);
  input.fire('keydown', { key: 'ArrowDown' }); input.fire('keydown', { key: 'Enter' });
  assert.equal(h.settings.providers[0].model, 'second-model');
  assert.equal(list.hidden, true);
  card.byClass('model-toggle')[0].fire('click');
  assert.equal(list.children.length, 3);
  input.value = 'manual-model-not-listed'; input.fire('input'); input.fire('keydown', { key: 'Escape' });
  assert.equal(h.settings.providers[0].model, 'manual-model-not-listed');
  assert.equal(list.hidden, true);
});

test('修改请求头会清除旧模型列表，迟到的模型响应不会填入新配置', async () => {
  let complete;
  const h = harness({ contains: async () => true, listModels: () => new Promise(resolve => { complete = resolve; }) });
  const card = h.cards()[0];
  card.byText('获取模型').fire('click'); await flush();
  card.byText('添加请求头').fire('click');
  const inputs = card.byClass('header-row')[0].children;
  inputs[0].value = 'X-Api-Key'; inputs[0].fire('input');
  inputs[1].value = 'header-test-only'; inputs[1].fire('input');
  complete(['old-account-model']); await flush();
  assert.equal(h.settings.providers[0].headers['x-api-key'], 'header-test-only');
  assert.equal(card.byClass('model-option').length, 0);
  assert.match(card.byClass('model-list-state')[0].textContent, /连接配置已修改/);
});

test('切换编辑的接口会作废未完成的模型列表请求', async () => {
  let complete;
  const h = harness({ contains: async () => true, listModels: () => new Promise(resolve => { complete = resolve; }) });
  const previous = h.cards()[0];
  previous.byText('获取模型').fire('click'); await flush();
  h.edit('o'); complete(['other-account-model']); await flush();
  assert.equal(h.cards()[0].byClass('model-option').length, 0);
  assert.equal(previous.byClass('model-option').length, 0);
});

test('授权在地址下方；拒绝授权时不发模型或生成请求，端口不进入主机权限模式', async () => {
  const requests = [];
  let generations = 0;
  const h = harness({ request: async value => { requests.push(value); return false; },
    generateTest: async () => { generations++; return {}; } });
  h.edit('o');
  const card = h.cards()[0];
  const access = card.byClass('host-access')[0];
  const advanced = card.byClass('advanced')[0];
  assert.equal(advanced.byClass('host-access').length, 0);
  card.byText('查询接口').fire('click');
  await flush();
  assert.equal(h.probes.length, 0);
  assert.deepEqual(Array.from(requests[0].origins), ['http://127.0.0.1/*']);
  assert.match(access.byClass('host-access-status')[0].textContent, /未授权/);
  card.byText('生成测试').fire('click');
  await flush();
  assert.equal(generations, 0);
});

test('域名改变后，旧权限检查迟到不能把新域名标为已授权', async () => {
  let resolveOld;
  const h = harness({ contains: value => value.origins[0] === 'http://127.0.0.1/*'
    ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(false) });
  h.edit('o');
  const card = h.cards()[0];
  const base = card.all(node => node.tag === 'input' && node.value === 'http://127.0.0.1:23000/v1')[0];
  base.value = 'https://new.example/v1'; base.fire('input');
  await flush();
  resolveOld(true); await flush();
  const access = card.byClass('host-access')[0];
  assert.match(access.byClass('host-access-status')[0].textContent, /未授权/);
  assert.match(access.byClass('host-access-help')[0].all(node => node.tag === 'p')[0].textContent, /https:\/\/new\.example/);
});

test('等待授权期间换地址，旧域名获批也不能向新地址发出查询', async () => {
  let resolveGrant;
  const h = harness({ request: () => new Promise(resolve => { resolveGrant = resolve; }) });
  h.edit('o');
  const card = h.cards()[0];
  card.byText('查询接口').fire('click');
  assert.equal(typeof resolveGrant, 'function');
  const base = card.all(node => node.tag === 'input' && node.value === 'http://127.0.0.1:23000/v1')[0];
  base.value = 'https://new.example/v1'; base.fire('input');
  await flush();
  resolveGrant(true); await flush();
  assert.equal(h.probes.length, 0);
  const access = card.byClass('host-access')[0];
  assert.match(access.byClass('host-access-status')[0].textContent, /未授权/);
  assert.match(access.byClass('host-access-help')[0].all(node => node.tag === 'p')[0].textContent, /https:\/\/new\.example/);
});

test('删除接口时评论用途一并回落；列表用途保持编辑对象，不重复默认类型名称', () => {
  const h = harness();
  h.settings.commentProviderId = 'g';
  h.ui.render();
  assert.ok(h.list.children[0].byText('Gemini'));
  assert.ok(h.list.children[0].byText('gem'));
  assert.ok(h.list.children[0].all(node => node.textContent.startsWith('用于：') && node.textContent.includes('评论')).length);
  h.edit('o');
  h.settings.liveContextProviderId = 'o';
  h.ui.render();
  assert.equal(h.picker.value, 'o');
  h.edit('g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.commentProviderId, 'o');
});

test('手机版接口选择仅切换编辑对象，所有字段标签关联真实控件', () => {
  const h = harness();
  h.settings.commentProviderId = 'g';
  h.picker.value = 'o';
  h.picker.fire('change');
  assert.equal(h.cards().length, 1);
  assert.equal(h.settings.subsProviderId, 'g');
  assert.equal(h.settings.selectionProviderId, 'g');
  assert.equal(h.settings.commentProviderId, 'g');
  assert.equal(h.selected.length, 0);
  const card = h.cards()[0];
  for (const label of card.all(node => node.tag === 'label')) {
    assert.ok(label.attrs.for);
    assert.ok(card.all(node => node.id === label.attrs.for).length, `找不到 ${label.textContent} 对应控件`);
  }
  assert.equal(card.byClass('key-storage-note').length, 1);
});

test('授权状态紧凑且可读，已授权不留灰色按钮；所有网站范围常驻并提供可展开说明', async () => {
  const h = harness({ contains: async () => true });
  await flush();
  const access = h.cards()[0].byClass('host-access')[0];
  assert.equal(access.byClass('host-access-status')[0].attrs.role, 'status');
  assert.equal(access.byClass('host-access-status')[0].textContent, '● 已授权');
  assert.equal(access.all(node => node.tag === 'button')[0].hidden, true);
  assert.ok(access.byClass('host-access-help')[0].byText('ⓘ 授权说明'));
  const custom = new FakeNode('div');
  h.LT.OptionsUI.mountHostAccess({ container: custom, getTarget: () => ({ origins: ['<all_urls>'],
    label: 'Chrome 所有网站权限', scopeLabel: '所有网站权限', missingText: '用于千问连接认证。' }) });
  await flush();
  assert.equal(custom.byClass('host-access-label')[0].textContent, '所有网站权限');
  assert.match(custom.byClass('host-access-help')[0].all(node => node.tag === 'p')[0].textContent, /用于千问连接认证/);
});

test('权限检查与授权失败有状态和详情，仍可通过按钮重试', async () => {
  const h = harness({ contains: async () => { throw new Error('权限检查不可用'); },
    request: async () => { throw new Error('浏览器拒绝此次授权'); } });
  await flush();
  const access = h.cards()[0].byClass('host-access')[0];
  assert.equal(access.attrs['data-state'], 'error');
  assert.match(access.byClass('host-access-status')[0].textContent, /检查失败/);
  const button = access.all(node => node.tag === 'button')[0];
  assert.equal(button.hidden, false);
  button.fire('click');
  await flush();
  assert.match(access.byClass('host-access-status')[0].textContent, /授权失败/);
  assert.match(access.byClass('host-access-help')[0].all(node => node.tag === 'p')[0].textContent, /浏览器拒绝此次授权/);
  assert.equal(button.disabled, false);
});

test('修改模型后作废尚未完成的生成测试，迟到成功不再上报', async () => {
  let complete;
  const h = harness({ contains: async () => true,
    generateTest: () => new Promise(resolve => { complete = resolve; }) });
  await flush();
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.equal(h.testResults.length, 0);
  h.cards()[0].byText('生成测试').fire('click');
  await flush();
  const model = h.cards()[0].all(node => node.tag === 'input' && node.attrs['aria-controls'] === 'models-g')[0];
  model.value = 'new-model'; model.fire('input');
  complete({ ms: 5, via: 'direct', sample: '你好' });
  await flush();
  assert.equal(h.testResults.length, 0);
  assert.equal(h.settings.providers[0].model, 'new-model');
});

test('多 Key 生成测试冻结完整列表，保留同一有效 Key 也不能验证后来改过的列表', async () => {
  let complete;
  const h = harness({ contains: async () => true,
    generateTest: () => new Promise(resolve => { complete = resolve; }) });
  h.settings.apiKeys = 'test-live-a, test-live-b';
  h.LT.Settings.pickKey = () => 'test-live-a';
  const before = h.LT.OptionsUI.providerSignature(h.settings, 'g');
  await flush();
  h.cards()[0].byText('生成测试').fire('click');
  await flush();
  h.settings.apiKeys = 'test-live-a, test-live-c';
  const after = h.LT.OptionsUI.providerSignature(h.settings, 'g');
  complete({ ms: 5, via: 'direct', sample: '你好' });
  await flush();
  assert.equal(h.testResults.length, 1);
  assert.equal(JSON.parse(h.testResults[0].signature).key, 'test-live-a');
  assert.equal(h.testResults[0].settingsSignature, before);
  assert.notEqual(h.testResults[0].settingsSignature, after);
});

// ---------- 导出 / 导入的纯函数 ----------

function dataHarness() {
  const ctx = vm.createContext({ console, URL, Date, Math, JSON, setTimeout, clearTimeout, document: { createElement: tag => new FakeNode(tag) } });
  for (const f of ['src/common/constants.js', 'src/common/settings.js', 'src/ui/options-data.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  }
  return ctx.LT;
}

function mountedDataHarness(patch) {
  const nodes = new Map();
  const ctx = vm.createContext({ console, URL, Date, Math, JSON, setTimeout, clearTimeout, confirm: () => true,
    document: { createElement: tag => new FakeNode(tag) } });
  for (const f of ['src/common/constants.js', 'src/common/settings.js', 'src/ui/options-data.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  }
  const LT = ctx.LT;
  const settings = LT.Settings.normalize(patch);
  const replacements = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  LT.OptionsUI.mountData({ $, settings: () => settings, replace: async next => replacements.push(next), version: 'test' });
  return { LT, $, settings, replacements,
    fire: async (id, event) => Promise.all(($(id).listeners[event] || []).map(fn => fn({ target: $(id) }))) };
}

test('导出默认剔除所有 Key，勾选后才带上', () => {
  const LT = dataHarness();
  const settings = LT.Settings.normalize({ apiKeys: 'live', providers: [{ id: 'a', apiType: 'openai', apiKey: 'sk' }] });
  const bare = LT.OptionsUI.exportObject(settings, false, '0.2.0');
  assert.equal(bare.app, 'liuyi');
  assert.equal(bare.includesKeys, false);
  assert.equal(bare.settings.apiKeys, '');
  assert.equal(bare.settings.providers[0].apiKey, '');
  const full = LT.OptionsUI.exportObject(settings, true, '0.2.0');
  assert.equal(full.settings.apiKeys, 'live');
  assert.equal(full.settings.providers[0].apiKey, 'sk');
});

test('导入不含 Key 的文件时按 id 保留现有 Key；不是流译文件会拒绝', () => {
  const LT = dataHarness();
  const current = LT.Settings.normalize({ apiKeys: 'live', providers: [{ id: 'a', apiType: 'openai', apiKey: 'sk' }, { id: 'b', apiKey: 'sk-b' }] });
  const file = { app: 'liuyi', includesKeys: false, settings: { sourceLang: 'en', providers: [{ id: 'a', apiType: 'openai' }, { id: 'c', apiType: 'gemini' }] } };
  const next = LT.OptionsUI.importObject(file, current);
  assert.equal(next.sourceLang, 'en');
  assert.equal(next.apiKeys, 'live');
  assert.equal(next.providers[0].apiKey, 'sk');
  assert.equal(next.providers[1].apiKey, '');
  assert.throws(() => LT.OptionsUI.importObject({ app: 'other', settings: {} }, current), /不是流译/);
  assert.throws(() => LT.OptionsUI.importObject({ app: 'liuyi' }, current), /不是流译/);
});

test('实际恢复默认按钮勾选保留接口时，四种用途 id 与所有 Key 保留', async () => {
  const h = mountedDataHarness({ apiKeys: 'test-live-key', qwenApiKey: 'test-qwen-key', ttsGeminiApiKey: 'test-speech-key',
    liveProvider: 'qwen', baseUrl: 'wss://live.example/ws', qwenWorkspaceHost: 'workspace.cn-beijing.maas.aliyuncs.com',
    ttsProvider: 'gemini', ttsGeminiReuseKey: false, ttsGeminiBaseUrl: 'https://speech.example', ttsGeminiModel: 'speech-custom-model',
    providers: ['context', 'subs', 'selection', 'comment'].map(id => ({ id, apiType: 'openai',
      name: id, apiKey: `test-${id}-key`, baseUrl: `https://${id}.example/v1`, model: `${id}-model` })),
    liveContextProviderId: 'context', subsProviderId: 'subs', selectionProviderId: 'selection', commentProviderId: 'comment',
    sourceLang: 'en', manualContext: '不应保留的普通背景' });
  h.$('keepKeys').checked = true;
  await h.fire('resetSettings', 'click');
  assert.equal(h.replacements.length, 1);
  const next = h.replacements[0];
  for (const field of ['liveContextProviderId', 'subsProviderId', 'selectionProviderId', 'commentProviderId',
    'apiKeys', 'qwenApiKey', 'ttsGeminiApiKey', 'liveProvider', 'baseUrl', 'qwenWorkspaceHost', 'ttsProvider',
    'ttsGeminiReuseKey', 'ttsGeminiBaseUrl', 'ttsGeminiModel']) assert.equal(next[field], h.settings[field], `${field} 未保留`);
  assert.equal(JSON.stringify(next.providers), JSON.stringify(h.settings.providers));
  assert.notEqual(next.providers, h.settings.providers);
  assert.equal(next.manualContext, h.LT.DEFAULTS.manualContext);
});

test('实际恢复默认按钮取消保留时，清除 Key 并恢复默认接口与连接', async () => {
  const h = mountedDataHarness({ apiKeys: 'test-live-key', qwenApiKey: 'test-qwen-key', ttsGeminiApiKey: 'test-speech-key',
    liveProvider: 'qwen', baseUrl: 'wss://live.example/ws', qwenWorkspaceHost: 'workspace.cn-beijing.maas.aliyuncs.com',
    ttsProvider: 'gemini', ttsGeminiReuseKey: false, ttsGeminiBaseUrl: 'https://speech.example', ttsGeminiModel: 'speech-custom-model',
    providers: [{ id: 'custom', apiType: 'openai', apiKey: 'test-custom-key', baseUrl: 'https://custom.example/v1', model: 'custom-model' }],
    subsProviderId: 'custom', liveContextProviderId: 'custom', selectionProviderId: 'custom', commentProviderId: 'custom' });
  h.$('keepKeys').checked = false;
  await h.fire('resetSettings', 'click');
  assert.equal(h.replacements.length, 1);
  const next = h.replacements[0];
  const defaults = h.LT.Settings.normalize({});
  for (const field of ['apiKeys', 'qwenApiKey', 'ttsGeminiApiKey']) assert.equal(next[field], '');
  for (const field of ['liveProvider', 'baseUrl', 'qwenWorkspaceHost', 'ttsProvider', 'ttsGeminiReuseKey', 'ttsGeminiBaseUrl',
    'ttsGeminiModel', 'subsProviderId', 'liveContextProviderId', 'selectionProviderId', 'commentProviderId']) {
    assert.equal(next[field], defaults[field], `${field} 未恢复默认`);
  }
  assert.equal(JSON.stringify(next.providers), JSON.stringify(defaults.providers));
});

test('实际导入旧备份首次评论沿用字幕接口，之后字幕选择不再改变评论', async () => {
  const h = mountedDataHarness({ providers: [
    { id: 'a', apiType: 'openai', apiKey: 'test-a-key' }, { id: 'b', apiType: 'gemini', apiKey: 'test-b-key' },
  ], subsProviderId: 'a', commentProviderId: 'a' });
  const old = { app: 'liuyi', includesKeys: false, settings: { providers: [
    { id: 'a', apiType: 'openai' }, { id: 'b', apiType: 'gemini' },
  ], subsProviderId: 'b' } };
  h.$('importFile').files = [{ text: async () => JSON.stringify(old) }];
  await h.fire('importFile', 'change');
  assert.equal(h.replacements.length, 1);
  const imported = h.replacements[0];
  assert.equal(imported.commentProviderId, 'b');
  assert.equal(imported.providers[0].apiKey, 'test-a-key');
  assert.equal(imported.providers[1].apiKey, 'test-b-key');
  const afterSelectionChange = h.LT.Settings.normalize({ ...imported, subsProviderId: 'a' });
  assert.equal(afterSelectionChange.subsProviderId, 'a');
  assert.equal(afterSelectionChange.commentProviderId, 'b');
});
