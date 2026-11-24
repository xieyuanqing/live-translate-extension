/**
 * 整片字幕控制器：读取字幕轨 → 分句 → 分块翻译 → 缓存 → 按播放时间显示。
 *
 * 和直播会话同一套约定：任务活在内容脚本里，开始时冻结配置快照；换视频、取消、刷新
 * 都通过 generation 作废旧任务的回调，旧任务的结果不会落到新视频上。
 * 每块校验通过就写缓存，中途关页面只丢正在进行的请求，回来再点就续翻。
 *
 * 顺序：含当前播放位置的块先翻，而且先翻眼前的 HEAD_UNITS 条；然后往后，最后回头补前面。
 * 翻好的条目立刻可显示，不等整片；「整片完成」只是缓存命中时零请求的依据。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  const abortError = () => new DOMException('已取消', 'AbortError');
  const isAbort = (err) => !!err && err.name === 'AbortError';
  const pack = (units) => units.map((u) => [u.start, u.end, u.text]);
  const unpack = (rows) => rows.map((r, i) => ({ id: i + 1, start: r[0], end: r[1], text: r[2] }));
  const langBase = (code) => String(code || '').toLowerCase().split('-')[0];
  const TINY_RE = /^[[［(（].*[\]］)）]$/;
  const validSource = (src) => !!src && src.segVersion === LT.SUBS.SEG_VERSION &&
    Array.isArray(src.units) && src.units.length > 0 && src.units.every((r, i, rows) =>
      Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) &&
      r[0] >= 0 && r[1] >= r[0] && typeof r[2] === 'string' && !!r[2].trim() &&
      (!i || r[0] >= rows[i - 1][0]));
  const validTexts = (arr, count) => Array.isArray(arr) && arr.length === count &&
    Array.from(arr).every(t => typeof t === 'string' && !!t.trim());
  const planFullChunks = (units) => LT.Chunker.plan(units, {
    chunkUnits: LT.SUBS.CHUNK_UNITS,
    chunkChars: LT.SUBS.CHUNK_CHARS,
    scheduleMs: Array.isArray(LT.SUBS.CHUNK_SCHEDULE_SEC)
      ? LT.SUBS.CHUNK_SCHEDULE_SEC.map((s) => s * 1000)
      : undefined,
  });
  /** 大块补漏时只提取缺失条前后相邻的少量参考，避免把 20 分钟几百条原文再塞一遍。 */
  function pickNearbyReference(target, missingSet) {
    if (target.length <= 80) return target.filter((u) => !missingSet.has(u.id));
    const keep = new Set();
    for (let i = 0; i < target.length; i++) {
      if (!missingSet.has(target[i].id)) continue;
      for (let k = Math.max(0, i - 2); k <= Math.min(target.length - 1, i + 2); k++) {
        if (!missingSet.has(target[k].id)) keep.add(k);
      }
    }
    return [...keep].sort((a, b) => a - b).slice(0, 40).map((idx) => target[idx]);
  }
  const settingsHash = (settings) => {
    const config = LT.TextModel.resolve(settings, settings.subsProviderId, settings.subsModel);
    return LT.SubsCache.fingerprint({
      sourceLang: settings.sourceLang, targetLang: settings.targetLang,
      scene: LT.Settings.scene(settings), useMetadata: settings.useMetadata,
      metadataLimit: settings.metadataLimit, manualContext: settings.manualContext,
      extraInstruction: settings.subsExtraInstruction || '',
      apiType: config.apiType, baseUrl: config.baseUrl, model: config.model,
      videoTranscriptMode: settings.videoTranscriptMode || 'auto',
      videoAsrBaseUrl: settings.videoAsrBaseUrl || '', videoAsrModel: settings.videoAsrModel || '',
    });
  };

  class VideoSubsController {
    /** @param {{caption:object, getVideo:()=>object|null, onStatus:()=>void}} deps */
    constructor(deps) {
      this.caption = deps.caption;
      this.getVideo = deps.getVideo;
      this.onStatus = deps.onStatus || (() => {});
      this.generation = 0;
      this.controllers = new Set();
      this.visible = true;
      this.reading = false; // 正在等页面桥读字幕轨
      this.reset('');
    }

    reset(videoId) {
      this.videoId = videoId;
      this.phase = 'idle'; // idle | reading | downloading | transcribing | translating | ready | partial | error
      this.progress = 0;
      this.downloadProgress = 0;
      this.vpsDurationMs = 0;
      this.vpsDoneDurationMs = 0;
      this.vpsUsingFallback = false;
      this.maxOverallProgress = 0;
      this.translateRetryHint = '';
      this.streamSegs = null;
      this.stage = '';
      this.sourceKind = '';
      this.asrTotal = 0;
      this.asrDone = 0;
      this.error = '';
      this.units = null; // [{id,start,end,text}]
      this.texts = []; // 与 units 对齐的译文，未翻为 undefined
      this.chunks = []; // [{i,from,to}]
      this.states = []; // pending | running | done | failed
      this.fp = '';
      this.meta = null;
      this.trackKey = '';
      this.trackLabel = '';
      this.isAsr = false;
      this.config = null;
      this.system = '';
      this.fromCache = false;
      this.staleConfig = false;
      this.hasCache = false;
      this.cachedComplete = false;
      this.saveError = '';
      this.fatal = null;
      this.cooldownUntil = 0;
      this.requests = 0;
      this.lastIdx = -2;
      this.lastText = null;
      this.lastNote = '';
      this.lastNoteAt = 0;
    }

    // ---------- 对外状态 ----------

    computeOverallProgress() {
      if (this.phase === 'ready') return 100;
      if (this.phase === 'idle') return 0;
      if (this.phase === 'reading') return this.maxOverallProgress;

      if (this.sourceKind === 'vps' && (this.phase === 'downloading' || this.phase === 'transcribing')) {
        const dlRatio = this.phase === 'downloading'
          ? Math.max(0, Math.min(1, (Number(this.downloadProgress) || 0) / 100))
          : 1;
        let asrRatio = 0;
        if (this.phase === 'transcribing') {
          if (this.vpsDurationMs > 0) {
            asrRatio = Math.max(0, Math.min(1, (this.vpsDoneDurationMs || 0) / this.vpsDurationMs));
          } else if (this.asrTotal > 0) {
            asrRatio = Math.max(0, Math.min(1, (this.asrDone || 0) / this.asrTotal));
          } else {
            asrRatio = Math.max(0, Math.min(1, (this.progress || 0) / 100));
          }
        }
        let transRatio = 0;
        if (this.streamSegs && this.streamSegs.size > 0) {
          const video = this.getVideo();
          const videoDurMs = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0;
          const totalDurMs = this.vpsDurationMs > 0 ? this.vpsDurationMs : videoDurMs;
          if (totalDurMs > 0) {
            let translatedDurMs = 0;
            for (const seg of this.streamSegs.values()) {
              const segDur = Math.max(0, (seg.endMs || 0) - (seg.startMs || 0));
              if (!segDur) continue;
              const okCount = seg.texts.reduce((n, t) => n + (typeof t === 'string' && t.trim() ? 1 : 0), 0);
              translatedDurMs += segDur * (seg.units.length ? okCount / seg.units.length : 1);
            }
            transRatio = Math.max(0, Math.min(1, translatedDurMs / totalDurMs));
          } else if (this.asrTotal > 0) {
            let doneSegs = 0;
            for (const seg of this.streamSegs.values()) {
              const okCount = seg.texts.reduce((n, t) => n + (typeof t === 'string' && t.trim() ? 1 : 0), 0);
              doneSegs += seg.units.length ? okCount / seg.units.length : 1;
            }
            transRatio = Math.max(0, Math.min(1, doneSegs / this.asrTotal));
          }
        }
        const raw = Math.min(99, Math.round(dlRatio * 10 + asrRatio * 55 + transRatio * 35));
        this.maxOverallProgress = Math.max(this.maxOverallProgress, raw);
        return this.maxOverallProgress;
      }

      if (this.units && this.units.length) {
        if (this.states.length > 0 && this.states.every((s) => s === 'done')) return 100;
        let translated = 0;
        for (let i = 0; i < this.units.length; i++) {
          if (typeof this.texts[i] === 'string' && this.texts[i].trim()) translated++;
        }
        const raw = Math.min(99, Math.round((translated / this.units.length) * 100));
        if (this.phase === 'translating') {
          this.maxOverallProgress = Math.max(this.maxOverallProgress, raw);
          return this.maxOverallProgress;
        }
        return raw;
      }
      return this.maxOverallProgress;
    }

    status() {
      let done = 0;
      let failed = 0;
      for (const s of this.states) {
        if (s === 'done') done++;
        else if (s === 'failed') failed++;
      }
      let frontierIdx = -1;
      let frontierMs = 0;
      if (this.units && this.units.length) {
        const video = this.getVideo();
        const from = LT.SubsScheduler.nextIndexFrom(this.units, video ? video.currentTime * 1000 : 0);
        const f = LT.SubsScheduler.frontier(this.units, this.texts, from);
        frontierIdx = f.idx;
        frontierMs = f.endMs;
      }
      return {
        phase: this.phase,
        error: this.error,
        visible: this.visible,
        trackLabel: this.trackLabel,
        isAsr: this.isAsr,
        unitCount: this.units ? this.units.length : 0,
        total: this.chunks.length,
        done,
        failed,
        frontierIdx,
        frontierMs,
        fromCache: this.fromCache,
        staleConfig: this.staleConfig,
        hasCache: this.hasCache,
        cachedComplete: this.cachedComplete,
        saveError: this.saveError,
        requests: this.requests,
        model: this.meta ? this.meta.model : this.config ? this.config.model : '',
        targetLang: this.meta ? this.meta.targetLang : '',
        progress: this.progress,
        overallProgress: this.computeOverallProgress(),
        downloadProgress: this.downloadProgress,
        usingFallback: this.vpsUsingFallback,
        translateRetryHint: this.translateRetryHint,
        stage: this.stage,
        sourceKind: this.sourceKind,
        asrTotal: this.asrTotal,
        asrDone: this.asrDone,
      };
    }

    emit() {
      if (this.phase === 'downloading' || this.phase === 'transcribing' || this.phase === 'translating') {
        this.progressNote();
      }
      try {
        this.onStatus();
      } catch (err) {
        console.warn('[流译] 状态推送失败', err);
      }
    }

    note(text, kind, autoHide) {
      this.lastNote = text;
      this.caption.setStatus(text, kind, autoHide);
    }

    progressNote(force = false) {
      const now = Date.now();
      if (!force && now - this.lastNoteAt < 1000) return;
      this.lastNoteAt = now;
      const s = this.status();
      const pct = s.overallProgress;
      const where = s.frontierIdx >= 0 ? `可看到 ${fmtClock(s.frontierMs)}` : '正在翻译当前位置…';
      let text;
      if (this.phase === 'downloading') {
        const dlText = this.stage || '正在下载音频…';
        text = pct > 0 ? `流译：${pct}% · ${dlText}` : `流译：${dlText}`;
      } else if (this.phase === 'transcribing') {
        if (!this.units || !this.units.length) {
          const asrInit = this.stage || (this.asrTotal ? `正在转写 ${this.asrDone}/${this.asrTotal} 段` : 'VPS 转写中…');
          text = `流译：${pct}% · ${asrInit}`;
        } else {
          const asrPart = this.asrTotal
            ? `转写 ${this.asrDone}/${this.asrTotal} 段${this.vpsUsingFallback ? '（备用模型）' : ''}`
            : (this.stage || `转写 ${this.progress}%`);
          const transPart = s.total
            ? `翻译 ${s.done}/${s.total} 块${this.translateRetryHint ? `（${this.translateRetryHint}）` : ''}`
            : '';
          text = `流译：${pct}% · ${asrPart}${transPart ? ` · ${transPart}` : ''} · ${where}`;
        }
      } else {
        const transPart = s.total
          ? `翻译 ${s.done}/${s.total} 块${this.translateRetryHint ? `（${this.translateRetryHint}）` : ''}`
          : '整片翻译中';
        text = `流译：${pct}% · ${transPart} · ${where}`;
      }
      if (text !== this.lastNote) this.note(text, 'warn', false);
    }

    // ---------- 生命周期 ----------

    /** 换视频：作废旧任务，清空显示；有缓存就按设置自动加载。 */
    async onVideoChanged(videoId, settings) {
      this.generation++;
      this.abortAll();
      this.reset(videoId);
      this.visible = true;
      this.caption.showTimed('', '');
      this.emit();
      if (!videoId) return;
      const gen = this.generation;
      let meta = null;
      try {
        meta = await LT.SubsCache.getMeta(videoId);
      } catch (_) {
        return;
      }
      if (gen !== this.generation) return;
      this.hasCache = !!meta;
      this.cachedComplete = !!(meta && meta.complete);
      if (meta && settings && settings.autoShowCached) {
        const loaded = await this.loadCached(meta, gen);
        if (gen !== this.generation) return;
        if (!loaded) this.cachedComplete = false;
        else this.updateSettings(settings);
      }
      if (gen !== this.generation) return;
      this.emit();
    }

    /** 展示缓存实际对应的配置；修改设置只标记差异，不自动发请求。 */
    updateSettings(settings) {
      const meta = this.meta;
      if (!meta || !['ready', 'partial', 'error'].includes(this.phase)) return;
      const config = LT.TextModel.resolve(settings, settings.subsProviderId, settings.subsModel);
      this.staleConfig = meta.settingsHash
        ? meta.settingsHash !== settingsHash(settings)
        : meta.targetLang !== settings.targetLang || meta.sourceLang !== settings.sourceLang ||
          meta.model !== config.model || meta.apiType !== config.apiType;
      this.emit();
    }

    async loadCached(meta, gen) {
      if (!meta || !Array.isArray(meta.chunks) || !meta.chunks.length || !meta.trackKey) return false;
      let src;
      let arrays;
      try {
        src = await LT.SubsCache.getSource(meta.videoId, meta.trackKey);
        arrays = await LT.SubsCache.getChunks(meta.videoId, meta.fp, meta.chunks.length);
      } catch (_) {
        return false;
      }
      if (gen !== this.generation || !validSource(src) || meta.unitCount !== src.units.length ||
          (meta.sourceHash && meta.sourceHash !== LT.SubsCache.fingerprint(src.units))) return false;
      let next = 0;
      for (const chunk of meta.chunks) {
        if (!Array.isArray(chunk) || chunk[0] !== next || !Number.isInteger(chunk[1]) ||
            chunk[1] < next || chunk[1] >= src.units.length) return false;
        next = chunk[1] + 1;
      }
      if (next !== src.units.length) return false;
      const units = unpack(src.units);
      const texts = new Array(units.length);
      const states = meta.chunks.map(() => 'pending');
      meta.chunks.forEach(([from, to], i) => {
        const a = arrays[i];
        if (validTexts(a, to - from + 1)) {
          a.forEach((t, k) => {
            texts[from + k] = t;
          });
          states[i] = 'done';
        }
      });
      if (!states.some((s) => s === 'done')) return false;
      Object.assign(this, {
        units,
        texts,
        states,
        chunks: meta.chunks.map(([from, to], i) => ({ i, from, to })),
        fp: meta.fp,
        meta,
        trackKey: meta.trackKey,
        trackLabel: meta.trackLabel || '',
        isAsr: !!src.isAsr,
        sourceKind: src.sourceKind || (String(meta.trackKey).startsWith('vps|') ? 'vps' : 'youtube'),
        fromCache: true,
      });
      this.phase = states.every((s) => s === 'done') ? 'ready' : 'partial';
      this.cachedComplete = this.phase === 'ready';
      this.lastIdx = -2;
      return true;
    }

    /** 直播会话开始时让位：取消任务并隐藏显示。 */
    deactivate() {
      this.cancel();
      this.visible = false;
      this.caption.showTimed('', '');
      this.lastIdx = -2;
      this.emit();
    }

    setVisible(visible) {
      this.visible = !!visible;
      if (!this.visible) {
        this.caption.showTimed('', '');
        this.lastIdx = -2;
      }
      this.emit();
    }

    cancel() {
      const active = ['reading', 'downloading', 'transcribing', 'translating'].includes(this.phase);
      this.generation++;
      this.abortAll();
      this.fatal = null;
      if (!active) return;
      this.states = this.states.map((s) => (s === 'running' ? 'pending' : s));
      if (!this.units) this.phase = 'idle';
      else this.phase = this.states.every((s) => s === 'done') ? 'ready' : 'partial';
      this.note('', 'ok', false);
      this.emit();
    }

    async clearCache() {
      const videoId = this.videoId;
      this.cancel();
      const gen = this.generation;
      await LT.SubsCache.removeVideo(videoId);
      if (gen !== this.generation || videoId !== this.videoId) return;
      this.reset(videoId);
      this.caption.showTimed('', '');
      this.emit();
    }

    abortAll() {
      if (this.reading) LT.YouTube.cancelCaptions();
      this.reading = false;
      for (const c of this.controllers) c.abort();
      this.controllers.clear();
    }

    // ---------- 主流程 ----------

    /**
     * @param {{settings:object, meta:object|null, tempContext:string, force?:boolean}} args
     *   force：重新翻译，丢弃当前配置指纹下的旧译文
     */
    async start({ settings, meta, tempContext, force = false }) {
      if (['reading', 'downloading', 'transcribing', 'translating'].includes(this.phase)) return;
      const videoId = LT.YouTube.videoIdFromUrl();
      if (!videoId) return;
      const gen = ++this.generation;
      const alive = () => gen === this.generation && videoId === LT.YouTube.videoIdFromUrl();
      this.videoId = videoId;
      this.phase = 'reading';
      this.error = '';
      this.fatal = null;
      this.saveError = '';
      this.visible = true;
      this.progress = 0;
      this.downloadProgress = 0;
      this.vpsDurationMs = 0;
      this.vpsDoneDurationMs = 0;
      this.vpsUsingFallback = false;
      this.maxOverallProgress = 0;
      this.translateRetryHint = '';
      this.streamSegs = null;
      this.stage = '';
      this.lastNoteAt = 0;
      this.note(settings.videoTranscriptMode === 'youtube' ? '流译：读取字幕轨…' : '流译：正在获取视频原文…', 'warn', false);
      this.emit();

      try {
        const run = { videoId, settings, meta, tempContext, force, gen, config: LT.TextModel.resolve(settings, settings.subsProviderId, settings.subsModel) };
        const source = await this.loadSource(run, alive);
        if (!source || !alive() || source.streamFinished) return;

        const prompt = this.buildPromptAndFingerprint(run, source);

        const restored = await this.restoreChunks(run, source, prompt, alive);
        if (!restored || !alive() || restored.done) return;

        await this.translateAll(gen, alive);
      } catch (err) {
        if (!alive() || isAbort(err)) return;
        console.error('[流译] 整片字幕失败', err);
        this.phase = 'error';
        this.error = err && err.message ? err.message : String(err);
        this.note(`流译：${this.error}`, 'err', false);
        this.emit();
      }
    }

    requireTextModel(config) {
      if (!LT.TextModel.hasCredentials(config)) throw new Error('未配置 API Key 或鉴权请求头，请在扩展设置里填写');
      if (!config.model) throw new Error('未填写文字模型名，请在扩展设置的「整片字幕」里填写');
    }

    async loadSource(runOrVideoId, settingsOrAlive, meta, tempContext, force, alive) {
      let run;
      if (runOrVideoId && typeof runOrVideoId === 'object') {
        run = runOrVideoId;
        alive = settingsOrAlive;
      } else {
        if (typeof meta === 'function') { alive = meta; meta = null; tempContext = ''; force = false; }
        run = {
          videoId: runOrVideoId,
          settings: settingsOrAlive,
          meta,
          tempContext,
          force,
          config: LT.TextModel.resolve(settingsOrAlive, settingsOrAlive.subsProviderId, settingsOrAlive.subsModel),
        };
      }
      const { videoId, settings } = run;
      const runMeta = run.meta;
      const runTemp = run.tempContext;
      const runForce = !!run.force;

      let cachedMeta = (await LT.SubsCache.getMeta(videoId)) || null;
      if (!alive()) return null;
      let units = null;
      let trackKey = '';
      let trackLabel = '';
      let isAsr = false;
      if (cachedMeta && cachedMeta.trackKey) {
        const src = await LT.SubsCache.getSource(videoId, cachedMeta.trackKey);
        if (!alive()) return null;
        const mode = settings.videoTranscriptMode || 'auto';
        const vpsTrack = String(cachedMeta.trackKey).startsWith('vps|');
        const modelFits = !settings.videoAsrModel || !vpsTrack || String(cachedMeta.trackKey).endsWith(`|${settings.videoAsrModel}`) || runForce;
        const autoUpgrade = mode === 'auto' && !!settings.videoAsrBaseUrl && !!src.isAsr;
        const fits =
          validSource(src) &&
          (settings.sourceLang === 'auto' || langBase(src.lang) === langBase(settings.sourceLang)) &&
          (mode !== 'vps' || vpsTrack) && (mode !== 'youtube' || !vpsTrack) && modelFits && !runForce && !autoUpgrade;
        if (fits) {
          units = unpack(src.units);
          trackKey = cachedMeta.trackKey;
          trackLabel = cachedMeta.trackLabel || '';
          isAsr = !!src.isAsr;
        }
      }
      if (!units) {
        // 原文失效后编号可能完全变化，不能走「旧设置缓存」的复用路径。
        if (!runForce) cachedMeta = null;
        let read;
        const mode = settings.videoTranscriptMode || 'auto';
        if (mode === 'vps') {
          if (!settings.videoAsrBaseUrl) throw new Error('已选择强制云端转写，但尚未配置 VPS 服务地址，请前往设置 → 视频翻译填写');
          read = await this.streamFromVps(run, cachedMeta, alive);
        } else if (mode === 'auto') {
          const info = await LT.YouTube.captionTracks();
          if (!alive()) return null;
          const human = info && info.tracks && info.tracks.some(
            t => t.kind !== 'asr' && (settings.sourceLang === 'auto' || langBase(t.languageCode) === langBase(settings.sourceLang))
          );
          if (human || !settings.videoAsrBaseUrl) read = await this.readTrack(videoId, settings, alive);
          else read = await this.streamFromVps(run, cachedMeta, alive);
        } else {
          read = await this.readTrack(videoId, settings, alive);
        }
        if (!read) return null;
        if (read.streamFinished) return read;
        ({ units, trackKey, trackLabel, isAsr } = read);
      }
      const sourceHash = LT.SubsCache.fingerprint(pack(units));
      if (cachedMeta && cachedMeta.sourceHash && cachedMeta.sourceHash !== sourceHash) cachedMeta = null;
      return { cachedMeta, units, trackKey, trackLabel, isAsr, sourceHash, sourceKind: String(trackKey).startsWith('vps|') ? 'vps' : 'youtube' };
    }

    buildVpsContext(settings, meta, tempContext) {
      if (!settings.videoAsrSendContext) return '';
      const parts = [];
      if (settings.useMetadata && meta && LT.Prompt?.formatMetadata) {
        const metaText = LT.Prompt.formatMetadata(meta, Math.min(Number(settings.metadataLimit) || 1000, 1000));
        if (metaText) parts.push(metaText);
      }
      if (settings.manualContext && String(settings.manualContext).trim()) {
        parts.push(String(settings.manualContext).trim());
      }
      if (tempContext && String(tempContext).trim()) {
        parts.push(String(tempContext).trim());
      }
      return parts.join('\n\n').slice(0, 1500);
    }

    /**
     * 全异步并行 VPS 转写 + 实时分片翻译流水线：
     * VPS 每完成一个音频分片，扩展立刻并行启动文字翻译并上屏，无需等待全片转写完成。
     * 若命中 VPS 服务端缓存（无增量分片）则回落到标准整片翻译路径。
     */
    async streamFromVps(run, cachedMeta, alive) {
      const { videoId, settings, meta, tempContext, force, config } = run;
      this.requireTextModel(config);

      const scene = LT.Settings.scene(settings);
      const metadataText = settings.useMetadata ? LT.Prompt.formatMetadata(meta, settings.metadataLimit) : '';
      const system = LT.Prompt.buildSubs({
        scene,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        isAsr: false,
        metadataText,
        manualContext: settings.manualContext,
        tempContext,
        extraInstruction: settings.subsExtraInstruction,
      });

      this.config = config;
      this.system = system;
      this.phase = 'downloading';
      this.stage = '正在连接 VPS 转写服务…';
      this.progress = 0;
      this.downloadProgress = 0;
      this.vpsDurationMs = 0;
      this.vpsDoneDurationMs = 0;
      this.vpsUsingFallback = false;
      this.maxOverallProgress = 0;
      this.translateRetryHint = '';
      this.asrTotal = 0;
      this.asrDone = 0;
      this.sourceKind = 'vps';
      this.isAsr = false;
      this.units = null;
      this.texts = [];
      this.chunks = [];
      this.states = [];
      this.lastIdx = -2;
      this.lastNoteAt = 0;
      this.note(`流译：${this.stage}`, 'warn', false);
      this.emit();

      const streamSegs = new Map();
      this.streamSegs = streamSegs;
      let vpsDone = false;
      let waiters = [];
      const wakeWorkers = () => {
        const list = waiters;
        waiters = [];
        for (const fn of list) fn();
      };
      const waitWork = () => new Promise(resolve => waiters.push(resolve));

      const rebuildTimeline = () => {
        const ordered = [...streamSegs.values()].sort((a, b) => a.index - b.index);
        const flatUnits = [];
        const flatTexts = [];
        const flatChunks = [];
        const flatStates = [];
        let lastStart = 0;
        for (const seg of ordered) {
          const baseOffset = flatUnits.length;
          for (let i = 0; i < seg.units.length; i++) {
            const u = seg.units[i];
            const s = Math.max(lastStart, u.start);
            const e = Math.max(s, u.end);
            flatUnits.push({ id: flatUnits.length + 1, start: s, end: e, text: u.text });
            flatTexts.push(seg.texts[i]);
            lastStart = s;
          }
          for (let i = 0; i < seg.chunks.length; i++) {
            const c = seg.chunks[i];
            flatChunks.push({ i: flatChunks.length, from: baseOffset + c.from, to: baseOffset + c.to });
            flatStates.push(seg.states[i]);
          }
        }
        this.units = flatUnits.length ? flatUnits : null;
        this.texts = flatTexts;
        this.chunks = flatChunks;
        this.states = flatStates;
        this.lastIdx = -2;
      };

      const pickStreamWork = () => {
        const video = this.getVideo();
        const posMs = video ? video.currentTime * 1000 : 0;
        let containing = null;
        let nearestForward = null;
        let nearestForwardDelta = Infinity;
        let earliest = null;
        let earliestStart = Infinity;

        for (const seg of streamSegs.values()) {
          for (let ci = 0; ci < seg.chunks.length; ci++) {
            if (seg.states[ci] !== 'pending') continue;
            const c = seg.chunks[ci];
            const first = seg.units[c.from];
            const last = seg.units[c.to];
            if (!first || !last) continue;
            if (posMs >= first.start && posMs <= last.end) {
              containing = { seg, chunkIdx: ci };
              break;
            }
            if (first.start >= posMs && first.start - posMs < nearestForwardDelta) {
              nearestForwardDelta = first.start - posMs;
              nearestForward = { seg, chunkIdx: ci };
            }
            if (first.start < earliestStart) {
              earliestStart = first.start;
              earliest = { seg, chunkIdx: ci };
            }
          }
          if (containing) break;
        }
        return containing || nearestForward || earliest;
      };

      const streamWorker = async () => {
        for (;;) {
          if (!alive() || this.fatal) return;
          const pick = pickStreamWork();
          if (!pick) {
            if (vpsDone) return;
            await waitWork();
            continue;
          }
          const { seg, chunkIdx } = pick;
          const chunk = seg.chunks[chunkIdx];
          seg.states[chunkIdx] = 'running';
          try {
            const video = this.getVideo();
            const posMs = video ? video.currentTime * 1000 : 0;
            // 仅当当前播放位置真正落在该分片时间范围内时，才先翻眼前 HEAD_UNITS 条；其他分片整块一次翻完
            const inSeg = posMs >= (seg.startMs || 0) && posMs < (seg.endMs || 0);
            const posIdx = inSeg ? LT.SubsScheduler.nextIndexFrom(seg.units, posMs) : -1;
            for (const [from, to] of LT.Chunker.ranges(chunk, posIdx, LT.SUBS.HEAD_UNITS)) {
              await this.translateRangeOn(seg.units, seg.texts, alive, from, to, 0, () => {
                rebuildTimeline();
                this.emit();
              });
            }
            if (!alive()) return;
            let complete = true;
            for (let k = chunk.from; k <= chunk.to; k++) {
              if (seg.texts[k] == null) complete = false;
            }
            seg.states[chunkIdx] = complete ? 'done' : 'failed';
          } catch (err) {
            if (!alive() || isAbort(err)) return;
            if (err && err.fatal) {
              this.fatal = err;
              seg.states[chunkIdx] = 'pending';
              this.abortAll();
              wakeWorkers();
              return;
            }
            console.warn(`[流译] 流式片段 ${seg.index}-${chunkIdx} 失败：${err && err.message}`);
            seg.states[chunkIdx] = 'failed';
          }
          rebuildTimeline();
          this.emit();
        }
      };

      const vpsController = new AbortController();
      this.controllers.add(vpsController);
      const workerCount = Math.max(1, Math.min(6, Number(config.concurrency) || 3));
      const workersPromise = Promise.all(Array.from({ length: workerCount }, () => streamWorker()));

      let result;
      let vpsError = null;
      try {
        const context = this.buildVpsContext(settings, meta, tempContext) || undefined;
        const pageUrl = typeof location !== 'undefined' && location.href
          ? location.href
          : `https://www.youtube.com/watch?v=${videoId}`;
        const video = this.getVideo();
        const preferMs = video && Number.isFinite(video.currentTime) ? Math.max(0, Math.round(video.currentTime * 1000)) : 0;

        result = await LT.VpsAsr.transcribe({
          baseUrl: settings.videoAsrBaseUrl,
          token: settings.videoAsrToken,
          videoId,
          url: pageUrl,
          sourceLang: settings.sourceLang,
          model: settings.videoAsrModel,
          context,
          force,
          preferMs,
          getPreferMs: () => {
            const v = this.getVideo();
            return v && Number.isFinite(v.currentTime) ? Math.max(0, Math.round(v.currentTime * 1000)) : 0;
          },
          signal: vpsController.signal,
          onChunk: chunk => {
            if (!alive() || this.fatal) return;
            if (!chunk.units || !chunk.units.length) return;
            const segUnits = chunk.units.map((u, idx) => ({
              id: idx + 1,
              start: u.start,
              end: u.end,
              text: u.text,
            }));
            // 每个 VPS 音频分片（1分/3分/5分/20分）直接作为一块翻译，与切段同频；仅在超安全上限时才拆分
            const segChunks = LT.Chunker.plan(segUnits, {
              chunkUnits: LT.SUBS.CHUNK_UNITS,
              chunkChars: LT.SUBS.CHUNK_CHARS,
            });
            streamSegs.set(chunk.index, {
              index: chunk.index,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              units: segUnits,
              texts: new Array(segUnits.length),
              chunks: segChunks,
              states: segChunks.map(() => 'pending'),
            });
            this.phase = 'transcribing';
            rebuildTimeline();
            wakeWorkers();
            this.progressNote(true);
            this.emit();
          },
          onProgress: p => {
            if (!alive() || this.fatal) return;
            const rawPct = Number(p.progress) || 0;
            const pct = rawPct > 0 && rawPct < 1 ? Math.round(rawPct * 100) : Math.round(rawPct);
            this.progress = Math.max(0, Math.min(100, pct));
            if (p.downloadProgress != null) this.downloadProgress = Math.max(0, Math.min(100, Math.round(Number(p.downloadProgress) || 0)));
            if (p.durationMs > 0) this.vpsDurationMs = Number(p.durationMs);
            if (p.doneDurationMs != null && p.doneDurationMs >= 0) this.vpsDoneDurationMs = Number(p.doneDurationMs);
            if (p.usingFallback != null) this.vpsUsingFallback = !!p.usingFallback;
            this.stage = p.stage || '';
            if (p.totalChunks) this.asrTotal = p.totalChunks;
            if (p.doneChunks != null) this.asrDone = p.doneChunks;
            this.phase = streamSegs.size > 0
              ? 'transcribing'
              : (p.status === 'queued' || p.status === 'downloading' ? 'downloading' : 'transcribing');
            this.progressNote(true);
            this.emit();
          },
        });
      } catch (err) {
        vpsError = err;
        if (!this.fatal) this.abortAll();
      } finally {
        this.controllers.delete(vpsController);
        vpsDone = true;
        wakeWorkers();
      }

      await workersPromise;
      this.streamSegs = null;
      if (!alive()) return null;
      if (this.fatal) {
        await this.finish(alive);
        return { streamFinished: true };
      }
      if (vpsError) throw vpsError;

      const usedModel = result.model || settings.videoAsrModel || 'default';
      const modelLabel = (Array.isArray(settings.videoAsrModels)
        ? settings.videoAsrModels.find(item => item.id === usedModel)?.label
        : '') || usedModel;
      const lang = result.lang || settings.sourceLang || 'auto';
      const trackKey = `vps|${lang}|${usedModel}`;
      const trackLabel = `VPS 转写 · ${modelLabel}`;

      // 服务端缓存直返或旧版 VPS 未返回增量分片：沿用标准整片缓存与翻译路径
      if (streamSegs.size === 0) {
        const units = result.units;
        await LT.SubsCache.setSource(videoId, trackKey, {
          videoId,
          trackKey,
          lang,
          isAsr: false,
          sourceKind: 'vps',
          model: usedModel,
          segVersion: LT.SUBS.SEG_VERSION,
          units: pack(units),
        }).catch(err => {
          if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
        });
        if (!alive()) return null;
        this.progress = 100;
        this.maxOverallProgress = 0;
        this.stage = 'VPS 转写完成';
        this.emit();
        return { units, trackKey, trackLabel, isAsr: false, sourceKind: 'vps' };
      }

      // 增量流式翻译已随转写同步完成：规整为标准块结构并写入完整本机缓存
      rebuildTimeline();
      const finalUnits = this.units || [];
      if (!finalUnits.length) throw new Error('VPS 转写结果为空');
      const finalTexts = this.texts;
      const finalChunks = planFullChunks(finalUnits);
      const finalStates = finalChunks.map(c => {
        for (let k = c.from; k <= c.to; k++) {
          if (typeof finalTexts[k] !== 'string' || !finalTexts[k].trim()) return 'failed';
        }
        return 'done';
      });
      const sourceHash = LT.SubsCache.fingerprint(pack(finalUnits));
      const { fp } = this.buildPromptAndFingerprint(run, { isAsr: false, trackKey, sourceHash });

      Object.assign(this, {
        units: finalUnits,
        texts: finalTexts,
        chunks: finalChunks,
        states: finalStates,
        fp,
        trackKey,
        trackLabel,
        isAsr: false,
        sourceKind: 'vps',
        config,
        system,
        staleConfig: false,
        fromCache: false,
        hasCache: true,
        progress: 100,
        stage: 'VPS 转写完成',
        lastIdx: -2,
      });

      const record = {
        videoId,
        title: (meta && meta.title) || (cachedMeta && cachedMeta.title) || '',
        trackKey,
        trackLabel,
        sourceLang: settings.sourceLang,
        sourceHash,
        segVersion: LT.SUBS.SEG_VERSION,
        settingsHash: settingsHash(settings),
        targetLang: settings.targetLang,
        fp,
        apiType: config.apiType,
        model: config.model,
        sceneLabel: scene.label,
        unitCount: finalUnits.length,
        chunks: finalChunks.map(c => [c.from, c.to]),
        complete: finalStates.every(s => s === 'done'),
        createdAt: (cachedMeta && cachedMeta.createdAt) || Date.now(),
        updatedAt: Date.now(),
      };
      this.meta = record;
      this.cachedComplete = record.complete;

      try {
        await LT.SubsCache.removeChunks(videoId);
        await LT.SubsCache.setSource(videoId, trackKey, {
          videoId,
          trackKey,
          lang,
          isAsr: false,
          sourceKind: 'vps',
          model: usedModel,
          segVersion: LT.SUBS.SEG_VERSION,
          units: pack(finalUnits),
        });
        for (let i = 0; i < finalChunks.length; i++) {
          if (finalStates[i] !== 'done') continue;
          await LT.SubsCache.setChunk(videoId, fp, i, finalTexts.slice(finalChunks[i].from, finalChunks[i].to + 1));
        }
        await LT.SubsCache.setMeta(record);
      } catch (err) {
        if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
      }
      if (!alive()) return null;

      await this.finish(alive);
      return { streamFinished: true };
    }

    buildPromptAndFingerprint({ settings, meta, tempContext, config }, { isAsr, trackKey, sourceHash }) {
      const scene = LT.Settings.scene(settings);
      const metadataText = settings.useMetadata
        ? LT.Prompt.formatMetadata(meta, settings.metadataLimit)
        : '';
      const system = LT.Prompt.buildSubs({
        scene,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        isAsr,
        metadataText,
        manualContext: settings.manualContext,
        tempContext,
        extraInstruction: settings.subsExtraInstruction,
      });
      const fp = LT.SubsCache.fingerprint({
        seg: LT.SUBS.SEG_VERSION,
        chunk: [LT.SUBS.CHUNK_UNITS, LT.SUBS.CHUNK_CHARS, LT.SUBS.CHUNK_SCHEDULE_SEC],
        trackKey,
        sourceHash,
        targetLang: settings.targetLang,
        apiType: config.apiType,
        baseUrl: config.baseUrl,
        model: config.model,
        system,
      });
      return { scene, system, fp };
    }

    async restoreChunks({ videoId, settings, meta, force, gen, config }, source, { scene, system, fp }, alive) {
      let { cachedMeta } = source;
      const { units, trackKey, trackLabel, isAsr, sourceHash, sourceKind } = source;
      const requireModel = () => {
        if (!LT.TextModel.hasCredentials(config)) throw new Error('未配置 API Key 或鉴权请求头，请在扩展设置里填写');
        if (!config.model) throw new Error('未填写文字模型名，请在扩展设置的「整片字幕」里填写');
      };

      const chunks = planFullChunks(units);
      let cachedChunks = [];
      if (cachedMeta && cachedMeta.fp && cachedMeta.fp !== fp) {
        if (!force && cachedMeta.trackKey === trackKey) {
          // 旧设置缓存继续显示，部分缓存也不能混入新配置的译文。
          const loaded = await this.loadCached(cachedMeta, gen);
          if (!alive()) return null;
          if (loaded) {
            this.staleConfig = true;
            this.hasCache = true;
            this.config = config;
            this.note('流译：已加载旧设置翻译的缓存字幕', 'ok', true);
            this.emit();
            return { done: true };
          }
        }
        requireModel();
        await LT.SubsCache.removeChunks(videoId);
        if (!alive()) return null;
        cachedMeta = null;
      } else if (cachedMeta && cachedMeta.fp === fp) {
        if (force) {
          requireModel();
          await LT.SubsCache.removeChunks(videoId);
        } else {
          cachedChunks = await LT.SubsCache.getChunks(videoId, fp, chunks.length);
        }
        if (!alive()) return null;
      }

      const texts = new Array(units.length);
      const states = chunks.map(() => 'pending');
      cachedChunks.forEach((arr, i) => {
        if (chunks[i] && validTexts(arr, chunks[i].to - chunks[i].from + 1)) {
          arr.forEach((t, k) => {
            texts[chunks[i].from + k] = t;
          });
          states[i] = 'done';
        }
      });
      if (!states.every(s => s === 'done')) requireModel();
      Object.assign(this, {
        units,
        texts,
        chunks,
        states,
        fp,
        trackKey,
        trackLabel,
        isAsr,
        sourceKind: sourceKind || (String(trackKey).startsWith('vps|') ? 'vps' : 'youtube'),
        config,
        system,
        staleConfig: false,
        fromCache: states.some((s) => s === 'done'),
        hasCache: true,
        lastIdx: -2,
      });
      const record = {
        videoId,
        title: (meta && meta.title) || (cachedMeta && cachedMeta.title) || '',
        trackKey,
        trackLabel,
        sourceLang: settings.sourceLang,
        sourceHash,
        segVersion: LT.SUBS.SEG_VERSION,
        settingsHash: settingsHash(settings),
        targetLang: settings.targetLang,
        fp,
        apiType: config.apiType,
        model: config.model,
        sceneLabel: scene.label,
        unitCount: units.length,
        chunks: chunks.map((c) => [c.from, c.to]),
        complete: states.every((s) => s === 'done'),
        createdAt: (cachedMeta && cachedMeta.createdAt) || Date.now(),
        updatedAt: Date.now(),
      };
      this.meta = record;
      this.cachedComplete = record.complete;
      await LT.SubsCache.setMeta(record).catch((err) => {
        if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
      });
      if (!alive()) return null;

      if (record.complete) {
        this.phase = 'ready';
        this.fromCache = true;
        this.note('流译：整片字幕已就绪（缓存）', 'ok', true);
        this.emit();
        return { done: true };
      }
      return { done: false };
    }

    async translateAll(gen, alive) {
      const { trackLabel, units, chunks, states, config } = this;
      console.info(
        `[流译] 整片翻译开始｜${trackLabel}｜${units.length} 条 / ${chunks.length} 块｜已缓存 ${
          states.filter((s) => s === 'done').length
        } 块｜模型 ${config.apiType}:${config.model}`
      );
      this.phase = 'translating';
      this.lastNoteAt = 0;
      this.emit();
      const n = Math.max(1, Math.min(6, Number(config.concurrency) || 3));
      const workers = [];
      for (let i = 0; i < n; i++) workers.push(this.worker(gen, alive));
      await Promise.all(workers);
      if (!alive()) return;
      await this.finish(alive);
    }

    /** 从 YouTube 读取字幕轨并分句；失败抛错，任务被作废时返回 null。 */
    async readTrack(videoId, settings, alive) {
      const info = await LT.YouTube.captionTracks();
      if (!alive()) return null;
      if (!info || info.videoId !== videoId) throw new Error('播放器还没就绪，请稍后再试');
      const track = LT.YouTube.chooseTrack(info.tracks, settings.sourceLang, info.defaultIndex, info.selected);
      if (!track) {
        if (info.tracks.length === 0) throw new Error('这个视频没有可用的字幕轨（自动字幕可能还没生成）');
        const available = info.tracks
          .map((t) => `${t.languageCode}${t.kind === 'asr' ? '（自动）' : ''}`)
          .join('、');
        throw new Error(`没有${LT.sourceLabel(settings.sourceLang)}字幕轨；可用：${available}。可把「听什么」改成自动检测`);
      }
      const t0 = Date.now();
      this.reading = true; // 取消时要通知页面桥放弃读取
      let res;
      try {
        res = await LT.YouTube.fetchCaptions({
          videoId,
          languageCode: track.languageCode,
          kind: track.kind,
          vssId: track.vssId,
          baseUrl: track.baseUrl,
        });
      } finally {
        this.reading = false;
      }
      if (!alive()) return null;
      if (!res) throw new Error('读取字幕超时，请刷新页面后再试');
      if (Array.isArray(res.tried) && res.tried.some((t) => t.error)) console.info('[流译] 字幕读取路径', res.tried);
      if (res.error || !res.text) throw new Error(`读取字幕失败：${res.error || '空响应'}`);
      const format = typeof LT.Json3.detectFormat === 'function' ? LT.Json3.detectFormat(res.text) : '';
      const events = LT.Json3.parse(res.text);
      const isAsr = track.kind === 'asr';
      const units = LT.Segmenter.build(events, { isAsr, lang: track.languageCode });
      if (units.length === 0) throw new Error('字幕轨是空的');
      const trackKey = `${track.languageCode}|${isAsr ? 'asr' : 'std'}`;
      const trackLabel = `${track.name || track.languageCode}${isAsr ? '（自动字幕）' : ''}`;
      await LT.SubsCache.setSource(videoId, trackKey, {
        videoId,
        trackKey,
        lang: track.languageCode,
        isAsr,
        segVersion: LT.SUBS.SEG_VERSION,
        units: pack(units),
      }).catch((err) => {
        if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
      });
      if (!alive()) return null;
      console.info(
        `[流译] 字幕轨 ${trackLabel}：${events.length} 段 → ${units.length} 条（来源 ${res.source}，格式 ${format || '未知'}，${Date.now() - t0} 毫秒）`
      );
      return { units, trackKey, trackLabel, isAsr };
    }

    async finish(alive) {
      let failed = 0;
      for (const s of this.states) if (s === 'failed') failed++;
      if (this.fatal) {
        this.states = this.states.map(s => s === 'running' ? 'pending' : s);
        this.phase = 'error';
        this.error = this.fatal.message;
        this.fatal = null;
        this.note(`流译：${this.error}`, 'err', false);
      } else if (failed === 0 && this.states.every((s) => s === 'done')) {
        this.phase = 'ready';
        this.cachedComplete = true;
        if (this.meta) {
          this.meta.complete = true;
          this.meta.updatedAt = Date.now();
          try {
            await LT.SubsCache.setMeta(this.meta);
          } catch (err) {
            if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
          }
        }
        if (!alive()) return;
        this.note(this.saveError ? '流译：整片字幕已就绪（缓存未保存）' : '流译：整片字幕已就绪', 'ok', true);
      } else {
        this.phase = 'partial';
        this.note(`流译：${failed} 个片段失败，可在弹窗里继续翻译`, 'warn', false);
      }
      this.emit();
    }

    // ---------- 翻译 ----------

    async worker(gen, alive) {
      for (;;) {
        if (!alive() || this.fatal) return;
        const video = this.getVideo();
        const posMs = video ? video.currentTime * 1000 : 0;
        const idx = LT.Chunker.pick(this.chunks, this.states, this.units, posMs);
        if (idx < 0) return;
        const chunk = this.chunks[idx];
        this.states[idx] = 'running';
        try {
          const posIdx = LT.SubsScheduler.nextIndexFrom(this.units, posMs);
          for (const [from, to] of LT.Chunker.ranges(chunk, posIdx, LT.SUBS.HEAD_UNITS)) {
            await this.translateRange(alive, from, to);
          }
          if (!alive()) return;
          let complete = true;
          for (let k = chunk.from; k <= chunk.to; k++) if (this.texts[k] == null) complete = false;
          if (complete) {
            this.states[idx] = 'done';
            try {
              await LT.SubsCache.setChunk(this.videoId, this.fp, idx, this.texts.slice(chunk.from, chunk.to + 1));
            } catch (err) {
              if (alive()) this.saveError = err && err.message ? err.message : '缓存写入失败';
            }
            if (!alive()) return;
          } else {
            this.states[idx] = 'failed';
          }
        } catch (err) {
          if (!alive() || isAbort(err)) return;
          if (err && err.fatal) {
            // Key / 模型名这类错误重试没用：记下来，让所有 worker 停下
            this.fatal = err;
            this.states[idx] = 'pending';
            this.abortAll();
            return;
          }
          console.warn(`[流译] 片段 ${idx} 失败：${err && err.message}`);
          this.states[idx] = 'failed';
        }
        this.emit();
      }
    }

    /**
     * 翻译 units[from..to]，直到全部编号都有译文，或用完尝试次数。
     * 截断：缺的是结尾一段就只补那一段；整段都没有就对半拆。零散缺漏：只补缺的编号。
     */
    translateRange(alive, from, to, depth = 0) {
      return this.translateRangeOn(this.units, this.texts, alive, from, to, depth, () => this.emit());
    }

    async translateRangeOn(units, texts, alive, from, to, depth = 0, onApplied = () => this.emit()) {
      const target = units.slice(from, to + 1);
      if (target.length === 0) return;
      const maxRetries = Math.max(0, Number(LT.SUBS.MAX_RETRIES ?? (LT.SUBS.MAX_ATTEMPTS - 1)) || 3);
      let valAttempt = 0;
      for (;;) {
        if (!alive()) throw abortError();
        const ctx = LT.Chunker.context(units, from, to, LT.SUBS.CONTEXT_UNITS);
        const res = await this.requestWithRetry(
          LT.Chunker.formatRequest({ before: ctx.before, target, after: ctx.after }),
          alive
        );
        if (!alive()) throw abortError();
        const parsed = LT.Chunker.parseResponse(res.text);
        const check = LT.Chunker.validate(parsed.map, target);
        this.applyTo(texts, parsed.map, target, onApplied);
        let missingUnits = target.filter((u) => texts[u.id - 1] == null);
        if (missingUnits.length === 0) return;

        if (depth < 8 && LT.Chunker.looksTruncated(res.finishReason, check.missing, target)) {
          let tailCount = 0;
          for (let i = target.length - 1; i >= 0 && texts[target[i].id - 1] == null; i--) tailCount++;
          if (tailCount > 0 && tailCount < target.length) {
            await this.translateRangeOn(units, texts, alive, to - tailCount + 1, to, depth + 1, onApplied);
            if (!alive()) throw abortError();
            missingUnits = target.filter((u) => texts[u.id - 1] == null);
            if (missingUnits.length === 0) return;
          } else if (missingUnits.length === target.length && target.length >= LT.SUBS.MIN_SPLIT_UNITS * 2) {
            const mid = from + Math.floor(target.length / 2);
            await this.translateRangeOn(units, texts, alive, from, mid - 1, depth + 1, onApplied);
            return this.translateRangeOn(units, texts, alive, mid, to, depth + 1, onApplied);
          }
        }

        const missingSet = new Set(missingUnits.map((u) => u.id));
        if (missingUnits.length <= Math.max(3, Math.ceil(target.length * 0.3))) {
          let fixed = false;
          try {
            const reference = pickNearbyReference(target, missingSet);
            const topup = await this.requestWithRetry(
              LT.Chunker.formatRequest({ before: [...ctx.before, ...reference], target: missingUnits, after: ctx.after }),
              alive
            );
            if (!alive()) throw abortError();
            const again = LT.Chunker.parseResponse(topup.text);
            this.applyTo(texts, again.map, missingUnits, onApplied);
            fixed = missingUnits.every((u) => texts[u.id - 1] != null);
          } catch (err) {
            if (isAbort(err) || (err && err.fatal)) throw err;
          }
          if (fixed) return;
          // 只剩极短的语气词或 [音楽] 这类标记还缺：照抄原文，不为它们再发整块
          const still = missingUnits.filter((u) => texts[u.id - 1] == null);
          if (still.every((u) => u.text.length <= 3 || TINY_RE.test(u.text))) {
            for (const u of still) texts[u.id - 1] = u.text;
            onApplied();
            return;
          }
        }

        valAttempt++;
        if (valAttempt > maxRetries) {
          throw new Error(`片段 ${target[0].id}-${target[target.length - 1].id} 校验未通过（缺 ${missingUnits.length} 条）`);
        }
        this.translateRetryHint = `校验重试 ${valAttempt}/${maxRetries}`;
        this.lastNoteAt = 0;
        this.emit();
        await this.sleep(LT.SUBS.BACKOFF_MS, alive);
      }
    }

    async requestWithRetry(user, alive) {
      let attempt = 0;
      for (;;) {
        if (!alive()) throw abortError();
        await this.waitCooldown(alive);
        if (!alive()) throw abortError();
        try {
          const res = await this.request(user);
          if (this.translateRetryHint) {
            this.translateRetryHint = '';
            this.lastNoteAt = 0;
            this.emit();
          }
          return res;
        } catch (err) {
          attempt = await this.retryAfter(err, attempt, alive);
        }
      }
    }

    /** 请求出错后决定等多久再试（默认最多重试 3 次，429 额外宽限）；致命或取消直接抛出。 */
    async retryAfter(err, attempt, alive) {
      if (!alive() || isAbort(err) || (err && err.fatal)) throw err;
      const next = attempt + 1;
      const status = (err && err.status) || 0;
      const rateLimited = status === 429;
      const transient = !!(err && err.retryable) || rateLimited || status === 408 || status === 200 || status >= 500 || status === 0;
      const maxRetries = Math.max(0, Number(LT.SUBS.MAX_RETRIES ?? (LT.SUBS.MAX_ATTEMPTS - 1)) || 3);
      const retryLimit = maxRetries + (rateLimited ? 3 : 0);
      if (!transient || next > retryLimit) {
        this.translateRetryHint = '';
        throw err;
      }
      const wait = (err && err.retryAfterMs) || Math.min(30000, LT.SUBS.BACKOFF_MS * Math.pow(2, next - 1));
      if (rateLimited) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wait);
      this.translateRetryHint = rateLimited
        ? `限流等待 ${Math.max(1, Math.round(wait / 1000))}s`
        : `重试 ${next}/${retryLimit}`;
      this.lastNoteAt = 0;
      this.emit();
      console.warn(`[流译] 请求失败（${err && err.message}），${Math.round(wait / 1000)} 秒后第 ${next}/${retryLimit} 次重试`);
      await this.sleep(wait, alive);
      return next;
    }

    async request(user) {
      if (this.fatal) throw this.fatal;
      const ac = new AbortController();
      this.controllers.add(ac);
      this.requests++;
      try {
        return await LT.TextModel.translate({ config: this.config, system: this.system, user, signal: ac.signal });
      } finally {
        this.controllers.delete(ac);
      }
    }

    apply(map, units) {
      this.applyTo(this.texts, map, units, () => this.emit());
    }

    applyTo(texts, map, units, onApplied) {
      let changed = false;
      for (const u of units) {
        const t = map.get(u.id);
        if (t != null && t.trim()) {
          texts[u.id - 1] = t.trim();
          changed = true;
        }
      }
      if (changed) onApplied?.();
    }

    async waitCooldown(alive) {
      while (Date.now() < this.cooldownUntil) {
        await this.sleep(Math.min(1000, this.cooldownUntil - Date.now()), alive);
      }
    }

    /** 分片睡眠：取消后最多半秒就能退出，不用等完整个退避时间。 */
    async sleep(ms, alive) {
      let left = ms;
      while (left > 0) {
        if (!alive()) throw abortError();
        const step = Math.min(500, left);
        await new Promise((r) => setTimeout(r, step));
        left -= step;
      }
      if (!alive()) throw abortError();
    }

    // ---------- 显示 ----------

    /** 每 200ms 调一次：按播放时间挑当前条，广告期间清空。 */
    tick() {
      if (!this.units || !this.visible || this.phase === 'idle') return;
      const video = this.getVideo();
      if (!video) return;
      if (LT.YouTube.adShowing()) {
        if (this.lastIdx !== -3) {
          this.caption.showTimed('', '');
          this.lastIdx = -3;
        }
        return;
      }
      const idx = LT.SubsScheduler.indexAt(this.units, video.currentTime * 1000);
      const text = idx >= 0 ? this.texts[idx] : undefined;
      if (idx !== this.lastIdx || text !== this.lastText) {
        // 原文总是一起给：双语 / 仅原文模式下还没翻到的条目先显示原文，仅译文模式由字幕层忽略
        this.caption.showTimed(text || '', idx >= 0 ? this.units[idx].text : '');
        this.lastIdx = idx;
        this.lastText = text;
      }
      if (this.phase === 'translating' || (this.phase === 'transcribing' && this.units && this.units.length)) {
        this.progressNote();
      }
    }
  }

  LT.VideoSubsController = VideoSubsController;
  LT.fmtClock = fmtClock;
})();
