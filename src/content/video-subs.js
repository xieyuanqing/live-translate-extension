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
  const settingsHash = (settings) => {
    const config = LT.TextModel.resolve(settings);
    return LT.SubsCache.fingerprint({
      sourceLang: settings.sourceLang, targetLang: settings.targetLang,
      scene: LT.Settings.scene(settings), useMetadata: settings.useMetadata,
      metadataLimit: settings.metadataLimit, manualContext: settings.manualContext,
      extraInstruction: settings.subsExtraInstruction || '',
      apiType: config.apiType, baseUrl: config.baseUrl, model: config.model,
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
      this.phase = 'idle'; // idle | reading | translating | ready | partial | error
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
      };
    }

    emit() {
      if (this.phase === 'translating') this.progressNote();
      try {
        this.onStatus();
      } catch (_) {
        /* 状态推送失败不影响任务 */
      }
    }

    note(text, kind, autoHide) {
      this.lastNote = text;
      this.caption.setStatus(text, kind, autoHide);
    }

    progressNote() {
      const now = Date.now();
      if (now - this.lastNoteAt < 1000) return;
      this.lastNoteAt = now;
      const s = this.status();
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      const where = s.frontierIdx >= 0 ? `可看到 ${fmtClock(s.frontierMs)}` : '正在翻译当前位置…';
      const text = `流译：整片翻译中 ${pct}% · ${where}`;
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
      const config = LT.TextModel.resolve(settings);
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
      const active = this.phase === 'reading' || this.phase === 'translating';
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
      if (this.reading && LT.YouTube && typeof LT.YouTube.cancelCaptions === 'function') LT.YouTube.cancelCaptions();
      this.reading = false;
      for (const c of this.controllers) {
        try {
          c.abort();
        } catch (_) {
          /* 已结束 */
        }
      }
      this.controllers.clear();
    }

    // ---------- 主流程 ----------

    /**
     * @param {{settings:object, meta:object|null, tempContext:string, force?:boolean}} args
     *   force：重新翻译，丢弃当前配置指纹下的旧译文
     */
    async start({ settings, meta, tempContext, force = false }) {
      if (this.phase === 'reading' || this.phase === 'translating') return;
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
      this.note('流译：读取字幕轨…', 'warn', false);
      this.emit();

      try {
        const config = LT.TextModel.resolve(settings);
        const requireModel = () => {
          if (!config.key) throw new Error('未配置 API Key，请在扩展设置里填写');
          if (!config.model) throw new Error('未填写文字模型名，请在扩展设置的「整片字幕」里填写');
        };

        // ---- 1. 原文：优先缓存里的，没有再读 YouTube ----
        let cachedMeta = (await LT.SubsCache.getMeta(videoId)) || null;
        if (!alive()) return;
        let units = null;
        let trackKey = '';
        let trackLabel = '';
        let isAsr = false;
        if (cachedMeta && cachedMeta.trackKey) {
          const src = await LT.SubsCache.getSource(videoId, cachedMeta.trackKey);
          if (!alive()) return;
          const fits =
            validSource(src) &&
            (settings.sourceLang === 'auto' || langBase(src.lang) === langBase(settings.sourceLang));
          if (fits) {
            units = unpack(src.units);
            trackKey = cachedMeta.trackKey;
            trackLabel = cachedMeta.trackLabel || '';
            isAsr = !!src.isAsr;
          }
        }
        if (!units) {
          // 原文失效后编号可能完全变化，不能走「旧设置缓存」的复用路径。
          cachedMeta = null;
          const read = await this.readTrack(videoId, settings, alive);
          if (!read) return;
          ({ units, trackKey, trackLabel, isAsr } = read);
        }
        const sourceHash = LT.SubsCache.fingerprint(pack(units));
        if (cachedMeta && cachedMeta.sourceHash && cachedMeta.sourceHash !== sourceHash) cachedMeta = null;

        // ---- 2. 提示词与配置指纹 ----
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
          chunk: [LT.SUBS.CHUNK_UNITS, LT.SUBS.CHUNK_CHARS],
          trackKey,
          sourceHash,
          targetLang: settings.targetLang,
          apiType: config.apiType,
          baseUrl: config.baseUrl,
          model: config.model,
          system,
        });

        // ---- 3. 分块，接上已有译文 ----
        const chunks = LT.Chunker.plan(units, {
          chunkUnits: LT.SUBS.CHUNK_UNITS,
          chunkChars: LT.SUBS.CHUNK_CHARS,
        });
        let cachedChunks = [];
        if (cachedMeta && cachedMeta.fp && cachedMeta.fp !== fp) {
          if (!force && cachedMeta.trackKey === trackKey) {
            // 旧设置缓存继续显示，部分缓存也不能混入新配置的译文。
            const loaded = await this.loadCached(cachedMeta, gen);
            if (!alive()) return;
            if (loaded) {
              this.staleConfig = true;
              this.hasCache = true;
              this.config = config;
              this.note('流译：已加载旧设置翻译的缓存字幕', 'ok', true);
              this.emit();
              return;
            }
          }
          requireModel();
          await LT.SubsCache.removeChunks(videoId);
          if (!alive()) return;
          cachedMeta = null;
        } else if (cachedMeta && cachedMeta.fp === fp) {
          if (force) {
            requireModel();
            await LT.SubsCache.removeChunks(videoId);
          } else {
            cachedChunks = await LT.SubsCache.getChunks(videoId, fp, chunks.length);
          }
          if (!alive()) return;
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
        if (!alive()) return;

        if (record.complete) {
          this.phase = 'ready';
          this.fromCache = true;
          this.note('流译：整片字幕已就绪（缓存）', 'ok', true);
          this.emit();
          return;
        }

        // ---- 4. 并发翻译 ----
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
      } catch (err) {
        if (!alive() || isAbort(err)) return;
        console.error('[流译] 整片字幕失败', err);
        this.phase = 'error';
        this.error = err && err.message ? err.message : String(err);
        this.note(`流译：${this.error}`, 'err', false);
        this.emit();
      }
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
    async translateRange(alive, from, to, depth = 0) {
      const target = this.units.slice(from, to + 1);
      if (target.length === 0) return;
      let attempt = 0;
      for (;;) {
        if (!alive()) throw abortError();
        await this.waitCooldown(alive);
        if (!alive()) throw abortError();
        const ctx = LT.Chunker.context(this.units, from, to, LT.SUBS.CONTEXT_UNITS);
        let res;
        try {
          res = await this.request(LT.Chunker.formatRequest({ before: ctx.before, target, after: ctx.after }));
        } catch (err) {
          attempt = await this.retryAfter(err, attempt, alive);
          continue;
        }
        if (!alive()) throw abortError();
        const parsed = LT.Chunker.parseResponse(res.text);
        const check = LT.Chunker.validate(parsed.map, target);
        this.apply(parsed.map, target);
        if (check.ok) return;

        if (depth < 8 && LT.Chunker.looksTruncated(res.finishReason, check.missing, target)) {
          if (check.missing.length < target.length) {
            return this.translateRange(alive, to - check.missing.length + 1, to, depth + 1);
          }
          if (target.length >= LT.SUBS.MIN_SPLIT_UNITS * 2) {
            const mid = from + Math.floor(target.length / 2);
            await this.translateRange(alive, from, mid - 1, depth + 1);
            return this.translateRange(alive, mid, to, depth + 1);
          }
        }

        const missingSet = new Set(check.missing);
        const missingUnits = target.filter((u) => missingSet.has(u.id));
        if (missingUnits.length <= Math.max(3, Math.ceil(target.length * 0.3))) {
          let fixed = false;
          try {
            const reference = target.filter((u) => !missingSet.has(u.id));
            const topup = await this.request(
              LT.Chunker.formatRequest({ before: [...ctx.before, ...reference], target: missingUnits, after: ctx.after })
            );
            if (!alive()) throw abortError();
            const again = LT.Chunker.parseResponse(topup.text);
            this.apply(again.map, missingUnits);
            fixed = LT.Chunker.validate(again.map, missingUnits).ok;
          } catch (err) {
            if (isAbort(err) || (err && err.fatal)) throw err;
          }
          if (fixed) return;
          // 只剩极短的语气词或 [音楽] 这类标记还缺：照抄原文，不为它们再发整块
          const still = missingUnits.filter((u) => this.texts[u.id - 1] == null);
          if (still.every((u) => u.text.length <= 3 || TINY_RE.test(u.text))) {
            for (const u of still) this.texts[u.id - 1] = u.text;
            this.emit();
            return;
          }
        }

        attempt++;
        if (attempt >= LT.SUBS.MAX_ATTEMPTS) {
          throw new Error(`片段 ${target[0].id}-${target[target.length - 1].id} 校验未通过（缺 ${check.missing.length} 条）`);
        }
        await this.sleep(LT.SUBS.BACKOFF_MS, alive);
      }
    }

    /** 请求出错后决定等多久再试；不该重试的直接抛出。返回新的尝试次数。 */
    async retryAfter(err, attempt, alive) {
      if (!alive() || isAbort(err) || (err && err.fatal)) throw err;
      const next = attempt + 1;
      const status = (err && err.status) || 0;
      const rateLimited = status === 429;
      const transient = rateLimited || status >= 500 || status === 0;
      const limit = LT.SUBS.MAX_ATTEMPTS + (rateLimited ? 3 : 0);
      if (!transient || next >= limit) throw err;
      const wait = (err && err.retryAfterMs) || LT.SUBS.BACKOFF_MS * Math.pow(2, next - 1);
      if (rateLimited) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wait);
      console.warn(`[流译] 请求失败（${err && err.message}），${Math.round(wait / 1000)} 秒后重试`);
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
      let changed = false;
      for (const u of units) {
        const t = map.get(u.id);
        if (t != null && t.trim()) {
          this.texts[u.id - 1] = t.trim();
          changed = true;
        }
      }
      if (changed) this.emit();
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
      if (this.phase === 'translating') this.progressNote();
    }
  }

  LT.VideoSubsController = VideoSubsController;
  LT.fmtClock = fmtClock;
})();
