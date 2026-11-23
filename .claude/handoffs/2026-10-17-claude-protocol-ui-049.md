# 0.4.9：Claude 协议与设置页配色层次

## 用户要求

- 自定义供应商在 OpenAI 兼容、Gemini 之外加 Claude 格式。
- 设置页主次不清，要求多用颜色和符号；尤其「API 提供商」页的文字模型、实时翻译、语音朗读三类区分度要拉开。

## 已完成

- `src/subs/text-model.js`：`apiType: 'anthropic'`。地址填到域名（默认 `https://api.anthropic.com`），请求 `/v1/messages`、列模型 `/v1/models?limit=1000`；头 `x-api-key`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`（页面直连跨域必需），自定义头仍可覆盖。不传 temperature（新 Claude 模型拒绝非默认采样参数）。流式只取 `text_delta`，`message_delta.stop_reason` 作结束原因，流内 `error` 事件按可重试失败抛出，兼容非流式 `message`。`max_tokens` 加入 `Chunker` 截断原因，HTTP 529 提示「服务过载」。
- `LT.Settings.textApiType` 统一协议归一化（未知值仍按 Gemini）。新增 Claude 官方预设；`TEXT_API_TYPES`、默认地址、划词浮窗名称、提供商编辑页地址规则与 Key 占位均已适配。
- 配色：`ui.css` 新增三类识别色 `--kind-*`（文字靛紫／实时红／朗读青绿）和侧栏色相 `--hue-*`，`[data-kind]`／`[data-group]`／`[data-hue]` 映射到 `--k*`、`--hue`。`options.css` 用 CSS mask 画类型与区块图标，不新增图片或字体。
- 提供商页：筛选改为 全部／文字模型／实时翻译／原文朗读 分段控件并显示数量；「全部」按类型分组（组标题在首个条目内，列表仍一项一个元素）；上下移与拖拽只在同类之间；列表项加标识方块、选中用类型色；编辑区头部类型色铺底、类型徽标、只读「正在用于」；文字编辑分「连接」「可用模型」两段，「查询接口」移到连接段；折叠项有图标和箭头。切到提供商页时重新渲染，启用锁与用途保持最新。
- 全局：侧栏彩色图标块，页标题复用当前分区图标与色相，卡片标题前色条；功能分配按类型分组、行左侧类型色条；各功能页「当前接口」块按类型着色；状态改为 ✓／!／• 标签；配置提示条改为警示样式。
- 版本、两份 README、`docs/development.md`、`docs/interface-presets.md`、CHANGELOG 同步 0.4.9。

## 验证

- `npm run check`：68 个文件语法、自检（新增 6 项 Claude/协议检查）与 186／186 模拟回归通过（新增分组排序回归）。
- 离线 Chrome（scratch 脚本，未入库）：九个分区、提供商页和添加弹窗在 1440／390 px 浅深主题无横向溢出、无脚本错误；核对 Claude 预设新建后排入文字组、下移禁用、数量 3、地址规则含 `/v1/messages`，自定义接口切 Claude 后地址规则与 `sk-ant-...` 占位。
- `npm run package`：`dist/live-translate-extension-0.4.9.zip`，60 个运行文件；`git diff --check` 通过。
- 未连接真实 Anthropic 接口，未在真实扩展／YouTube 中验证；Claude 直连跨域、流式与模型列表需真机确认。改动未提交。
