'use strict';

// 第三方 ASR 适配器模板：
// 1. 复制本文件，实现 transcribeChunk({ audioBuffer, mimeType, durationMs, sourceLang, context, modelConfig, signal })
// 2. 返回相对当前音频分片起点的字幕段数组：[{ startMs, endMs, text }]
// 3. 在 server.js 初始化处调用 registerAdapter('your-provider', require('./lib/adapters/your-provider'))
// 4. 在 config.json 的 models 数组里新增模型条目并将 provider 设为 'your-provider'

async function transcribeChunk() {
  throw new Error('请先实现第三方 ASR 适配器');
}

module.exports = { transcribeChunk };
