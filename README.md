# Beta Life

[English README](README.en.md)

Beta Life 是一个本地优先的桌面生活时间板。它把一天分成四个可调整的时段，让习惯先落在大致节奏里；需要时，再安排到具体小时。

## 下载

请前往 [GitHub Releases](https://github.com/chen-junluo/beta-life/releases) 下载：

- macOS（Apple Silicon 与 Intel）：`.dmg`
- Windows：优先选择 `.msi`，也可以使用 NSIS `.exe` 安装包

### macOS 未签名版本的安装说明

当前 macOS 版本没有 Apple Developer ID 签名，也没有经过 notarization。打开 `.dmg` 后，先把 `Beta Life.app` 拖到 `Applications`。

如果 macOS 提示应用已损坏或不允许打开，请在 Terminal 中运行：

```bash
xattr -dr com.apple.quarantine "/Applications/Beta Life.app"
open "/Applications/Beta Life.app"
```

这一路径适合开发者用户和小范围测试，暂时不是面向普通用户的无提示安装方式。请只对你从本仓库 Releases 下载并确认来源的应用执行上述命令。

## 主要功能

- 用全局视图查看早上、下午、晚上和睡眠四个时段
- 切换到单个时段的专注视图
- 把习惯放在大致时段或具体小时，并通过拖拽重新安排
- 为习惯记录描述、标签和来源依据
- 自定义时段边界、颜色、slogan、卡片宽度、字号和界面缩放
- 自动保存本地数据，并支持撤销、重做及 Board JSON 导入导出
- 通过 DeepSeek 或自定义 OpenAI-compatible 接口，从文字或图片中提取待确认的习惯建议

AI 建议不会自动写入时间板；你可以先修改、选择，再导入。

## 数据与隐私

时间板和设置保存在系统应用数据目录中。API key 在 macOS 上保存到 Keychain，在 Windows 上使用当前用户的 DPAPI 加密后保存。Board JSON 导出不包含 API key、Provider 设置或自定义 Prompt。

只有在你主动使用 AI 提取时，输入的文字、图片和该次对话上下文才会发送给你所配置的外部 AI Provider；其处理和保留方式受对应 Provider 的政策约束。

常见数据目录：

- macOS：`~/Library/Application Support/com.dylanchen.beta-life/`
- Windows：`%APPDATA%\com.dylanchen.beta-life\`

导入 Board JSON 会替换当前时间板；应用会在数据目录保留一份导入前备份，但仍建议先手动导出。

## 从源码运行

需要 Node.js 22、Rust stable，以及当前平台对应的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

```bash
npm ci
npm run tauri -- dev
```

检查与测试：

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

按当前平台构建：

```bash
npm run build:mac
npm run build:windows
```

macOS 本地开发测试如果希望清理生成缓存、重新构建并自动打开拖拽安装窗口，可以运行：

```bash
npm run build:mac:clean
```

该命令只清理项目生成的 `dist`、Vite 缓存和 Cargo 构建目录，不会删除依赖或应用数据。构建完成后会自动打开 DMG；将 `Beta Life.app` 拖到 `Applications` 即可安装。

`build:mac` 只能在 macOS 上运行，`build:windows` 只能在 Windows 上运行。推送形如 `v0.1.0` 的 tag 后，GitHub Actions 会构建通用 macOS DMG 以及 Windows MSI/NSIS 安装包，并发布到 Releases。

## 技术栈

React 19、TypeScript、Vite、Rust 与 Tauri 2。
