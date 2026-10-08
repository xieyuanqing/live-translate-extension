/** 设置页接口编辑和授权回归：用极简的假 DOM，不开浏览器、不发网络请求。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test('七项功能只在集中页分配接口和模型，功能页各自直达对应分配', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/options.html'), 'utf8');
  const page = name => {
    const start = html.indexOf(`<section class="page" data-page="${name}">`);
    assert.notEqual(start, -1, `缺少 ${name} 页面`);
    const next = html.indexOf('<section class="page" data-page="', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  };
  assert.match(page('models'), /id="purposeAssignments"/);
  assert.match(page('models'), /id="providerPage"/);
  assert.match(page('models'), /id="providerKindFilters"/);
  for (const kind of ['all', 'live', 'text', 'speech']) {
    assert.match(page('models'), new RegExp(`data-provider-kind="${kind}"`));
  }
  for (const [section, purpose, obsoleteIds] of [
    ['speech', 'selection', ['modelSelectionProviderId', 'selectionModelPicker']],
    ['speech', 'speech', ['ttsProviderId']],
    ['live', 'live', ['liveProviderId']],
    ['live', 'context', ['modelContextProviderId', 'liveContextModelPicker']],
    ['video', 'subs', ['modelSubsProviderId', 'subsModelPicker']],
    ['text', 'chat', ['chatProviderId', 'chatModelPicker']],
    ['text', 'comment', ['modelCommentProviderId', 'commentModelPicker']],
  ]) {
    const feature = page(section);
    assert.match(feature, new RegExp(`href="#models/purpose/${purpose}"`), `${section} 缺少 ${purpose} 配置入口`);
    assert.match(feature, new RegExp(`data-purpose-summary="${purpose}"`), `${section} 缺少 ${purpose} 当前分配摘要`);
    for (const id of obsoleteIds) assert.doesNotMatch(feature, new RegExp(`id="${id}"`), `${section} 重复提供 ${id} 选择控件`);
  }
});

test('七项功能分配继续使用原有 settings 字段，修改其中一项不影响其他项', () => {
  const h = harness();
  const assignments = {
    liveProviderId: h.settings.providers.find(p => p.kind === 'live').id,
    ttsProviderId: h.settings.providers.find(p => p.kind === 'speech').id,
    chatProviderId: 'o', chatModel: 'chat-flash',
    subsProviderId: 'o', subsModel: 'subtitle-pro',
    commentProviderId: 'o', commentModel: 'comment-flash',
    selectionProviderId: 'o', selectionModel: 'selection-flash',
    liveContextProviderId: 'o', liveContextModel: 'context-flash',
  };
  Object.assign(h.settings, assignments);
  const persisted = h.LT.Settings.persistable(h.settings);
  for (const [field, value] of Object.entries(assignments)) assert.equal(persisted[field], value, field);
  const reloaded = h.LT.Settings.normalize({ ...persisted, subsModel: 'subtitle-flash' });
  for (const [field, value] of Object.entries(assignments)) {
    assert.equal(reloaded[field], field === 'subsModel' ? 'subtitle-flash' : value, field);
  }
});

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
  const alerts = [];
  const kindButtons = Object.fromEntries(['all', 'live', 'text', 'speech'].map(kind => {
    const button = new FakeNode('button');
    button.dataset = { providerKind: kind };
    return [kind, button];
  }));
  const ctx = vm.createContext({
    console, URL, Date, Math, JSON, AbortController, setTimeout, clearTimeout, confirm: () => true, alert: message => alerts.push(message),
    document: { createElement: tag => new FakeNode(tag), querySelectorAll: selector => {
      assert.equal(selector, '#providerKindFilters [data-provider-kind]');
      return Object.values(kindButtons);
    } },
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
      { id: 'g', name: '', preset: 'gemini', apiType: 'gemini', model: 'gem' },
      { id: 'o', name: '本地网关', kind: 'text', preset: 'custom', apiType: 'openai', baseUrl: 'http://127.0.0.1:23000/v1', apiKey: 'sk', model: 'local' },
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
  return { LT, settings, box, list, picker, kindButtons, ui, probes, testResults, alerts, initialProviderCount: settings.providers.length, saves: () => saves, selected, cards: () => box.children,
    edit: id => list.children.find(item => item.attrs['data-provider-id'] === id).byClass('provider-list-item')[0].fire('click') };
}

test('配置列表只展开正在编辑的一套，不显示功能分配；只剩一套时不能删', () => {
  const h = harness();
  assert.equal(h.cards().length, 1);
  assert.equal(h.list.children.length, h.settings.providers.length);
  assert.equal(h.cards()[0].className, 'provider');
  assert.equal(h.list.children[0].byClass('provider-list-roles').length, 0);
  assert.equal(h.cards()[0].byClass('provider-function-section').length, 0);
  assert.equal(h.cards()[0].byText('删除').disabled, false);
  h.settings.providers = h.settings.providers.filter(p => p.kind !== 'text' || p.id === 'g');
  h.ui.render();
  assert.equal(h.cards()[0].byText('删除').disabled, true);
});

test('按接口类型筛选仅改变列表，跨分类编辑会定位目标接口且不改功能绑定', () => {
  const h = harness();
  h.settings.subsProviderId = 'o'; h.settings.subsModel = 'subtitle-pro';
  h.settings.selectionProviderId = 'g'; h.settings.selectionModel = 'selection-flash';
  const assignments = Object.fromEntries(['liveProviderId', 'ttsProviderId', 'chatProviderId', 'chatModel',
    'subsProviderId', 'subsModel', 'commentProviderId', 'commentModel', 'selectionProviderId', 'selectionModel',
    'liveContextProviderId', 'liveContextModel'].map(field => [field, h.settings[field]]));
  h.ui.render();
  const visible = () => h.list.children.map(node => node.attrs['data-provider-id']);
  for (const kind of ['live', 'text', 'speech', 'all']) {
    h.kindButtons[kind].fire('click');
    const expected = h.settings.providers.filter(provider => kind === 'all' || provider.kind === kind).map(provider => provider.id);
    assert.deepEqual(visible(), expected, kind);
    assert.equal(h.kindButtons[kind].attrs['aria-pressed'], 'true');
  }
  h.kindButtons.speech.fire('click');
  h.ui.edit('o');
  assert.equal(h.kindButtons.text.attrs['aria-pressed'], 'true');
  assert.ok(visible().includes('o'));
  assert.equal(h.list.children.find(node => node.attrs['data-provider-id'] === 'o')
    .byClass('provider-list-item')[0].attrs['aria-pressed'], 'true');
  for (const [field, value] of Object.entries(assignments)) assert.equal(h.settings[field], value, field);
  assert.equal(h.saves(), 0);
});

test('同一接口添加多个模型；切换编辑的接口不会改变各功能选用', () => {
  const h = harness();
  h.edit('o');
  const model = h.cards()[0].all(n => n.tag === 'input' && n.id?.endsWith('-add-model'))[0];
  model.value = 'local-2';
  h.cards()[0].byText('添加模型').fire('click');
  assert.deepEqual(Array.from(h.settings.providers[1].models), ['local', 'local-2']);
  assert.equal(h.saves(), 1);
  assert.equal(h.settings.subsProviderId, 'g');
  assert.equal(h.settings.selectionProviderId, 'g');
  h.edit('g');
  assert.equal(h.cards()[0].className, 'provider');
});

test('从模型目录移除条目不改动功能已经保存的模型选择', () => {
  const h = harness();
  h.edit('o');
  h.settings.subsProviderId = 'o';
  h.settings.subsModel = 'local';
  h.cards()[0].byClass('provider-model-row')[0].byText('移除').fire('click');
  assert.deepEqual(Array.from(h.settings.providers[1].models), []);
  assert.equal(h.settings.subsProviderId, 'o');
  assert.equal(h.settings.subsModel, 'local');
  assert.deepEqual(Array.from(h.LT.Settings.normalize(h.LT.Settings.persistable(h.settings)).providers.find(p => p.id === 'o').models), []);
});

test('复制得到新 id 的副本，删除当前选用的会切到第一套', () => {
  const h = harness();
  h.cards()[0].byText('复制').fire('click');
  assert.equal(h.settings.providers.length, h.initialProviderCount + 1);
  assert.equal(h.settings.providers[1].name, 'Gemini 副本');
  assert.notEqual(h.settings.providers[1].id, 'g');
  h.edit('g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.providers.length, h.initialProviderCount);
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

test('模型生成测试的失败会带上原因；列出模型合并进目录并计数', async () => {
  const h = harness({
    generateTest: async () => { throw new Error('模型名不存在或接口地址不对'); },
    listModels: async () => ['gemini-x', 'gemini-y', 'gemini-z'],
  });
  h.cards()[0].byClass('provider-model-row')[0].byText('测试').fire('click');
  await flush();
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /^✗ 生成测试失败：模型名不存在/);
  assert.equal(h.testResults.length, 1);
  assert.equal(h.testResults[0].ok, false);
  h.cards()[0].byText('获取模型列表').fire('click');
  await flush();
  assert.deepEqual(Array.from(h.settings.providers[0].models), ['gem', 'gemini-x', 'gemini-y', 'gemini-z']);
  assert.equal(h.cards()[0].byClass('provider-model-row').length, 4);
  assert.match(h.cards()[0].byClass('model-list-state')[0].textContent, /已获取 3 个模型/);
});

test('跨域直连失败时给出授权与改走后台的提示', async () => {
  const h = harness({ probe: async () => { const err = new TypeError('Failed to fetch'); err.canRelay = true; throw err; } });
  h.edit('o');
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.match(h.cards()[0].byClass('test-state')[0].textContent, /不允许浏览器直连/);
});

test('模型选择器显示目录，支持筛选、键盘选择和手填未知模型', () => {
  const h = harness();
  const input = new FakeNode('input');
  let selected = '';
  const picker = h.LT.OptionsUI.modelPicker(input, 'test-models', value => { selected = value; });
  picker.setItems(['gem', 'second-model', 'third-model']);
  picker.root.byClass('model-toggle')[0].fire('click');
  const list = picker.root.byClass('model-options')[0];
  assert.equal(list.children.length, 3);
  input.value = 'second'; input.fire('input');
  assert.equal(list.children.length, 1);
  input.fire('keydown', { key: 'ArrowDown' }); input.fire('keydown', { key: 'Enter' });
  assert.equal(selected, 'second-model');
  assert.equal(list.hidden, true);
  input.value = 'manual-model-not-listed'; input.fire('input'); input.fire('keydown', { key: 'Escape' });
  assert.equal(selected, 'manual-model-not-listed');
  assert.equal(list.hidden, true);
});

test('修改请求头会清除旧模型列表，迟到的模型响应不会填入新配置', async () => {
  let complete;
  const h = harness({ contains: async () => true, listModels: () => new Promise(resolve => { complete = resolve; }) });
  const card = h.cards()[0];
  card.byText('获取模型列表').fire('click'); await flush();
  card.byText('添加请求头').fire('click');
  const inputs = card.byClass('header-row')[0].children;
  inputs[0].value = 'X-Api-Key'; inputs[0].fire('input');
  inputs[1].value = 'header-test-only'; inputs[1].fire('input');
  complete(['old-account-model']); await flush();
  assert.equal(h.settings.providers[0].headers['x-api-key'], 'header-test-only');
  assert.equal(h.settings.providers[0].models.includes('old-account-model'), false);
  assert.match(card.byClass('model-list-state')[0].textContent, /连接配置已修改/);
});

test('切换编辑的接口会作废未完成的模型列表请求', async () => {
  let complete;
  const h = harness({ contains: async () => true, listModels: () => new Promise(resolve => { complete = resolve; }) });
  const previous = h.cards()[0];
  previous.byText('获取模型列表').fire('click'); await flush();
  h.edit('o'); complete(['other-account-model']); await flush();
  assert.equal(h.settings.providers[0].models.includes('other-account-model'), false);
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
  card.byClass('provider-model-row')[0].byText('测试').fire('click');
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

test('删除接口时评论用途一并回落；列表只显示接口和模型数', () => {
  const h = harness();
  h.settings.commentProviderId = 'g';
  h.ui.render();
  assert.ok(h.list.children[0].byText('Gemini'));
  assert.match(h.list.children[0].byClass('provider-meta')[0].textContent, /1 个模型/);
  assert.equal(h.list.children[0].byClass('provider-list-roles').length, 0);
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

test('修改连接后作废尚未完成的模型生成测试，迟到成功不再上报', async () => {
  let complete;
  const h = harness({ contains: async () => true,
    generateTest: () => new Promise(resolve => { complete = resolve; }) });
  await flush();
  h.cards()[0].byText('查询接口').fire('click');
  await flush();
  assert.equal(h.testResults.length, 0);
  h.cards()[0].byClass('provider-model-row')[0].byText('测试').fire('click');
  await flush();
  const key = h.cards()[0].all(node => node.tag === 'input' && node.id?.endsWith('-key'))[0];
  key.value = 'new-key'; key.fire('input');
  complete({ ms: 5, via: 'direct', sample: '你好' });
  await flush();
  assert.equal(h.testResults.length, 0);
  assert.equal(h.settings.providers[0].apiKey, 'new-key');
});

test('多 Key 生成测试冻结完整列表，保留同一有效 Key 也不能验证后来改过的列表', async () => {
  let complete;
  const h = harness({ contains: async () => true,
    generateTest: () => new Promise(resolve => { complete = resolve; }) });
  h.settings.apiKeys = 'test-live-a, test-live-b';
  h.settings.providers.find(p => p.preset === 'gemini-live').apiKey = h.settings.apiKeys;
  h.LT.Settings.pickKey = () => 'test-live-a';
  const before = h.LT.OptionsUI.providerSignature(h.settings, 'g');
  await flush();
  h.cards()[0].byClass('provider-model-row')[0].byText('测试').fire('click');
  await flush();
  h.settings.apiKeys = 'test-live-a, test-live-c';
  h.settings.providers.find(p => p.preset === 'gemini-live').apiKey = h.settings.apiKeys;
  const after = h.LT.OptionsUI.providerSignature(h.settings, 'g');
  complete({ ms: 5, via: 'direct', sample: '你好' });
  await flush();
  assert.equal(h.testResults.length, 1);
  assert.equal(JSON.parse(h.testResults[0].signature).key, 'test-live-a');
  assert.equal(h.testResults[0].settingsSignature, before);
  assert.notEqual(h.testResults[0].settingsSignature, after);
});

test('被任何用途使用的提供商不能停用，未使用的启停不会改动功能绑定', async () => {
  const h = harness();
  const fields = ['liveContextProviderId', 'subsProviderId', 'selectionProviderId', 'commentProviderId'];
  const before = fields.map(field => h.settings[field]);
  const used = h.list.children[0].byClass('provider-enable-switch')[0];
  assert.equal(used.disabled, true);
  assert.match(h.list.children[0].byClass('provider-enable')[0].title, /正在被 4 个功能使用/);
  used.checked = false;
  used.fire('change');
  assert.equal(h.settings.providers[0].enabled, true);
  assert.equal(used.checked, true);
  h.edit('o');
  const unused = h.list.children[1].byClass('provider-enable-switch')[0];
  assert.equal(unused.disabled, false);
  unused.checked = false;
  unused.fire('change');
  assert.equal(h.settings.providers[1].enabled, false);
  assert.deepEqual(fields.map(field => h.settings[field]), before);
  const card = h.cards()[0];
  for (const label of ['查询接口', '获取模型列表']) {
    assert.equal(card.byText(label).disabled, true);
    card.byText(label).fire('click');
  }
  assert.equal(card.byClass('provider-model-row')[0].byText('测试').disabled, true);
  await flush();
  assert.equal(h.probes.length, 0);
  assert.equal(h.testResults.length, 0);
  const enableAgain = h.list.children[1].byClass('provider-enable-switch')[0];
  enableAgain.checked = true;
  enableAgain.fire('change');
  assert.equal(h.settings.providers[1].enabled, true);
  assert.deepEqual(fields.map(field => h.settings[field]), before);
});

test('提供商编辑器只维护连接目录，不包含功能分配控件', () => {
  const h = harness();
  for (const id of ['g', 'o']) {
    h.edit(id);
    assert.equal(h.cards()[0].byClass('provider-function-section').length, 0);
    assert.equal(h.cards()[0].byClass('provider-function-switch').length, 0);
    assert.equal(h.list.children.find(node => node.attrs['data-provider-id'] === id).byClass('provider-list-roles').length, 0);
  }
  assert.equal(h.settings.subsProviderId, 'g');
});

test('官方预设协议固定，单个自定义 API 可选协议，Key 显隐及描述独立保存', () => {
  const h = harness();
  for (const [id, preset] of [['g', 'gemini'], ['o', 'custom']]) {
    h.edit(id);
    const card = h.cards()[0];
    assert.equal(card.byClass('provider-identity')[0].textContent, h.LT.PROVIDER_PRESETS.find(p => p.code === preset).label);
    assert.equal(card.all(node => node.tag === 'select' && node.id.endsWith('-type')).length, preset === 'custom' ? 1 : 0);
  }
  const customGemini = h.LT.Settings.newProvider({ name: '自定义 Gemini', kind: 'text', preset: 'custom', apiType: 'gemini', baseUrl: 'https://gateway.example' });
  h.settings.providers.push(customGemini);
  h.ui.edit(customGemini.id);
  const card = h.cards()[0];
  assert.equal(card.byClass('provider-identity')[0].textContent, h.LT.PROVIDER_PRESETS.find(p => p.code === 'custom').label);
  const description = card.all(node => node.id?.endsWith('-description'))[0];
  description.value = '我的备用接口';
  description.fire('input');
  assert.equal(customGemini.description, '我的备用接口');
  const key = card.all(node => node.id?.endsWith('-key') && !node.id.endsWith('-show-key'))[0];
  const visibility = card.all(node => node.id?.endsWith('-show-key'))[0];
  assert.equal(key.type, 'password');
  visibility.checked = true;
  visibility.fire('change');
  assert.equal(key.type, 'text');
  const protocol = card.all(node => node.id?.endsWith('-type'))[0];
  protocol.value = 'openai';
  protocol.fire('change');
  assert.equal(customGemini.apiType, 'openai');
  protocol.value = 'gemini';
  protocol.fire('change');
  assert.equal(customGemini.preset, 'custom');
  assert.equal(customGemini.apiType, 'gemini');
});

test('复制保留厂商、启用状态和描述，重名副本自动编号；删除只回落可用提供商', () => {
  const h = harness();
  const original = h.settings.providers[1];
  original.description = '备用账号';
  original.enabled = false;
  h.edit('o');
  h.cards()[0].byText('复制').fire('click');
  const firstCopy = h.settings.providers[2];
  for (const field of ['preset', 'enabled', 'description']) assert.equal(firstCopy[field], original[field]);
  h.edit('o');
  h.cards()[0].byText('复制').fire('click');
  assert.equal(h.settings.providers[2].name, '本地网关 副本 2');
  h.edit('g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.providers.length, h.initialProviderCount + 2);
  assert.equal(h.settings.subsProviderId, 'g');
  assert.match(h.alerts[0], /请先启用另一个模型提供商/);
  firstCopy.enabled = true;
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.providers.length, h.initialProviderCount + 1);
  for (const field of ['liveContextProviderId', 'subsProviderId', 'selectionProviderId', 'commentProviderId']) assert.equal(h.settings[field], firstCopy.id);
  assert.equal(original.enabled, false);
});

test('按钮和拖拽只排序提供商，编辑对象和四个用途绑定保持原 id', () => {
  const h = harness();
  const fields = ['liveContextProviderId', 'subsProviderId', 'selectionProviderId', 'commentProviderId'];
  const before = fields.map(field => h.settings[field]);
  h.cards()[0].byText('下移').fire('click');
  assert.deepEqual(Array.from(h.settings.providers.filter(p => p.kind === 'text'), p => p.id), ['o', 'g']);
  assert.equal(h.picker.value, 'g');
  assert.deepEqual(fields.map(field => h.settings[field]), before);
  const g = h.list.children[1];
  g.byClass('provider-list-item')[0].fire('dragstart', { dataTransfer: { setData() {} } });
  h.list.children[0].fire('drop');
  assert.deepEqual(Array.from(h.settings.providers.filter(p => p.kind === 'text'), p => p.id), ['g', 'o']);
  h.list.children[0].byClass('provider-list-item')[0].fire('dragstart', { dataTransfer: { setData() {} } });
  h.list.children[1].fire('drop');
  assert.deepEqual(Array.from(h.settings.providers.filter(p => p.kind === 'text'), p => p.id), ['o', 'g']);
  h.list.children[1].byClass('provider-list-item')[0].fire('dragstart', { dataTransfer: { setData() {} } });
  h.list.children[0].fire('drop');
  assert.deepEqual(Array.from(h.settings.providers.filter(p => p.kind === 'text'), p => p.id), ['g', 'o']);
  assert.equal(h.picker.value, 'g');
  assert.deepEqual(fields.map(field => h.settings[field]), before);
});

test('停用正在编辑的提供商作废未完成模型请求，迟到响应不进入列表', async () => {
  let complete;
  const h = harness({ contains: async () => true, listModels: () => new Promise(resolve => { complete = resolve; }) });
  h.edit('o');
  const previous = h.cards()[0];
  previous.byText('获取模型列表').fire('click');
  await flush();
  const enable = h.list.children[1].byClass('provider-enable-switch')[0];
  enable.checked = false;
  enable.fire('change');
  complete(['old-account-model']);
  await flush();
  assert.equal(h.settings.providers[1].models.includes('old-account-model'), false);
  assert.equal(h.settings.providers[1].enabled, false);
});

test('编辑器启用开关让手机选择的提供商可启停，同样保护用途并作废旧测试', async () => {
  let complete;
  const h = harness({ contains: async () => true, generateTest: () => new Promise(resolve => { complete = resolve; }) });
  const fields = ['liveContextProviderId', 'subsProviderId', 'selectionProviderId', 'commentProviderId'];
  const before = fields.map(field => h.settings[field]);
  const used = h.cards()[0].byClass('provider-editor-enable-switch')[0];
  assert.equal(used.attrs['aria-label'], '启用当前提供商');
  assert.equal(used.disabled, true);
  used.checked = false;
  used.fire('change');
  assert.equal(used.checked, true);
  assert.equal(h.settings.providers[0].enabled, true);
  h.picker.value = 'o';
  h.picker.fire('change');
  const previous = h.cards()[0];
  previous.byClass('provider-model-row')[0].byText('测试').fire('click');
  await flush();
  const unbound = previous.byClass('provider-editor-enable-switch')[0];
  assert.equal(unbound.disabled, false);
  unbound.checked = false;
  unbound.fire('change');
  complete({ ms: 10, via: 'direct', sample: '旧测试' });
  await flush();
  assert.equal(h.settings.providers[1].enabled, false);
  assert.equal(h.picker.value, 'o');
  assert.equal(h.testResults.length, 0);
  assert.equal(h.cards()[0].byClass('provider-model-row')[0].byText('测试').disabled, true);
  const reenable = h.cards()[0].byClass('provider-editor-enable-switch')[0];
  reenable.checked = true;
  reenable.fire('change');
  assert.equal(h.settings.providers[1].enabled, true);
  assert.equal(h.cards()[0].byClass('provider-model-row')[0].byText('测试').disabled, false);
  assert.deepEqual(fields.map(field => h.settings[field]), before);
});

test('统一列表区分三种能力，服务编辑器只暴露实际连接字段', async () => {
  const h = harness();
  const presets = ['gemini-live', 'qwen-live', 'microsoft-tts', 'gemini-tts'];
  for (const preset of presets) {
    const provider = h.settings.providers.find(p => p.preset === preset);
    assert.ok(provider);
    h.edit(provider.id);
    const card = h.cards()[0];
    assert.equal(card.byClass('provider-function-switch').length, 0);
    assert.equal(card.byClass('custom-headers').length, 0);
    assert.equal(card.byText('获取模型列表'), undefined);
    const entry = h.list.children.find(node => node.attrs['data-provider-id'] === provider.id);
    assert.equal(entry.byClass('provider-kind')[0].textContent, provider.kind === 'live' ? '实时翻译' : '原文朗读');
    for (const label of card.all(node => node.tag === 'label')) {
      assert.ok(card.all(node => node.id === label.attrs.for).length, `找不到 ${label.textContent} 对应控件`);
    }
  }
  const geminiLive = h.settings.providers.find(p => p.preset === 'gemini-live');
  h.edit(geminiLive.id);
  const liveCard = h.cards()[0];
  const keys = liveCard.all(node => node.id?.endsWith('-apiKey'))[0];
  assert.equal(keys.tag, 'textarea');
  keys.value = 'live-a, live-b'; keys.fire('input');
  assert.equal(geminiLive.apiKey, 'live-a, live-b');
  const liveModel = liveCard.all(node => node.id?.endsWith('-model'))[0];
  assert.equal(liveModel.readOnly, true);
  assert.equal(liveModel.value, h.LT.MODEL);
  assert.equal(liveCard.byClass('host-access').length, 0);
  const qwen = h.settings.providers.find(p => p.preset === 'qwen-live');
  h.edit(qwen.id);
  const qwenCard = h.cards()[0];
  const workspace = qwenCard.all(node => node.id?.endsWith('-workspaceHost'))[0];
  workspace.value = 'workspace.ap-southeast-1.maas.aliyuncs.com'; workspace.fire('input');
  assert.equal(qwen.workspaceHost, workspace.value);
  assert.equal(qwenCard.all(node => node.id?.endsWith('-model'))[0].value, h.LT.QWEN_MODEL);
  await flush();
  assert.equal(qwenCard.byClass('host-access-label')[0].textContent, '所有网站权限');
  const microsoft = h.settings.providers.find(p => p.preset === 'microsoft-tts');
  h.edit(microsoft.id);
  const msCard = h.cards()[0];
  assert.equal(msCard.all(node => node.id?.endsWith('-apiKey')).length, 0);
  const jaVoice = msCard.all(node => node.id?.endsWith('-jaVoice'))[0];
  jaVoice.value = 'ja-JP-MasaruMultilingualNeural'; jaVoice.fire('change');
  assert.equal(microsoft.jaVoice, jaVoice.value);
  const geminiSpeech = h.settings.providers.find(p => p.preset === 'gemini-tts');
  h.edit(geminiSpeech.id);
  const speechCard = h.cards()[0];
  const key = speechCard.all(node => node.id?.endsWith('-apiKey'))[0];
  assert.equal(key.disabled, true);
  const reuse = speechCard.all(node => node.id?.endsWith('-reuseKey'))[0];
  reuse.checked = false; reuse.fire('change');
  assert.equal(geminiSpeech.reuseKey, false);
  assert.equal(key.disabled, false);
  const voice = speechCard.all(node => node.id?.endsWith('-voice'))[0];
  voice.value = 'Puck'; voice.fire('change');
  assert.equal(geminiSpeech.voice, 'Puck');
  assert.equal(speechCard.byClass('host-access').length, 1);
});

test('删除已绑定接口只迁移同类用途并清除旧模型选择，最后一套不可删除', () => {
  const h = harness();
  h.settings.subsModel = 'gem';
  h.settings.selectionModel = 'gem';
  h.edit('g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.subsProviderId, 'o');
  assert.equal(h.settings.selectionProviderId, 'o');
  assert.equal(h.settings.subsModel, '');
  assert.equal(h.settings.selectionModel, '');
  h.edit('o');
  assert.equal(h.cards()[0].byText('删除').disabled, true);

  const qwen = h.settings.providers.find(p => p.preset === 'qwen-live');
  const geminiLive = h.settings.providers.find(p => p.preset === 'gemini-live');
  h.settings.liveProviderId = qwen.id;
  h.edit(qwen.id);
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.liveProviderId, geminiLive.id);
  h.edit(geminiLive.id);
  assert.equal(h.cards()[0].byText('删除').disabled, true);

  const microsoft = h.settings.providers.find(p => p.preset === 'microsoft-tts');
  const geminiSpeech = h.settings.providers.find(p => p.preset === 'gemini-tts');
  h.settings.ttsProviderId = geminiSpeech.id;
  h.edit(geminiSpeech.id);
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.ttsProviderId, microsoft.id);
  h.edit(microsoft.id);
  assert.equal(h.cards()[0].byText('删除').disabled, true);
  for (const kind of ['text', 'live', 'speech']) assert.ok(h.settings.providers.some(p => p.kind === kind));
});

function speechHarness({ permissionsGranted = true, flushSettings = async () => {} } = {}) {
  const nodes = new Map(['ttsRate', 'ttsPreviewJa', 'ttsPreviewEn', 'ttsStopPreview', 'ttsPreviewState'].map(id => [id, new FakeNode('div')]));
  const messages = [], permissionChecks = [], permissionRequests = [], saves = [];
  let connections = 0;
  const $ = id => { assert.ok(nodes.has(id), `不应读取旧连接控件 ${id}`); return nodes.get(id); };
  $('ttsStopPreview').disabled = true;
  const context = vm.createContext({ console, URL, Date, Math, JSON,
    setInterval: () => 1, clearInterval() {}, window: { addEventListener() {} },
    document: { createElement: tag => new FakeNode(tag) },
    chrome: { permissions: {
      contains: async value => { permissionChecks.push(value); return permissionsGranted; },
      request: async value => { permissionRequests.push(value); return permissionsGranted; },
    }, runtime: { connect() { connections++; return { postMessage: message => messages.push(message), disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } } },
  });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/selection.js', 'src/ui/options-tts.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  }
  const LT = context.LT;
  const settings = LT.Settings.normalize({});
  const ui = LT.OptionsUI.mountSpeech({ $, settings: () => settings,
    save: patch => { saves.push(patch); Object.assign(settings, patch); }, flush: flushSettings });
  ui.bind();
  return { LT, settings, $, ui, messages, permissionChecks, permissionRequests, saves, connections: () => connections };
}

test('朗读功能页只设置语速，试听读取集中分配并按当前配置授权', async () => {
  const h = speechHarness();
  const firstSpeech = h.settings.providers.find(p => p.preset === 'gemini-tts');
  firstSpeech.baseUrl = 'https://speech-first.example';
  const secondSpeech = h.LT.Settings.newProvider({ preset: 'gemini-tts', name: '第二朗读接口', apiKey: 'test-speech-key', reuseKey: false,
    baseUrl: 'https://speech-second.example', model: 'my-tts', voice: 'Puck' });
  h.settings.providers.push(secondSpeech);
  h.settings.ttsProviderId = secondSpeech.id;
  h.ui.render();
  h.$('ttsRate').value = '1.15'; h.$('ttsRate').fire('change');
  h.$('ttsPreviewEn').fire('click'); await flush();
  assert.deepEqual(Array.from(h.permissionRequests[0].origins), ['https://speech-second.example/*']);
  assert.equal(h.permissionChecks.length, 0);
  assert.equal(h.connections(), 1);
  assert.equal(h.messages.find(message => message.type === 'speak').rate, 1.15);
  assert.equal(h.LT.Selection.resolve(h.LT.Settings.normalize(h.settings)).voice, 'Puck');
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].ttsRate, 1.15);
});

test('朗读试听拒绝权限和被停用提供商，保存等待中改配置取消旧试听', async () => {
  const denied = speechHarness({ permissionsGranted: false });
  const gemini = denied.settings.providers.find(p => p.preset === 'gemini-tts');
  gemini.apiKey = 'test-speech-key'; gemini.reuseKey = false;
  denied.settings.ttsProviderId = gemini.id;
  denied.ui.render();
  denied.$('ttsPreviewJa').fire('click'); await flush();
  assert.equal(denied.connections(), 0);
  assert.equal(denied.permissionRequests.length, 1);
  assert.match(denied.$('ttsPreviewState').textContent, /未获得接口域名权限/);
  gemini.enabled = false;
  denied.ui.render();
  denied.$('ttsPreviewJa').fire('click'); await flush();
  assert.equal(denied.permissionRequests.length, 1);
  assert.equal(denied.connections(), 0);
  assert.match(denied.$('ttsPreviewState').textContent, /停用/);
  let finishSave;
  const waiting = speechHarness({ flushSettings: () => new Promise(resolve => { finishSave = resolve; }) });
  waiting.$('ttsPreviewEn').fire('click'); await flush();
  const other = waiting.settings.providers.find(p => p.preset === 'gemini-tts');
  waiting.settings.ttsProviderId = other.id;
  waiting.ui.render();
  finishSave(); await flush();
  assert.equal(waiting.connections(), 0);
  assert.equal(waiting.messages.filter(message => message.type === 'speak').length, 0);
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
  assert.equal('apiKeys' in bare.settings, false);
  assert.equal(bare.settings.providers.find(p => p.preset === 'gemini-live').apiKey, '');
  assert.equal(bare.settings.providers[0].apiKey, '');
  const full = LT.OptionsUI.exportObject(settings, true, '0.2.0');
  assert.equal('apiKeys' in full.settings, false);
  assert.equal(full.settings.providers.find(p => p.preset === 'gemini-live').apiKey, 'live');
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
