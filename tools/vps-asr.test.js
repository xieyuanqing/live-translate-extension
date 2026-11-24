const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);

function harness(request) {
  const ctx = vm.createContext({ console, URL, Date, DOMException, AbortController, setTimeout, clearTimeout });
  load(ctx, 'src/subs/vps-asr.js');
  ctx.LT.Net = { request };
  return ctx.LT.VpsAsr;
}

test('VPS 基础规范化', () => {
  const v = harness(async () => ({ ok: true, status: 200, text: '{}' }));
  assert.equal(v.normalizeBaseUrl(' https://a.test/// '), 'https://a.test');
  assert.throws(() => v.normalizeBaseUrl('ftp://a.test'));
  assert.equal(v.authHeaders(' t ').Authorization, 'Bearer t');
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        v.normalizeUnits([
          { startMs: 4, endMs: 2, text: ' x ' },
          { start: 1, end: 5, text: 'y' },
          { start: 9, end: 10, text: ' ' },
        ])
      )
    ),
    [
      { id: 1, start: 4, end: 4, text: 'x' },
      { id: 2, start: 4, end: 5, text: 'y' },
    ]
  );
});

test('VPS 信息读取：/health 单次拿到模型、/health 无 models 时补拉 /api/models、以及 401 错误', async () => {
  const calls = [];
  const v = harness(async ({ url }) => {
    calls.push(url);
    if (url.includes('/bad/')) return { ok: false, status: 401, text: '{}' };
    if (url === 'https://v1.test/health') {
      return {
        ok: true,
        status: 200,
        via: 'direct',
        text: JSON.stringify({
          ok: true,
          service: 'liuyi-vps-asr',
          version: '1.0.0',
          defaultModel: 'gemini-3.5-transcribe',
          models: [{ id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe', provider: 'gemini' }],
        }),
      };
    }
    if (url === 'https://v2.test/health') {
      return { ok: true, status: 200, via: 'relay', text: JSON.stringify({ ok: true, version: '2.0' }) };
    }
    if (url === 'https://v2.test/api/models') {
      return {
        ok: true,
        status: 200,
        via: 'relay',
        text: JSON.stringify({ defaultModel: 'whisper', models: [{ id: 'whisper', label: 'Whisper' }] }),
      };
    }
    return { ok: false, status: 404, text: '{}' };
  });

  const info1 = await v.fetchServerInfo({ baseUrl: 'https://v1.test', token: 'x' });
  assert.equal(info1.version, '1.0.0');
  assert.equal(info1.defaultModel, 'gemini-3.5-transcribe');
  assert.equal(info1.models[0].id, 'gemini-3.5-transcribe');
  assert.ok(info1.ms >= 0 && info1.ms < 10000);
  assert.deepEqual(calls, ['https://v1.test/health']);

  calls.length = 0;
  const info2 = await v.fetchServerInfo({ baseUrl: 'https://v2.test' });
  assert.equal(info2.version, '2.0');
  assert.equal(info2.models[0].id, 'whisper');
  assert.deepEqual(calls, ['https://v2.test/health', 'https://v2.test/api/models']);

  await assert.rejects(() => v.fetchServerInfo({ baseUrl: 'https://v.test/bad' }), /VPS 访问令牌无效/);
});

test('VPS 转写缓存直返与异步轮询进度', async () => {
  const progress = [];
  let pollCount = 0;
  const v = harness(async ({ url }) => {
    if (url === 'https://cached.test/api/transcribe') {
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'done', cached: true, units: [{ startMs: 0, endMs: 1000, text: 'ok' }] }),
      };
    }
    if (url === 'https://async.test/api/transcribe') {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-1', status: 'queued' }) };
    }
    if (url === 'https://async.test/api/jobs/job-1') {
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'downloading', progress: 0, stage: '正在下载音频' }) };
      }
      if (pollCount === 2) {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'transcribing', progress: 50, stage: '正在转写 1/2 段' }) };
      }
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'done',
          progress: 100,
          model: 'gemini-3.5-transcribe',
          units: [{ startMs: 0, endMs: 1500, text: '测试原文' }],
        }),
      };
    }
    return { ok: false, status: 404, text: '{}' };
  });

  const cached = await v.transcribe({ baseUrl: 'https://cached.test', videoId: 'x', url: 'u', pollIntervalMs: 1 });
  assert.equal(cached.cached, true);
  assert.equal(cached.units[0].text, 'ok');

  const asyncOut = await v.transcribe({
    baseUrl: 'https://async.test',
    videoId: 'x',
    url: 'u',
    pollIntervalMs: 1,
    onProgress: p => progress.push(p),
  });
  assert.equal(asyncOut.units[0].text, '测试原文');
  assert.equal(progress[0].status, 'downloading');
  assert.equal(progress[1].progress, 50);
  assert.equal(progress[2].status, 'done');
});

test('VPS 轮询中止会通知服务端取消，连续断线 3 次或 401/404 立刻报错', async () => {
  const cancelled = [];
  const ac = new AbortController();
  const vCancel = harness(async ({ url, signal }) => {
    if (url.endsWith('/api/transcribe')) {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-cancel', status: 'queued' }) };
    }
    if (url.endsWith('/cancel')) {
      cancelled.push(url);
      return { ok: true, status: 200, text: JSON.stringify({ ok: true, status: 'cancelled' }) };
    }
    if (url.endsWith('/api/jobs/job-cancel')) {
      ac.abort();
      throw new DOMException('已取消', 'AbortError');
    }
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    return { ok: true, status: 200, text: '{}' };
  });

  await assert.rejects(
    () => vCancel.transcribe({ baseUrl: 'https://c.test', videoId: 'x', url: 'u', signal: ac.signal, pollIntervalMs: 1 }),
    err => err.name === 'AbortError'
  );
  assert.equal(cancelled.length, 1);

  let fails = 0;
  const vDrop = harness(async ({ url }) => {
    if (url.endsWith('/api/transcribe')) {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-drop', status: 'queued' }) };
    }
    fails++;
    throw new Error('Failed to fetch');
  });
  await assert.rejects(
    () => vDrop.transcribe({ baseUrl: 'https://drop.test', videoId: 'x', url: 'u', pollIntervalMs: 1 }),
    /连接中断/
  );
  assert.equal(fails, 3);

  let authTries = 0;
  const vAuth = harness(async ({ url }) => {
    if (url.endsWith('/api/transcribe')) {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-auth', status: 'queued' }) };
    }
    authTries++;
    return { ok: false, status: 401, text: '{}' };
  });
  await assert.rejects(
    () => vAuth.transcribe({ baseUrl: 'https://auth.test', videoId: 'x', url: 'u', pollIntervalMs: 1 }),
    /访问令牌无效/
  );
  assert.equal(authTries, 1);
});

test('VPS 增量分片轮询：传 preferMs、按 afterSeq 增量回调 onChunk 且不重复', async () => {
  const seenUrls = [];
  const sentBodies = [];
  const receivedChunks = [];
  let poll = 0;
  const v = harness(async ({ url, body }) => {
    seenUrls.push(url);
    if (body) sentBodies.push(JSON.parse(body));
    if (url.endsWith('/api/transcribe')) {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-stream', status: 'queued' }) };
    }
    if (url.includes('/api/jobs/job-stream')) {
      poll++;
      if (poll === 1) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'transcribing',
            progress: 50,
            stage: '正在转写 1/2 段',
            totalChunks: 2,
            doneChunks: 1,
            seq: 1,
            chunks: [{ seq: 1, index: 0, startMs: 0, endMs: 60000, units: [{ startMs: 500, endMs: 2000, text: '第一段' }] }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'done',
          progress: 100,
          stage: '转写完成',
          totalChunks: 2,
          doneChunks: 2,
          seq: 2,
          chunks: [
            { seq: 1, index: 0, startMs: 0, endMs: 60000, units: [{ startMs: 500, endMs: 2000, text: '第一段' }] },
            { seq: 2, index: 1, startMs: 60000, endMs: 120000, units: [{ startMs: 61000, endMs: 63000, text: '第二段' }] },
          ],
          units: [
            { startMs: 500, endMs: 2000, text: '第一段' },
            { startMs: 61000, endMs: 63000, text: '第二段' },
          ],
        }),
      };
    }
    return { ok: false, status: 404, text: '{}' };
  });

  const out = await v.transcribe({
    baseUrl: 'https://stream.test',
    videoId: 'vid12345678',
    url: 'https://www.youtube.com/watch?v=vid12345678',
    preferMs: 45000,
    pollIntervalMs: 1,
    onChunk: chunk => receivedChunks.push(chunk),
  });
  assert.equal(sentBodies[0].preferMs, 45000);
  assert.equal(seenUrls[1], 'https://stream.test/api/jobs/job-stream');
  assert.equal(seenUrls[2], 'https://stream.test/api/jobs/job-stream?afterSeq=1');
  assert.equal(receivedChunks.length, 2);
  assert.equal(receivedChunks[0].index, 0);
  assert.equal(receivedChunks[1].index, 1);
  assert.equal(out.streamedChunks, 2);
});

test('VPS 轮询期间拖动进度条自动携带 preferMs 提权，并透传时长与备用模型进度字段', async () => {
  const seenUrls = [];
  const progressEvents = [];
  let curPos = 10000;
  let poll = 0;
  const v = harness(async ({ url }) => {
    seenUrls.push(url);
    if (url.endsWith('/api/transcribe')) {
      return { ok: true, status: 202, text: JSON.stringify({ jobId: 'job-seek', status: 'queued' }) };
    }
    poll++;
    if (poll === 1) {
      curPos = 15000; // 仅前进 5 秒（< 15s），下次不应上报 preferMs
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'downloading',
          progress: 0,
          downloadProgress: 40,
          stage: '正在下载音频 40%',
        }),
      };
    }
    if (poll === 2) {
      curPos = 600000; // 拖到 10 分钟处，下次必须携带 preferMs=600000
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'transcribing',
          progress: 25,
          downloadProgress: 100,
          durationMs: 1200000,
          doneDurationMs: 300000,
          usingFallback: true,
          stage: '正在转写 1/2 段（备用模型）',
          totalChunks: 2,
          doneChunks: 1,
          seq: 1,
          chunks: [{ seq: 1, index: 0, startMs: 0, endMs: 300000, units: [{ startMs: 0, endMs: 1000, text: 'a' }] }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({
        status: 'done',
        progress: 100,
        durationMs: 1200000,
        doneDurationMs: 1200000,
        totalChunks: 2,
        doneChunks: 2,
        seq: 1,
        units: [{ startMs: 0, endMs: 1000, text: 'a' }],
      }),
    };
  });

  await v.transcribe({
    baseUrl: 'https://seek.test',
    videoId: 'vid12345678',
    url: 'https://www.youtube.com/watch?v=vid12345678',
    preferMs: 10000,
    getPreferMs: () => curPos,
    pollIntervalMs: 1,
    onProgress: p => progressEvents.push(p),
  });

  assert.equal(seenUrls[1], 'https://seek.test/api/jobs/job-seek');
  assert.equal(seenUrls[2], 'https://seek.test/api/jobs/job-seek');
  assert.equal(seenUrls[3], 'https://seek.test/api/jobs/job-seek?afterSeq=1&preferMs=600000');
  assert.equal(progressEvents[0].downloadProgress, 40);
  assert.equal(progressEvents[1].durationMs, 1200000);
  assert.equal(progressEvents[1].doneDurationMs, 300000);
  assert.equal(progressEvents[1].usingFallback, true);
});
