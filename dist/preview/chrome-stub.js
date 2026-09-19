// 离线预览用的 chrome.* 替身，只在 dist/preview 里存在
(() => {
  const store = {};
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
      getManifest: () => ({ version: '0.2.0' }),
      connect: () => { throw new Error('预览里没有后台'); },
      openOptionsPage() {},
    },
  };
})();
