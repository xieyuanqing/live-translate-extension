/**
 * Service Worker：首次写入默认设置、维护标签页角标、转发快捷键，以及替内容脚本转发
 * 文字模型请求（第三方接口不放行跨域时用）。
 * MV3 的 SW 随时会被杀掉，所以这里不保存任何会话状态，会话完全活在内容脚本里。
 */
importScripts('/src/common/constants.js', '/src/common/settings.js');

const LT = globalThis.LT;

const BADGE = {
  ready: { text: 'ON', color: '#2e7d32' },
  connecting: { text: '···', color: '#ef6c00' },
  reconnecting: { text: '···', color: '#ef6c00' },
  rotating: { text: '···', color: '#ef6c00' },
  subs: { text: 'CC', color: '#1565c0' },
  error: { text: '!', color: '#c62828' },
  idle: { text: '', color: '#000000' },
};

function paintBadge(tabId, status) {
  let key = 'idle';
  const video = status.video || {};
  if (status.error) key = 'error';
  else if (status.phase === 'running') key = status.conn === 'ready' ? 'ready' : 'connecting';
  else if (status.phase === 'starting') key = 'connecting';
  else if (video.phase === 'reading' || video.phase === 'translating') key = 'connecting';
  else if (video.phase === 'error') key = 'error';
  else if ((video.phase === 'ready' || video.phase === 'partial') && video.visible) key = 'subs';

  const badge = BADGE[key] || BADGE.idle;
  chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  // 只补齐缺失字段，不覆盖用户已有设置
  const current = await LT.Settings.load();
  await LT.Settings.save(current);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== LT.MSG.STATUS) return;
  if (sender.tab && typeof sender.tab.id === 'number') {
    paintBadge(sender.tab.id, msg.payload || {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-session') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: LT.MSG.TOGGLE }).catch(() => {});
});

// ---------- 文字模型请求转发 ----------
// 内容脚本直连被 CORS 拦下时，改由这里发请求。一律流式读取并按块推回：
// 响应头很快就到，端口消息也算扩展活动，不会撞上 SW 的 30 秒空闲回收。
// 只转发已获授权的域名；自定义接口要先在设置页点「授权访问该域名」。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LT.RELAY_PORT) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch (_) {
      /* 对端已断开 */
    }
  };
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'fetch') return;
    let origin;
    try {
      origin = new URL(msg.url).origin;
    } catch (_) {
      send({ type: 'error', message: '接口地址无效' });
      return;
    }
    try {
      const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!allowed) {
        send({ type: 'error', message: `浏览器未授权访问 ${origin}，请在扩展设置里点「授权访问该域名」` });
        return;
      }
      const res = await fetch(msg.url, {
        method: 'POST',
        headers: msg.headers || {},
        body: msg.body,
        signal: controller.signal,
      });
      send({ type: 'head', status: res.status, ok: res.ok, retryAfter: res.headers.get('retry-after') || '' });
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          send({ type: 'chunk', text: dec.decode(value, { stream: true }) });
        }
        send({ type: 'chunk', text: dec.decode() });
      } else {
        send({ type: 'chunk', text: await res.text() });
      }
      send({ type: 'end' });
    } catch (err) {
      send({
        type: 'error',
        message: err && err.name === 'AbortError' ? '已取消' : String((err && err.message) || err),
      });
    }
  });
});
