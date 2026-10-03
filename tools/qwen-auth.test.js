/** 临时握手规则回归：验证请求范围、权限与断线清理。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function harness(granted = true) {
  const onConnect = [];
  const rules = new Map();
  const chrome = {
    declarativeNetRequest: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        for (const id of removeRuleIds) rules.delete(id);
        for (const rule of addRules) rules.set(rule.id, rule);
      },
    },
    permissions: { contains: async () => granted },
    runtime: { onConnect: { addListener(fn) { onConnect.push(fn); } }, onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const ctx = vm.createContext({ chrome, URL, Math, console, AbortController, importScripts(...files) {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file.slice(1)), 'utf8'), ctx);
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/background/service-worker.js'), 'utf8'), ctx);
  function port(tabUrl = 'https://www.youtube.com/watch?v=abc', name = ctx.LT.QWEN_AUTH_PORT) {
    const p = { name, sender: { tab: { id: 17, url: tabUrl } }, replies: [],
      onMessage: { addListener(fn) { p.receive = fn; } },
      onDisconnect: { addListener(fn) { p.disconnect = fn; } },
      postMessage(msg) { p.replies.push(msg); } };
    for (const fn of onConnect) fn(p);
    return p;
  }
  return { rules, port, ctx, chrome };
}

const url = 'wss://ws-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime';

test('规则仅命中本次标签页、准确 WebSocket URL，断开端口即删除', async () => {
  const h = harness();
  const p = h.port();
  p.receive({ type: 'prepare', url, key: 'sk-test-only' });
  await flush();
  assert.equal(p.replies.at(-1).type, 'prepared');
  assert.equal(h.rules.size, 1);
  const rule = [...h.rules.values()][0];
  assert.equal(rule.condition.urlFilter, `|${url}|`);
  assert.deepEqual(JSON.parse(JSON.stringify(rule.condition.resourceTypes)), ['websocket']);
  assert.deepEqual(JSON.parse(JSON.stringify(rule.condition.tabIds)), [17]);
  assert.equal(rule.action.requestHeaders[0].value, 'Bearer sk-test-only');
  p.disconnect();
  await flush();
  assert.equal(h.rules.size, 0);
});

test('缺权限或非千问地址不得创建带 Key 的规则', async () => {
  const cases = [
    { h: harness(false), url },
    { h: harness(), url: 'wss://evil.example.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime' },
  ];
  for (const item of cases) {
    const p = item.h.port();
    p.receive({ type: 'prepare', url: item.url, key: 'sk-test-only' });
    await flush();
    assert.equal(p.replies.at(-1).type, 'error');
    assert.equal(item.h.rules.size, 0);
  }
});

test('文字接口后台转发检查不含端口的权限，同时保留实际请求端口；拒绝授权不请求', async () => {
  for (const granted of [true, false]) {
    const h = harness();
    const checked = [], requested = [];
    h.chrome.permissions.contains = async ({ origins }) => { checked.push(origins[0]); return granted; };
    h.ctx.fetch = async value => { requested.push(value); return { ok: true, status: 200,
      headers: { get: () => '' }, text: async () => 'mock response' }; };
    const p = h.port(undefined, h.ctx.LT.RELAY_PORT);
    await p.receive({ type: 'fetch', url: 'http://127.0.0.1:23000/v1/models', method: 'GET' });
    assert.deepEqual(checked, ['http://127.0.0.1/*']);
    assert.deepEqual(requested, granted ? ['http://127.0.0.1:23000/v1/models'] : []);
    assert.equal(p.replies.at(-1).type, granted ? 'end' : 'error');
  }
});
