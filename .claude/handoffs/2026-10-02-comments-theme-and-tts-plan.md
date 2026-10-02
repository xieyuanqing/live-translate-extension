# 交接：YouTube 评论颜色修复与日语朗读研究（2026-10-02）

> 历史交接：以下状态和限制对应当时的开发阶段。2026-10-02 用户已要求将当前改动分批提交到 GitHub；最新实现以仓库源码及 CHANGELOG 为准，私人直播日志不提交。

接续 `2026-10-02-ui-theme-emotes.md`。用户反馈真实 YouTube 深色评论译文与工具栏提示黑字不可读，浅色操作色也待改善；同时要求先研究划词右键翻译和高质量日语原文朗读，下载 KISS / Read Frog 对照。已完成未发布 **0.3.5** 颜色修复与方案研究；朗读功能尚未实现或试听。保留此前所有未提交工作与用户日志，没有提交、推送或发布。

## 最新用户约束

用户明确要求首版不做姓名读音表、假名校正或自定义发音，只先做好普通日语朗读。后续不能把先前的自定义读法提议当作已接受需求。

## 评论修复

- 新版 YouTube 可把真实字色放在内层 `.yt-core-attributed-string`，外层 `#content-text` / body 仍是黑色；译文又位于 expander 外，单靠继承或通用页面变量会读错作用域。
- `YouTubeText.applySourceColor` 从内层或原文节点采样 computed color，设置在评论 host。字号等原文样式同样从该内层取得；聊天正文仍保留原生付费/会员颜色。
- 评论扫描刷新已有 host 字色，不替换译文、展开收起内容或请求模型。独立主题观察器只观察 html 的 dark/class/style，不监听插件节点，避免写 style 产生自身循环。
- 操作、状态、焦点和禁用控件按 YouTube `html[dark]` 使用独立深浅配色，不受 popup 主题控制。用户选择 textColor 装饰时保留其明确覆盖。
- 版本同步 manifest/package、README EN/ZH、CHANGELOG 和开发说明。只读代理复查未发现明显回归或观察器循环。

## 研究资料与后续方案

- 新克隆保存在仓库外的独立参考目录；没有覆盖旧 Read Frog 参考副本。
- KISS commit `7de86b4efcadf4245bbab0d9bcfb0c594b5ab2cd`：朗读主要使用 Chrome.tts / Web Speech，无法保证本机日语声音；页面译文默认不覆盖字色，界面控件采用成套亮暗 token。
- Read Frog commit `308a08d73091300c14fe2bf184d59895478174ef`：通过微软消费者鉴权路径获得 region/token，再调用 Speech SSML 合成；不要求客户 Azure Key，但不是公开承诺稳定的开发者免费接口。默认日语为 Masaru 男声，Nanami 为女声候选；其 HD 列表会被过滤，不能承诺免费 HD。
- Read Frog 的基础页面译文 CSS 继承原文字色，但首次安装实际预设为固定绿色 textColor；其页面 muted token 跟系统，不能替代 YouTube 的实际 dark 属性。应借鉴机制而非照搬默认值。
- 两份源码均为 GPLv3；目前没有复制 GPL 源文件进本仓库 MIT 运行代码。直接移用需先处理许可证。
- `docs/selection-and-japanese-tts-plan.md` 已记录路线比较、固定 commit 参考、官方资料和验收。主候选为微软 Neural，先试听 Nanami，再决定默认；Azure 官方接口为需 Key/区域的备选，千问后续可比较。右键翻译复用现有 TextModel，朗读直接使用日语原文与日语 voice。
- 后续实现需准确 tab/frame、按需注入、选区冻结、Shadow DOM 浮窗、后台合成 + offscreen 播放、停止/重播/简单语速、请求作废与音频释放。无需额外后端和永久全站注入。当前没有调用语音服务、生成音频或完成听感比较。

## 验证与安装包

- `npm run check`：50 个 JS 语法检查、自检和 **101 项模拟回归通过**；`git diff --check` 通过。
- 加强离线 Chrome fixture：body 与评论作用域变量故意保持黑色，内层原文字色独立设为页面主题颜色。旧 0.3.4 runtime 的 source/result 字色断言失败；0.3.5 在深浅色 × 1440/390 px 通过。主题只改 html 属性、不重绘文字时，现有译文正确变色、保持收起且无额外模型请求。
- 实际评论/聊天脚本仍以模拟 DOM / 模型运行，覆盖 12 种样式、回复、长 URL、付费/会员、缓存、节点重用和表情悬停。检查无脚本错误和横向溢出；已查看两种主题截图。
- 设置页样式预览在 1440/390 px 复查通过：12 预设、评论/聊天独立保存、颜色、重置和键盘操作；无脚本错误。
- 忽略目录 `dist/preview/` 包含 `comment-colors-qa.cjs/json`、四张深浅宽窄截图与旧版失败日志 `comment-colors-before.log`。这些模拟材料不进入安装包。
- `npm run package` 成功；`dist/unpacked` 同步为 0.3.5。ZIP：45 个运行文件，405224 字节，SHA-256 `8b2df565859a84b0cd2074d7c777a07779d42dfdb19109b9a0ff5f0ff2703682`。Python 验证 ZIP CRC、运行文件集合与源码/ZIP/unpacked 逐字节对应，manifest 位于根目录。

## 边界

没有操作用户正在播放的 Chrome/YouTube 页面；当前启用的浏览器工具没有用户 Chrome surface。离线测试证明修复在作用域回归 fixture 下有效，不能声称实际 YouTube 已验证。用户需在扩展管理页重新加载并刷新 YouTube 核对。此前真实直播/字幕接口、模型质量、日志耐久性待验证项保持不变；朗读仅完成研究。
