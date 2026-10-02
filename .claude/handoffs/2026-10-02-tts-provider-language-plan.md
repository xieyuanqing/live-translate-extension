# 交接：朗读供应商切换与日英规则（2026-10-02）

> 历史交接：以下状态和限制对应当时的开发阶段。2026-10-02 用户已要求将当前改动分批提交到 GitHub；最新实现以仓库源码及 CHANGELOG 为准，私人直播日志不提交。

接续 `2026-10-02-comments-theme-and-tts-plan.md`。用户认可微软方案，提出增加一两个语音供应商，明确希望 Gemini 3.1 Flash TTS；只需日语和英语，纯拉丁字母读英语，其他读日语。用户明确当前只在本机自用，GPL/MIT 许可处理留到分发或公开推送前，不用因此阻碍开发。

本次只核对资料并更新 `docs/selection-and-japanese-tts-plan.md`，没有实现运行代码、调用用户 Key、合成音频或修改 0.3.5 安装包。没有提交或推送。

## 已更新的设计

- 首版微软默认 + Gemini 第二供应商，设置独立保存并随时切换，共用后台合成入口、offscreen 播放和停止/重播/简单语速。千问可作为后续第三个供应商，Azure 官方保留备选。
- 右键菜单改为「朗读选中文字」，仅日语/英语；判定副本 NFKC 归一化，抽取字母，至少一个且全 Latin 则 en-US，其余 ja-JP。原文不改写；忽略数字/标点/空格/表情，纯数字沿用日语，空白选区不请求。罗马字日语会读英语，是接受的简单规则取舍。
- 判定结果必须传到供应商：微软使用对应语言 voice/SSML；Gemini 指定 speechConfig.languageCode。Google 官方 schema 有 en-US/ja-JP，但型号实际支持和纯汉字读法待实测，不能声称客户端判定已保证服务端读音。
- Gemini API Key 可由用户选用已有 Gemini Key 或独立填写；TTS 配置不改变直播/翻译模型。音频缓存依供应商/模型/声音/语言/原文区别；切换作废旧请求，重播复用结果。

## 官方资料核对

- Gemini 3.1 TTS 的价格页确实列出 Free Tier 免费输入和输出：https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-tts-preview 。
- 额度页要求在 AI Studio 查看项目实际限制，按项目而非 Key 计算，没有确认统一 500 次/天：https://ai.google.dev/gemini-api/docs/rate-limits 。不把 AI Studio 网页额度当成扩展 API 固定额度。
- 截至 2026-10-02，3.1 TTS 模型页已标 legacy preview，推荐 3.8 TTS 系列：https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview 。保留用户提出的型号并让模型可配置；后续按版本适配请求结构与音频格式，不能承诺只改模型名就兼容。
- Gemini 3.1 裸 PCM 与新版完整 WAV 区别见官方迁移/输出格式说明；微软为 MP3。适配器按实际 MIME 和采样率处理，统一交给播放器。
- GPL 允许私人修改和使用而不公开；移用时保留版权、来源、版本、许可证记录。向他人分发安装包或公开推送前处理适用许可或替换移用部分。没有更改仓库 LICENSE，没有复制外部源文件。

## 状态与边界

仅方案更新。两语言规则做示例执行核对、文档差异检查；供应商可用性、额度、音色和汉字日语发音均未用实际 Key 验证。当前运行版本仍为前一交接的 0.3.5，101 项回归与离线评论颜色修复结果不属于本次朗读实现证据。
