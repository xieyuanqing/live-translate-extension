'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractVideoId, normalizeScheduleSeconds } = require('./lib/media');
const { JobManager } = require('./lib/jobs');
const { registerAdapter } = require('./lib/adapters');

registerAdapter('gemini', require('./lib/adapters/gemini'));
registerAdapter('openai-audio', require('./lib/adapters/openai-audio'));

const MAX_BODY_BYTES = 1024 * 1024;

function resolveDir(baseDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function loadConfig() {
  const customPath = process.env.LIUYI_ASR_CONFIG;
  const configPath = customPath
    ? path.resolve(customPath)
    : path.join(__dirname, 'config.json');
  const fallbackPath = path.join(__dirname, 'config.example.json');

  let loadedPath = configPath;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    loadedPath = fallbackPath;
    config = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }

  const baseDir = path.dirname(loadedPath);
  if (process.env.LIUYI_ASR_AUTH_TOKEN !== undefined && process.env.LIUYI_ASR_AUTH_TOKEN !== '') {
    config.authToken = process.env.LIUYI_ASR_AUTH_TOKEN;
  }
  if (process.env.LIUYI_ASR_PORT) {
    config.port = Number(process.env.LIUYI_ASR_PORT);
  }
  if (process.env.LIUYI_ASR_HOST) {
    config.host = process.env.LIUYI_ASR_HOST;
  }
  if (process.env.LIUYI_ASR_CACHE_DIR) {
    config.cacheDir = process.env.LIUYI_ASR_CACHE_DIR;
  }
  if (process.env.LIUYI_ASR_TEMP_DIR) {
    config.tempDir = process.env.LIUYI_ASR_TEMP_DIR;
  }
  if (process.env.LIUYI_ASR_DEFAULT_MODEL) {
    config.defaultModel = process.env.LIUYI_ASR_DEFAULT_MODEL;
  }

  config.cacheDir = resolveDir(baseDir, config.cacheDir || './cache');
  if (config.tempDir) {
    config.tempDir = resolveDir(baseDir, config.tempDir);
  }

  for (const model of config.models || []) {
    const envKey = `LIUYI_ASR_MODEL_${String(model.id).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    if (process.env[envKey]) {
      model.apiKey = process.env[envKey];
    }
  }
  return config;
}

function publicModels(config) {
  return (config.models || [])
    .filter(item => item && item.enabled !== false)
    .map(item => ({
      id: item.id,
      label: item.label || item.id,
      provider: item.provider,
      description: item.description || '',
      supportsContext: item.supportsContext !== false
    }));
}

function resolveDefaultModel(config, models) {
  if (config.defaultModel && models.some(item => item.id === config.defaultModel)) {
    return config.defaultModel;
  }
  return models[0]?.id || '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let settled = false;

    const fail = (message, statusCode = 400) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      reject(err);
    };

    req.on('data', chunk => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        fail('请求体过大', 413);
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON 请求体必须为对象');
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('JSON 请求体无效');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function viewJob(job, afterSeq = 0) {
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    downloadProgress: job.downloadProgress || 0,
    durationMs: job.durationMs || 0,
    doneDurationMs: job.doneDurationMs || 0,
    stage: job.stage,
    model: job.model,
    activeModel: job.activeModel || job.model,
    usingFallback: Boolean(job.usingFallback),
    provider: job.provider,
    lang: job.lang,
    totalChunks: job.totalChunks || 0,
    doneChunks: job.doneChunks || 0,
    seq: job.seq || 0,
    chunks: (job.readyChunks || []).filter(c => c.seq > afterSeq),
    units: job.status === 'done' ? job.units : [],
    error: job.error || ''
  };
}

function normalizePathname(rawUrl) {
  const pathname = new URL(rawUrl || '/', 'http://localhost').pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function createServer(options = {}) {
  const config = options.config || loadConfig();
  const manager = options.manager || new JobManager(config, options);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const send = (statusCode, payload) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    if (config.authToken && req.headers.authorization !== `Bearer ${config.authToken}`) {
      send(401, { ok: false, error: '访问令牌无效或缺失' });
      return;
    }

    try {
      const pathname = normalizePathname(req.url);

      if (req.method === 'GET' && pathname === '/health') {
        const models = publicModels(config);
        send(200, {
          ok: true,
          service: 'liuyi-vps-asr',
          version: '1.0.0',
          defaultModel: resolveDefaultModel(config, models),
          models
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        const models = publicModels(config);
        send(200, {
          ok: true,
          defaultModel: resolveDefaultModel(config, models),
          models
        });
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = manager.get(decodeURIComponent(jobMatch[1]));
        if (!job) {
          send(404, { ok: false, error: '任务不存在' });
          return;
        }
        const query = new URL(req.url, 'http://localhost').searchParams;
        const afterSeq = Math.max(0, Number(query.get('afterSeq')) || 0);
        const rawPrefer = query.get('preferMs');
        if (rawPrefer !== null && typeof job.reprioritize === 'function') {
          const preferMs = Math.max(0, Math.round(Number(rawPrefer)));
          if (Number.isFinite(preferMs) && Math.abs(preferMs - (job.lastPreferMs || 0)) >= 15000) {
            job.reprioritize(preferMs);
          }
        }
        send(200, viewJob(job, afterSeq));
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const status = manager.cancelJob(decodeURIComponent(cancelMatch[1]));
        if (!status) {
          send(404, { ok: false, error: '任务不存在' });
          return;
        }
        send(200, { ok: true, status });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/transcribe') {
        const data = await readJsonBody(req);
        const videoId = extractVideoId(data.videoId || data.url);
        const enabledModels = (config.models || []).filter(item => item && item.enabled !== false);
        const wantedModel = data.model || config.defaultModel || enabledModels[0]?.id;
        const model = enabledModels.find(item => item.id === wantedModel);
        if (!model) {
          send(400, { ok: false, error: `模型不存在或已禁用：${wantedModel || '(未指定)'}` });
          return;
        }

        const result = await manager.create({
          videoId,
          url: data.url,
          sourceLang: data.sourceLang || 'auto',
          modelConfig: model,
          context: data.context,
          force: Boolean(data.force),
          preferMs: Math.max(0, Number(data.preferMs) || 0)
        });
        const job = result.job;
        const payload = {
          ok: true,
          jobId: job.jobId,
          status: result.cached ? 'done' : job.status,
          model: model.id,
          provider: model.provider,
          lang: job.lang,
          progress: job.progress,
          stage: job.stage,
          totalChunks: job.totalChunks || 0,
          doneChunks: job.doneChunks || 0,
          seq: job.seq || 0
        };
        if (result.cached) {
          payload.cached = true;
          payload.units = job.units;
        }
        send(result.cached ? 200 : 202, payload);
        return;
      }

      send(404, { ok: false, error: '接口不存在' });
    } catch (err) {
      const code = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      send(code, { ok: false, error: err?.message || '请求处理失败' });
    }
  });

  return { server, config, manager };
}

if (require.main === module) {
  const { server, config, manager } = createServer();
  const port = Number(config.port) || 8787;
  const host = config.host || '0.0.0.0';
  server.listen(port, host, () => {
    const models = publicModels(config);
    manager.log('server.start', {
      listen: `http://${host}:${port}`,
      models: models.length,
      defaultModel: resolveDefaultModel(config, models),
      schedule: normalizeScheduleSeconds(config)
    });
  });
}

module.exports = { createServer, loadConfig, publicModels };
