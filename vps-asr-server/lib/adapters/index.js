'use strict';

const adapters = new Map();
function registerAdapter(type, adapter) {
  if (!type || !adapter || typeof adapter.transcribeChunk !== 'function') throw new TypeError('适配器必须实现 transcribeChunk');
  adapters.set(type, adapter);
}
function getAdapter(type) { return adapters.get(type); }
function listAdapters() { return [...adapters.keys()]; }
module.exports = { registerAdapter, getAdapter, listAdapters };
