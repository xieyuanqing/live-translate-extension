# 交接：字幕读取加固 + 设置页重构（2026-09-19）

继续自 `2026-09-18-020-polish.md`。本次工作在 worktree 分支 `claude/caption-fetch-review-941ce5`（目录 `D:\live-translate-extension\.claude\worktrees\caption-fetch-review-941ce5`），该分支已快进包含 0.2.0 功能分支的全部提交（5dec1d8），本次改动**尚未提交**。主分支和线上版本未改变，0.2.0 仍未发布，仍未真机验证。

两份设计稿（`docs/design/2026-09-19-caption-fetch-hardening.md`、`…-settings-redesign.md`）留在 worktree `project-progress-latest-commit-d27729` 里未跟踪，已被本次实现取代，可以删掉。用户与 GPT 评审的采纳结果：读取路径不再每轮重跑网络请求、统一截止时间、取消可中断；CC 恢复检查用户是否介入；解析改动只保留「识别格式打日志」，`SEG_VERSION` 仍为 1；测试连接分两级；设置不做迁移。

## 做了什么

**1. 字幕读取加固**（`page-bridge.js` 重写，`youtube.js`、`video-subs.js`、`main.js`、`json3.js`、`constants.js`）

- 读取顺序：拦截正文 → 拦截 URL 改 json3 补取 → `getAudioTrack().captionTracks` 同轨道 URL（一般自带 pot）→ 用任意来源的 pot 加 baseUrl 按 read-frog 参数组合拼 URL → 同视频其他轨道换轨 → 开 CC 触发（`toggleSubtitles()` 或点按钮，触发期间隐藏原生字幕，3 秒没动静再 `setOption` 指定轨道）→ 最后 baseUrl 作诊断对照。
- 触发后每 200 毫秒只检查「拦截计数 / 音轨 URL」有没有变化，变化才重跑候选；每个候选 URL 只请求一次；触发后最多等 12 秒，整个读取 20 秒截止（内容脚本等 25 秒）。
- CC 只在「同一视频、同一播放器节点、CC 仍然开着」时关回去，用户中途关掉就不碰。桥内读取串行；内容脚本在取消 / 换视频时发 `cancel`（`LT.BRIDGE.KIND_CANCEL`）让读取立即退出。
- 每一步记进 `tried` 随结果返回，`readTrack` 打进控制台，错误文案列出已尝试的路径。`tracks()` 多返回 `selected`（播放器选中轨）、`hasPot`、绝对 `baseUrl`；`chooseTrack` 在指定语言时优先同语言的选中轨，自动检测时选中轨最优先。
- `LT.debug.probeCaptions()`：只读轨与分句，不调用模型不写缓存，返回轨道、选中轨、pot 状态、来源、`tried`、格式、事件数、单元数、样例。`Json3.detectFormat` 只进日志（standard / scrolling-asr / karaoke / animated），不改解析。

**2. 文字模型多套配置**（`constants.js`、`settings.js`、`text-model.js`、`net.js`、`service-worker.js`、`options-providers.js`）

- `settings.providers[]` + `subsProviderId` 替代原来的 `text*` 六个字段，**没有迁移**：旧字段被 `normalize()` 清掉，用户要重填一次。每套带并发与请求路径。
- 两级测试：`TextModel.probe`（GET 查模型信息 / 模型列表，不花额度，只证明 Key 能访问查询接口）和 `TextModel.generateTest`（走 `translate` 的完整路径发一条极短请求，花少量额度）。`TextModel.listModels` 填模型名候选，不预填。
- `LT.Net.request({ method, timeoutMs })` 贯穿直连与后台转发，SW 按 method 发、GET 不带正文；`post` 保留为快捷方式。

**3. 设置页重构 + 外观 + 数据**（`options.html/css/js`、`options-style.js`、`options-data.js`、`caption-layer.js/css`、`prompt.js`）

- 七个分区左栏导航，hash 路由，窄于 720 像素变顶部标签条，记住上次分区。
- 外观：显示模式（双语 / 仅译文 / 仅原文，替代 `showSource`）、译文位置、字体栈、字重、译文 / 原文颜色、原文字号比例，全部经 CSS 变量下发；预览用真实 `CaptionLayer` 挂在自适应宽度的假播放器上。显示模式只过滤显示，不停止翻译；双语 / 仅原文下未翻到的条目先显示原文（`tick()` 现在总是传原文）。
- 整片字幕附加指令 `subsExtraInstruction`：追加在场景之后，进系统提示词和缓存指纹。
- 数据：导出（默认不含 Key）、导入（校验 `app === 'liuyi'`，不含 Key 时按接口配置 id 保留现有 Key，确认后整体覆盖并重载页面）、恢复默认（可保留 Key 与接口配置）。
- 关于：版本、链接、打开 Chrome 快捷键设置、诊断命令提示。搜索、整片字幕快捷键、设置页内的诊断按钮**没做**，按用户要求放最后。

## 验证情况

- `npm run check`：36 个文件语法、自检全部通过、65 个回归用例通过（新增：页面桥 13 例、轨道选择 5 例、文字模型卡片 6 例 + 导入导出 2 例、网络 GET 2 例、取消读取 1 例）。`npm run package` 正常，`git diff --check` 干净。
- `node tools/preview.js` 生成 `dist/preview/options.html`（chrome.* 替身），用无头 Chrome 在 1280 与 600 像素截图看过全部七个分区，布局正常。截图在 `dist/preview/shots/`（被忽略）。
- **没有任何真机验证**：YouTube 字幕接口、真实模型、设置页在真实扩展环境里的行为都没跑过。

## 真机验证清单（按顺序）

1. `chrome://extensions` 重新加载扩展，刷新 YouTube；设置页确认布局，在「文字模型」里重填接口配置（旧配置已清空），点「测试连接」和「生成测试」各一次，记录耗时与 via。
2. 打开一个日语自动字幕的已结束直播回放（超过 1 小时，CC 关着），DevTools Console 切到本扩展上下文，跑 `await LT.debug.probeCaptions()`，把返回对象整个复制下来。期望 `source` 是 audiotrack / composed / triggered-* 之一，`format` 是 standard 或 scrolling-asr。
3. 同一视频先手动开 CC 再 probe，期望 `captured` 或 `refetch`。
4. 人工日语字幕的视频、多轨道视频（人工日 + 自动日 + 人工英）、没字幕的视频、歌回（看 `format` 与 `tried`）。
5. 弹窗点「翻译整片字幕」：进度、首条字幕耗时、拖动到未翻处、换视频再换回、刷新后缓存零请求、2 倍速 / 全屏同步。
6. 第三方 OpenAI 兼容接口（含带端口的本地网关）：授权域名，「测试连接」应提示走后台，翻译日志 `via` 为 relay。
7. 外观：改显示模式 / 位置 / 颜色 / 字体，YouTube 页面即时生效且与预览一致；仅原文模式下未翻条目显示原文。
8. 数据：导出文件不含 Key；导入不含 Key 的文件后 Key 还在；恢复默认保留 Key。
9. 正在直播的页面：弹窗不显示整片区块，实时翻译不受影响；双语模式下实时翻译显示原文行。

失败时把 `[流译]` 开头的控制台行、`LT.debug.videoSubs.status()`、`tried` 原文记进下一份交接。根据结果决定是否删掉 CC 开关 / setOption 里不工作的一条，以及 `detectFormat` 的阈值。

## 接下来

1. 上面的真机验证，修正读取路径。
2. 通过后提交并合入 main（分支名是 `claude/…` 而不是 AGENTS.md 说的 `codex/`，合并时注意）。
3. 后续：设置搜索、整片字幕快捷键（`toggle-video-subs`）、设置页内诊断按钮、播放器内按钮与面板、隐藏原生 CC、SRT 导出；json3 卡拉 OK / 特效字幕的专门解析等真机见到样本后再定。

## 容易踩的坑

- `tools/page-bridge.test.js` 的时间是假的：`setTimeout(fn, 200)` 立刻返回并把假时钟拨快 200 毫秒，所以桥里 200 毫秒的睡眠只能用于轮询，补取超时用 `Math.max(250, …)` 避开 200。
- 沙箱里出来的对象原型不同，断言前先 `JSON.parse(JSON.stringify())`。
- `options.js` 的 `queueSave` 仍然不能用返回值覆盖 `settings`（场景卡片与接口配置卡片的闭包持有对象引用）；导入 / 恢复默认走 `replaceSettings` → 写入后 `location.reload()`。
- 窄屏的 `.two` 单列规则必须放在 `options.css` 最后，否则被后面的基础规则覆盖。
- `dist/` 被忽略；预览页与截图不进包。生成预览：`node tools/preview.js`。
- read-frog v1.47.3 已克隆在 `D:\read-frog`，查它的做法直接读本地文件。
