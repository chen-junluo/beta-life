# Beta Life Agent Instructions

Before changing frontend UI, read `DESIGN.md` and inspect the nearest existing Settings or AI Provider surface for typography, control height, padding, and spacing. Treat the design contract as a repository-level constraint, not a suggestion.

When adding a new form, use the shared CSS tokens and component patterns. Do not introduce page-specific spacing values to compensate for a missing parent gap. When a list can grow, prefer step navigation with one expanded editor. Check spacing and type by measuring computed sibling gaps and font sizes in a browser, not by eye. For visual redesigns, first hand the user a before/after review HTML built from the real rendered DOM and `src/styles.css`, and change code only after they approve it.

For AI features, keep prompts in `AppSettings.ai`, preserve structured response validation in the Rust command, and make language behavior follow the input content. Never write AI output directly into confirmed data without an explicit user confirmation step.

For activity tracking (foreground window, AFK detection, browser domains, event storage, timeline views), use ActivityWatch (https://github.com/ActivityWatch/activitywatch) as the implementation reference, especially `aw-watcher-window`, `aw-watcher-afk`, `aw-watcher-web`, `aw-server-rust` (event model and heartbeat merging), and `aw-webui`. Before designing one of these pieces, study how ActivityWatch solves it, then implement our own improved version inside Beta Life's Rust and React code; do not add ActivityWatch as a runtime dependency. ActivityWatch is MPL-2.0: borrow designs and ideas, but do not copy its source files or substantial code verbatim. When you find an ActivityWatch bug, an open issue we could fix, or an improvement worth upstreaming, proactively tell the user and propose a concrete PR (repo, problem, fix sketch); never open issues or PRs without the user's approval.

Before handoff, run the frontend checks, Rust tests, and production build. Report any visual inspection that could not be performed separately from automated checks.

Every task ends with a local test build: after the requested changes and the checks above pass, run `scripts/build-mac-clean.sh` so the user can install the DMG and test locally. Do not hand off a task without running it, and report the resulting DMG path or the failure output.

## 功能分支、PR 与本地 main

- 开始修改前先检查当前 branch、工作区状态，并按下面的 Tab/功能域映射确定唯一归属。branch 使用 `feature/<domain>-<short-description>`，`domain` 必须取映射中的标准名；不在 `main` 上直接开发，也不把不同功能域的改动混在一个 branch 或 PR。
- 功能域映射（Tab 名称以应用当前界面为准）：
  - 时间板：`board`。习惯卡片、习惯打卡、习惯提醒等子功能的 commit scope 用 `habits`
  - 回想（用户也可能称“回响”）：`recall`。
  - 能力森林（能力测评）：`forest`。
  - 记忆星云：`memories`。
  - 日记：`diary`。
  - 时间轴：`timeline`。前台应用、窗口、网站采集及分类等时间追踪底层功能，commit scope 用 `activity`，branch 仍归时间轴域。
  - AI 助手统一域：`ai-assistant`，包含 bebe 桌面宠物、AI Dock、AI 工作台及它们之间的对话、提醒和任务流程。它们属于同一功能 branch；新 commit 统一使用 `ai` scope。历史提交里的 `bebe`、`pet` 是这个域的旧 scope，后续新改动不再以它们作为独立 branch 域。
- commit message 延续历史 Conventional Commit 格式：`<type>(<scope>): <简短说明>`，例如 `feat(habits): ...`、`fix(timeline): ...`、`feat(ai): ...`。scope 使用上面的标准名或其明确列出的子功能名；新功能先归入对应 Tab，不为同一功能另造同义 scope。
- 如果当前在 `main` 且有未提交改动，先确认这些改动属于本次功能，再用保留工作区内容的方式切换或新建对应 branch；不要丢弃、覆盖或擅自归并用户已有的修改。已有匹配功能 branch 时优先复用；没有时按映射命名新 branch。
- 完成改动和必要验证后，将本次功能改动提交到对应 branch 并推送。交付时给用户一个以 `main` 为 base、当前功能 branch 为 compare 的 GitHub PR 链接，方便用户检查并创建 PR；说明验证结果和待处理事项。
- 用户创建 PR 后，检查 PR 内容与必要的 CI/检查状态；在符合仓库合并条件时合并该 PR。若检查失败、存在冲突或合并条件不满足，先解决问题并报告，不要绕过保护条件。
- 合并成功后，将本地仓库切回 `main` 并更新到刚合并的提交（fetch 后 fast-forward/pull），让当前 VS Code 工作区显示更新后的 `main`。切换前保留并检查任何未提交改动；如它们会阻碍安全更新，先停下并说明具体原因。
