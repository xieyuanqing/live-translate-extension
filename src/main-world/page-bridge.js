/**
 * 页面桥，跑在 MAIN world（和 YouTube 自己的脚本同一个 JS 环境）。
 *
 * 两件事：
 * 1. 把播放器的结构化元数据递给内容脚本。走 movie_player.getPlayerResponse() 而不是解析 DOM，
 *    也不用 ytInitialPlayerResponse：比 DOM 稳，SPA 切视频后 getPlayerResponse() 永远是当前视频。
 * 2. 读取字幕轨。YouTube 的 /api/timedtext 从 2025 年起要带 pot 等校验参数，直接拿 baseUrl 请求
 *    会返回 200 但正文为空。这里按「先不打扰播放器，再触发播放器」的顺序找一个带校验参数的 URL：
 *    拦截到的请求正文 → 拦截到的 URL 改 fmt=json3 补取 → 播放器 getAudioTrack() 里带 pot 的轨道 URL
 *    → 用任意来源的 pot 加 baseUrl 自己拼 → 同视频其他轨道的请求换轨 → 临时打开 CC 让播放器去加载
 *    → 最后直接请求 baseUrl（几乎必然为空，留作诊断对照）。
 *    整个读取有统一的截止时间，每个候选 URL 只请求一次，取消或换视频后立即停止并恢复 CC。
 *    每一步都记进 tried，成功失败都随结果返回，真机排查靠它。
 *
 * 这里不能用 chrome.* API（MAIN world 没有扩展 API），只能 window.postMessage。
 * 消息名和请求种类要和 src/common/constants.js 里的 LT.BRIDGE 对上。
 */
(() => {
  const TAG = 'lt-bridge';
  const nativeFetch = window.fetch;
  const POLL_MS = 200; // 触发播放器后检查状态的间隔
  const POLL_UNTIL_MS = 12000; // 触发播放器后最多等这么久
  const HARD_DEADLINE_MS = 20000; // 整个读取的上限；内容脚本那边等 25 秒，要留出最后一次请求的余量
  const FETCH_TIMEOUT_MS = 3500; // 单次补取的上限
  const SELECT_AFTER_MS = 3000; // 开 CC 后这么久还没动静，再用 setOption 指定轨道
  const noop = () => {};
  const player = () => document.getElementById('movie_player');

  // ---------- 元数据 ----------

  function playerResponse() {
    let response = null;
    try {
      const p = player();
      if (p && typeof p.getPlayerResponse === 'function') {
        response = p.getPlayerResponse();
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

  function absolute(url) {
    try {
      return url ? new URL(url, location.href).toString() : '';
    } catch (_) {
      return url || '';
    }
  }

  /** 播放器当前选中的字幕轨（用户在播放器里手动选过的）；模块没加载或没选时返回 null。 */
  function selectedTrack() {
    try {
      const p = player();
      const t = p && typeof p.getOption === 'function' ? p.getOption('captions', 'track') : null;
      if (!t || !t.languageCode) return null;
      return {
        languageCode: t.languageCode || '',
        kind: t.kind || '',
        vssId: t.vssId || '',
        translated: !!t.translationLanguage, // 自动翻译轨：只能当作「用户选了这个原语言」的线索
      };
    } catch (_) {
      return null;
    }
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
    const videoId = response.videoDetails.videoId || '';
    return {
      videoId,
      defaultIndex,
      selected: selectedTrack(),
      hasPot: !!pagePot(videoId),
      tracks: list.map((t) => ({
        languageCode: t.languageCode || '',
        kind: t.kind || '',
        vssId: t.vssId || '',
        name: trackName(t),
        baseUrl: absolute(t.baseUrl || ''),
      })),
    };
  }

  // ---------- 拦截播放器自己的字幕请求 ----------

  const captured = []; // 最近的字幕请求，新的在前：{ url, v, lang, kind, tlang, body, at }
  const selfUrls = new Set(); // 我们自己补取用的 URL，不能再被记一遍，否则会循环
  let captureSeq = 0; // 每记一条加一；触发播放器后只在它变化时重跑候选

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
    captureSeq++;
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

  // ---------- 候选 URL 的来源 ----------

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
  const sameWant = (t, want) =>
    t.vssId && want.vssId
      ? t.vssId === want.vssId
      : t.languageCode === want.languageCode && (t.kind || '') === (want.kind || '');

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

  function potOf(url) {
    try {
      const p = new URL(url, location.href).searchParams;
      const pot = p.get('pot');
      return pot ? { pot, potc: p.get('potc') || '' } : null;
    } catch (_) {
      return null;
    }
  }

  /** 播放器音轨对象里的字幕轨 URL，一般自带 pot；播放器没就绪或没有就返回空数组。 */
  function audioTrackUrls() {
    try {
      const p = player();
      if (!p || typeof p.getAudioTrack !== 'function') return [];
      const audio = p.getAudioTrack();
      const list = audio && Array.isArray(audio.captionTracks) ? audio.captionTracks : [];
      const out = [];
      for (const t of list) {
        if (!t || typeof t.url !== 'string' || !t.url) continue;
        let languageCode = t.languageCode || '';
        if (!languageCode) {
          try {
            languageCode = new URL(t.url, location.href).searchParams.get('lang') || '';
          } catch (_) {
            /* 解析不了的 URL 照样保留，只当 pot 来源 */
          }
        }
        out.push({ url: t.url, languageCode, kind: t.kind || '', vssId: t.vssId || '' });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  /** pot 与轨道无关，可以跨轨道复用：先找播放器音轨 URL，再找拦截到的请求（优先同一视频）。 */
  function pagePot(videoId) {
    for (const t of audioTrackUrls()) {
      const r = potOf(t.url);
      if (r) return Object.assign(r, { from: 'audiotrack' });
    }
    const list = captured.filter((c) => c.v === videoId).concat(captured.filter((c) => c.v !== videoId));
    for (const c of list) {
      const r = potOf(c.url);
      if (r) return Object.assign(r, { from: c.v === videoId ? 'captured' : 'captured-other' });
    }
    return null;
  }

  /** 按 read-frog 真机验证过的参数组合，用轨道自己的 baseUrl 拼一个带 pot 的完整 URL。 */
  function composeUrl(baseUrl, pot) {
    const u = new URL(baseUrl, location.href);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.delete('tlang');
    const fixed = { c: 'WEB', cplayer: 'UNIPLAYER', xorb: '2', xobt: '3', xovt: '3' };
    for (const k of Object.keys(fixed)) u.searchParams.set(k, fixed[k]);
    try {
      const device = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('DEVICE') : '';
      if (device) {
        const d = new URLSearchParams(String(device));
        for (const k of ['cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform']) {
          const v = d.get(k);
          if (v) u.searchParams.set(k, v);
        }
      }
    } catch (_) {
      /* 没有 ytcfg 就不带设备参数 */
    }
    try {
      const p = player();
      const cfg = p && typeof p.getWebPlayerContextConfig === 'function' ? p.getWebPlayerContextConfig() : null;
      if (cfg && cfg.innertubeContextClientVersion) u.searchParams.set('cver', String(cfg.innertubeContextClientVersion));
    } catch (_) {
      /* 同上 */
    }
    u.searchParams.set('pot', pot.pot);
    if (pot.potc) u.searchParams.set('potc', pot.potc);
    return u.toString();
  }

  async function fetchJson3(url, timeoutMs) {
    selfUrls.add(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    try {
      const res = await nativeFetch.call(window, url, { credentials: 'include', signal: controller.signal });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const text = await res.text();
      return isJson(text) ? { text } : { error: text.trim() ? 'NOT_JSON' : 'EMPTY' };
    } catch (err) {
      return { error: controller.signal.aborted ? 'TIMEOUT' : String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
      setTimeout(() => selfUrls.delete(url), 60000);
    }
  }

  // ---------- 触发播放器加载字幕 ----------

  /** CC 开关状态：优先看播放器按钮，其次问播放器；都拿不到返回 null。 */
  function ccState() {
    try {
      const button = document.querySelector('.ytp-subtitles-button');
      if (button) {
        const v = button.getAttribute('aria-pressed');
        if (v === 'true' || v === 'false') return v === 'true';
      }
    } catch (_) {
      /* 没有按钮 */
    }
    try {
      const p = player();
      if (p && typeof p.isSubtitlesOn === 'function') return !!p.isSubtitlesOn();
    } catch (_) {
      /* 模块没加载 */
    }
    return null;
  }

  /** 触发期间把原生字幕藏起来，免得闪一下；返回撤销函数。 */
  function hideNativeCaptions() {
    let style = null;
    try {
      style = document.createElement('style');
      style.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
      (document.head || document.documentElement).appendChild(style);
    } catch (_) {
      style = null;
    }
    return () => {
      try {
        if (style) style.remove();
      } catch (_) {
        /* 已移除 */
      }
    };
  }

  /**
   * 打开 CC 让播放器自己去请求字幕（read-frog 验证过的触发方式）。
   * 恢复函数只在「还是这个视频、还是这个播放器、CC 仍是我们打开后的开着状态」时才关回去：
   * 用户等待期间自己关掉了，或者状态读不到，就不再碰。
   */
  function ensureCaptionsOn(want) {
    const before = ccState();
    if (before === true) return { changed: false, method: 'already-on', restore: noop };
    const p = player();
    let button = null;
    try {
      button = document.querySelector('.ytp-subtitles-button');
    } catch (_) {
      button = null;
    }
    let method = '';
    try {
      if (p && typeof p.toggleSubtitles === 'function') {
        p.toggleSubtitles();
        method = 'toggleSubtitles';
      } else if (button && typeof button.click === 'function') {
        button.click();
        method = 'button';
      } else {
        return { changed: false, method: 'unavailable', restore: noop };
      }
    } catch (_) {
      return { changed: false, method: 'failed', restore: noop };
    }
    const unhide = hideNativeCaptions();
    return {
      changed: true,
      method,
      restore: () => {
        unhide();
        // 播放器节点常被复用，不能把旧视频的 CC 状态恢复到新视频上
        if (!onVideo(want.videoId) || player() !== p) return;
        if (ccState() !== true) return;
        try {
          if (typeof p.toggleSubtitles === 'function') p.toggleSubtitles();
          else if (button && button.isConnected !== false) button.click();
        } catch (_) {
          /* 恢复失败不影响读取结果 */
        }
      },
    };
  }

  /** 第二种触发：用 setOption 指定目标轨道。返回 { applied, restore }。 */
  function selectTrack(want) {
    const p = player();
    if (!p || typeof p.setOption !== 'function') return { applied: false, restore: noop };
    let prev = null;
    let wasOn = false;
    try {
      prev = p.getOption('captions', 'track');
    } catch (_) {
      /* 模块没加载 */
    }
    try {
      wasOn =
        typeof p.isSubtitlesOn === 'function'
          ? !!p.isSubtitlesOn()
          : !!(prev && prev.languageCode);
    } catch (_) {
      wasOn = !!(prev && prev.languageCode);
    }
    try {
      if (typeof p.loadModule === 'function') p.loadModule('captions');
    } catch (_) {
      /* 已加载 */
    }
    let target = { languageCode: want.languageCode };
    try {
      const list = p.getOption('captions', 'tracklist') || [];
      const hit = list.find(
        (t) => t && t.languageCode === want.languageCode && (t.kind || '') === (want.kind || '')
      );
      if (hit) target = hit;
      else if (want.vssId) target = { languageCode: want.languageCode, vssId: want.vssId, kind: want.kind || undefined };
    } catch (_) {
      /* 用最简形式 */
    }
    try {
      p.setOption('captions', 'track', target);
    } catch (_) {
      return { applied: false, restore: noop };
    }
    return {
      applied: true,
      restore: () => {
        if (!onVideo(want.videoId) || player() !== p) return;
        try {
          if (!wasOn) {
            if (typeof p.unloadModule === 'function') p.unloadModule('captions');
          } else if (
            prev &&
            prev.languageCode &&
            (prev.languageCode !== want.languageCode || (prev.kind || '') !== (want.kind || ''))
          ) {
            p.setOption('captions', 'track', prev);
          }
        } catch (_) {
          /* 恢复失败不影响读取结果 */
        }
      },
    };
  }

  // ---------- 读取一条字幕轨 ----------

  let readSeq = 0; // 每次读取递增；取消再递增一次，旧读取在下一次检查时退出
  let queue = Promise.resolve(); // 同一时间只跑一个读取：探测和正式读取不能同时操作播放器

  function summarize(tried) {
    const sources = [];
    let last = '';
    for (const t of tried) {
      if (!t.error) continue;
      if (!sources.includes(t.source)) sources.push(t.source);
      if (t.error !== 'DEADLINE') last = t.error;
    }
    return (
      `字幕接口没有返回可用内容（${last || 'EMPTY'}；已尝试 ${sources.join('、') || '无'}）。` +
      '可先在播放器里手动打开一次 CC 再试；反复失败说明 YouTube 的校验方式可能变了'
    );
  }

  /** 触发播放器后用来判断「有没有新东西」的指纹：拦截计数 + 音轨 URL 列表。 */
  function stateKey() {
    return `${captureSeq}\n${audioTrackUrls().map((t) => t.url).join('\n')}`;
  }

  /**
   * @param {{videoId:string, languageCode:string, kind:string, vssId?:string, baseUrl?:string}} want
   * @returns {Promise<{text?:string, source?:string, error?:string, tried:object[]}>}
   */
  function captions(want) {
    const run = queue.then(() => readCaptions(want));
    queue = run.then(noop, noop);
    return run;
  }

  async function readCaptions(want) {
    const tried = []; // 每一步的记录：{ source, at, ok?, ms?, error?, ... }
    if (!want || !want.videoId || !want.languageCode) return { error: '缺少字幕轨参数', tried };
    const seq = ++readSeq;
    const t0 = Date.now();
    const hardDeadline = t0 + HARD_DEADLINE_MS;
    const attempted = new Set(); // 每个候选 URL 只请求一次
    const alive = () => seq === readSeq && onVideo(want.videoId);
    const stopped = () => ({ error: seq === readSeq ? '视频已切换，已停止读取旧字幕' : '读取已取消', tried });
    const note = (source, extra) => tried.push(Object.assign({ source, at: Date.now() - t0 }, extra));

    const attempt = async (source, url) => {
      if (!url || attempted.has(url)) return null;
      attempted.add(url);
      const left = hardDeadline - Date.now();
      if (left <= 0) {
        note(source, { error: 'DEADLINE' });
        return null;
      }
      const started = Date.now();
      const r = await fetchJson3(url, Math.max(250, Math.min(FETCH_TIMEOUT_MS, left)));
      const ms = Date.now() - started;
      if (r.text) {
        note(source, { ok: true, ms });
        return { text: r.text, source, tried };
      }
      note(source, { error: r.error, ms });
      return null;
    };

    // 不打扰播放器的候选，按成本从低到高。重跑很便宜：请求过的 URL 不会再请求。
    const pass = async (prefix) => {
      const ready = captured.find((c) => sameTrack(c, want) && isJson(c.body));
      if (ready) {
        note(prefix + 'captured', { ok: true, ms: 0 });
        return { text: ready.body, source: prefix + 'captured', tried };
      }
      const steps = [];
      const known = captured.find((c) => sameTrack(c, want));
      if (known) steps.push(['refetch', withTrack(known.url, want)]);
      const own = audioTrackUrls().find((t) => sameWant(t, want));
      if (own) steps.push(['audiotrack', withTrack(own.url, want)]);
      const pot = pagePot(want.videoId);
      if (pot && want.baseUrl) steps.push(['composed', composeUrl(want.baseUrl, pot)]);
      const sibling = captured.find((c) => c.v === want.videoId);
      if (sibling) steps.push(['sibling', withTrack(sibling.url, want)]);
      for (const [source, url] of steps) {
        const r = await attempt(prefix + source, url);
        if (r) return r;
        if (!alive()) return null;
      }
      return null;
    };

    if (!alive()) return stopped();
    let r = await pass('');
    if (r) return r;
    if (!alive()) return stopped();

    // 触发播放器加载：先开 CC；一段时间没动静再用 setOption 指定轨道。之后只在状态变化时重跑候选。
    let last = stateKey();
    const cc = ensureCaptionsOn(want);
    note('trigger-cc', { method: cc.method, changed: cc.changed });
    const triggeredAt = Date.now();
    const pollUntil = Math.min(hardDeadline, triggeredAt + POLL_UNTIL_MS);
    let selectAt = triggeredAt + (cc.changed ? SELECT_AFTER_MS : 0);
    let select = { applied: false, restore: noop };
    try {
      while (Date.now() < pollUntil) {
        await sleep(POLL_MS);
        if (!alive()) return stopped();
        if (selectAt !== null && Date.now() >= selectAt) {
          selectAt = null;
          select = selectTrack(want);
          note('trigger-setoption', { applied: select.applied });
        }
        const key = stateKey();
        if (key === last) continue;
        last = key;
        r = await pass('triggered-');
        if (r) return r;
        if (!alive()) return stopped();
      }
      note('trigger-wait', { timedOut: true, ms: Date.now() - triggeredAt });
    } finally {
      select.restore();
      cc.restore();
    }

    // 最后直接请求 baseUrl：缺 pot 时多半为空，留作诊断对照
    if (want.baseUrl) {
      r = await attempt('baseUrl', withTrack(want.baseUrl, want));
      if (r) return r;
      if (!alive()) return stopped();
    }
    return { error: summarize(tried), tried };
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
        (err) => post(msg.id, { error: String((err && err.message) || err), tried: [] })
      );
    } else if (kind === 'cancel') {
      // 内容脚本取消或换视频：让进行中的读取在下一次检查时退出并恢复 CC
      readSeq++;
      post(msg.id, { ok: true });
    }
  });

  // SPA 切视频后主动推一次，内容脚本不用轮询
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => post(0, read()), 300);
  });
})();
