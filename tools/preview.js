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
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        set: async (obj) => { Object.assign(store, clone(obj)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
        getBytesInUse: async () => 123456,
      },
    },
    permissions: { contains: async () => false, request: async () => true },
    tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
    runtime: {
      getManifest: () => ({ version: '0.2.0-preview' }),
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
    .replace(/href="\.\.\/(content|common|subs)\//g, 'href="../../src/$1/')
    .replace(/src="\.\.\/(content|common|subs)\//g, 'src="../../src/$1/')
    .replace(/src="(options[^"]*\.js)"/g, 'src="../../src/ui/$1"')
    .replace('<script src=', '<script src="chrome-stub.js"></script>\n    <script src=');
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'chrome-stub.js'), STUB);
fs.writeFileSync(path.join(OUT, 'options.html'), rewrite(fs.readFileSync(path.join(ROOT, 'src/ui/options.html'), 'utf8')));
console.log(`已生成 ${path.relative(ROOT, path.join(OUT, 'options.html'))}`);
