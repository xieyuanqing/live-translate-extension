/** 界面主题模拟：保存偏好、系统变化与迟到的初次读取；不访问浏览器或模型。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let resolveLoad, storageListener, systemListener;
  const system = { matches: true, addEventListener: (_, fn) => { systemListener = fn; } };
  const root = { dataset: {} };
  const context = vm.createContext({ document: { documentElement: root, getElementById: () => null },
    matchMedia: () => system, chrome: { storage: { onChanged: { addListener: fn => { storageListener = fn; } } } } });
  for (const file of ['src/common/constants.js', 'src/common/settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  context.LT.Settings.load = () => new Promise(resolve => { resolveLoad = resolve; });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/theme.js'), 'utf8'), context);
  return { root, LT: context.LT, loaded: resolveLoad,
    change: value => storageListener({ settings: { newValue: { uiTheme: value } } }, 'local'),
    system: dark => { system.matches = dark; systemListener(); } };
}

test('主题默认跟随系统，手选主题保持，恢复跟随系统后响应系统变化', async () => {
  const h = harness();
  assert.equal(h.LT.Settings.normalize({ uiTheme: 'invalid' }).uiTheme, 'system');
  assert.equal(h.root.dataset.theme, 'dark');
  h.loaded({ uiTheme: 'light' });
  await Promise.resolve();
  assert.equal(h.root.dataset.theme, 'light');
  h.system(false); h.system(true);
  assert.equal(h.root.dataset.theme, 'light');
  h.change('system');
  assert.equal(h.root.dataset.theme, 'dark');
  h.system(false);
  assert.equal(h.root.dataset.theme, 'light');
});

test('初次设置读取迟到时不能覆盖另一窗口刚保存的主题', async () => {
  const h = harness();
  h.change('dark');
  h.loaded({ uiTheme: 'light' });
  await Promise.resolve();
  assert.equal(h.root.dataset.theme, 'dark');
});

test('手动选择优先于迟到的初次读取和上一次保存事件', async () => {
  const h = harness();
  const first = h.LT.UITheme.apply('dark');
  const latest = h.LT.UITheme.apply('light');
  h.loaded({ uiTheme: 'dark' });
  h.change('dark');
  await Promise.resolve();
  assert.equal(h.root.dataset.theme, 'light');
  h.LT.UITheme.settle(first, 'dark');
  h.change('dark');
  assert.equal(h.root.dataset.theme, 'light');
  h.LT.UITheme.settle(latest, 'light');
  h.change('dark');
  assert.equal(h.root.dataset.theme, 'dark');
});
