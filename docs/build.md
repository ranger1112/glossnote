# 构建与运行

## 前置

- Node.js 22+
- Rust 1.94.1（仓库根目录 `rust-toolchain.toml` 固定）
- Visual Studio Build Tools 2022，勾选「使用 C++ 的桌面开发」

## 本机工具链位置

Rust 没有装在默认位置，也没有进系统 PATH：

```
RUSTUP_HOME = D:\Rust\rustup
CARGO_HOME  = D:\Rust\cargo
VCVARS      = D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat
```

`scripts/_env.local.cmd`（已 gitignore）负责写入这三个变量；`scripts/_env.cmd` 加载它，再调用 `vcvars64.bat` 把 MSVC 的 `cl.exe` / `link.exe` 放进当前进程。换机器时复制 `scripts/_env.cmd` 里的注释说明，新建自己的 `_env.local.cmd` 即可。

`.cmd` 文件必须保持**纯 ASCII**。cmd.exe 按系统代码页（简体中文是 GBK）读取批处理文件，UTF-8 中文注释会被解析成乱码，甚至把 `||` 之类的符号拆坏。

## 命令

| 目的 | 命令 |
| --- | --- |
| 检查 MSVC + Rust 环境 | `scripts\check-env.cmd` |
| 桌面开发（Tauri + Vite） | `scripts\dev.cmd` |
| 桌面构建 | `scripts\build.cmd` |
| 只跑 Rust 检查 | `scripts\cargo.cmd check` |
| Rust 测试 | `scripts\cargo.cmd test` |
| 只跑浏览器前端 | `npm run dev` |
| 前端单元测试 | `npm test` |
| 前端类型检查 | `npm run typecheck` |

`scripts\dev.cmd` 会先加载工具链，再直接调用 `node_modules\.bin\tauri.cmd dev`。它内部的 `beforeDevCommand` 会启动 Vite（`http://localhost:1420`），所以不要同时开着一个独立的 `npm run dev`，端口会冲突。

不要在网关脚本里改用 `npm run tauri dev`：在这台机器上 npm 会重建子进程的 PATH，把 `_env.cmd` 加进去的 `D:\Rust\cargo\bin` 丢掉，Tauri CLI 随后报 `cargo metadata ... program not found`。直接调用 `.bin\tauri.cmd` 可以保留批处理的环境。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 书库（PDF + sidecar） | `文档\GlossNote\` |
| SQLite 索引 | `%APPDATA%\com.phoebe.glossnote\library.db` |
| 设置（可改 `libraryDir`） | `%APPDATA%\com.phoebe.glossnote\settings.json` |

要换书库位置，在 `settings.json` 写：

```json
{ "libraryDir": "D:\\GlossNote" }
```

## Tauri 配置要点

- `tauri = { features = ["protocol-asset"] }` 与 `security.assetProtocol.enable = true` 必须同时存在，否则 `cargo check` 会直接报 allowlist 不匹配。
- PDF 字节不走 IPC：Rust 只返回路径、大小和 SHA-256，前端用 `convertFileSrc()` 得到 asset URL，交给 pdf.js 加载。
- 生产 CSP 需要 `worker-src 'self' blob:`（pdf.js worker）与 `script-src 'wasm-unsafe-eval'`（部分扫描件的 JPEG2000 解码）；开发时 `devCsp` 为 `null`，避免 HMR 的 WebSocket 被拦。
- pdf.js 的 `cmaps` / `standard_fonts` / `wasm` / `iccs` 由 `npm run pdfjs:assets` 复制到 `public/pdfjs/`，`dev` 与 `build` 已自动执行。少了 wasm 时 PDF 里的 JPEG2000 插图会渲染成黑块，控制台只有 `JpxError` 警告、不会中断渲染。
- `assetProtocol.scope` 目前是 `["**"]`，因为 PDF 可能在任何盘符。这是本地应用的取舍；等书库目录固定后应收窄到书库根目录。

## 自动验证

1. **前端单元测试**：`npm test`，覆盖锚定四级回退。
2. **浏览器冒烟 E2E**：`npm run test:e2e`（首次先 `npx playwright install chromium`），自动启动 Vite，覆盖「示例 → 划线 → 改色 → 刷新复原」「撤销/重做」「侧栏分组与筛选」「阅读器快捷键」「设置面板」「`Ctrl+F` 页内查找」。CI 的 `e2e` job 跑的就是这些。
3. **Tauri 端到端**：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动 `scripts\dev.cmd`，再用 Playwright `connectOverCDP` 连上 WebView2，可以验证 `invoke('open_document')` 返回的文档与标注、asset protocol 取字节、pdf.js 从 asset URL 打开文档，以及完整的高亮流程。

第 3 条是桌面壳阶段的主要验收手段：原生文件对话框本身无法用 CDP 驱动，但对话框之后的全部链路都能自动验证。

## 更新签名（维护者）

- 私钥：`%USERPROFILE%\.glossnote\updater.key`，密码在同目录 `updater-key-password.txt`；只在本机保存，丢失后已发布版本无法再签名更新。
- 公钥：写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- GitHub Actions secrets：`TAURI_SIGNING_PRIVATE_KEY`（私钥文件内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。缺少时 Release workflow 会直接失败，不会产出无法验证的安装包。
- `createUpdaterArtifacts` 开启后，Release workflow 会生成 `.sig`、`latest.json` 与安装包一起上传；客户端设置里的「检查更新」读取 `releases/latest/download/latest.json`。
