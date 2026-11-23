'use strict';

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, body, json };
}

function modelError(status, body) {
  const detail = String(body || '').trim().slice(0, 500);
  const error = new Error(`转写接口失败（${status}）：${detail || '无响应内容'}`);
  error.status = status;
  return error;
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers || {}).some(key => key.toLowerCase() === target);
}

function formatContext(context, maxChars = 1500) {
  if (!context) return '';
  if (typeof context === 'string') return context.trim().slice(0, maxChars);
  if (typeof context === 'object') {
    const parts = Object.values(context)
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    return parts.join('\n').slice(0, maxChars);
  }
  return String(context).trim().slice(0, maxChars);
}

module.exports = { requestJson, modelError, hasHeader, formatContext };
