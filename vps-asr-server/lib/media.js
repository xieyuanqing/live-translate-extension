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
      reject(err);
    });
  });
}

async function probeAudio(ffmpegPath, input, signal) {
  let durationMs = 0;
  let silences = [];
  try {
    const probe = await run(
      ffmpegPath,
      ['-i', input, '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'],
      { signal }
    );
    const durationMatch = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (durationMatch) {
      durationMs = Math.round(
        (Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])) * 1000
      );
    }
    silences = [...probe.stderr.matchAll(/silence_(?:start|end):\s*([\d.]+)/g)]
      .map(match => Math.round(Number(match[1]) * 1000))
      .filter(Number.isFinite);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return { durationMs, silences };
}

function buildBoundaries(durationMs, chunkMs, silences) {
  if (!durationMs || durationMs <= 0) return [0];
  const boundaries = [0];
  const maxDrift = chunkMs * 0.2;
  for (let target = chunkMs; target < durationMs; target += chunkMs) {
    let best = target;
    let bestDist = Infinity;
    for (const point of silences) {
      const dist = Math.abs(point - target);
      if (dist < maxDrift && dist < bestDist && point > boundaries[boundaries.length - 1] + 5000) {
        best = point;
        bestDist = dist;
      }
    }
    if (best < durationMs - 2000) {
      boundaries.push(best);
    }
  }
  boundaries.push(durationMs);
  return boundaries;
}

async function prepareChunks({ videoId, url, config, signal, onStage }) {
  const id = extractVideoId(videoId || url);
  const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
  const tempRoot = config.tempDir || os.tmpdir();
  await fsp.mkdir(tempRoot, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(tempRoot, 'liuyi-asr-'));
  const sourceTemplate = path.join(temp, 'source.%(ext)s');
  const ytDlpPath = config.ytDlpPath || 'yt-dlp';
  const ffmpegPath = config.ffmpegPath || 'ffmpeg';

  try {
    onStage?.('正在下载音频');
    await run(
      ytDlpPath,
      [
        '--no-playlist',
        '-f', 'bestaudio/best',
        '-o', sourceTemplate,
        ...(config.ytDlpExtraArgs || []),
        '--',
        canonicalUrl
      ],
      { signal }
    );

    const files = (await fsp.readdir(temp)).filter(name => name.startsWith('source.'));
    if (!files.length) throw new Error('yt-dlp 未生成音频文件');
    const input = path.join(temp, files[0]);

    onStage?.('正在分析静音并切分音频');
    const { durationMs, silences } = await probeAudio(ffmpegPath, input, signal);
    const chunkMs = Math.max(15, Number(config.chunkSeconds) || 150) * 1000;
    const chunks = [];

    if (durationMs > 0) {
      const boundaries = buildBoundaries(durationMs, chunkMs, silences);
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i];
        const length = boundaries[i + 1] - start;
        if (length <= 0) continue;
        const out = path.join(temp, `chunk-${i}.mp3`);
        await run(
          ffmpegPath,
          [
            '-y',
            '-ss', String(start / 1000),
            '-t', String(length / 1000),
            '-i', input,
            '-ac', '1',
            '-b:a', '48k',
            '-f', 'mp3',
            out
          ],
          { signal }
        );
        const audioBuffer = await fsp.readFile(out);
        if (audioBuffer.length) {
          chunks.push({ audioBuffer, offsetMs: start, durationMs: length, mimeType: 'audio/mpeg' });
        }
      }
    } else {
      // 未探测到总时长时退回按固定时长连续分段，避免截断长视频
      const segmentSec = Math.round(chunkMs / 1000);
      const pattern = path.join(temp, 'chunk-%04d.mp3');
      await run(
        ffmpegPath,
        [
          '-y',
          '-i', input,
          '-ac', '1',
          '-b:a', '48k',
          '-f', 'segment',
          '-segment_time', String(segmentSec),
          '-reset_timestamps', '1',
          pattern
        ],
        { signal }
      );
      const segFiles = (await fsp.readdir(temp))
        .filter(name => /^chunk-\d+\.mp3$/.test(name))
        .sort();
      for (let i = 0; i < segFiles.length; i++) {
        const audioBuffer = await fsp.readFile(path.join(temp, segFiles[i]));
        if (audioBuffer.length) {
          chunks.push({
            audioBuffer,
            offsetMs: i * chunkMs,
            durationMs: chunkMs,
            mimeType: 'audio/mpeg'
          });
        }
      }
    }

    return { videoId: id, chunks };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { extractVideoId, run, prepareChunks, buildBoundaries };
