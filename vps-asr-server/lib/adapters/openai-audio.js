'use strict';

const { requestJson, modelError, hasHeader, formatContext } = require('./util');

function normalizeWhisperLang(sourceLang) {
  if (!sourceLang || sourceLang === 'auto') return '';
  return String(sourceLang).trim().split(/[-_]/)[0].toLowerCase();
}

async function transcribeChunk({
  audioBuffer,
  mimeType = 'audio/mpeg',
  durationMs = 0,
  sourceLang,
  context,
  modelConfig,
  signal
}) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'chunk.mp3');
  form.append('model', modelConfig.apiModel);
  form.append('response_format', 'verbose_json');

  const lang = normalizeWhisperLang(sourceLang);
  if (lang) form.append('language', lang);
  const safeContext = formatContext(context, 800);
  if (safeContext) {
    form.append('prompt', safeContext);
  }

  const base = String(modelConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = { ...(modelConfig.headers || {}) };
  if (modelConfig.apiKey && !hasHeader(headers, 'authorization')) {
    headers.Authorization = `Bearer ${modelConfig.apiKey}`;
  }

  const result = await requestJson(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal
  });
  if (!result.ok) throw modelError(result.status, result.body);

  const rows = result.json?.segments;
  if (Array.isArray(rows) && rows.length) {
    return rows
      .map(item => ({
        startMs: Math.max(0, Math.round((item.start ?? 0) * 1000)),
        endMs: Math.max(0, Math.round((item.end ?? 0) * 1000)),
        text: String(item.text || '').trim()
      }))
      .filter(item => item.text && item.endMs > item.startMs);
  }

  const fallbackText = String(result.json?.text || '').trim();
  if (fallbackText) {
    return [{ startMs: 0, endMs: durationMs > 0 ? durationMs : 1000, text: fallbackText }];
  }
  return [];
}

module.exports = { transcribeChunk, normalizeWhisperLang };
