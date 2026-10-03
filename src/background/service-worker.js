/**
 * Service Worker：首次写入默认设置、维护标签页角标、转发快捷键，以及替内容脚本转发
 * 文字模型请求（第三方接口不放行跨域时用）。
 * 直播会话在内容脚本中；划词任务独立放在 selection.js，由客户端/播放器心跳维持并处理取消。
 */
importScripts('/src/common/constants.js', '/src/common/settings.js', '/src/common/selection.js',
  '/src/subs/net.js', '/src/subs/text-model.js', '/src/tts/audio.js', '/src/tts/microsoft.js', '/src/tts/gemini.js');

const LT = globalThis.LT;
importScripts('/src/background/selection.js');
const QWEN_RULE_MIN = 1000000000;
const QWEN_RULE_MAX = 1500000000;
const qwenRules = new Set();

function validQwenUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'wss:' &&
      /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname) &&
      url.pathname === '/api-ws/v1/realtime' &&
      url.searchParams.size === 1 &&
      url.searchParams.get('model') === LT.QWEN_MODEL;
  } catch (_) {
    return false;
  }
}

async function clearStaleQwenRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const stale = rules.map((r) => r.id)
    .filter((id) => id >= QWEN_RULE_MIN && id < QWEN_RULE_MAX && !qwenRules.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
}

// 上次工作进程异常退出时，握手用的临时认证规则不能留在本次浏览器会话里。
const qwenCleanupOnStart = clearStaleQwenRules().catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LT.QWEN_AUTH_PORT) return;
  let ruleId = 0;
  let closed = false;
  const reply = (msg) => { try { port.postMessage(msg); } catch (_) { /* 对端已断开 */ } };
  const release = async () => {
    const id = ruleId;
    ruleId = 0;
    if (!id) return;
    qwenRules.delete(id);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  };
  port.onDisconnect.addListener(() => {
    closed = true;
    release().catch(() => {});
  });
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'prepare' || ruleId || closed) return;
    const tab = port.sender && port.sender.tab;
    if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '') ||
        !validQwenUrl(msg.url) || !/^sk-[^\s]{8,}$/.test(String(msg.key || ''))) {
      reply({ type: 'error', message: '千问连接配置无效' });
      return;
    }
    try {
      const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      if (!granted) throw new Error('请先在扩展设置里授权千问 WebSocket 连接');
      await qwenCleanupOnStart;
      await clearStaleQwenRules();
      if (closed) return;
      let id;
      do { id = QWEN_RULE_MIN + Math.floor(Math.random() * (QWEN_RULE_MAX - QWEN_RULE_MIN)); }
      while (qwenRules.has(id));
      qwenRules.add(id);
      try { await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
          { header: 'Authorization', operation: 'set', value: `Bearer ${msg.key}` },
        ] },
        condition: {
          urlFilter: `|${msg.url}|`,
          resourceTypes: ['websocket'],
          tabIds: [tab.id],
        },
      }] }); }
      catch (err) { qwenRules.delete(id); throw err; }
      ruleId = id;
      if (closed) await release();
      else reply({ type: 'prepared' });
    } catch (err) {
      reply({ type: 'error', message: err && err.message ? err.message : '无法设置千问连接认证' });
    }
  });
});

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
  await LT.Settings.save({});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === LT.MSG.QUERY_CHAT_STATUS) {
    if (!sender.tab || sender.frameId !== 0 || !/^https:\/\/www\.youtube\.com\//.test(sender.url || '')) return;
    // 聊天帧可能先于主页面初始化，弹窗查询时补取状态，不保存跨页面会话。
    chrome.tabs.sendMessage(sender.tab.id, { type: LT.MSG.QUERY_CHAT_STATUS }).catch(() => {});
    return;
  }
  if (msg?.type === LT.MSG.CHAT_STATUS) {
    if (!sender.tab || !/^https:\/\/www\.youtube\.com\/live_chat(?:_replay)?\/?(?:\?|$)/.test(sender.url || '')) return;
    const currentVideo = new URL(sender.tab.url || 'https://www.youtube.com/').searchParams.get('v');
    if (currentVideo && msg.payload?.videoId && currentVideo !== msg.payload.videoId) return;
    chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }).catch(() => {});
    return;
  }
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
    let origin, hostPattern;
    try {
      origin = new URL(msg.url).origin;
      hostPattern = LT.Settings.hostPattern(msg.url);
    } catch (_) {
      send({ type: 'error', message: '接口地址无效' });
      return;
    }
    try {
      const allowed = await chrome.permissions.contains({ origins: [hostPattern] });
      if (!allowed) {
        send({ type: 'error', message: `浏览器未授权访问 ${origin}，请在扩展设置里点「授权访问该域名」` });
        return;
      }
      // 方法跟着请求走：翻译是 POST，设置页查模型信息是 GET（不能带正文）
      const method = typeof msg.method === 'string' && msg.method ? msg.method.toUpperCase() : 'POST';
      const res = await fetch(msg.url, {
        method,
        headers: msg.headers || {},
        body: method === 'GET' || method === 'HEAD' ? undefined : msg.body,
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
