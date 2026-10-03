# 划词翻译与日英朗读方案

研究及更新日期：2026-10-03。状态：已实现为 0.4.2 开发版。0.4.2 按双卡片设计收紧划词浮窗：顶部选目标语言和固定位置，原文旁只留一个可停止的扬声器，译文旁是复制/重译图标，底栏独立选翻译模型与朗读服务；语速只在朗读设置。旧设置的划词模型首次沿用字幕模型，之后独立保存。微软真实日语／英语合成及扩展播放此前已验证；Gemini 用网络替身验证，真实 Gemini 权限与音色听感待验收。

## 首版目标

- 选中文字后，右键提供「流译：翻译与朗读」，句子旁显示原文和译文，点播放才朗读；不打开单独页面或窗口。
- 翻译调用现有文字模型；朗读直接合成原文，只使用日语和英语，不先翻译，也不先调用 LLM 改写。
- 日语是主要验收语言，同时支持英语；声音自然、操作直接、可以停止和重播。
- 首版支持微软与 Gemini 两个供应商，设置中随时切换；各自保留配置，共用同一套播放界面。
- 不做姓名读音表、假名校正、自定义发音、克隆声音或额外后端。
- 普通网页用 `activeTab` + `scripting` 在用户点击菜单后按需注入；不新增永久全站注入。
- 优先验收 YouTube 普通页面、评论和聊天 iframe；浏览器内部页等受限页面显示明确提示。

## 推荐路线与备选

| 路线 | 价值 | 代价或限制 | 首版定位 |
| --- | --- | --- | --- |
| Read Frog 使用的微软消费者语音路径 | 无需客户 Azure Key，日语/英语 Neural 音色可选，原生 JS 可接入 | 使用非公开承诺稳定的客户端兼容路径，可能失效或受地区影响 | 首版默认供应商 |
| Gemini TTS，包含用户提出的 3.1 Flash TTS Preview | 有官方接口及免费档，可以比较另一种音色与读法 | 需要 Gemini API Key；实际额度以项目为准，3.1 已是旧预览版；请求和音频格式与微软不同 | 首版第二供应商 |
| 千问 Qwen3-TTS-Flash | 支持日语和英语，REST 接入直接 | 需有相应权限的 Model Studio Key；聊天反代 Key 不一定支持 TTS | 第三个供应商的后续候选 |
| Azure Speech 官方接口 | 正式认证与开发文档，提供日语/英语 Neural / HD | 用户要配置 Speech Key 和区域，按量计费 | 后续正式微软接口备选 |

日语默认 `ja-JP-NanamiNeural` 女声；首版男声可选 `ja-JP-MasaruNeural`。
英语默认 `en-US-JennyNeural`，另可选 Aria / Guy。已确认真实请求和播放可用，主观自然度与其他音色比较仍由用户试听决定，不宣称当前默认是最佳音色。
普通句子直接交给 TTS；罕见人名或多音汉字可能读错，首版不增加读音控制系统。

## 只判断日语和英语

按用户指定的简单规则处理，不接入语言识别库或识别模型，也不提供中文分支。

1. 仅在判定副本上做 Unicode NFKC 归一化；发送给 TTS 的原文保持不变。
2. 抽取字母，忽略空格、数字、标点和表情。
3. 至少有一个字母且所有字母都属于拉丁文字时，选择 `en-US`；其余选择 `ja-JP`。
4. 空白选区不发请求；纯数字沿用日语分支。

示意逻辑：

```js
function readingLanguage(text) {
  const letters = String(text).normalize('NFKC').match(/\p{L}/gu) || [];
  return letters.length && letters.every(letter => /\p{Script=Latin}/u.test(letter))
    ? 'en-US' : 'ja-JP';
}
```

| 选中文字 | 朗读语言 |
| --- | --- |
| `Hello, world! 2026` / `Don't worry.` | 英语 |
| `APEX` / `ＡＰＥＸ` / `café` | 英语 |
| `花芽すみれ` / `東京` / `お疲れ様！` | 日语 |
| `APEXお疲れ様` / `2026` | 日语 |

罗马字拼写的日语会按英语读，其他拉丁文字也会按英语读；这是两语言粗规则的明确取舍，不另加分类系统。
判定结果必须进入供应商请求：微软选择对应语言 voice 和 SSML 语言；Gemini 明确传 `speechConfig.languageCode`（`en-US` / `ja-JP`），并要求只朗读指定原文。
Google API 文档有该语言字段，但具体 TTS 型号的接受程度、纯汉字是否按日语读仍须真实试听，不能只根据客户端判定声称服务端发音已验证。

## 供应商切换与 Gemini 接入

- 设置仅展示当前供应商需要的字段。微软配置日语/英语音色；Gemini 配置 Key、模型和音色，并提供日语/英语试听。
- Gemini 可由用户选择复用现有 Gemini Key，也可单独填写；TTS 的供应商、模型和音色独立保存，切换不会改直播或文字翻译配置。
- 统一合成入口只接受冻结的原文、语言、供应商配置及取消信号，返回音频数据和 MIME 类型；鉴权、请求和音频格式在各适配器内处理。
- 微软返回 MP3；Gemini 3.1 返回的裸 PCM 需按实际 MIME/采样率封装为 WAV 后播放。新版模型可直接返回 WAV，不能把同一套格式处理硬套给所有模型。
- 首版先使用单说话人、完整短句合成，不添加音频标签、情绪控制或声音克隆。微软和 Gemini 共用 offscreen 播放、停止、重播和简单语速。
- 播放速度优先在播放器统一控制，并保持音高；首次不再为不同供应商增加一套语速提示词或参数。
- 重播复用当前结果的内存音频；缓存身份包括供应商、模型、音色、语言和原文。供应商切换作废旧请求，旧结果不得重新开始播放。
- 接口失败或遇到 429 时显示重试/切换供应商入口；不后台连续尝试所有服务。

截至本次核对，官方价格页确认 `gemini-3.1-flash-tts-preview` 有免费输入/输出档；官方额度页要求在 AI Studio 查看项目的实际限制，不保证所有项目统一每天 500 次。
AI Studio 网页试用体验也不能直接当成扩展 API 的固定额度。
3.1 模型页目前已标为 legacy preview，并推荐 3.8 TTS 系列。保留用户提出的 3.1 选择，模型设为可配置；实际接入时按型号处理 schema 和输出格式，再决定默认型号。

## 免费路径与官方接口的区别

Read Frog 先请求 Microsoft Translator 客户端 endpoint，取得 region/token，再 POST SSML 到区域 Speech endpoint。
该路径不要求客户 Key，但不能描述成微软向扩展开发者保证稳定的免费 API。
Read Frog 的可选列表主动过滤 DragonHD：消费者 token 返回的区域不可控。
因此首版使用普通 Neural 音色，不承诺免费路径支持 Azure 官方 HD 音色。
若消费者接口失效，应给出可理解的错误和重试入口，允许切换已经配置的 Gemini，保留后续官方 Azure 适配器的空间。

## 菜单、浮窗与播放

- 使用 Chrome 菜单的 `selectionText`，冻结本次原文；按 `tabId` / `frameId` 发到实际选中文字的 frame。
- 翻译浮窗显示原文与译文，译文旁有复制和重译图标，调用现有 `TextModel` / 网络层及已配置的接口。目标语言在顶部选择，翻译模型与朗读服务在底栏选择。
- 点击菜单后按需读取并克隆选区 Range，浮窗靠近句子，随滚动／译文高度更新位置，边缘自动放到上方或限制在视口内；不新增全站监听来提前记录坐标。
- 浮窗用 Shadow DOM 隔离网页样式，译文用纯文本渲染，并使用现有浅色 / 深色主题。
- 朗读准备与播放状态只通过原文旁的扬声器轻量显示；失败时短暂提示，不常驻占行。再次点击扬声器可在合成或播放期间停止。
- 默认正常语速；慢一点和快一点放在「设置 → 划词与朗读」，浮窗不展示语速、音色或 API 配置。
- 翻译中在译文卡片直接显示“翻译中…”及小型旋转图标；原文超过五行折叠，译文不单独限高。
- 关闭播放浮窗或对应页面导航时停止该任务，避免旧页面的完成回调重新开始播放。

## MV3 实现边界

后台负责菜单、所选供应商的鉴权和合成；offscreen document 负责 `Audio` 播放，不依赖 popup 保持打开。
复用创建中的 offscreen promise，避免同时点击产生多次创建；文档回收后允许重建。
每次启动递增 `requestId`；停止、导航或新朗读作废旧编号，旧响应不得覆盖新任务。
配合 `AbortController`、有限重试和超时；401/403 可刷新 token，429/服务故障不无限请求。
音频只在内存短暂缓存；结束或停止时清理播放器和 object URL，不默认持久保存划词或语音。
微软 token 保存在临时内存，日志不输出 token 或 Key；权限仅申请实际使用的语音域名。
选中的原文发送给当前所选语音供应商；Gemini Key 按现有设置机制明文保存在本机扩展存储，说明须如实呈现。
播放独立于直播采集旁路，不改变播放器原音频连接，也不把朗读输出当成待翻译音频。
独立 Chromium 检查使用真实 AudioTap worklet：先播放已知音调确认采集有效，视频改为静音波形后同时播放 offscreen 朗读，采集块仍为零。这验证了音频路径隔离；真实 YouTube 上的并行播放、听感与当前网页兼容性仍待用户验收。

## 下载源码与参考位置

- KISS Translator：`7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd`；参考[右键菜单与转发](https://github.com/fishjar/kiss-translator/blob/7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd/src/background.js#L454)、[系统朗读](https://github.com/fishjar/kiss-translator/blob/7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd/src/libs/speech.js#L65)。
- Read Frog：`308a08d73091300c14fe2bf184d59895478174ef`；参考[准确 frame 菜单](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/entrypoints/background/context-menu.ts#L239)。
- 微软路径：[endpoint 常量](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/constants.ts#L30)、[鉴权](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/endpoint.ts#L82)、[合成](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/synthesize.ts#L88)。
- 日语候选及 HD 过滤：[音色配置](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/types/config/tts.ts#L2014)、[过滤规则](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/types/config/tts.ts#L3175)。
- MV3 播放参考：[offscreen 调度](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/entrypoints/background/tts-playback.ts#L11)、[Audio 清理](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/tts-playback/dom-audio-controller.ts#L38)。
- 两份下载源码均含 GPLv3：[KISS LICENSE](https://github.com/fishjar/kiss-translator/blob/7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd/LICENSE)、[Read Frog LICENSE](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/LICENSE)。
- 开发阶段先按本机自用实现；当前用户已要求上传源码。保留版权、来源、版本、完整适配源码与许可证文件，并明确组合包不能笼统标为 MIT。
- 0.4.0 已将微软签名／endpoint 协议适配进 `src/tts/microsoft.js`，随运行包保留 `src/tts/LICENSE.read-frog`；来源、版本和改动见 [第三方来源记录](third-party-tts.md)。GPL 允许私人修改和使用，不要求因此公开修改版；见 [GNU 官方 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#GPLRequireSourcePostedPublic)。
- 本次 GitHub 同步保留 GPLv3 适配部分及其许可证；向别人分发组合安装包时仍需遵守适用许可要求。复制的 GPL 部分不会因仓库现有 MIT 标签自动变为 MIT。

## 官方资料与验收

- [Azure 日语音色](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)、[HD 的 SSML 支持](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices#supported-and-unsupported-ssml-elements-for-azure-speech-hd-voices)、[REST 认证与音频](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。
- [千问日语音色](https://help.aliyun.com/en/model-studio/qwen-tts-voice-list)、[Qwen3-TTS API](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api)；可选备选不代表现在要同时接入。
- [Gemini 3.1 Flash TTS 模型](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview)、[免费档价格](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-tts-preview)、[项目实际额度](https://ai.google.dev/gemini-api/docs/rate-limits)、[SpeechConfig 语言字段](https://ai.google.dev/api/generate-content#SpeechConfig)、[TTS 音频格式及迁移](https://ai.google.dev/gemini-api/docs/speech-generation)。
- [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)：`AUDIO_PLAYBACK` 在无播放 30 秒后回收，需要处理重新创建。
- 用正常日语短句、纯汉字词语、问句及长一点的句子试听，同时检查带标点的英语：核对两家供应商的语言、清晰度、自然度、停顿和语速，不以文档宣传代替听感。
- 实测首次播放、重播、停止准备中的请求、快速切换选择、供应商切换、跨 frame、页面导航、网络失败/限流与 offscreen 回收。
- 先完成状态机模拟和 `npm run check` / `npm run package` / `git diff --check`，再完成真实 Chrome 与 YouTube 检查。
- 已通过微软日语／英语真实合成与 offscreen 播放。独立浏览器检查覆盖设置与浮窗深浅色、宽窄屏、靠近选句且不自动朗读、重播不再请求、准备中停止、导航取消、offscreen 重建，以及网络替身 Gemini 音频／文字模型。帧受限时回退同一网页顶层帧，不额外开页面。未使用真实 Gemini Key；原生 Chrome 右键手势、当前 YouTube 聊天跨 frame 和主观音色尚待用户验收。
