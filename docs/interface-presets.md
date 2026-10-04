# 接口预设与自定义请求头

0.4.5 的预设只填写协议和基础地址，复用已有 Gemini / OpenAI 兼容客户端。选预设后点「新增接口」，生成独立配置；Key、模型和功能选用由用户填写或选择。模型不设固定默认值，可手填，也可从接口获取后选择。部分兼容服务不提供模型列表，获取失败不影响手填与生成测试。

## 地址来源

以下是 2026-10-05 核对的官方资料。地址可在设置中编辑；预设不代表该账号、地域或模型已经通过实测。

| 预设 | 基础地址 | 官方资料 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | [首次调用](https://api-docs.deepseek.com/) |
| 硅基流动 | `https://api.siliconflow.cn/v1` | [快速开始](https://docs.siliconflow.cn/docs/userguide/quickstart) |
| 火山方舟（北京） | `https://ark.cn-beijing.volces.com/api/v3` | [调用说明](https://docs.volcengine.com/docs/ark/1263249?lang=zh) |
| 阿里百炼（北京） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [地域与 Base URL](https://help.aliyun.com/en/model-studio/base-url) |
| 阿里百炼（新加坡） | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | [地域与 Base URL](https://help.aliyun.com/en/model-studio/base-url) |
| OpenRouter | `https://openrouter.ai/api/v1` | [Quickstart](https://openrouter.ai/docs/quickstart) |
| Groq | `https://api.groq.com/openai/v1` | [OpenAI compatibility](https://console.groq.com/docs/openai) |
| 月之暗面 | `https://api.moonshot.cn/v1` | [Kimi CLI 官方配置示例](https://moonshotai.github.io/kimi-cli/en/configuration/config-files.html) |

另保留 OpenAI、Gemini 官方地址预设和空白的自定义接口。百炼地域需与 Key 所属地域相符。服务端返回的模型列表不保证每个模型都适合文字翻译，可用「生成测试」检查当前选择。

## 请求头

展开「自定义请求头」，逐行填名称和值。值默认隐藏，可临时显示。空白行不保存，名称不区分大小写；同名项覆盖默认头，例如用 `Authorization` 覆盖自动生成的 Bearer 鉴权，也可以留空 API Key，仅填写 `X-Api-Key` 等鉴权头。

请求头用于该文字接口的模型列表、查询、生成测试，以及背景整理、整片字幕、评论和划词翻译；页面直连与扩展后台转发均携带。浏览器控制的请求头仍受 Fetch 限制。直播 WebSocket 和朗读使用各自的连接配置。

请求头与 Key 一样明文存入本机扩展存储。默认备份排除全部自定义请求头；勾选「包含 Key 和请求头」才导出。导入不含凭据的备份，按接口 id 保留本机现有 Key 和请求头。

## 候选占位

直播、聊天、专用机器翻译和朗读候选位于各标签下折叠的「暂未接入」说明中，没有可运行的配置或客户端。当前直播仍为 Gemini / Qwen，聊天仍为 Chrome 本地翻译，朗读仍为 Microsoft / Gemini。本次没有下载模型权重、引入 SDK 或启动自托管服务。
