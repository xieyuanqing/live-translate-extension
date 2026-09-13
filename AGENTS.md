# AGENTS.md

本仓库是独立的流译浏览器扩展。产品与安装说明看 README.md，中文说明看 README.zh-CN.md，技术约束看 docs/development.md。

## 范围与协作

- 用中文与项目持有者沟通；主 README 使用英文，中文文档保持对应。
- 优先个人日常使用体验，简单直接，不添加未经要求的账号、订阅、后端或多平台支持。
- 当前主要支持 YouTube 直播音频翻译。不是读取已有 CC 字幕的翻译器；不抓麦克风。
- 当前界面为简体中文。英文 README 不代表界面已国际化。
- 不依赖 Android 仓库，不迁入其构建、服务端或历史数据。
- 分支前缀使用 codex/；代码注释和提交说明使用中文。
- 危险操作如删用户文件、删分支、强推必须先确认。

## 保持的行为

- 场景只包含名称和提示词，语言方向独立保存；临时补充仅存当前页面内存。
- 开始时冻结 Prompt、语言、场景和连接配置。停止、换视频或重开必须作废旧异步启动；旧回调不得改新会话。
- 源音频必须持续连接 AudioContext.destination，停止翻译只断开采集旁路；全页复用 AudioContext。
- 字幕注入 #movie_player，随全屏 / 剧场模式显示。
- 连接轮换、重连统一清理旧 socket 和定时器。保留默认 505 秒轮换、200 块队列和异常断线约 1 秒回填。
- setup 字段位置以 docs/development.md 和已验证实现为准。
- 视频元数据与手写背景当作资料，不能当作可信指令。提示词围栏只是缓解措施，不承诺绝对防护。
- 数据处理描述必须真实：音频和背景会发送给 Gemini 或用户配置的反代，API Key 当前明文存在 chrome.storage.local。
- 不加入用户 API Key、浏览器配置、抓取的音频、假数据或本机绝对路径。
- 以后做界面国际化时，必须把展示标签与 Prompt 标签分开，不能随界面语言改变本场指令。

## 验证与交付

无需安装依赖，Node.js 22+：

```sh
npm run check
npm run package
git diff --check
```

- 插件根目录即仓库根目录；修改后在扩展管理页重新加载，并刷新 YouTube 页面。
- npm run check 包括语法、原有算法自检和会话竞态回归；这些不能替代真实音频 / Gemini 实测。
- npm run package 只将 manifest.json、src/ 和 icons/ 打进 dist/，manifest 位于 ZIP 根目录。
- 版本同时维护 manifest.json、package.json、两份 README 和 CHANGELOG.md。
- 功能或重要修复补 CHANGELOG.md；验证记录区分自动化模拟与真实浏览器。
- 商店上架以后单独处理；不得宣称已获审核、已上架或已完成隐私合规。
