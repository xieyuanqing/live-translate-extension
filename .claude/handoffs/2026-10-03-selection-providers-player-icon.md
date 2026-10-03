# 0.4.1 划词供应商与播放器单图标交接

日期：2026-10-03。本次在干净的 `main` 工作区上修改源码，尚未提交或推送。当前版本为未发布的 0.4.1，`dist/` 仍被忽略。

## 已完成

- 划词原文旁改为线框扬声器；朗读中同处显示停止，译文区只保留重译。页脚独立选择划词翻译模型、微软/Gemini 朗读服务和语速。切换翻译模型先取消旧请求，再保存配置并重译；无效配置不会退到其他模型。
- `selectionProviderId` 独立于字幕/评论模型和 AI 整理模型；旧设置首次沿用原字幕模型。设置页「文字模型」也可选此用途，删除当前所选配置时回落到第一套。
- YouTube 原生控制栏只保留一个灰白线框图标；直播启停、整片字幕开始/取消及完成后显隐复用此按钮。直播字幕显隐放到扩展弹窗；显示状态只用灰白短线提示，不再使用彩色标识和 ON/OFF 徽标。
- manifest/package、两份 README、CHANGELOG 和开发说明同步到 0.4.1。

## 验证和交付

- `npm run check`：62 个 JS 文件语法、自检、120 项模拟回归通过；`git diff --check` 通过。
- 隔离 Chromium 的替身 YouTube 页面：实际只插入一个按钮；划词翻译从模型甲切到模型乙时，后台请求按新 ID 路由并保存，整片字幕选择保持不变；朗读服务切换保存；扬声器位于原文标题行；390 px 视口内无溢出。截图在忽略目录 `dist/preview/selection-provider-041*.png` 和 `player-control-041.png`，脚本也在该目录，不进入安装包。
- `dist/live-translate-extension-0.4.1.zip`：57 个运行文件，SHA-256 `fd762c7bd0ea5ba1cdedb6bfbbebd7d5dd88ba145abfad99bbc7d2f8ec5007d2`。ZIP CRC 及 ZIP/源码/`dist/unpacked` 逐文件一致，无多余运行文件；固定安装目录已同步。
- 用户浏览器需要在扩展管理页重新加载，并刷新 YouTube 页面。新按钮尚未在真实 YouTube 页面核对；真实 Gemini TTS、直播/整片字幕调用及用户 Chrome 原生右键仍待实测。本次没有使用用户 Key 或录音。
