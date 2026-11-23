'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { createServer } = require('./server');
const { extractVideoId } = require('./lib/media');
const { mergeAndNormalizeUnits } = require('./lib/jobs');
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
