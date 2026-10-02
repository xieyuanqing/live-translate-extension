# 0.4.0 划词浮窗与日英朗读实现交接

> 历史交接：以下状态和限制对应当时的开发阶段。2026-10-02 用户已要求将当前改动分批提交到 GitHub；最新实现以仓库源码及 CHANGELOG 为准，私人直播日志不提交。

日期：2026-10-02。用户已明确要求开始执行；当前本机自用，不提交、不推送、不公开分发。仓库仍有此前 0.3.x 大量未提交改动和私人直播日志，全部保留，勿清理或把日志打包。

## 已实现及最新交互要求

- 用户最后补充：像 Read Frog/沉浸式翻译，选中句子右键，句子旁显示原文和译文，点击播放；不要单独页面。最终实现按这个要求调整。
- 菜单统一为「流译：翻译与朗读」，仅按需注入准确 frame；打开浮窗先自动翻译，不自动合成／播放。浮窗在选区 Range 附近，随内容高度、滚动和窗口大小调整；窄屏／边缘保持在视口内。帧受限时在同一 tab 顶层靠近 iframe 显示；彻底受限的浏览器页用扩展 badge/title 提示，不额外开页。已移除开发中的 selection.html/selection-fallback.js 路线。
- 浮窗用 Shadow DOM + constructed stylesheet + textContent，显示原文／译文、播放原文、停止、重播、复制、供应商和语速，响应柔和灰深／浅主题变化。关闭／导航断开 port 后取消所属任务。
- 翻译复用当前字幕文字模型与目标语言，不发送视频背景，也不先叫 LLM 判断语言。
- 朗读只有日语／英语：NFKC 分类副本抽取字母，全 Latin 且非空读英语，其余日语；原文不改写。不做人名读音表、假名校正、克隆音色或后台。
- 微软消费者接口默认 Nanami（日语）／Jenny（英语），另有普通 Neural 选项；Gemini 是第二供应商，可复用已有 Gemini Key 或填独立 Key，默认 3.1 Flash TTS Preview，可配置型号／音色。3.8 请求 schema 与 WAV 输出分别处理；3.1 PCM 按实际采样率封装 WAV。免费额度以项目为准，未保证每天 500 次。
- 统一后台任务、offscreen 独立播放器、客户端／播放器十秒心跳，防止 MV3 空闲关闭；递增身份+AbortController 作废旧任务，创建期间也可停止；最多三段内存重播缓存，十分钟内有效；停止／结束释放 URL。语速统一用播放速度，保持音高，不重发合成。
- `ttsGeminiApiKey` 纳入日志脱敏；默认导出不带 Key，无 Key 导入及保留 Key 恢复均保留它。Key 依旧明文存本机扩展存储。
- UI「朗读」第九设置区有两家配置、日语／英语试听、速度及域名授权。试听等待保存时也能取消。安装时补默认字段简化成 `Settings.save({})`，避免把更早的读取快照再次覆盖回去。

## 文件与许可

主要新增：common/selection、background/selection、content/selection、tts/{audio,microsoft,gemini,offscreen.js,offscreen.html,LICENSE.read-frog}、ui/options-tts、tools/selection.test。

微软签名／endpoint 适配自 Read Frog `308a08d73091300c14fe2bf184d59895478174ef`，GPLv3，完整许可证保留在运行包，来源与改动记于 `docs/third-party-tts.md`。KISS 下载参考版本 `7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd` 未直接复制其运行源码。用户明确允许先按私人用途适配，公开发布时再决定许可或替换。原核心 MIT 留存，当前包不笼统标 MIT；package 的 license 指向说明。

manifest/package/两份 README/CHANGELOG 已同步 0.4.0；开发说明和方案文档更新为实际实现状态。

## 验证证据

- `npm run check` 全通过：语法、算法自检、113 项模拟回归（原 101 + 新增 12）。`git diff --check` 通过。
- 新增回归覆盖语言、UTF-8 分块、Gemini 新旧 schema、PCM/WAV、Key 脱敏、停止迟到合成／创建、跨 port 重播／导航、准确 frame、同页 frame 失败回退、试听等待保存取消、offscreen 旧消息及 URL 释放。
- 独立的无品牌 Chromium 开发配置，未访问用户 Chrome profile，也未改用户浏览器设置。
- 真实微软日语／英语接口合成及 offscreen 播放、结束、停止成功；日语样本 MP3 31,392 bytes，ffprobe 5.232 s。样本只放忽略目录的 `dist/preview/tts-microsoft-ja.mp3`，没进入运行包。
- 真扩展 + 网络替身 Gemini/文字模型验证语言字段、播放、同页选句浮窗、不开新页、不自动朗读、译文、重播无请求、准备中停止、导航取消、主题变化及 1440/390 px。`dist/preview/selection-e2e.json` / `.cjs` 及截图留作本机证据。
- AudioTap 真实 worklet 先采到测试音调 peak 4000；视频改为静音后同时播 offscreen 语音，15 个采集块 peak 0。关闭 offscreen 后由后续实际微软播放成功重建。`dist/preview/audio-isolation.json` / `.cjs`。
- Gemini 没用有效账号 Key，真实 Gemini TTS 合成和主观音色听感仍未验证；当前用户 Chrome 原生右键手势、真实 YouTube DOM／聊天跨 frame 待用户验收。已有直播长时间轮换／真实字幕接口待验项目仍未补齐。

## 成品

- `dist/live-translate-extension-0.4.0.zip`：55 个运行文件，490,285 bytes，SHA256 `3f86c6f346a16148ca70167c8ba9d74061786b46de065c41a74bb5a17a22c773`。
- `dist/unpacked` 已同步到 0.4.0 固定加载目录；运行文件集合与源码／ZIP 逐字节一致，ZIP CRC 验证通过。私人日志、QA profile、样本音频、截图、文档不在安装包内；GPL 许可证在内。
- 重新加载原安装目录，刷新 YouTube／相关网页。新界面用右键「翻译与朗读」，句子旁浮窗点击播放。

任何修改运行源码后必须重新打包并同步固定 unpacked 目录；若改变生成包，重新记录哈希。
