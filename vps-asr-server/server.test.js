'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { createServer } = require('./server');
const { extractVideoId, planSegments, parseDownloadPercent } = require('./lib/media');
const { mergeAndNormalizeUnits, JobManager } = require('./lib/jobs');
const gemini = require('./lib/adapters/gemini');
const openai = require('./lib/adapters/openai-audio');
const { registerAdapter } = require('./lib/adapters');

function request(port, method, url, data, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method,
        path: url,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      }
    );
    req.on('error', reject);
    if (data !== undefined && data !== null) req.write(JSON.stringify(data));
    req.end();
  });
}

test('extractVideoId 支持标准、短链、shorts 与 live，拒绝非 YouTube 域名', () => {
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=1'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.throws(() => extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ'));
  assert.throws(() => extractVideoId('bad'));
});

test('Gemini endpoint、时间戳解析（含 HH:MM:SS 与 00:00.5）和请求头', async () => {
  assert.equal(
    gemini.baseEndpoint('https://relay.example.com/v1beta/', 'gemini-3.5-transcribe'),
    'https://relay.example.com/v1beta/models/gemini-3.5-transcribe:generateContent'
  );

  // 00:00.5 必须解析为 500ms，不能再次乘 1000
  assert.deepEqual(
    gemini.parseSegments(
      '```json\n{"segments":[{"start":"00:00.5","end":"00:02.5","text":" hi "},{"start":"1:02:03.5","end":"1:02:05","text":"hour"}]}\n```',
      4000000
    ),
    [
      { startMs: 500, endMs: 2500, text: 'hi' },
      { startMs: 3723500, endMs: 3725000, text: 'hour' }
    ]
  );

  // durationMs === 0 时不应把所有时间戳截成 0
  assert.deepEqual(
    gemini.parseSegments('[{"startMs":100,"endMs":1500,"text":"ok"}]', 0),
    [{ startMs: 100, endMs: 1500, text: 'ok' }]
  );

  const oldFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://relay.example.com/v1beta/models/gemini-3.5-transcribe:generateContent');
      assert.equal(opts.headers['Content-Type'], 'application/json');
      assert.equal(opts.headers['x-goog-api-key'], 'test-key');
      const sent = JSON.parse(opts.body);
      assert.equal(sent.contents[0].parts[0].text.includes('auto'), false);
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"segments":[{"startMs":0,"endMs":1200,"text":"hello"}]}' }] } }
          ]
        }),
        { status: 200 }
      );
    };
    const rows = await gemini.transcribeChunk({
      audioBuffer: Buffer.from('abc'),
      durationMs: 5000,
      sourceLang: 'auto',
      modelConfig: {
        baseUrl: 'https://relay.example.com',
        apiModel: 'gemini-3.5-transcribe',
        apiKey: 'test-key'
      }
    });
    assert.deepEqual(rows, [{ startMs: 0, endMs: 1200, text: 'hello' }]);
  } finally {
    global.fetch = oldFetch;
  }
});

test('Gemini 适配器转写模式发送 audioTranscriptionConfig 并按词级时间戳断句', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      const sent = JSON.parse(opts.body);
      assert.equal(sent.contents[0].role, 'user');
      assert.equal(sent.contents[0].parts.length, 1);
      assert.ok(sent.contents[0].parts[0].inlineData);
      assert.deepEqual(sent.generationConfig, {
        audioTranscriptionConfig: { wordTimestamp: true, languageCodes: ['ja-JP'] }
      });
      const words = [
        { word: '3D', startOffset: '2.100s', endOffset: '2.700s' },
        { word: '配信。', startOffset: '2.700s', endOffset: '3.600s' },
        { word: 'そう', startOffset: '9.400s', endOffset: '9.800s' },
        { word: '簡単', startOffset: '9.800s', endOffset: '10.200s' },
        { word: '系で', startOffset: '12s', endOffset: '12.500s' }
      ];
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x', audioTranscription: { text: 'x', words } }] } }] }),
        { status: 200 }
      );
    };
    const rows = await gemini.transcribeChunk({
      audioBuffer: Buffer.from('abc'),
      durationMs: 60000,
      sourceLang: 'ja',
      modelConfig: {
        baseUrl: 'https://relay.example.com',
        apiModel: 'gemini-3.5-transcribe',
        apiKey: 'test-key',
        extra: { audioTranscriptionConfig: { wordTimestamp: true } }
      }
    });
    assert.deepEqual(rows, [
      { startMs: 2100, endMs: 3600, text: '3D配信。' },
      { startMs: 9400, endMs: 10200, text: 'そう簡単' },
      { startMs: 12000, endMs: 12500, text: '系で' }
    ]);
  } finally {
    global.fetch = oldFetch;
  }
});

test('OpenAI 适配器跳过 auto 语言、标准化区域码并兼容仅返回 text 的响应', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://proxy.example.com/v1/audio/transcriptions');
      assert.equal(opts.headers.Authorization, 'Bearer k');
      assert.equal(opts.body.get('language'), null);
      return new Response(JSON.stringify({ text: '整段文本' }), { status: 200 });
    };
    const fallback = await openai.transcribeChunk({
      audioBuffer: Buffer.from('a'),
      durationMs: 3000,
      sourceLang: 'auto',
      modelConfig: { baseUrl: 'https://proxy.example.com/v1', apiModel: 'whisper-1', apiKey: 'k' }
    });
    assert.deepEqual(fallback, [{ startMs: 0, endMs: 3000, text: '整段文本' }]);

    global.fetch = async (_url, opts) => {
      assert.equal(opts.body.get('language'), 'zh');
      return new Response(JSON.stringify({ segments: [{ start: 0, end: 1.5, text: '你好' }] }), { status: 200 });
    };
    const rows = await openai.transcribeChunk({
      audioBuffer: Buffer.from('a'),
      durationMs: 3000,
      sourceLang: 'zh-CN',
      modelConfig: { baseUrl: 'https://proxy.example.com/v1', apiModel: 'whisper-1', apiKey: 'k' }
    });
    assert.deepEqual(rows, [{ startMs: 0, endMs: 1500, text: '你好' }]);
  } finally {
    global.fetch = oldFetch;
  }
});

test('429 时改用 fallback 模型，被限流模型冷却期间后续分片直接走备用', async () => {
  const calls = [];
  registerAdapter('fake-limited', {
    async transcribeChunk({ modelConfig }) {
      calls.push(modelConfig.id);
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    }
  });
  registerAdapter('fake-ok', {
    async transcribeChunk({ offsetMs, modelConfig }) {
      calls.push(modelConfig.id);
      return [{ startMs: 0, endMs: 1000, text: `seg@${offsetMs}` }];
    }
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-test-'));
  const primary = { id: 'primary', provider: 'fake-limited', enabled: true, fallback: ['backup'] };
  const backup = { id: 'backup', provider: 'fake-ok', enabled: true };
  const manager = new JobManager(
    { cacheDir: dir, chunkConcurrency: 1, maxRetries: 2, models: [primary, backup] },
    {
      prepareChunks: async () => ({
        chunks: [0, 10000, 20000].map(offsetMs => ({
          audioBuffer: Buffer.from('a'), offsetMs, durationMs: 10000, mimeType: 'audio/mpeg'
        }))
      })
    }
  );
  const { job } = await manager.create({ videoId: 'abcdefghijk', sourceLang: 'ja', modelConfig: primary });
  for (let i = 0; i < 100 && !['done', 'error'].includes(job.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(job.units.map(u => u.text), ['seg@0', 'seg@10000', 'seg@20000']);
  assert.deepEqual(calls, ['primary', 'backup', 'backup', 'backup']);
});

test('mergeAndNormalizeUnits 解决时间重叠并保持 endMs > startMs', () => {
  const merged = mergeAndNormalizeUnits([
    { startMs: 1000, endMs: 5000, text: '第一句' },
    { startMs: 2000, endMs: 3000, text: '被重叠的短句' }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].startMs, 5000);
  assert.ok(merged[1].endMs > merged[1].startMs);
});

test('HTTP 鉴权、带查询参数的健康检查、模型列表与路由边界', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-test-'));
  const { server } = createServer({
    config: {
      port: 0,
      authToken: 'secret-token',
      cacheDir: dir,
      defaultModel: 'm',
      models: [{ id: 'm', label: 'Model M', provider: 'gemini', apiKey: 'TOP_SECRET', enabled: true }]
    },
    prepareChunks: async () => ({ chunks: [] })
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    assert.equal((await request(port, 'GET', '/health')).status, 401);
    const health = await request(port, 'GET', '/health?t=123', null, 'secret-token');
    assert.equal(health.status, 200);
    assert.equal(health.body.defaultModel, 'm');
    assert.equal(JSON.stringify(health.body).includes('TOP_SECRET'), false);

    const models = await request(port, 'GET', '/api/models/', null, 'secret-token');
    assert.equal(models.status, 200);
    assert.equal(models.body.models.length, 1);

    // GET /api/jobs/:id/cancel 不应误命中 GET /api/jobs/:id
    assert.equal((await request(port, 'GET', '/api/jobs/abc/cancel', null, 'secret-token')).status, 404);
    assert.equal((await request(port, 'POST', '/api/jobs/missing/cancel', {}, 'secret-token')).status, 404);
    assert.equal((await request(port, 'POST', '/api/transcribe', { videoId: 'bad', model: 'm' }, 'secret-token')).status, 400);
  } finally {
    server.close();
  }
});

test('任务缓存命中、轮询进度、失败和取消', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-job-'));
  registerAdapter('test-slow', {
    async transcribeChunk({ signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
      return [{ startMs: 0, endMs: 1000, text: '测试字幕' }];
    }
  });

  const config = {
    cacheDir: dir,
    defaultModel: 'ok',
    chunkConcurrency: 1,
    maxRetries: 0,
    models: [{ id: 'ok', label: 'OK', provider: 'test-slow', enabled: true }]
  };
  const prepare = async () => ({
    chunks: [{ audioBuffer: Buffer.from('x'), offsetMs: 0, durationMs: 1000, mimeType: 'audio/mpeg' }]
  });

  const { server } = createServer({ config, prepareChunks: prepare });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const first = await request(port, 'POST', '/api/transcribe', { videoId: 'abcdefghijk', model: 'ok' });
    assert.equal(first.status, 202);

    let state;
    for (let i = 0; i < 40; i++) {
      state = await request(port, 'GET', `/api/jobs/${first.body.jobId}`);
      if (state.body.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(state.body.status, 'done');
    assert.equal(state.body.error, '');
    assert.deepEqual(state.body.units, [{ startMs: 0, endMs: 1000, text: '测试字幕' }]);

    const cached = await request(port, 'POST', '/api/transcribe', { videoId: 'abcdefghijk', model: 'ok' });
    assert.equal(cached.status, 200);
    assert.equal(cached.body.cached, true);
    assert.equal(cached.body.units.length, 1);

    const started = await request(port, 'POST', '/api/transcribe', { videoId: 'lmnopqrstuv', model: 'ok' });
    const cancelled = await request(port, 'POST', `/api/jobs/${started.body.jobId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
  } finally {
    server.close();
  }

  const failDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-fail-'));
  const failed = createServer({
    config: { ...config, cacheDir: failDir, models: [{ id: 'bad', provider: 'missing', enabled: true }] },
    prepareChunks: prepare
  });
  await new Promise(resolve => failed.server.listen(0, resolve));
  try {
    const bad = await request(failed.server.address().port, 'POST', '/api/transcribe', {
      videoId: 'abcdefghijk',
      model: 'bad'
    });
    let badState;
    for (let i = 0; i < 30; i++) {
      badState = await request(failed.server.address().port, 'GET', `/api/jobs/${bad.body.jobId}`);
      if (badState.body.status === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(badState.body.status, 'error');
    assert.ok(badState.body.error.includes('missing'));
  } finally {
    failed.server.close();
  }
});

test('planSegments 首段短切、末尾残片合并与 preferMs 片中优先排序', () => {
  // 开头播放：首段 60s，后续 180s，末尾 10s 残片合并进前一段
  const p0 = planSegments(430000, { headChunkSeconds: 60, chunkSeconds: 180, preferMs: 0 });
  assert.deepEqual(
    p0.segments.map(s => [s.index, s.startMs, s.endMs]),
    [
      [0, 0, 60000],
      [1, 60000, 240000],
      [2, 240000, 430000]
    ]
  );
  assert.deepEqual(p0.priorityOrder, [0, 1, 2]);

  // 片中播放（preferMs = 200s）：首段 [200s, 260s] 最先，接着向后到片尾，最后回头补 [0, 200s]
  const pMid = planSegments(500000, { headChunkSeconds: 60, chunkSeconds: 180, preferMs: 200000 });
  assert.equal(pMid.segments[pMid.priorityOrder[0]].startMs, 200000);
  assert.equal(pMid.segments[pMid.priorityOrder[0]].endMs, 260000);
  assert.equal(pMid.priorityOrder.length, pMid.segments.length);
  assert.ok(pMid.priorityOrder.every(idx => idx >= 0 && idx < pMid.segments.length));
  // 校验各段无缝衔接覆盖 0..500000
  assert.equal(pMid.segments[0].startMs, 0);
  assert.equal(pMid.segments.at(-1).endMs, 500000);
  for (let i = 1; i < pMid.segments.length; i++) {
    assert.equal(pMid.segments[i].startMs, pMid.segments[i - 1].endMs);
  }
});

test('异步边切边转与增量 afterSeq 查询：首段切完立刻转写并推送，无需等待后段切完', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-pipe-'));
  let releaseSecondCut;
  const secondCutGate = new Promise(resolve => { releaseSecondCut = resolve; });
  let releaseSecondAsr;
  const secondAsrGate = new Promise(resolve => { releaseSecondAsr = resolve; });
  const events = [];

  registerAdapter('test-pipe', {
    async transcribeChunk({ index }) {
      events.push(`asr-start-${index}`);
      if (index === 1) await secondAsrGate;
      events.push(`asr-done-${index}`);
      return [{ startMs: 1000, endMs: 3000, text: `第${index}段台词` }];
    }
  });

  const { server } = createServer({
    config: {
      cacheDir: dir,
      defaultModel: 'pipe',
      headChunkSeconds: 60,
      chunkSeconds: 180,
      cutConcurrency: 2,
      chunkConcurrency: 2,
      maxRetries: 0,
      models: [{ id: 'pipe', label: 'Pipe', provider: 'test-pipe', enabled: true }]
    },
    downloadAudio: async ({ videoId }) => ({
      videoId,
      tempDir: dir,
      inputPath: path.join(dir, 'fake.m4a'),
      durationMs: 240000,
      cleanup: async () => {}
    }),
    cutSegment: async ({ index, startMs, durationMs }) => {
      events.push(`cut-start-${index}`);
      if (index === 1) await secondCutGate;
      events.push(`cut-done-${index}`);
      return { index, audioBuffer: Buffer.from('mp3'), offsetMs: startMs, durationMs, mimeType: 'audio/mpeg' };
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const created = await request(port, 'POST', '/api/transcribe', {
      videoId: 'pipe1234567',
      model: 'pipe',
      preferMs: 0
    });
    assert.equal(created.status, 202);
    const jobId = created.body.jobId;

    // 等待第 0 段转写完并推送到 readyChunks，此时第 1 段连切段都没结束！
    let snap1;
    for (let i = 0; i < 40; i++) {
      snap1 = await request(port, 'GET', `/api/jobs/${jobId}?afterSeq=0`);
      if (snap1.body.chunks.length >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(snap1.body.status, 'transcribing');
    assert.equal(snap1.body.totalChunks, 2);
    assert.equal(snap1.body.doneChunks, 1);
    assert.equal(snap1.body.chunks.length, 1);
    assert.equal(snap1.body.chunks[0].seq, 1);
    assert.equal(snap1.body.chunks[0].index, 0);
    assert.deepEqual(snap1.body.chunks[0].units, [{ startMs: 1000, endMs: 3000, text: '第0段台词' }]);
    assert.ok(events.includes('asr-done-0'), '第 0 段必须在第 1 段切段完成前就完成转写');
    assert.equal(events.includes('cut-done-1'), false);

    // 用 afterSeq=1 再查，尚无新段应返回空数组
    const snapEmpty = await request(port, 'GET', `/api/jobs/${jobId}?afterSeq=1`);
    assert.equal(snapEmpty.body.chunks.length, 0);

    // 放行第 1 段切段与转写
    releaseSecondCut();
    releaseSecondAsr();

    let snap2;
    for (let i = 0; i < 40; i++) {
      snap2 = await request(port, 'GET', `/api/jobs/${jobId}?afterSeq=1`);
      if (snap2.body.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(snap2.body.status, 'done');
    assert.equal(snap2.body.chunks.length, 1);
    assert.equal(snap2.body.chunks[0].seq, 2);
    assert.equal(snap2.body.chunks[0].index, 1);
    assert.deepEqual(snap2.body.units, [
      { startMs: 1000, endMs: 3000, text: '第0段台词' },
      { startMs: 61000, endMs: 63000, text: '第1段台词' }
    ]);
  } finally {
    server.close();
  }
});

test('planSegments 默认渐进分段 [60, 180, 300, 1200]：2 小时 17 分视频从片头与片中均无缝覆盖', () => {
  const dur = 8220000; // 2h 17m
  const p0 = planSegments(dur, { preferMs: 0 });
  assert.deepEqual(p0.scheduleSeconds, [60, 180, 300, 1200]);
  assert.equal(p0.segments.length, 10);
  assert.deepEqual(
    p0.segments.map(s => s.durationMs / 1000),
    [60, 180, 300, 1200, 1200, 1200, 1200, 1200, 1200, 480]
  );
  assert.deepEqual(p0.priorityOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // 从第 40 分钟（2400s）开始：前 40 分钟按 20m×2 切，40 分钟起按 1m→3m→5m→20m... 切且优先执行
  const pMid = planSegments(dur, { preferMs: 2400000 });
  assert.equal(pMid.segments.length, 10);
  assert.equal(pMid.segments[0].durationMs, 1200000);
  assert.equal(pMid.segments[1].durationMs, 1200000);
  assert.equal(pMid.segments[2].startMs, 2400000);
  assert.equal(pMid.segments[2].durationMs, 60000);
  assert.equal(pMid.segments[3].durationMs, 180000);
  assert.equal(pMid.segments[4].durationMs, 300000);
  assert.equal(pMid.segments[5].durationMs, 1200000);
  assert.deepEqual(pMid.priorityOrder, [2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
  for (let i = 1; i < pMid.segments.length; i++) {
    assert.equal(pMid.segments[i].startMs, pMid.segments[i - 1].endMs);
  }
  assert.equal(pMid.segments.at(-1).endMs, dur);
});

test('parseDownloadPercent 解析 yt-dlp 百分比输出', () => {
  assert.equal(parseDownloadPercent('[download]  42.6% of ~24.50MiB at 3.2MiB/s ETA 00:04'), 43);
  assert.equal(parseDownloadPercent('[download] 100% of 24.50MiB in 00:07'), 100);
  assert.equal(parseDownloadPercent('[youtube] Extracting URL'), null);
});

test('跨任务共享 90 秒冷却表，且结构化日志记录完整并绝不泄露密钥', async () => {
  const calls = [];
  const logs = [];
  registerAdapter('shared-cd-limited', {
    async transcribeChunk({ modelConfig }) {
      calls.push(modelConfig.id);
      const err = new Error('429 too many');
      err.status = 429;
      throw err;
    }
  });
  registerAdapter('shared-cd-ok', {
    async transcribeChunk({ modelConfig }) {
      calls.push(modelConfig.id);
      return [{ startMs: 0, endMs: 1000, text: 'ok' }];
    }
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-cd-'));
  const primary = { id: 'p-secret', provider: 'shared-cd-limited', apiKey: 'SUPER_SECRET_KEY_123', enabled: true, fallback: ['b-ok'] };
  const backup = { id: 'b-ok', provider: 'shared-cd-ok', apiKey: 'BACKUP_SECRET_456', enabled: true };
  const manager = new JobManager(
    { cacheDir: dir, chunkConcurrency: 1, maxRetries: 0, models: [primary, backup] },
    {
      logger: (event, fields) => logs.push({ event, fields }),
      prepareChunks: async () => ({
        chunks: [{ audioBuffer: Buffer.from('a'), offsetMs: 0, durationMs: 10000, mimeType: 'audio/mpeg' }]
      })
    }
  );

  // 任务 1 触发 primary 429 并切 backup
  const r1 = await manager.create({ videoId: 'video111111', sourceLang: 'ja', modelConfig: primary });
  for (let i = 0; i < 60 && r1.job.status !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(r1.job.status, 'done');

  // 紧接着任务 2（不同视频）直接复用冷却表，不再撞 primary！
  const r2 = await manager.create({ videoId: 'video222222', sourceLang: 'ja', modelConfig: primary });
  for (let i = 0; i < 60 && r2.job.status !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(r2.job.status, 'done');

  assert.deepEqual(calls, ['p-secret', 'b-ok', 'b-ok']);
  assert.ok(logs.some(l => l.event === 'job.start'));
  assert.ok(logs.some(l => l.event === 'job.chunk_fallback' && l.fields.reason === 429));
  assert.ok(logs.some(l => l.event === 'job.chunk_fallback' && l.fields.reason === 'cooldown'));
  assert.ok(logs.some(l => l.event === 'job.chunk_done' && l.fields.model === 'b-ok'));
  assert.ok(logs.some(l => l.event === 'job.done'));
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('SUPER_SECRET_KEY_123'), false);
  assert.equal(serialized.includes('BACKUP_SECRET_456'), false);
});

test('GET /api/jobs/:id?preferMs=... 支持中途拖动进度条动态提权（含落在大段中间）并上报下载与时长进度', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-seek-'));
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const order = [];

  registerAdapter('test-seek', {
    async transcribeChunk({ index }) {
      order.push(index);
      if (index === 0) await firstGate;
      return [{ startMs: 0, endMs: 1000, text: `seg-${index}` }];
    }
  });

  const { server } = createServer({
    config: {
      cacheDir: dir,
      defaultModel: 'seek',
      chunkScheduleSeconds: [60, 180, 300, 1200],
      cutConcurrency: 1,
      chunkConcurrency: 1,
      maxRetries: 0,
      models: [{ id: 'seek', label: 'Seek', provider: 'test-seek', enabled: true }]
    },
    logger: null,
    downloadAudio: async ({ videoId, onDownloadProgress }) => {
      onDownloadProgress?.(55);
      onDownloadProgress?.(100);
      return {
        videoId,
        tempDir: dir,
        inputPath: path.join(dir, 'fake.m4a'),
        // 4 段：[0..60s], [60..240s], [240..540s], [540..1740s]
        durationMs: 1740000,
        cleanup: async () => {}
      };
    },
    cutSegment: async ({ index, startMs, durationMs }) => ({
      index, audioBuffer: Buffer.from('mp3'), offsetMs: startMs, durationMs, mimeType: 'audio/mpeg'
    })
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const created = await request(port, 'POST', '/api/transcribe', { videoId: 'seek1234567', model: 'seek', preferMs: 0 });
    const jobId = created.body.jobId;
    for (let i = 0; i < 40 && order.length === 0; i++) await new Promise(r => setTimeout(r, 10));

    // 用户拖到第 15 分钟（900000ms），正好落在第 3 段 [540s..1740s] 中间
    const mid = await request(port, 'GET', `/api/jobs/${jobId}?afterSeq=0&preferMs=900000`);
    assert.equal(mid.body.durationMs, 1740000);
    assert.equal(mid.body.downloadProgress, 100);

    releaseFirst();
    let finalSnap;
    for (let i = 0; i < 60; i++) {
      finalSnap = await request(port, 'GET', `/api/jobs/${jobId}`);
      if (finalSnap.body.status === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(finalSnap.body.status, 'done');
    assert.equal(finalSnap.body.doneDurationMs, 1740000);
    // 第 0 段正在执行；放行后下一段必须立刻切第 3 段（含 900s），再补第 1、2 段！
    assert.deepEqual(order, [0, 3, 1, 2]);
  } finally {
    server.close();
  }
});
