/** YouTube 页面适配：只依赖 #movie_player 和 video 这两个多年没变的选择器。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  const TAG = 'lt-bridge';

  let reqSeq = 1;
  const waiting = new Map(); // requestId → resolve
  const pushHandlers = [];

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__lt !== TAG || msg.dir !== 'meta') return;
    if (msg.id === 0) {
      pushHandlers.forEach((fn) => fn(msg.payload));
      return;
    }
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg.payload);
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = (code) => String(code || '').toLowerCase().split('-')[0];

  /** 把播放器当前选中的轨道对到列表里的一条：先按 vssId，再按语言加类型，最后只按语言。 */
  function matchSelected(tracks, selected) {
    if (!selected || !selected.languageCode) return null;
    if (selected.vssId) {
      const hit = tracks.find((t) => t.vssId && t.vssId === selected.vssId);
      if (hit) return hit;
    }
    return (
      tracks.find((t) => t.languageCode === selected.languageCode && (t.kind || '') === (selected.kind || '')) ||
      tracks.find((t) => t.languageCode === selected.languageCode) ||
      null
    );
  }

  LT.YouTube = {
    player() {
      return document.getElementById('movie_player');
    },

    video() {
      const p = this.player();
      return p ? p.querySelector('video') : document.querySelector('video');
    },

    isWatchPage() {
      return location.pathname === '/watch' || location.pathname.startsWith('/live/');
    },

    videoIdFromUrl() {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/live/')) return url.pathname.split('/')[2] || '';
      return url.searchParams.get('v') || '';
    },

    adShowing() {
      const p = this.player();
      if (!p) return false;
      return (
        p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')
      );
    },

    /** 向 MAIN world 发一次请求；kind 见 LT.BRIDGE.KIND_*。超时或播放器没就绪返回 null。 */
    request(kind, args, timeoutMs = 1500) {
      return new Promise((resolve) => {
        const id = reqSeq++;
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(null);
        }, timeoutMs);
        waiting.set(id, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
        window.postMessage({ __lt: TAG, dir: 'req', id, kind, args }, '*');
      });
    },

    /** 向 MAIN world 要一次元数据；播放器没就绪会返回 null。 */
    requestMeta(timeoutMs = 1500) {
      return this.request(LT.BRIDGE.KIND_META, undefined, timeoutMs);
    },

    /** 当前视频的字幕轨列表：{ videoId, defaultIndex, selected, hasPot, tracks[] }。 */
    captionTracks() {
      return this.request(LT.BRIDGE.KIND_TRACKS, undefined, 3000);
    },

    /**
     * 读一条字幕轨的 json3 文本：{ text, source, tried } 或 { error, tried }。
     * 页面桥自己有 20 秒的截止时间，这里再留一点余量；超时返回 null。
     */
    fetchCaptions(track) {
      return this.request(LT.BRIDGE.KIND_CAPTIONS, track, 25000);
    },

    /** 让页面桥放弃正在进行的读取并恢复 CC（取消、换视频时调用），不等回复。 */
    cancelCaptions() {
      window.postMessage({ __lt: TAG, dir: 'req', id: reqSeq++, kind: LT.BRIDGE.KIND_CANCEL }, '*');
    },

    /**
     * 选字幕轨。
     * - 指定源语言：同语言里先人工轨再自动轨；播放器里当前选中的轨道如果也是这个语言，优先用它。
     * - 自动检测：播放器当前选中的轨 > 播放器默认轨 > 第一条人工轨 > 第一条自动轨。
     * 自动翻译出来的轨不在列表里，不会被选到；selected 若是自动翻译轨，只按它的原语言匹配。
     */
    chooseTrack(tracks, sourceLang, defaultIndex = -1, selected = null) {
      if (!Array.isArray(tracks) || tracks.length === 0) return null;
      const human = tracks.filter((t) => t.kind !== 'asr');
      const asr = tracks.filter((t) => t.kind === 'asr');
      const picked = matchSelected(tracks, selected);
      if (sourceLang && sourceLang !== 'auto') {
        const want = base(sourceLang);
        if (picked && base(picked.languageCode) === want) return picked;
        return (
          human.find((t) => base(t.languageCode) === want) ||
          asr.find((t) => base(t.languageCode) === want) ||
          null
        );
      }
      if (picked) return picked;
      if (defaultIndex >= 0 && tracks[defaultIndex]) return tracks[defaultIndex];
      return human[0] || asr[0] || null;
    },

    /** 播放器初始化有延迟，轮询几次直到拿到当前视频的元数据。 */
    async waitForMeta({ videoId = '', tries = 12, gapMs = 500 } = {}) {
      for (let i = 0; i < tries; i++) {
        const meta = await this.requestMeta();
        if (meta && meta.videoId && (!videoId || meta.videoId === videoId)) return meta;
        await sleep(gapMs);
      }
      return null;
    },

    /** MAIN world 在 yt-navigate-finish 之后推过来的元数据。 */
    onMetaPush(fn) {
      pushHandlers.push(fn);
    },

    /** SPA 导航。yt-navigate-finish 是 YouTube 自己派发的，比 popstate 可靠。 */
    onNavigate(fn) {
      let last = location.href;
      const fire = () => {
        if (location.href === last) return;
        last = location.href;
        fn();
      };
      document.addEventListener('yt-navigate-finish', () => setTimeout(fire, 60));
      // 兜底：极少数跳转不派发 yt-navigate-finish
      setInterval(fire, 1500);
    },

    /** 等待 <video> 元素出现（换视频时 YouTube 有时会重建它）。 */
    async waitForVideo(tries = 20, gapMs = 300) {
      for (let i = 0; i < tries; i++) {
        const v = this.video();
        if (v) return v;
        await sleep(gapMs);
      }
      return null;
    },
  };
})();
