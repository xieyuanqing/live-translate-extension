'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com'
]);
const DEFAULT_YT_DLP_FORMAT = 'bestaudio[abr<=96]/worstaudio[abr>=48]/bestaudio/best';
const MIN_TAIL_MS = 15000;

function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('缺少 videoId 或 YouTube URL');
  if (VIDEO_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('videoId 或 YouTube URL 无效');
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('只支持 YouTube URL');
  }

  let id = '';
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (url.searchParams.get('v')) {
    id = url.searchParams.get('v');
  } else {
    const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (pathMatch) id = pathMatch[1];
  }

  if (!VIDEO_ID_RE.test(id || '')) {
    throw new Error('YouTube videoId 无效');
  }
  return id;
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', err => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', code => {
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(`${bin} 退出码 ${code}: ${stderr.slice(-1000)}`);
      err.code = code;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function parseDurationFromText(text) {
  const match = String(text || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}

/** 毫秒级探测音频总时长（只读容器头，不做全片解码）。 */
async function probeDurationMs(config, inputPath, signal) {
  const ffprobePath = config.ffprobePath || 'ffprobe';
  try {
    const res = await run(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath],
      { signal }
    );
    const seconds = Number.parseFloat(res.stdout);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  try {
    const res = await run(config.ffmpegPath || 'ffmpeg', ['-i', inputPath], { signal });
    return parseDurationFromText(res.stderr);
  } catch (err) {
    if (signal?.aborted) throw err;
    return parseDurationFromText(err.stderr || err.message);
  }
}

function splitForward(startMs, endMs, stepMs) {
  const list = [];
  for (let s = startMs; s < endMs; s += stepMs) {
    const e = Math.min(endMs, s + stepMs);
    if (list.length && e - s < MIN_TAIL_MS) {
      list[list.length - 1].endMs = e;
      list[list.length - 1].durationMs = e - list[list.length - 1].startMs;
    } else if (e > s) {
      list.push({ startMs: s, endMs: e, durationMs: e - s });
    }
  }
  return list;
}

/**
 * 规划音频分片：首段短切（默认 60 秒）放在 preferMs 处最先执行，
 * 随后向片尾推进，最后回头补 0..preferMs；各段同时保有稳定的时间序 index。
 */
function planSegments(durationMs, { headChunkSeconds = 60, chunkSeconds = 180, preferMs = 0 } = {}) {
  const totalMs = Math.round(Number(durationMs) || 0);
  if (totalMs <= 0) return { segments: [], priorityOrder: [] };

  const headMs = Math.max(15, Number(headChunkSeconds) || 60) * 1000;
  const stepMs = Math.max(30, Number(chunkSeconds) || 180) * 1000;
  if (totalMs <= headMs * 1.5) {
    return {
      segments: [{ index: 0, startMs: 0, endMs: totalMs, durationMs: totalMs }],
      priorityOrder: [0]
    };
  }

  const anchor = Math.min(Math.max(0, Math.round(Number(preferMs) || 0)), Math.max(0, totalMs - 1000));
  let headStart = anchor;
  if (headStart > 0 && headStart < MIN_TAIL_MS) {
    headStart = 0;
  }
  let headEnd = Math.min(totalMs, headStart + headMs);
  if (totalMs - headEnd > 0 && totalMs - headEnd < MIN_TAIL_MS) {
    headEnd = totalMs;
  }

  const before = headStart > 0 ? splitForward(0, headStart, stepMs) : [];
  const head = { startMs: headStart, endMs: headEnd, durationMs: headEnd - headStart };
  const after = headEnd < totalMs ? splitForward(headEnd, totalMs, stepMs) : [];

  const segments = [...before, head, ...after].map((seg, index) => ({ ...seg, index }));
  const headIndex = before.length;
  const priorityOrder = [headIndex];
  for (let i = headIndex + 1; i < segments.length; i++) priorityOrder.push(i);
  for (let i = 0; i < headIndex; i++) priorityOrder.push(i);

  return { segments, priorityOrder };
}

async function downloadAudio({ videoId, url, config, signal, onStage }) {
  const id = extractVideoId(videoId || url);
  const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
  const tempRoot = config.tempDir || os.tmpdir();
  await fsp.mkdir(tempRoot, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(tempRoot, 'liuyi-asr-'));
  const sourceTemplate = path.join(tempDir, 'source.%(ext)s');
  const cleanup = () => fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  try {
    onStage?.('正在下载音频');
    await run(
      config.ytDlpPath || 'yt-dlp',
      [
        '--no-playlist',
        '-f', config.ytDlpFormat || DEFAULT_YT_DLP_FORMAT,
        '-o', sourceTemplate,
        ...(config.ytDlpExtraArgs || []),
        '--',
        canonicalUrl
      ],
      { signal }
    );

    const file = (await fsp.readdir(tempDir)).find(name => name.startsWith('source.'));
    if (!file) throw new Error('yt-dlp 未生成音频文件');
    const inputPath = path.join(tempDir, file);
    const durationMs = await probeDurationMs(config, inputPath, signal);
    return { videoId: id, tempDir, inputPath, durationMs, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function cutSegment({ inputPath, tempDir, index, startMs, durationMs, config, signal }) {
  const out = path.join(tempDir, `chunk-${index}.mp3`);
  try {
    await run(
      config.ffmpegPath || 'ffmpeg',
      [
        '-y',
        '-ss', String(startMs / 1000),
        '-t', String(durationMs / 1000),
        '-i', inputPath,
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '48k',
        '-f', 'mp3',
        out
      ],
      { signal }
    );
    const audioBuffer = await fsp.readFile(out);
    return { index, audioBuffer, offsetMs: startMs, durationMs, mimeType: 'audio/mpeg' };
  } finally {
    fsp.rm(out, { force: true }).catch(() => {});
  }
}

/** 极少数无法探测总时长时的兜底连续分段。 */
async function cutAllFallback({ inputPath, tempDir, config, signal }) {
  const chunkMs = Math.max(30, Number(config.chunkSeconds) || 180) * 1000;
  const segmentSec = Math.round(chunkMs / 1000);
  const pattern = path.join(tempDir, 'chunk-%04d.mp3');
  await run(
    config.ffmpegPath || 'ffmpeg',
    [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '48k',
      '-f', 'segment',
      '-segment_time', String(segmentSec),
      '-reset_timestamps', '1',
      pattern
    ],
    { signal }
  );
  const segFiles = (await fsp.readdir(tempDir))
    .filter(name => /^chunk-\d+\.mp3$/.test(name))
    .sort();
  const chunks = [];
  for (let i = 0; i < segFiles.length; i++) {
    const filePath = path.join(tempDir, segFiles[i]);
    const audioBuffer = await fsp.readFile(filePath);
    fsp.rm(filePath, { force: true }).catch(() => {});
    if (audioBuffer.length) {
      chunks.push({ index: i, audioBuffer, offsetMs: i * chunkMs, durationMs: chunkMs, mimeType: 'audio/mpeg' });
    }
  }
  return chunks;
}

async function prepareChunks(args) {
  const descriptor = await downloadAudio(args);
  try {
    if (descriptor.durationMs <= 0) {
      const chunks = await cutAllFallback({
        inputPath: descriptor.inputPath,
        tempDir: descriptor.tempDir,
        config: args.config,
        signal: args.signal
      });
      return { videoId: descriptor.videoId, chunks };
    }
    const plan = planSegments(descriptor.durationMs, { ...args.config, preferMs: args.preferMs });
    const chunks = [];
    for (const i of plan.priorityOrder) {
      const seg = plan.segments[i];
      const cut = await cutSegment({
        ...seg,
        inputPath: descriptor.inputPath,
        tempDir: descriptor.tempDir,
        config: args.config,
        signal: args.signal
      });
      if (cut.audioBuffer.length) chunks.push(cut);
    }
    return { videoId: descriptor.videoId, chunks };
  } finally {
    await descriptor.cleanup();
  }
}

module.exports = {
  extractVideoId,
  run,
  probeDurationMs,
  planSegments,
  downloadAudio,
  cutSegment,
  cutAllFallback,
  prepareChunks
};
