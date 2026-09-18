/**
 * 页面桥，跑在 MAIN world（和 YouTube 自己的脚本同一个 JS 环境）。
 *
 * 两件事：
 * 1. 把播放器的结构化元数据递给内容脚本。走 movie_player.getPlayerResponse() 而不是解析 DOM，
 *    也不用 ytInitialPlayerResponse：比 DOM 稳，SPA 切视频后 getPlayerResponse() 永远是当前视频。
 * 2. 读取字幕轨。YouTube 的 /api/timedtext 从 2025 年起要带 pot 等校验参数，直接拿 baseUrl 请求
 *    会返回 200 但正文为空。所以这里在 document_start 包住 fetch / XHR，记住播放器自己发出的
 *    字幕请求和响应：优先复用现成的正文；没有就用完整 URL 改 fmt=json3 补取一次；再没有就
 *    临时打开目标字幕轨让播放器去加载，拿到后恢复用户原来的 CC 状态。
 *
 * 这里不能用 chrome.* API（MAIN world 没有扩展 API），只能 window.postMessage。
 * 消息名和请求种类要和 src/common/constants.js 里的 LT.BRIDGE 对上。
 */
(() => {
  const TAG = 'lt-bridge';
  const nativeFetch = window.fetch;

  // ---------- 元数据 ----------

  function playerResponse() {
    let response = null;
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        response = player.getPlayerResponse();
      }
    } catch (_) {
      /* 播放器还没初始化 */
    }
    if (!response || !response.videoDetails) {
      response = window.ytInitialPlayerResponse || null;
    }
    return response && response.videoDetails ? response : null;
  }

  function read() {
    const response = playerResponse();
    if (!response) return null;
    const d = response.videoDetails;
    const micro =
      response.microformat && response.microformat.playerMicroformatRenderer;
    return {
      videoId: d.videoId || '',
      title: d.title || '',
      author: d.author || '',
      description: d.shortDescription || '',
      keywords: Array.isArray(d.keywords) ? d.keywords : [],
      isLive: !!(d.isLive || d.isLiveNow),
      isLiveContent: !!d.isLiveContent,
      lengthSeconds: Number(d.lengthSeconds || 0),
      category: (micro && micro.category) || '',
    };
  }

  // ---------- 字幕轨列表 ----------

  function trackName(t) {
    if (!t || !t.name) return '';
    if (t.name.simpleText) return t.name.simpleText;
    if (Array.isArray(t.name.runs)) return t.name.runs.map((r) => r.text || '').join('');
    return '';
  }

  function tracks() {
    const response = playerResponse();
    if (!response) return null;
    const renderer =
      response.captions && response.captions.playerCaptionsTracklistRenderer;
    const list = (renderer && renderer.captionTracks) || [];
    let defaultIndex = -1;
    const audio = renderer && Array.isArray(renderer.audioTracks) ? renderer.audioTracks[0] : null;
    if (audio && typeof audio.defaultCaptionTrackIndex === 'number') defaultIndex = audio.defaultCaptionTrackIndex;
    return {
      videoId: response.videoDetails.videoId || '',
      defaultIndex,
      tracks: list.map((t) => ({
        languageCode: t.languageCode || '',
        kind: t.kind || '',
        vssId: t.vssId || '',
        name: trackName(t),
        baseUrl: t.baseUrl || '',
      })),
    };
  }

  // ---------- 拦截播放器自己的字幕请求 ----------

  const captured = []; // 最近的字幕请求，新的在前：{ url, v, lang, kind, tlang, body, at }
  const selfUrls = new Set(); // 我们自己补取用的 URL，不能再被记一遍，否则会循环

  function inspectUrl(input) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (!raw || raw.indexOf('/api/timedtext') === -1) return null;
      const url = new URL(raw, location.href);
      if (url.pathname !== '/api/timedtext') return null;
      const p = url.searchParams;
      return {
        url: url.toString(),
        v: p.get('v') || '',
        lang: p.get('lang') || '',
        kind: p.get('kind') || '',
        tlang: p.get('tlang') || '',
      };
    } catch (_) {
      return null;
    }
  }

  function remember(info, body) {
    if (!info || selfUrls.has(info.url)) return;
    info.body = typeof body === 'string' ? body : '';
    info.at = Date.now();
    captured.unshift(info);
    if (captured.length > 12) captured.length = 12;
  }

  if (typeof nativeFetch === 'function') {
    window.fetch = function (input) {
      const result = nativeFetch.apply(window, arguments);
      const info = inspectUrl(input);
      if (info && !selfUrls.has(info.url) && result && typeof result.then === 'function') {
        result
          .then((res) => {
            if (!res || !res.ok || typeof res.clone !== 'function') return;
            res
              .clone()
              .text()
              .then((body) => remember(info, body))
              .catch(() => {});
          })
          .catch(() => {});
      }
      return result;
    };
  }

  if (window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    proto.open = function (method, url) {
      try {
        this.__ltTimedtext = inspectUrl(String(url));
      } catch (_) {
        this.__ltTimedtext = null;
      }
      return nativeOpen.apply(this, arguments);
    };
    proto.send = function () {
      const info = this.__ltTimedtext;
      if (info && !selfUrls.has(info.url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status !== 200) return;
            const type = this.responseType;
            let body = '';
            if (!type || type === 'text') body = this.responseText;
            else if (type === 'json' && this.response) body = JSON.stringify(this.response);
            remember(info, body);
          } catch (_) {
            /* 读不到正文就只记 URL，后面靠补取 */
          }
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // ---------- 读取一条字幕轨 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isJson = (body) => {
    try {
      const data = JSON.parse(body);
      return Array.isArray(data.events) && data.events.some(e =>
        e && Array.isArray(e.segs) && e.segs.some(s => s && typeof s.utf8 === 'string' && s.utf8.trim()));
    } catch (_) {
      return false;
    }
  };
  const onVideo = (videoId) => {
    const url = new URL(location.href);
    const id = url.pathname.startsWith('/live/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
    return id === videoId;
  };
  const sameTrack = (c, want) =>
    c.v === want.videoId && c.lang === want.languageCode && (c.kind || '') === (want.kind || '') && !c.tlang;

  /** 签名参数（sparams）不含 lang / kind / fmt，所以同一视频的请求可以换轨道复用。 */
  function withTrack(url, want) {
    const u = new URL(url, location.href);
    u.searchParams.set('lang', want.languageCode);
    if (want.kind) u.searchParams.set('kind', want.kind);
    else u.searchParams.delete('kind');
    u.searchParams.delete('tlang');
    u.searchParams.set('fmt', 'json3');
    return u.toString();
  }

  async function fetchJson3(url) {
    selfUrls.add(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await nativeFetch.call(window, url, { credentials: 'include', signal: controller.signal });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const text = await res.text();
      return isJson(text) ? { text } : { error: text.trim() ? 'NOT_JSON' : 'EMPTY' };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
      setTimeout(() => selfUrls.delete(url), 60000);
    }
  }

  /** 让播放器自己去加载目标轨道，从而拿到带校验参数的请求；返回恢复函数。 */
  function triggerTrack(want) {
    const player = document.getElementById('movie_player');
    const noop = () => {};
    if (!player || typeof player.setOption !== 'function') return noop;
    let prev = null;
    let wasOn = false;
    try {
      prev = player.getOption('captions', 'track');
    } catch (_) {
      /* 模块没加载 */
    }
    try {
      wasOn =
        typeof player.isSubtitlesOn === 'function'
          ? !!player.isSubtitlesOn()
          : !!(prev && prev.languageCode);
    } catch (_) {
      wasOn = !!(prev && prev.languageCode);
    }
    try {
      if (typeof player.loadModule === 'function') player.loadModule('captions');
    } catch (_) {
      /* 已加载 */
    }
    let target = { languageCode: want.languageCode };
    try {
      const list = player.getOption('captions', 'tracklist') || [];
      const hit = list.find(
        (t) => t && t.languageCode === want.languageCode && (t.kind || '') === (want.kind || '')
      );
      if (hit) target = hit;
      else if (want.vssId) target = { languageCode: want.languageCode, vssId: want.vssId, kind: want.kind || undefined };
    } catch (_) {
      /* 用最简形式 */
    }
    try {
      player.setOption('captions', 'track', target);
    } catch (_) {
      return noop;
    }
    return () => {
      // YouTube 经常复用同一个播放器节点，不能恢复到新视频上。
      if (!onVideo(want.videoId) || document.getElementById('movie_player') !== player) return;
      try {
        if (!wasOn) {
          if (typeof player.unloadModule === 'function') player.unloadModule('captions');
        } else if (
          prev &&
          prev.languageCode &&
          (prev.languageCode !== want.languageCode || (prev.kind || '') !== (want.kind || ''))
        ) {
          player.setOption('captions', 'track', prev);
        }
      } catch (_) {
        /* 恢复失败不影响读取结果 */
      }
    };
  }

  /**
   * @param {{videoId:string, languageCode:string, kind:string, vssId?:string, baseUrl?:string}} want
   * @returns {Promise<{text?:string, source?:string, error?:string}>}
   */
  async function captions(want) {
    if (!want || !want.videoId || !want.languageCode) return { error: '缺少字幕轨参数' };
    const current = () => onVideo(want.videoId);
    const switched = () => ({ error: '视频已切换，已停止读取旧字幕' });
    if (!current()) return switched();

    // 1. 播放器已经取到的正文
    const ready = captured.find((c) => sameTrack(c, want) && isJson(c.body));
    if (ready) return { text: ready.body, source: 'captured' };

    // 2. 有该轨道的完整 URL，但正文不是 json3（XML）或没读到：改格式补取
    const known = captured.find((c) => sameTrack(c, want));
    if (known) {
      const r = await fetchJson3(withTrack(known.url, want));
      if (!current()) return switched();
      if (r.text) return { text: r.text, source: 'refetch' };
    }

    // 3. 触发播放器加载该轨道，等拦截到请求
    const restore = triggerTrack(want);
    let hit = null;
    try {
      for (let i = 0; i < 40 && !hit; i++) {
        await sleep(200);
        if (!current()) return switched();
        hit = captured.find((c) => sameTrack(c, want));
      }
    } finally {
      restore();
    }
    if (hit) {
      if (isJson(hit.body)) return { text: hit.body, source: 'triggered' };
      const r = await fetchJson3(withTrack(hit.url, want));
      if (!current()) return switched();
      if (r.text) return { text: r.text, source: 'triggered-refetch' };
    }

    // 4. 同一视频其他轨道（包括自动翻译轨）的请求：换轨道参数复用
    const sibling = captured.find((c) => c.v === want.videoId);
    if (sibling) {
      const r = await fetchJson3(withTrack(sibling.url, want));
      if (!current()) return switched();
      if (r.text) return { text: r.text, source: 'sibling' };
    }

    // 5. 最后试 baseUrl；缺 pot 参数时多半返回空
    if (want.baseUrl) {
      const r = await fetchJson3(withTrack(want.baseUrl, want));
      if (!current()) return switched();
      if (r.text) return { text: r.text, source: 'baseUrl' };
      return { error: `字幕接口返回 ${r.error || 'EMPTY'}，可能是 YouTube 校验方式变了；先在播放器里手动打开一次 CC 再试` };
    }
    return { error: '没有拿到播放器的字幕请求' };
  }

  // ---------- 消息 ----------

  function post(id, payload) {
    window.postMessage({ __lt: TAG, dir: 'meta', id, payload }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__lt !== TAG || msg.dir !== 'req') return;
    const kind = msg.kind || 'meta';
    if (kind === 'meta') {
      post(msg.id, read());
    } else if (kind === 'tracks') {
      post(msg.id, tracks());
    } else if (kind === 'captions') {
      captions(msg.args || {}).then(
        (r) => post(msg.id, r),
        (err) => post(msg.id, { error: String((err && err.message) || err) })
      );
    }
  });

  // SPA 切视频后主动推一次，内容脚本不用轮询
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => post(0, read()), 300);
  });
})();
