**Beta Life UI Contract**

- 新增或大幅修改任何 surface 前先读本文件；这是 repository-level constraint，不是建议
- 目标：第一版就交付「primary content 优先、元信息收敛」的界面，不需要事后再压缩输入界面

---
## 1. Spacing、Type 与 Controls

- Spacing 只用 `src/styles.css` 的 shared tokens：字段之后用 `--ui-field-gap`，section 之间用 `--ui-section-gap`
  - 不用一次性像素值或负 margin 修补布局；新组件需要不同节奏时，加 named token 或 component rule
  - 标准 sheet content padding 为 `20px 21px 22px`；two-column row 与单列 row 到下一个 section 的间距一致
- Type 对齐 Settings 与 AI Provider：field label 用 compact semibold，control 用 shared input height 和 12–13px body，helper text 小一级且 muted
- 复用 shared button、input、select、panel、focus 样式，不发明第二套 radius、shadow、font scale；颜色只做强化，状态必须有文字或 `aria-label`
- CSS specificity 规则：generic 默认样式用 `:where()` 保持 0 specificity，不压过 context rule
  - shared input selector（`input:not([type="range"])…`）specificity 约为 `(0,4,1)`；需要覆盖时沿用 `.sheet-title-input` 重复 `:not()` 列表的写法，不用 `!important`

---
## 2. 文本输入（Text Input）

- 多行自由文本一律用 `MarkdownEditor`（`src/components/MarkdownEditor.tsx`），存储仍是 Markdown string
  - 无 toolbar；支持 input rules（`- `、`1. `、`> `、`#`、```、`**`、`*`、`` ` ``）、Cmd/Ctrl+B/I、列表 Tab 缩进，粘贴的 Markdown 直接渲染
  - 读取同一字段的展示处用 `MarkdownContent`，不能显示原始 `**`；未编辑的值不得重新序列化
  - 中文加粗以标点结尾（`**加粗。**后文`）必须能 round-trip，parser 与 renderer 都挂 `markdown-it-cjk-friendly`
- 例外：AI prompt 和给机器读的配置保持 plain `textarea`；名称、日期、URL 等单行值用 `input`
- 散文类编辑器不用 monospace；monospace 只用于 code 与 prompt
- Tags、枚举、阶段等有候选值的字段用 picker（`TagChips` 或 chip popover 里的 options），不让用户手打逗号分隔文本

---
## 3. 编辑 Sheet 布局：Title-as-header + Chips

- 先认定 primary content：记录里最长、最常读的字段（习惯备注、知识正文、记忆正文），它默认占满 sheet 剩余高度
  - 用 `.sheet-main-editor`，通过 `--main-editor-offset` 声明其余内容的高度；保留右下角 `resize: vertical`
  - 预算：1440×900 窗口下 primary content ≥ sheet 高度的 55%，header + chip row ≤ 约 130px；达不到就说明元信息没有收敛
- 记录名称就是 header：`.title-header` + `.sheet-title-input`，eyebrow 写 `TYPE · 新建/编辑`；不再放「编辑 X」h2，也不再另设名称字段
- 短元信息（时间、tags、日期、阶段、地点、来源、情绪）收进一行 `.chip-row`，用 `src/components/ChipFields.tsx` 的 `ChipPopover`、`TimeChip`、`TagChips`、`ChipTextInput`
  - 有值的 chip 显示值本身，空值显示 ghost chip（虚线 `+ 字段`）；不给每个字段配整行 label
  - 互斥模式合并进一个控件：例如「时间精度 + 时段 + 小时」合成一个 `TimeChip`，不要先选模式再出现第二个 select
- 不做重复的输入入口：不设「手动 / AI」切换，不另开导入框；只保留一个正文，AI 动作放 footer 左侧 `.footer-start`，结果填回 chips 等用户确认
- 编辑器已经实时渲染时，不再提供单独的「预览」区

---
## 4. Popover、Long Content 与 Theme

- Popover：点外部或按 Escape 只关闭 popover、不关闭 sheet；不能被 sheet 裁切；靠右的 chip 打开时自动左移（`ChipFields.tsx` 里的 `usePopover` 已处理）
- 用户可重命名的 label（时段、阶段、tag）一律 nowrap，宽度随内容自适应
  - 必要时 sheet 加宽到上限（参考 `--habit-sheet-width`，560–760px），横向滚动只作最后手段
  - 设计和验证都按 8–12 个汉字的长名称来做，不按默认的两字名称
- Long Content：数量会增长的同类编辑项（抽查点、AI prompt）用 step navigation 或 tabs，配一个展开的编辑器，不竖向堆叠；导航里的长 label 在稳定宽度内截断，完整值放 `title`
- Dark surface：shared component 只读 CSS variables；暗色区域只在需要的容器上局部覆写 token（参考 `.memory-create-backdrop`、`.memory-editor-header`），不要覆写整个 pane，以免误改按钮

---
## 5. Verification

- 跑 `npm run check`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`
- 视觉检查用浏览器截图：项目没有内置 Playwright，可以在临时目录装 `playwright-core`，指向本机缓存的 Chromium
  - 覆盖正常桌面宽度与窄宽度、light 与 dark、每个 popover 的打开态
  - 用真实长内容验证：多段中文 + 列表 + 加粗、长标题、8–12 字的重命名 label
  - 量 primary content 的高度是否达到第 3 节的预算，检查长内容是否把后续控件挤出屏幕
- 新增文本输入的自检：是否用了 `MarkdownEditor`、展示处是否用了 `MarkdownContent`、是否存在重复的输入入口
- 截图看不到的部分（WKWebView 里的实际表现、中文输入法触发 input rules）要在交付时单独说明
