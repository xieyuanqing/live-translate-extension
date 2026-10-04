# 朗读功能第三方来源记录

本记录对应 0.4.0 开发版，日期 2026-10-02。源码包含下列第三方适配及许可证；尚未创建 GitHub Release。

## 微软消费者语音适配

`src/tts/microsoft.js` 的客户端 endpoint、签名材料及 HMAC 签名协议改编自 Read Frog，原作者版权及 GPLv3 许可保留。上游版本为 `308a08d73091300c14fe2bf184d59895478174ef`：

- [constants.ts](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/constants.ts)
- [signature.ts](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/signature.ts)
- [endpoint.ts](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/endpoint.ts)
- [synthesize.ts](https://github.com/mengxi-ream/read-frog/blob/308a08d73091300c14fe2bf184d59895478174ef/src/utils/server/edge-tts/synthesize.ts)

修改包括：改为无构建依赖的普通 JavaScript；使用本项目 fetch/取消/超时；短暂缓存 token；仅保留日语与英语；SSML 转义及 UTF-8 分块；中文错误；401/403 有限刷新。完整上游许可证复制为 [`src/tts/LICENSE.read-frog`](../src/tts/LICENSE.read-frog)，随运行包保留。客户端公开签名材料不是用户 API Key。

菜单 frame 定位、offscreen 播放和资源清理思路也参考 Read Frog。KISS Translator 下载版本为 `7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd`，用于研究右键菜单和系统朗读流程；未直接复制其源文件进运行代码。

## 当前边界

原项目核心的 MIT 文件继续保留；Read Frog 改编部分按其 GPLv3 许可证提供，完整源码、来源、修改记录与许可证一并上传。直接改编的 GPL 部分不会自动变成 MIT，整个组合包不能笼统标为 MIT，package.json 的 license 因此指向本说明。后续如分发组合安装包，仍需遵守适用许可要求。本记录说明当前来源与标注，不宣称已完成公开发行许可审核。

Gemini 适配器、浮窗、任务取消和设置代码为本仓库新增实现；Google/微软上游服务的账号、额度与使用条款独立于源代码许可。
