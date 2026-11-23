# 流译 VPS 音频转写服务

供「流译」扩展视频翻译（步骤 1）使用的自托管音频转写服务。
服务接收扩展提交的 YouTube 视频链接或 ID，通过 `yt-dlp` 下载纯音频，快速读取时长后按首段优先的队列切分，并行调用云端转写模型。每个分片完成后即可通过任务接口增量读取，全部完成后合并时间戳并缓存到本地 `cacheDir`。

## 环境要求

- Node.js 22+（零 npm 第三方依赖，使用原生 `http` 与 `fetch`）
- `yt-dlp` 与 `ffmpeg` 已安装并在 `PATH` 中（或在 `config.json` 中填写绝对路径）

## 快速部署

1. 复制配置模板并填写你的 API Key 与访问令牌：

```bash
cp config.example.json config.json
```

2. 编辑 `config.json`：
   - `authToken`：强烈建议设置一串随机令牌，扩展设置页填入相同令牌（请求头 `Authorization: Bearer <token>`）。
   - `defaultModel`：扩展选「使用后端默认」时采用的模型 ID。
   - `models`：数组中每个 `enabled: true` 的条目都会通过 `/health` 和 `/api/models` 暴露给扩展前端选择。
   - `headChunkSeconds`、`chunkSeconds`、`cutConcurrency`、`chunkConcurrency` 控制首段长度、常规分片长度及切段和转写并发度。`ytDlpFormat` 可降低长视频下载码率。

3. 启动服务：

```bash
node server.js
```

4. 在浏览器打开流译扩展的 **设置 → 视频翻译**：
   - 原文来源选择「智能优先（VPS 转写 → 字幕轨）」或「强制云端转写（仅 VPS）」
   - 填写 VPS 地址（建议配 HTTPS 反向代理，如 Nginx / Caddy）和 `authToken`
   - 点击 **「连接并获取模型」**，即可拉取后端模型列表并在前端选择模型。

## 自定义中转站与多模型配置

### 1. Gemini 3.5 Transcribe / 自定义中转站（`provider: "gemini"`）

- `baseUrl` 填写官方域名 `https://generativelanguage.googleapis.com` 或你的 Gemini 中转站域名（是否带 `/v1beta` 后缀均可，服务会自动拼出 `/v1beta/models/{apiModel}:generateContent`）。
- 默认使用 `x-goog-api-key: <apiKey>` 鉴权；如果你的中转站要求 `Authorization: Bearer ...`，可在该模型条目的 `headers` 中显式配置 `Authorization`，服务会自动以它为准，不再重复注入 `x-goog-api-key`。
- 如需覆盖 `generationConfig`（例如关闭 `responseMimeType` 或调整参数），可写在 `extra.generationConfig` 中。
- Gemini 3.5 Transcribe 可在 `extra.audioTranscriptionConfig` 中启用 `{ "wordTimestamp": true }`，服务会据此请求词级时间戳。

### 2. OpenAI 兼容转写接口（`provider: "openai-audio"`）

- 适用于 OpenAI Whisper / GPT-4o Transcribe、Groq、硅基流动等兼容 `POST {baseUrl}/audio/transcriptions` 的服务。
- `sourceLang` 为 `auto` 时自动省略 `language` 参数；区域码如 `zh-CN` 会自动标准化为 `zh`。

### 3. 环境变量覆盖

适合 Docker 或 systemd 注入密钥，避免明文写死在 `config.json`：

- `LIUYI_ASR_CONFIG`：自定义配置文件路径
- `LIUYI_ASR_HOST` / `LIUYI_ASR_PORT`：监听地址（默认 `0.0.0.0`）与端口（默认 `8787`）
- `LIUYI_ASR_AUTH_TOKEN`：覆盖 `authToken`
- `LIUYI_ASR_CACHE_DIR` / `LIUYI_ASR_TEMP_DIR`：覆盖缓存和临时目录
- `LIUYI_ASR_DEFAULT_MODEL`：覆盖默认模型 ID
- `LIUYI_ASR_MODEL_<ID>_API_KEY`：按模型 ID 覆盖对应 `apiKey`（非字母数字字符替换为 `_` 并转大写，例如 `gemini-3.5-transcribe` 对应 `LIUYI_ASR_MODEL_GEMINI_3_5_TRANSCRIBE_API_KEY`）

### 4. YouTube 机房 IP 风控处理

如果 VPS 机房 IP 被 YouTube 要求登录或限流，在 `config.json` 的 `ytDlpExtraArgs` 中配置参数数组（直接传给 `spawn`，不经 shell）：

```json
"ytDlpExtraArgs": ["--cookies", "/opt/liuyi-vps-asr/cookies.txt"]
```

也可配合 `--proxy` 或 `--extractor-args` 使用。

## 扩展第三方转写适配器

1. 复制 `lib/adapters/custom-template.js`，实现：

```js
async function transcribeChunk({ audioBuffer, mimeType, durationMs, sourceLang, context, modelConfig, signal })
```

返回相对当前分片起点的 `[{ startMs, endMs, text }]` 数组即可。
2. 在 `server.js` 顶部注册：`registerAdapter('elevenlabs', require('./lib/adapters/elevenlabs'))`。
3. 在 `config.json` 的 `models` 里增加条目并把 `provider` 设为 `'elevenlabs'`，前端重新点击「连接并获取模型」即可立即可选。

## HTTP 接口一览

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查，同时返回 `defaultModel` 与启用的 `models` 清单（不含密钥） |
| `GET /api/models` | 返回 `defaultModel` 与启用的 `models` 清单 |
| `POST /api/transcribe` | 提交转写 `{ videoId 或 url, sourceLang, model, context, force, preferMs }`；命中缓存返回 `200 + units`，新任务返回 `202 + jobId` |
| `GET /api/jobs/:jobId?afterSeq=N` | 查询状态及 `totalChunks`、`doneChunks`、`seq`。`chunks` 返回序号大于 N 的已完成分片，任务完成时 `units` 返回完整结果 |
| `POST /api/jobs/:jobId/cancel` | 取消进行中的任务 |

## Docker / systemd 部署示例

### Docker

```bash
docker build -t liuyi-vps-asr .
docker run -d --name liuyi-vps-asr -p 8787:8787 \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v $(pwd)/cache:/app/cache \
  liuyi-vps-asr
```

### systemd

创建 `/etc/systemd/system/liuyi-vps-asr.service`，设置 `WorkingDirectory=/opt/liuyi-vps-asr`、`ExecStart=/usr/bin/node /opt/liuyi-vps-asr/server.js` 与 `Restart=on-failure`，执行 `systemctl enable --now liuyi-vps-asr`。建议前置 Caddy 或 Nginx 提供 HTTPS 终止。
