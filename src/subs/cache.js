/**
 * 整片字幕缓存：chrome.storage.local，配合 unlimitedStorage。
 *
 * 键：
 *   列表直接从每个视频的元信息生成，避免多标签页同时更新共享索引而丢项。
 *   vs:m:<videoId>                 元信息：轨道、目标语言、配置指纹、分块边界、是否完整
 *   vs:s:<videoId>:<trackKey>      原文单元（时间轴 + 原文），续翻和双语显示都用它，不必再读 YouTube
 *   vs:c:<videoId>:<fp>:<i>        第 i 块的译文数组，块完整校验通过才写；按块独立写入，并发不会互相覆盖
 *
 * 指纹 fp 覆盖轨道、目标语言、模型与提示词：配置变了就是另一份译文，不会混用。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const store = () => chrome.storage.local;

  function fingerprint(parts) {
    const s = JSON.stringify(parts);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    let g = 2166136261;
    for (let i = 0; i < s.length; i++) g = Math.imul(g ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0');
  }

  const metaKey = (videoId) => `vs:m:${videoId}`;
  const sourceKey = (videoId, trackKey) => `vs:s:${videoId}:${trackKey}`;
  const chunkKey = (videoId, fp, i) => `vs:c:${videoId}:${fp}:${i}`;

  async function getOne(key) {
    const box = await store().get(key);
    return box[key];
  }

  const SubsCache = {
    fingerprint,

    getMeta: (videoId) => getOne(metaKey(videoId)),

    async setMeta(meta) {
      await store().set({ [metaKey(meta.videoId)]: meta });
    },

    getSource: (videoId, trackKey) => getOne(sourceKey(videoId, trackKey)),

    setSource(videoId, trackKey, source) {
      return store().set({ [sourceKey(videoId, trackKey)]: source });
    },

    /** 按块读回译文，缺的块是 undefined。 */
    async getChunks(videoId, fp, count) {
      const keys = [];
      for (let i = 0; i < count; i++) keys.push(chunkKey(videoId, fp, i));
      const box = await store().get(keys);
      return keys.map((k) => box[k]);
    },

    setChunk(videoId, fp, i, texts) {
      return store().set({ [chunkKey(videoId, fp, i)]: texts });
    },

    async listIndex() {
      const all = await store().get(null);
      return Object.fromEntries(Object.entries(all)
        .filter(([key, value]) => key.startsWith('vs:m:') && value && value.videoId === key.slice(5))
        .map(([key, value]) => [key.slice(5), value]));
    },

    async keysOf(videoId) {
      const all = await store().get(null);
      const mid = `:${videoId}:`;
      return Object.keys(all).filter((k) => k === metaKey(videoId) || (k.startsWith('vs:') && k.includes(mid)));
    },

    /** 只删译文块，保留原文与元信息；重新翻译前调用。 */
    async removeChunks(videoId) {
      const keys = (await this.keysOf(videoId)).filter((k) => k.startsWith(`vs:c:${videoId}:`));
      if (keys.length) await store().remove(keys);
    },

    async removeVideo(videoId) {
      const keys = await this.keysOf(videoId);
      if (keys.length) await store().remove(keys);
    },

    async clearAll() {
      const all = await store().get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('vs:'));
      if (keys.length) await store().remove(keys);
    },

    async bytesInUse() {
      const all = await store().get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('vs:'));
      if (keys.length === 0) return 0;
      if (typeof store().getBytesInUse === 'function') return store().getBytesInUse(keys);
      return keys.reduce((n, k) => n + JSON.stringify(all[k]).length, 0);
    },
  };

  LT.SubsCache = SubsCache;
})();
