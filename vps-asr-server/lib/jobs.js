'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { prepareChunks, downloadAudio, planSegments, cutSegment, cutAllFallback } = require('./media');
const { getAdapter } = require('./adapters');

const MAX_STORED_JOBS = 200;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);
const RATE_LIMIT_COOLDOWN_MS = 90000;

function safeKeyPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function formatLogValue(value) {
  if (Array.isArray(value)) return `[${value.join(',')}]`;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function defaultLogger(event, fields = {}) {
  const parts = [`[liuyi-asr]`, new Date().toISOString(), event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${formatLogValue(value)}`);
  }
  console.log(parts.join(' '));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('任务已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('任务已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return async function withLimit(fn) {
    if (active >= limit) {
      await new Promise(resolve => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

function mergeAndNormalizeUnits(rawUnits) {
  const units = rawUnits
    .filter(item => item && String(item.text || '').trim())
    .map(item => ({
      startMs: Math.max(0, Math.round(Number(item.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(item.endMs) || 0)),
      text: String(item.text).trim()
    }))
    .filter(item => item.endMs > item.startMs);

  units.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const normalized = [];
  for (const item of units) {
    if (normalized.length) {
      const prev = normalized[normalized.length - 1];
      if (item.startMs < prev.endMs) {
        item.startMs = prev.endMs;
      }
      if (item.endMs <= item.startMs) {
        item.endMs = item.startMs + 200;
      }
    }
    normalized.push(item);
  }
  return normalized;
}

class JobManager {
  constructor(config, options = {}) {
    this.config = config;
    this.cacheDir = config.cacheDir || path.join(__dirname, '..', 'cache');
    this.jobs = new Map();
    this.active = new Map();
    // 跨任务共享 429 冷却表，避免连续打开新视频时反复撞限流模型
    this.cooldown = new Map();
    this.customPrepareChunks = options.prepareChunks || null;
    this.downloadAudio = options.downloadAudio || downloadAudio;
    this.cutSegment = options.cutSegment || cutSegment;
    this.cutAllFallback = options.cutAllFallback || cutAllFallback;
    this.prepareChunks = options.prepareChunks || prepareChunks;
    this.log = options.logger === null || options.logger === false
      ? () => {}
      : (typeof options.logger === 'function' ? options.logger : defaultLogger);
  }

  key(videoId, lang, modelId) {
    return `${safeKeyPart(videoId)}__${safeKeyPart(lang || 'auto')}__${safeKeyPart(modelId)}`;
  }

  async readCache(cacheKey) {
    try {
      const raw = await fs.readFile(path.join(this.cacheDir, `${cacheKey}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writeCache(cacheKey, units) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const filePath = path.join(this.cacheDir, `${cacheKey}.json`);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ units, savedAt: new Date().toISOString() }));
    await fs.rename(tmpPath, filePath);
  }

  pruneOldJobs() {
    if (this.jobs.size <= MAX_STORED_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_STORED_JOBS) break;
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        this.jobs.delete(id);
      }
    }
  }

  makeJob(videoId, lang, modelConfig, units, cacheKey, status) {
    const job = {
      jobId: crypto.randomUUID(),
      videoId,
      lang,
      model: modelConfig.id,
      activeModel: modelConfig.id,
      usingFallback: false,
      provider: modelConfig.provider,
      status,
      progress: status === 'done' ? 100 : 0,
      downloadProgress: status === 'done' ? 100 : 0,
      durationMs: 0,
      doneDurationMs: 0,
      stage: status === 'done' ? '命中服务端缓存' : '已加入队列',
      units,
      totalChunks: 0,
      doneChunks: 0,
      seq: 0,
      readyChunks: [],
      error: '',
      key: cacheKey,
      lastPreferMs: 0,
      controller: new AbortController()
    };
    this.jobs.set(job.jobId, job);
    this.pruneOldJobs();
    return job;
  }

  async create({ videoId, url, sourceLang, modelConfig, context, force = false, preferMs = 0 }) {
    const lang = sourceLang || 'auto';
    const cacheKey = this.key(videoId, lang, modelConfig.id);

    if (!force) {
      const cached = await this.readCache(cacheKey);
      if (cached && Array.isArray(cached.units)) {
        this.log('job.cache_hit', { videoId, model: modelConfig.id, lang, units: cached.units.length });
        return {
          cached: true,
          job: this.makeJob(videoId, lang, modelConfig, cached.units, cacheKey, 'done')
        };
      }
    }

    const activeId = this.active.get(cacheKey);
    if (activeId && this.jobs.has(activeId)) {
      const existing = this.jobs.get(activeId);
      if (preferMs > 0 && typeof existing.reprioritize === 'function') {
        existing.reprioritize(preferMs);
      }
      return { cached: false, job: existing };
    }

    const job = this.makeJob(videoId, lang, modelConfig, [], cacheKey, 'queued');
    job.lastPreferMs = preferMs;
    this.active.set(cacheKey, job.jobId);
    this.run(job, { videoId, url, sourceLang: lang, modelConfig, context, preferMs, force });
    return { cached: false, job };
  }

  // 候选模型：所选模型在前，其 fallback 依次在后（去重）
  candidates(modelConfig) {
    const all = this.config.models || [];
    const out = [modelConfig];
    for (const id of modelConfig.fallback || []) {
      const model = all.find(item => item && item.id === id && item.enabled !== false);
      if (model && !out.includes(model)) out.push(model);
    }
    return out;
  }

  // 429 立即换下一个候选并让该模型冷却；5xx/网络错误按 5s、10s 退避重试后再换
  async transcribeWithFallback(chunk, args, signal, hooks = {}) {
    const maxRetries = Math.max(0, Number(this.config.maxRetries ?? 2));
    const models = this.candidates(args.modelConfig);
    let lastError = null;
    let skippedByCooldown = false;
    for (const [index, modelConfig] of models.entries()) {
      const isLastModel = index === models.length - 1;
      if (!isLastModel && (this.cooldown.get(modelConfig.id) || 0) > Date.now()) {
        skippedByCooldown = true;
        continue;
      }
      if (index > 0 && skippedByCooldown) {
        skippedByCooldown = false;
        hooks.onFallback?.(args.modelConfig.id, modelConfig.id, 'cooldown');
      }
      const adapter = getAdapter(modelConfig.provider);
      if (!adapter) {
        lastError = new Error(`未注册转写适配器：${modelConfig.provider}`);
        continue;
      }
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) throw new Error('任务已取消');
        try {
          const rows = await adapter.transcribeChunk({
            ...chunk,
            sourceLang: args.sourceLang,
            context: args.context,
            modelConfig,
            signal
          });
          return { rows, modelId: modelConfig.id, usedFallback: index > 0 };
        } catch (err) {
          lastError = err;
          if (signal.aborted) throw err;
          if (NON_RETRYABLE_STATUS.has(err.status)) break;
          if (err.status === 429) {
            this.cooldown.set(modelConfig.id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
            if (!isLastModel) {
              const nextModel = models[index + 1];
              hooks.onFallback?.(modelConfig.id, nextModel?.id || '', 429);
              break;
            }
          }
          if (attempt >= maxRetries) {
            if (!isLastModel) {
              const nextModel = models[index + 1];
              hooks.onFallback?.(modelConfig.id, nextModel?.id || '', err.status || 'error');
            }
            break;
          }
          const backoff = err.status === 429 || err.status >= 500 ? 5000 * (attempt + 1) : 1000 * (attempt + 1);
          hooks.onRetry?.(modelConfig.id, attempt + 1, maxRetries, err.status || 0, backoff);
          await sleep(backoff, signal);
        }
      }
    }
    throw lastError || new Error('没有可用的转写模型');
  }

  async run(job, args) {
    const controller = job.controller;
    const signal = controller.signal;
    const shortId = job.jobId.slice(0, 8);
    const jobStartedAt = Date.now();
    const concurrency = Math.max(1, Number(this.config.chunkConcurrency) || 4);
    const cutConcurrency = Math.max(1, Number(this.config.cutConcurrency) || 2);
    const withCutLimit = createSemaphore(cutConcurrency);
    let descriptor = null;

    this.log('job.start', {
      job: shortId,
      videoId: args.videoId,
      model: args.modelConfig.id,
      lang: args.sourceLang,
      preferMs: args.preferMs || 0,
      force: args.force ? 1 : 0
    });

    try {
      job.status = 'downloading';
      job.downloadProgress = 0;
      job.stage = '正在下载音频';

      let queue = [];
      let needsCut = false;
      let scheduleSeconds = [];
      const downloadStartedAt = Date.now();

      if (this.customPrepareChunks) {
        const prepared = await this.customPrepareChunks({
          ...args,
          config: this.config,
          signal,
          onStage: stage => {
            if (!signal.aborted) job.stage = stage;
          },
          onDownloadProgress: pct => {
            if (signal.aborted) return;
            job.downloadProgress = pct;
            job.stage = pct >= 100 ? '音频下载完成，准备切段' : `正在下载音频 ${pct}%`;
          }
        });
        queue = (prepared.chunks || []).map((chunk, idx) => ({
          ...chunk,
          index: Number.isInteger(chunk.index) ? chunk.index : idx,
          startMs: chunk.offsetMs ?? chunk.startMs ?? 0
        }));
        job.durationMs = queue.reduce((sum, item) => sum + Math.max(0, Number(item.durationMs) || 0), 0);
        job.downloadProgress = 100;
      } else {
        descriptor = await this.downloadAudio({
          ...args,
          config: this.config,
          signal,
          onStage: stage => {
            if (!signal.aborted) job.stage = stage;
          },
          onDownloadProgress: pct => {
            if (signal.aborted) return;
            job.downloadProgress = pct;
            job.stage = pct >= 100 ? '音频下载完成，准备切段' : `正在下载音频 ${pct}%`;
          }
        });
        if (signal.aborted) throw new Error('任务已取消');
        job.downloadProgress = 100;
        job.durationMs = Math.max(0, Number(descriptor.durationMs) || 0);

        if (descriptor.durationMs > 0) {
          const plan = planSegments(descriptor.durationMs, {
            chunkScheduleSeconds: this.config.chunkScheduleSeconds,
            headChunkSeconds: this.config.headChunkSeconds,
            chunkSeconds: this.config.chunkSeconds,
            preferMs: args.preferMs
          });
          queue = plan.priorityOrder.map(i => plan.segments[i]);
          scheduleSeconds = plan.scheduleSeconds || [];
          needsCut = true;
        } else {
          queue = await this.cutAllFallback({
            inputPath: descriptor.inputPath,
            tempDir: descriptor.tempDir,
            config: this.config,
            signal
          });
          job.durationMs = queue.reduce((sum, item) => sum + Math.max(0, Number(item.durationMs) || 0), 0);
        }

        this.log('job.download_done', {
          job: shortId,
          videoId: args.videoId,
          durationSec: Math.round(job.durationMs / 1000),
          segments: queue.length,
          schedule: scheduleSeconds.length ? scheduleSeconds : undefined,
          ms: Date.now() - downloadStartedAt
        });
      }

      if (signal.aborted) throw new Error('任务已取消');

      if (!getAdapter(args.modelConfig.provider)) {
        throw new Error(`未注册转写适配器：${args.modelConfig.provider}`);
      }

      const total = queue.length;
      let done = 0;
      const formatStage = note => {
        if (!total) return '无音频分片';
        const suffix = note || (job.usingFallback ? '备用模型' : '');
        return suffix ? `正在转写 ${done}/${total} 段（${suffix}）` : `正在转写 ${done}/${total} 段`;
      };

      job.totalChunks = total;
      job.status = 'transcribing';
      job.stage = formatStage();

      // 支持中途收到新的 preferMs 时把尚未开始的分片按距离重排：含当前位置最先，其次向后，最后回头补
      job.reprioritize = targetMs => {
        const ms = Math.max(0, Math.round(Number(targetMs) || 0));
        job.lastPreferMs = ms;
        if (!queue.length) return;
        const rank = seg => {
          const s = seg.startMs ?? seg.offsetMs ?? 0;
          const e = seg.endMs ?? (s + (seg.durationMs ?? 0));
          if (ms >= s && ms < e) return -1;
          if (s >= ms) return s - ms;
          return 1e12 + s;
        };
        queue.sort((a, b) => rank(a) - rank(b));
        this.log('job.reprioritize', { job: shortId, preferMs: ms, nextSeg: queue[0]?.index });
      };

      const collected = [];

      const worker = async () => {
        while (queue.length) {
          if (signal.aborted) throw new Error('任务已取消');
          const seg = queue.shift();
          if (!seg) break;

          const cutStartedAt = Date.now();
          const actual = needsCut
            ? await withCutLimit(() =>
                this.cutSegment({
                  inputPath: descriptor.inputPath,
                  tempDir: descriptor.tempDir,
                  index: seg.index,
                  startMs: seg.startMs,
                  durationMs: seg.durationMs,
                  config: this.config,
                  signal
                })
              )
            : seg;
          const cutMs = needsCut ? Date.now() - cutStartedAt : 0;

          if (signal.aborted) throw new Error('任务已取消');

          const segOffset = actual.offsetMs ?? seg.startMs ?? 0;
          const segDuration = actual.durationMs ?? seg.durationMs ?? 0;
          let chunkRows = [];
          let hitModel = args.modelConfig.id;
          let asrMs = 0;

          if (actual.audioBuffer && actual.audioBuffer.length > 0) {
            const asrStartedAt = Date.now();
            const result = await this.transcribeWithFallback(
              { ...actual, offsetMs: segOffset, durationMs: segDuration },
              args,
              signal,
              {
                onFallback: (fromId, toId, reason) => {
                  job.usingFallback = Boolean(toId && toId !== args.modelConfig.id);
                  if (toId) job.activeModel = toId;
                  if (job.status === 'transcribing') job.stage = formatStage();
                  this.log('job.chunk_fallback', { job: shortId, seg: seg.index, from: fromId, to: toId, reason });
                },
                onRetry: (modelId, attempt, maxRetries, status, backoffMs) => {
                  if (job.status === 'transcribing') job.stage = formatStage(`重试 ${attempt}/${maxRetries}`);
                  this.log('job.chunk_retry', {
                    job: shortId,
                    seg: seg.index,
                    model: modelId,
                    attempt: `${attempt}/${maxRetries}`,
                    status,
                    backoffMs
                  });
                }
              }
            );
            asrMs = Date.now() - asrStartedAt;
            hitModel = result.modelId;
            job.activeModel = hitModel;
            job.usingFallback = result.usedFallback;
            chunkRows = (result.rows || []).map(row => ({
              startMs: segOffset + row.startMs,
              endMs: segOffset + row.endMs,
              text: row.text
            }));
          }

          const readyUnits = mergeAndNormalizeUnits(chunkRows);
          collected.push(...readyUnits);
          done += 1;
          job.doneChunks = done;
          job.doneDurationMs += Math.max(0, segDuration);
          job.readyChunks.push({
            seq: ++job.seq,
            index: seg.index,
            startMs: segOffset,
            endMs: segOffset + segDuration,
            units: readyUnits
          });
          job.progress = job.durationMs > 0
            ? Math.min(99, Math.round((job.doneDurationMs / job.durationMs) * 100))
            : (total ? Math.min(99, Math.round((done / total) * 100)) : 100);
          job.stage = formatStage();

          this.log('job.chunk_done', {
            job: shortId,
            seg: seg.index,
            done: `${done}/${total}`,
            model: hitModel,
            cutMs,
            asrMs,
            units: readyUnits.length,
            bytes: actual.audioBuffer ? actual.audioBuffer.length : 0
          });
        }
      };

      const workerCount = Math.min(concurrency, total || 1);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (signal.aborted) throw new Error('任务已取消');

      const units = mergeAndNormalizeUnits(collected);
      if (units.length > 0) {
        await this.writeCache(job.key, units);
      }

      job.units = units;
      job.status = 'done';
      job.progress = 100;
      job.stage = '转写完成';
      this.log('job.done', {
        job: shortId,
        videoId: args.videoId,
        model: job.activeModel,
        chunks: total,
        units: units.length,
        totalMs: Date.now() - jobStartedAt
      });
    } catch (err) {
      if (signal.aborted) {
        job.status = 'cancelled';
        job.error = '';
        job.stage = '已取消';
        this.log('job.cancelled', {
          job: shortId,
          videoId: args.videoId,
          done: `${job.doneChunks}/${job.totalChunks}`,
          totalMs: Date.now() - jobStartedAt
        });
      } else {
        job.status = 'error';
        job.error = err?.message || String(err);
        job.stage = '转写失败';
        this.log('job.error', {
          job: shortId,
          videoId: args.videoId,
          error: String(job.error).slice(0, 200),
          totalMs: Date.now() - jobStartedAt
        });
      }
    } finally {
      delete job.reprioritize;
      if (descriptor) await descriptor.cleanup();
      if (this.active.get(job.key) === job.jobId) {
        this.active.delete(job.key);
      }
      delete job.controller;
    }
  }

  get(jobId) {
    return this.jobs.get(jobId);
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (['done', 'error', 'cancelled'].includes(job.status)) {
      return job.status;
    }
    job.status = 'cancelled';
    job.stage = '已取消';
    job.controller?.abort();
    return 'cancelled';
  }
}

module.exports = { JobManager, mergeAndNormalizeUnits, defaultLogger };
