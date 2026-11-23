'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { prepareChunks } = require('./media');
const { getAdapter } = require('./adapters');

const MAX_STORED_JOBS = 200;
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

function safeKeyPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
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
    this.prepareChunks = options.prepareChunks || prepareChunks;
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
      provider: modelConfig.provider,
      status,
      progress: status === 'done' ? 100 : 0,
      stage: status === 'done' ? '命中服务端缓存' : '已加入队列',
      units,
      error: '',
      key: cacheKey,
      controller: new AbortController()
    };
    this.jobs.set(job.jobId, job);
    this.pruneOldJobs();
    return job;
  }

  async create({ videoId, url, sourceLang, modelConfig, context, force = false }) {
    const lang = sourceLang || 'auto';
    const cacheKey = this.key(videoId, lang, modelConfig.id);

    if (!force) {
      const cached = await this.readCache(cacheKey);
      if (cached && Array.isArray(cached.units)) {
        return {
          cached: true,
          job: this.makeJob(videoId, lang, modelConfig, cached.units, cacheKey, 'done')
        };
      }
    }

    const activeId = this.active.get(cacheKey);
    if (activeId && this.jobs.has(activeId)) {
      return { cached: false, job: this.jobs.get(activeId) };
    }

    const job = this.makeJob(videoId, lang, modelConfig, [], cacheKey, 'queued');
    this.active.set(cacheKey, job.jobId);
    this.run(job, { videoId, url, sourceLang: lang, modelConfig, context });
    return { cached: false, job };
  }

  async run(job, args) {
    const controller = job.controller;
    const signal = controller.signal;
    const maxRetries = Math.max(0, Number(this.config.maxRetries ?? 2));
    const concurrency = Math.max(1, Number(this.config.chunkConcurrency) || 3);

    try {
      job.status = 'downloading';
      job.stage = '正在下载和切段';
      const prepared = await this.prepareChunks({
        ...args,
        config: this.config,
        signal,
        onStage: stage => {
          if (!signal.aborted) job.stage = stage;
        }
      });

      if (signal.aborted) throw new Error('任务已取消');

      const adapter = getAdapter(args.modelConfig.provider);
      if (!adapter) {
        throw new Error(`未注册转写适配器：${args.modelConfig.provider}`);
      }

      const chunks = prepared.chunks || [];
      const total = chunks.length;
      job.status = 'transcribing';
      job.stage = total ? `正在转写 0/${total} 段` : '无音频分片';

      const collected = [];
      let done = 0;
      const queue = chunks.slice();

      const worker = async () => {
        while (queue.length) {
          if (signal.aborted) throw new Error('任务已取消');
          const chunk = queue.shift();
          let lastError = null;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal.aborted) throw new Error('任务已取消');
            try {
              const rows = await adapter.transcribeChunk({
                ...chunk,
                sourceLang: args.sourceLang,
                context: args.context,
                modelConfig: args.modelConfig,
                signal
              });
              for (const row of rows || []) {
                collected.push({
                  startMs: chunk.offsetMs + row.startMs,
                  endMs: chunk.offsetMs + row.endMs,
                  text: row.text
                });
              }
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
              if (signal.aborted || NON_RETRYABLE_STATUS.has(err.status) || attempt >= maxRetries) {
                break;
              }
              await sleep(300 * (2 ** attempt), signal);
            }
          }

          if (lastError) throw lastError;
          done += 1;
          job.progress = total ? Math.min(99, Math.round((done / total) * 100)) : 100;
          job.stage = `正在转写 ${done}/${total} 段`;
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
    } catch (err) {
      if (signal.aborted) {
        job.status = 'cancelled';
        job.error = '';
        job.stage = '已取消';
      } else {
        job.status = 'error';
        job.error = err?.message || String(err);
        job.stage = '转写失败';
      }
    } finally {
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

module.exports = { JobManager, mergeAndNormalizeUnits };
