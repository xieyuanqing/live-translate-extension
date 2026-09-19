/** 设置页「文字模型」卡片回归：用极简的假 DOM 跑 options-providers.js，不开浏览器、不发请求。 */
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
    this.className = ''; this.value = ''; this.textContent = ''; this.disabled = false; this.placeholder = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; cs.forEach(c => this.appendChild(c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byText(text) { return this.all(n => n.textContent === text)[0]; }
  byClass(cls) { return this.all(n => n.className.split(' ').includes(cls)); }
}

function harness({ probe, generateTest, listModels } = {}) {
  const ctx = vm.createContext({
    console, URL, Date, Math, JSON, setTimeout, clearTimeout, confirm: () => true,
    document: { createElement: tag => new FakeNode(tag) },
    chrome: { permissions: { contains: async () => false, request: async () => true } },
  });
  for (const f of ['src/common/constants.js', 'src/common/settings.js', 'src/subs/text-model.js', 'src/ui/options-providers.js']) {
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
  let saves = 0;
  const selected = [];
  const ui = LT.OptionsUI.mountProviders({
    box,
    settings: () => settings,
    save: () => { saves++; },
    select: id => { selected.push(id); settings.subsProviderId = id; },
  });
  ui.render();
  return { LT, settings, box, ui, probes, saves: () => saves, selected, cards: () => box.children };
}

test('每套配置一张卡片，选用的那张带标记，只剩一套时不能删', () => {
  const h = harness();
  assert.equal(h.cards().length, 2);
  assert.equal(h.cards()[0].className, 'provider active');
  assert.ok(h.cards()[0].byText('整片字幕使用'));
  assert.ok(h.cards()[1].byText('整片字幕改用这套'));
  assert.equal(h.cards()[0].byText('删除').disabled, false);
  h.settings.providers.pop();
  h.ui.render();
  assert.equal(h.cards()[0].byText('删除').disabled, true);
});

test('改模型名原位写回并保存，切换选用会回调', () => {
  const h = harness();
  const model = h.cards()[1].all(n => n.tag === 'input' && n.attrs.list === 'models-o')[0];
  model.value = 'local-2';
  model.fire('input');
  assert.equal(h.settings.providers[1].model, 'local-2');
  assert.equal(h.saves(), 1);
  h.cards()[1].byText('整片字幕改用这套').fire('click');
  assert.deepEqual(h.selected, ['o']);
  assert.equal(h.cards()[1].className, 'provider active');
});

test('复制得到新 id 的副本，删除当前选用的会切到第一套', () => {
  const h = harness();
  h.cards()[0].byText('复制').fire('click');
  assert.equal(h.settings.providers.length, 3);
  assert.equal(h.settings.providers[1].name, 'Gemini generateContent 副本');
  assert.notEqual(h.settings.providers[1].id, 'g');
  h.cards()[0].byText('删除').fire('click');
  assert.equal(h.settings.providers.length, 2);
  assert.equal(h.settings.subsProviderId, h.settings.providers[0].id);
});

test('测试连接按该卡片归一化后的配置发起，结果写在卡片上', async () => {
  const h = harness({ probe: cfg => ({ ok: cfg.apiType === 'openai', ms: 5, via: 'relay', message: cfg.apiType === 'openai' ? '连接及模型查询通过' : 'API Key 无效' }) });
  h.cards()[1].byText('测试连接').fire('click');
  await flush();
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].apiType, 'openai');
  assert.equal(h.probes[0].key, 'sk');
  assert.equal(h.probes[0].baseUrl, 'http://127.0.0.1:23000/v1');
  assert.match(h.cards()[1].byClass('test-state')[0].textContent, /^✓ 连接及模型查询通过 · 5 ms · 经后台转发$/);
  h.cards()[0].byText('测试连接').fire('click');
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
  h.cards()[0].byText('列出可用模型').fire('click');
  await flush();
  const datalist = h.cards()[0].all(n => n.tag === 'datalist')[0];
  assert.equal(datalist.children.length, 3);
  assert.equal(datalist.children[0].value, 'gemini-x');
  assert.match(h.cards()[0].all(n => n.textContent.startsWith('共 3 个可用模型'))[0].textContent, /共 3 个/);
});

test('跨域直连失败时给出授权与改走后台的提示', async () => {
  const h = harness({ probe: async () => { const err = new TypeError('Failed to fetch'); err.canRelay = true; throw err; } });
  h.cards()[1].byText('测试连接').fire('click');
  await flush();
  assert.match(h.cards()[1].byClass('test-state')[0].textContent, /不允许浏览器直连/);
});

// ---------- 导出 / 导入的纯函数 ----------

function dataHarness() {
  const ctx = vm.createContext({ console, URL, Date, Math, JSON, setTimeout, clearTimeout, document: { createElement: tag => new FakeNode(tag) } });
  for (const f of ['src/common/constants.js', 'src/common/settings.js', 'src/ui/options-data.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  }
  return ctx.LT;
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
