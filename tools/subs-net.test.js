/** 文字模型传输回归：模拟网络异常、超时和后台端口，不调用真实接口。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(fetch, seen = []) {
  let connections = 0;
  const ctx = vm.createContext({ URL, TypeError, DOMException, AbortController, TextDecoder,
    setTimeout, clearTimeout, fetch,
    LT: { SUBS: { REQUEST_TIMEOUT_MS: 10 }, RELAY_PORT: 'test' },
    chrome: { runtime: { connect() {
      connections++;
      let receive;
      return {
        onMessage: { addListener(fn) { receive = fn; } },
        onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(msg) {
          seen.push(msg);
          receive({ type: 'head', ok: true, status: 200 });
          receive({ type: 'chunk', text: 'reply' });
          receive({ type: 'end' });
        },
      };
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/subs/net.js'), 'utf8'), ctx);
  return { net: ctx.LT.Net, connections: () => connections };
}
const req = { url: 'https://example.invalid/test', headers: {}, body: '{}', path: 'auto' };

test('请求尚未建立时的跨域失败，可以回退后台', async () => {
  const h = harness(async () => { throw new TypeError('Failed to fetch'); });
  const res = await h.net.post(req);
  assert.equal(res.via, 'relay');
  assert.equal(res.text, 'reply');
  assert.equal(h.connections(), 1);
});

test('已收到响应后流中断，不把同一请求自动重发到后台', async () => {
  const h = harness(async () => ({ ok: true, status: 200, headers: new Headers(),
    body: { getReader: () => ({ read: async () => { throw new TypeError('stream interrupted'); }, releaseLock() {} }) },
  }));
  await assert.rejects(h.net.post(req), /stream interrupted/);
  assert.equal(h.connections(), 0);
});

test('长时间没有完成的请求会中止并给出可重试的超时错误', async () => {
  let aborted = false;
  const h = harness((_url, { signal }) => new Promise((resolve, reject) => {
    const fallback = setTimeout(() => resolve({ ok: true, status: 200, headers: new Headers(), text: async () => 'late' }), 60);
    signal.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(fallback);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  }));
  await assert.rejects(h.net.post({ ...req, signal: new AbortController().signal }), /超时/);
  assert.equal(aborted, true);
  assert.equal(h.connections(), 0);
});

test('后台请求完成后释放外部取消监听器', async () => {
  const h = harness(() => {});
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { listeners++; return add(...args); };
  signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
  await h.net.post({ ...req, path: 'relay', signal });
  assert.equal(listeners, 0);
});

test('GET 请求的方法一路传到后台，直连与转发都不带正文', async () => {
  const seen = [];
  const calls = [];
  const h = harness(async (_url, init) => { calls.push(init); throw new TypeError('Failed to fetch'); }, seen);
  const res = await h.net.request({ ...req, method: 'get' });
  assert.equal(res.via, 'relay');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].body, undefined);
  const posted = await h.net.post({ ...req, path: 'relay' });
  assert.equal(posted.via, 'relay');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, '{}');
});

test('单独给的超时时间优先于默认两分钟', async () => {
  const h = harness((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const t0 = Date.now();
  await assert.rejects(h.net.request({ ...req, method: 'GET', timeoutMs: 5 }), /超时/);
  assert.ok(Date.now() - t0 < 1000);
});
