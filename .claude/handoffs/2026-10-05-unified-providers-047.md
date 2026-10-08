# 0.4.7：统一 API 提供商

## 本轮要求

用户要求沿用陪读蛙的 API 提供商页面逻辑：列表选择配置、右侧编辑、添加弹窗按服务类型分组。后续明确删除兼容 API 区的第三方预设，只留一个自定义入口；直播翻译和语音朗读也合并到提供商列表，成为不同类型。

## 已完成

- 同一个列表与编辑器管理文字模型 `text`、直播翻译 `live`、语音朗读 `speech`。取消旧的类型标签页和独立连接设置面板。各类型共用名称、描述、启停、复制、排序、删除和用途绑定，各自显示实际支持的连接字段。
- 添加弹窗保留原厂 LLM、一个自定义 API、直播翻译、语音朗读以及 DeepLX / DeepL 两个禁用的纯翻译占位。移除兼容区的 OpenRouter、硅基流动、火山方舟入口。自定义 API 可以选 OpenAI 兼容或 Gemini 协议，自己填写地址、Key 和模型。
- 已有第三方兼容配置转成自定义，保留 ID、名称、地址、Key、模型、自定义请求头和功能选择。旧的独立 Gemini / 千问直播、微软 / Gemini 朗读配置一次性迁入列表。
- `providerSchema: 2`，`providers[]` 是持久化连接配置的唯一来源。`liveProviderId`、`ttsProviderId` 与四项文字用途分别绑定配置。运行时归一化生成旧客户端所需的连接快照；存储和备份不再重复保存旧平铺连接字段。
- 各功能选择器按类型筛选；复制或新增配置不抢占功能绑定。删除已绑定配置只回落到启用的同类配置；每类最后一项不可删除。使用中的配置不可停用；导入的已停用绑定保持可见并在使用前报错。
- 朗读服务字段和音色移入提供商编辑器，功能页保留选择、语速、试听。实际朗读按配置 ID 解析和隔离缓存。直播开播前验证选定配置，开始后的连接快照保持冻结。
- 默认备份去掉所有类型的 Key 及文字配置的请求头；无凭据导入按 ID 保留本机凭据。日志和错误遮盖所有配置中的凭据，包括逗号分隔的多直播 Key。

## 验证与交付

- `npm run check`：178 / 178 回归通过，语法和算法自检通过。全量检查发现的两处旧 fixture 已改为更新统一配置及使用真实 Settings 实现，没有增加生产代码兜底。
- 实际本机 Chrome 无头离线界面检查：77 项通过，1440 / 390 宽度、明暗主题；0 脚本错误，0 网络请求。使用 Chrome API 模拟与示例配置，禁止真实 HTTP(S)。这是界面检查，不是实际扩展授权或服务调用验证。
- `npm run package` 与 `git diff --check` 通过。`dist/live-translate-extension-0.4.7.zip` 的 60 个文件与当前源码逐字节一致，manifest 在 ZIP 根且版本为 0.4.7。
- ZIP SHA-256：`f0b229969149bcbf508339d775ee4bd87d464a0c20655b8ce75f75ec6fb1d15d`。
- 离线截图、报告和 QA 脚本位于忽略的 `dist/preview/`。入口截图 `provider-dialog-1440-light.png`，列表截图 `providers-1440-light.png`；另有手机和深色版。
- 没有连接真实 Gemini / 千问 / TTS / 自定义接口，没有真实 YouTube 音频、字幕请求或宿主权限弹窗验证。需要在扩展管理页重新加载根目录扩展并刷新设置和 YouTube 页面后实测。
- 本轮未提交或推送。保留原先所有未提交工作和 `.codex-remote-attachments/`。旧 `dist/unpacked` 仍为历史 0.4.4 内容，交付使用仓库根目录源码或本轮 0.4.7 ZIP。

## 主要改动位置

- `src/common/constants.js`、`settings.js`：统一目录、类型、迁移、持久化及运行投影。
- `src/ui/options-provider-picker.js`、`options-providers.js`、`options.js`、`options.html`、`options.css`：统一页面、弹窗、编辑器与功能选择。
- `src/ui/options-tts.js`、`options-setup.js`、`options-data.js`：朗读、填写引导及统一备份。
- `src/common/selection.js`、`src/content/selection.js`、`src/background/selection.js`、`src/content/main.js`、`src/subs/text-model.js`、`src/common/live-log.js`：运行时按类型和配置 ID 解析、快照及凭据遮盖。
- 版本文档升为 0.4.7，0.4.6 记录保留为之前历史。
