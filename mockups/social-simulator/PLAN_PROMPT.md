**社交模拟器 tab（交给下一个 AI 的执行 prompt）**

- 你要新增第 6 个 panel「社交模拟器」，放在「日记」之后：用户给每个角色（比如某位老师）写设定，自己设想对方会问什么、自己写回答，AI 只做三件事：出备选问题、代写回答、评分
  - **不是**「用户说一句、AI 扮演对方回一句」的聊天，不要做成 chat
- **最终 UI 稿：`mockups/social-simulator/final.html`**，布局、交互、文案以它和页面底部三张说明卡为准；`index.html` 是早期 10 方案，仅供参考
- 开工前先读：`AGENTS.md`、`DESIGN.md`、`final.html`、`src/components/DiaryView.tsx`、`src/diaryStorage.ts`、`src-tauri/src/vault/diary.rs`、`src-tauri/src/vault/mod.rs`、`src/ai/types.ts`、`src-tauri/src/ai.rs`、`src/components/AiDock.tsx`（diff 卡）

---
## 1. 已敲定的需求

- 层级 = **角色 → 问题 → 版本 → 多轮 Q/A**
  - 问题 = 一个起始问句（如「这学期进展怎么样？」）+ 短主题名（如 `进度询问`）
  - 版本 = 这个问题某天的一次练习，文件名 `<主题><YYMMDD>`（如 `进度询问261111`）；同一问题换天再练 = 新版本
  - 一个版本里是多轮 Q/A，**全部平铺，追问不缩进**；标签固定 `Q：` / `A：`
- 左栏（角色树），每个角色展开后从上到下：
  - 两份 md：`角色设定.md`、`应对与正样本.md`，点开在右侧窗口里直接编辑
  - `★ 收藏`：汇总该角色所有 ★ 的版本，置顶
  - `问题 · N`：**可点击折叠**（「AI 出题」按钮不触发折叠）；每个问题一张卡，卡内列版本行（★、日期、均分或「进行中」），右上「练」= 新建今天的版本；没练过的问题显示虚线卡 + 「未练」
- **★ 只能标在单个版本上**，问题不能 ★；左栏版本行、收藏区、窗口标签、版本标题四处状态同步
- 右侧 = 窗口标签页（版本和两份 md 都能开，可同时开多个）+ 底部输入条
  - 输入条切「写问题 / 写回答」，按钮 `AI 出新问题`、`AI 出追问`、`AI 代答`、`评一下`、`放入`；打开 md 窗口时输入条隐藏
  - 输入条是本 tab 自己的，**不是**全局 AI Dock
  - 当前待答的那一轮高亮；每轮 hover 出 `AI 代答`、`评一下`
- AI 三件事
  - 出题：`AI 出新问题` / `AI 出追问` 每次 3–5 个候选，内联显示在当前轮下方（不弹窗），每条「用」= 设为下一个 Q，「存进问题库」= 加进该角色的问题列表，「换一批」重出
  - 代答：按 `角色设定.md` + `应对与正样本.md` 写，填进当前 `A：`；已有内容时作为备选显示，**不覆盖**
  - 评分：每条 A 一个 1–10 分 + ≤ 30 字点评，低分附改进写法；`结束本轮并评估` 给整体 ≤ 3 条调整方向，写进版本末尾 `## 评估`，可重评（覆盖）
- 回答格式（代答和评分共用的标准）：不长篇大论；复杂时用嵌套 bullet，**最多两层**
- 结束评估时 AI 提议修改两份 md（正样本 / 原则 → `应对与正样本.md`，性格补充 → `角色设定.md`），以勾选列表给出，用户「确认写入」才落盘
- 一个角色可同时有多个进行中的版本；结束后仍可编辑
- 全局 AI Dock：新增 `@社交模拟器` scope，读 + 写，写全部走 diff 卡；新建角色可在 dock 里对话起步，由 AI 起草 `角色设定.md`。出题 / 代答 / 评分仍只在 tab 内，不进 dock
- **不接** bebe 提醒；配色用 teal `#0d9488`（其它色已被别的 tab 占用）

---
## 2. 数据（数据文件夹内，md 为源，沿用现有 tab 的双向同步与外部修改监听）

- 目录：`社交模拟器/<角色名>/`
  - `角色设定.md`：身份与场景（场景写进角色，同一个人换场合 = 新建角色）、性格、`## 可能会问的问题`
  - `应对与正样本.md`：`## 原则` + `## 正样本`（每条 `Q：` / `A：` + 来源版本）
  - `QA记录/<主题><YYMMDD>.md`：一个版本；同主题同日已存在时加后缀 `-2`
- 版本文件结构（建议，开工前和用户确认）
  - frontmatter：`question`（起始问句）、`topic`、`starred`、`status: open | done`
  - 正文按轮写 `Q：…` / `A：…`，A 可含最多两层 bullet；评分写在该轮下方一行（如 `> 7/10 · 点评`）
  - 末尾 `## 评估`：整体 ≤ 3 条调整方向
- 问题列表 = `角色设定.md` 的 `## 可能会问的问题` ∪ 各版本 frontmatter 里的 `question`；版本按 `question` 归到问题下，「存进问题库」写进 `## 可能会问的问题`
- 均分、版本数、分数变化（如 `6 → 7 → 8`）都从版本文件现算，不另存
- 版本 id 用文件名；改名或删除角色要处理同名冲突，和 diary、memories 的 `dedupe_ids` 做法一致

---
## 3. 实现落点（参照日记 panel 的接法，逐个对照，不要漏）

- Rust：新建 `src-tauri/src/vault/social.rs`（列角色、读写三类 md、新建版本、★、解析 Q/A），在 `vault/mod.rs`、`lib.rs` 注册 command；用 `vault::open`、`read_md`、`write_md`、`lock`
- 外部修改：`vault/watch.rs` 把 `社交模拟器/` 纳入监听
- TS：`src/types.ts`（类型和 settings 里的 3 个 AI prompt）、`src/defaults.ts`（默认 prompt）、`src/socialStorage.ts`（仿 `diaryStorage.ts`）
- UI：新组件 `src/components/SocialView.tsx`；在 `WorkspaceDrawer.tsx` 的 `WorkspaceSection` 加 `social`，接进 `App.tsx` 的 section 切换和 undo history；样式进 `styles.css`，用 teal token
- AI 按钮：出题 / 代答 / 评分走单次结构化调用，不进 dock 对话；输出在 Rust 侧校验（分数 1–10、点评 ≤ 30 字、候选 3–5 条、bullet ≤ 两层），不合格就报错，不要静默截断
- AI Dock scope：`src/ai/types.ts` 的 `AiPanelId` 与 `src-tauri/src/ai.rs` 的 `Panel` 加 `Social`（label `社交模拟器 (social)`），`src/ai/tools.json` 加 list / read / 写入类工具，写入走现有 diff 卡
- `AGENTS.md`：功能域映射加一行「社交模拟器：`social`」
- Settings：3 个 prompt（出题、代答、评分）可编辑，放在现有 AI prompt 区

---
## 4. 开工前先问用户（每条给推荐项）

- 版本文件结构：推荐第 2 节的 frontmatter + `Q：`/`A：` 正文 + 每轮评分一行；备选把评分集中写进 `## 评估`
- 新建角色入口：推荐 tab 左栏 `+ 角色` 先建空模板，dock 起草作为可选；还是只走 dock
- 删除角色、版本：推荐移进数据文件夹的回收区或要求二次确认，不直接删
- AI 候选「存进问题库」：推荐写进 `角色设定.md` 的 `## 可能会问的问题`；备选单独一个 `问题库.md`
- 评分结果：推荐「评一下」立即写入版本文件；还是要用户点保存

---
## 5. 流程与验收

- 按 `AGENTS.md`：开 `feature/social-<short-description>` branch，不在 `main` 开发；commit `feat(social): …`
- 实现顺序：Rust 存储 + 解析和单测 → TS 存储层 → 左栏 + 窗口标签 + 只读渲染 → 输入条写入 → AI 三个按钮 → 结束评估 + 两份 md 修改提议 → `@社交模拟器` scope → Settings
- 验收
  - `npm run check` 通过；`cargo test` 覆盖 Q/A 解析、文件名冲突、★ 读写、外部修改
  - 用 `final.html` 逐条对照：折叠、★ 四处同步、平铺不缩进、md 窗口隐藏输入条、候选内联
  - 真机跑 macOS app：在 Obsidian 改 md 后 tab 刷新；`★` 和新版本落盘后在 Obsidian 可见
  - 验证时不要把用户真实的 md 内容打印到日志或回复里
- 交付：推 branch，给 `main...feature/social-…` 的 PR 链接，说明验证结果和待办；用户验收前不合并
