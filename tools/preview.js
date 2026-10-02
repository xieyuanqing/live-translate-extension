/**
 * 生成设置页的离线预览：把 src/ui/options.html 复制到 dist/preview/，路径改成指向 src/，
 * 并在最前面注入一个 chrome.* 替身（内存存储、假权限、假标签页）。
 * 用浏览器直接打开 dist/preview/options.html 就能看布局、点控件；不发网络请求，也不进扩展包。
 *
 *   node tools/preview.js
 *   然后打开 dist/preview/options.html#style（或用无头 Chrome 截图）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'preview');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

const STUB = `// 离线预览用的 chrome.* 替身，只在 dist/preview 里存在
(() => {
  const store = {
    settings: {
      apiKeys: '',
      manualContext: 'ホロライブ 相关名字统一用官方中文译名。',
      providers: [
        { id: 'p-default', name: '', apiType: 'gemini', baseUrl: '', apiKey: '', model: 'gemini-x-flash', concurrency: 3, requestPath: 'auto' },
        { id: 'p-local', name: '本地网关', apiType: 'openai', baseUrl: 'http://127.0.0.1:23000/v1', apiKey: 'sk-preview', model: 'local-model', concurrency: 2, requestPath: 'relay' },
      ],
      subsProviderId: 'p-default',
      captionDisplayMode: 'bilingual',
    },
    'vs:m:preview01': { videoId: 'preview01', title: '【歌回】示例视频标题', trackLabel: '日本語（自动字幕）', targetLang: 'zh', complete: true, unitCount: 1234, model: 'gemini-x-flash', updatedAt: Date.now() },
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const storageListeners = [];
  window.chrome = {
    storage: {
      onChanged: { addListener: listener => storageListeners.push(listener) },
      local: {
        get: async (keys) => {
          const out = {};
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const [key, value] of Object.entries(obj)) {
            changes[key] = { oldValue: store[key] === undefined ? undefined : clone(store[key]), newValue: clone(value) };
            store[key] = clone(value);
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
        getBytesInUse: async () => 123456,
      },
    },
    permissions: { contains: async () => false, request: async () => true },
    tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
    runtime: {
      getManifest: () => ({ version: '${VERSION}-preview' }),
      getURL: file => '../../' + file,
      connect: () => { throw new Error('预览里没有后台'); },
      openOptionsPage() {},
    },
  };
})();
`;

function rewrite(html) {
  return html
    .replace(/href="ui\.css"/g, 'href="../../src/ui/ui.css"')
    .replace(/href="options\.css"/g, 'href="../../src/ui/options.css"')
    .replace(/href="popup\.css"/g, 'href="../../src/ui/popup.css"')
    .replace(/href="\.\.\/(content|common|subs)\//g, 'href="../../src/$1/')
    .replace(/src="\.\.\/(content|common|subs)\//g, 'src="../../src/$1/')
    .replace(/src="((?:options|popup|theme)[^"]*\.js)"/g, 'src="../../src/ui/$1"')
    .replace('<script src=', '<script src="chrome-stub.js"></script>\n    <script src=');
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'chrome-stub.js'), STUB);
fs.writeFileSync(path.join(OUT, 'options.html'), rewrite(fs.readFileSync(path.join(ROOT, 'src/ui/options.html'), 'utf8')));
// 真实 popup 控件的离线交互预览；示例数据不进入运行包，也不访问模型。
const POPUP_STUB = `(() => {
  let revision = 0, running = false, review = null, tempContext = '';
  const previewMode = new URL(location.href).searchParams.get('mode') || 'live';
  let videoPhase = 'idle', videoVisible = true;
  const generated = { background: '示例频道的生日直播。', phrases: { '示例频道': '示例频道', 'ゆに': 'YuNi' } };
  const makeReview = (provider) => ({ provider, phase: 'preview', contextStatus: 'generated', generatorModel: 'offline-preview', generated,
    generatorRequest: { system: '优先保留主播名，候选术语最多 12 对。', user: '离线示例页面资料' },
    prompt: '你是实时语音翻译引擎。\\n只输出中文译文，保留说话主体和专名。\\n候选术语：ゆに＝YuNi',
    translation: { language: 'zh', corpus: { phrases: generated.phrases } } });
  chrome.tabs.query = async () => previewMode === 'none' ? [] : [{ id: 1, url: 'https://www.youtube.com/watch?v=preview01' }];
  chrome.tabs.sendMessage = async (_, msg) => {
    const provider = new URL(location.href).searchParams.get('provider') === 'gemini' ? 'gemini' : 'qwen';
    if (msg.type === 'lt:preview-live-context') { review = makeReview(provider); revision++; return { ok: true, review }; }
    if (msg.type === 'lt:query-live-context') return { review };
    if (msg.type === 'lt:start') { running = true; if (!review) review = makeReview(provider); review.phase = 'session'; revision++; }
    if (msg.type === 'lt:stop') running = false;
    if (msg.type === 'lt:set-temp-context') tempContext = msg.payload;
    if (msg.type === 'lt:vs-start') videoPhase = 'translating';
    if (msg.type === 'lt:vs-cancel') videoPhase = 'partial';
    if (msg.type === 'lt:vs-set-visible') videoVisible = msg.payload;
    if (msg.type === 'lt:query-text-status') {
      const settings = LT.Settings.normalize((await chrome.storage.local.get('settings')).settings);
      return { comments: { enabled: settings.enableCommentTranslation, busy: false, pending: 0, translated: 0, error: '' },
        chat: { enabled: settings.enableChatTranslation, phase: 'waiting', translated: 0, error: '离线预览不运行 Chrome 翻译' } };
    }
    if (msg.type === 'lt:translate-visible-comments') return { ok: true, count: 0 };
    if (msg.type === 'lt:cancel-comment-translation') return { ok: true };
    if (msg.type === 'lt:query-status') return { onWatchPage: true, isLive: previewMode !== 'video', videoId: 'preview01', title: previewMode === 'video' ? '离线预览 · 歌回录像' : '离线预览 · 生日直播',
      phase: running ? 'running' : 'idle', conn: running ? 'ready' : '', elapsedMs: running ? 123000 : 0, level: 20,
      error: previewMode === 'error' ? '连接失败，请检查接口配置后重试。' : '',
      liveProvider: provider, contextStatus: running ? review?.contextStatus || '' : '',
      generatedTerms: running ? Object.keys(review?.generated?.phrases || {}).length : 0,
      tempContext, liveReviewRevision: revision, previewBusy: false, video: { phase: videoPhase, done: 4, total: 12, frontierIdx: 3, frontierMs: 130000, visible: videoVisible } };
  };
})();`;
fs.writeFileSync(path.join(OUT, 'popup-stub.js'), POPUP_STUB);
fs.writeFileSync(path.join(OUT, 'popup.html'), rewrite(fs.readFileSync(path.join(ROOT, 'src/ui/popup.html'), 'utf8'))
  .replace('<script src="chrome-stub.js"></script>', '<script src="chrome-stub.js"></script>\n    <script src="popup-stub.js"></script>'));
console.log(`已生成 ${path.relative(ROOT, path.join(OUT, 'options.html'))}`);
