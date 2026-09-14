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

    /** 当前视频的字幕轨列表：{ videoId, defaultIndex, tracks[] }。 */
    captionTracks() {
      return this.request(LT.BRIDGE.KIND_TRACKS, undefined, 3000);
    },

    /** 读一条字幕轨的 json3 文本。页面桥可能要触发播放器加载并等待，超时给长一点。 */
    fetchCaptions(track) {
      return this.request(LT.BRIDGE.KIND_CAPTIONS, track, 25000);
    },

    /**
     * 选字幕轨：指定源语言时先人工轨再自动轨；自动检测时用播放器默认轨，
     * 其次第一条人工轨、第一条自动轨。自动翻译出来的轨不在列表里，不会被选到。
     */
    chooseTrack(tracks, sourceLang, defaultIndex = -1) {
      if (!Array.isArray(tracks) || tracks.length === 0) return null;
      const base = (code) => String(code || '').toLowerCase().split('-')[0];
      const human = tracks.filter((t) => t.kind !== 'asr');
      const asr = tracks.filter((t) => t.kind === 'asr');
      if (sourceLang && sourceLang !== 'auto') {
        const want = base(sourceLang);
        return (
          human.find((t) => base(t.languageCode) === want) ||
          asr.find((t) => base(t.languageCode) === want) ||
          null
        );
      }
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
