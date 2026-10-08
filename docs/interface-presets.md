# API 提供商与自定义请求头

0.4.8 的「API 与模型」分为「功能与模型」和「API 提供商」。提供商页只管理文字、直播、朗读接口的连接信息和模型目录，不在提供商内分配翻译用途。文字接口可以保存多个模型，同一套 Key 和地址可供不同功能分别使用 Flash、Pro 等模型。「添加提供商」按文字模型、兼容 API、直播翻译、语音朗读分组；自定义 API 只有一个入口，可选 OpenAI 兼容／Gemini 协议。

左侧选择、启停和排序提供商；右侧按类型填写 Key、地址、可用模型或音色。直播模型固定只读，朗读语速在功能页统一调整。停用未使用的配置保留数据，但不出现在功能选择中；被用途绑定的不能停用。排序不改变选用，复制得到独立配置；删除有绑定用途的配置需要同类型的已启用替代项，每类最后一套不能删除。

旧文字配置保留 Key、原模型、顺序和功能 id；原先每个提供商的单一模型首次迁移到各功能的模型选择。已配置的第三方兼容地址转为自定义 API，旧直播／朗读连接迁入同一列表。文字模型可手填或从接口获取，部分服务不提供模型列表，获取失败不影响手填或逐个测试。

## 地址来源

以下地址沿用 0.4.5 的预设，附官方资料入口。地址可编辑；提供商出现在列表中不代表账号、地域或模型已经通过实测。

| 预设 | 基础地址 | 官方资料 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | [首次调用](https://api-docs.deepseek.com/) |
| 阿里百炼（北京） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [地域与 Base URL](https://help.aliyun.com/en/model-studio/base-url) |
| 阿里百炼（新加坡） | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | [地域与 Base URL](https://help.aliyun.com/en/model-studio/base-url) |
| Groq | `https://api.groq.com/openai/v1` | [OpenAI compatibility](https://console.groq.com/docs/openai) |
| 月之暗面 | `https://api.moonshot.cn/v1` | [Kimi CLI 官方配置示例](https://moonshotai.github.io/kimi-cli/en/configuration/config-files.html) |

另有 OpenAI、Gemini 官方地址；其他文字服务从自定义 API 配置。百炼地域需与 Key 所属地域相符。服务端返回的模型列表不保证每个模型都适合文字翻译；模型行中的「测试」按翻译路径发一条极短请求，会消耗少量额度。

## 请求头

展开「自定义请求头」，逐行填名称和值。值默认隐藏，可临时显示。空白行不保存，名称不区分大小写；同名项覆盖默认头，例如用 `Authorization` 覆盖自动生成的 Bearer 鉴权，也可以留空 API Key，仅填写 `X-Api-Key` 等鉴权头。

请求头用于该文字配置的模型列表、查询、模型测试，以及背景整理、整片字幕、聊天弹幕、评论和划词翻译；页面直连与扩展后台转发均携带。浏览器控制的请求头仍受 Fetch 限制。直播 WebSocket 和朗读使用对应类型的配置字段，不共用文字请求头。

请求头与 Key 一样明文存入本机扩展存储。默认备份排除全部自定义请求头；勾选「包含 Key 和请求头」才导出。导入不含凭据的备份，按接口 id 保留本机现有 Key 和请求头。

## 聊天与未接入服务

DeepL、DeepLX 尚未接入，不会出现在添加弹窗，也不能保存为提供商或发出请求。添加弹窗只展示实际可用的服务。

聊天默认使用 Chrome 本地翻译；也可在「功能与模型」或「聊天与评论」选择已配置的文字接口和模型。云端模式会将可见聊天文字分批发送到该接口，使用对应额度。本地模式仍在浏览器内运行，不会自动切到云端。
