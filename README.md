# GlossNote · 旁注

[![CI](https://github.com/ranger1112/glossnote/actions/workflows/ci.yml/badge.svg)](https://github.com/ranger1112/glossnote/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ranger1112/glossnote)](https://github.com/ranger1112/glossnote/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

本地优先的 PDF 阅读与标注客户端：划线、批注、打标签，把标注做成卡片复习，或者让 AI 带着页码回答关于这份文档的问题。

## 关于

读长文档时，真正有价值的东西往往不是「读完了」，而是你划出的那句话和当时写下的想法。但换一个阅读器、换一台设备、过两周再回来，这些痕迹就散了。

GlossNote 把「读」和「以后用得上」放在同一个地方：PDF 复制进书库，标注是明文 JSON，索引删了可以从书库重建，不登录、不联网也能用。目标只有一件事——每条标注都能回到原文那一行字，并且在需要时继续被检索、复习和引用。

当前只发布 Windows 桌面版（Tauri 2）。EPUB / HTML / TXT 多格式计划在 1.x。

## 能做什么

- **阅读与标注**：四色高亮、下划线、删除线、批注、标签，标注可改色、可撤销/重做；`Ctrl+F` 页内查找；侧栏按页分组，并可按颜色与类型筛选。缩放、刷新、重开文档后仍锚回同一行字。
- **书库与导出**：封面网格、阅读进度、收藏与文档标签；可按收藏/标签筛选，按最近阅读、添加时间、标题或标注数排序；多选后可批量收藏、增删标签。支持标注与批注搜索，可导出 Markdown，或另存一份带标注的 PDF 副本（高亮、下划线、删除线写为原生 PDF 标注，批注写为便签，原文件不变）。
- **同步**：书库目录可以指向坚果云 / OneDrive / Syncthing 等同步目录，扫描时按时间戳合并冲突副本；没有账号，也没有服务端。
- **卡片与复习**：标注一键制卡、卡片双向链接、FSRS-4.5 到期调度。
- **AI（默认关闭）**：划词解释、本地全文索引后的提问与总结，回答带页码来源，可跳回原文。支持 Anthropic 与 OpenAI 兼容服务。
- **更新**：顶栏「检查更新」按需联网，校验签名后下载安装并重启；不自动检查、不上报。

## 下载与安装

从 [Releases](https://github.com/ranger1112/glossnote/releases) 下载最新的 `GlossNote_x.y.z_x64-setup.exe` 安装。安装包未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「更多信息 → 仍要运行」即可。

从 0.1.1 起支持应用内更新；0.1.0 需要在更新器接入之前构建，请手动安装一次 0.1.1。更新检查遵循系统代理设置；如果 GitHub 无法直连，请启用系统代理（或在启动应用前设置 `HTTPS_PROXY`）。

首次启动的书库默认在 `文档\GlossNote\`，可以在书库页点「书库位置」换到任意目录（包括云盘同步目录）。

## 从源码运行

前置：Node.js 22+、Rust 1.94.1、Visual Studio Build Tools 2022（C++ 桌面开发）。Windows 工具链的细节见 [docs/build.md](docs/build.md)。

```bash
npm install
npm run desktop:dev     # 启动 Tauri 桌面应用
npm test                # 锚定算法单元测试
npm run build           # 类型检查 + 前端生产构建
```

只想在浏览器里看前端：`npm run dev`，打开 http://localhost:1420。

## 数据在哪里

| 内容 | 位置 |
| --- | --- |
| 书库（PDF + 标注 sidecar + 封面） | `文档\GlossNote\`（可切换） |
| SQLite 索引（可重建） | `%APPDATA%\com.phoebe.glossnote\library.db` |
| 设置与 AI 配置 | `%APPDATA%\com.phoebe.glossnote\settings.json` |

标注同时写入 SQLite 与 `.glossnote/annotations/<sha256>.json`。SQLite 只是索引：删掉它后重启，会从书库里的 PDF 与 sidecar 重建。

## 隐私

- 默认不联网、无账号、无遥测。
- 只有你主动使用 AI 时，才发送当前问题、选中的文字与本地检索到的片段；全文索引本身在本机完成。
- 只有你点击「检查更新」时才会访问 GitHub Releases，且只下载更新清单与安装包。
- API Key 明文保存在本机 `settings.json`，不进入书库，也不进入 sidecar。
- sidecar 是明文 JSON，可靠性优先于保密性；需要保密时请依赖云盘或磁盘加密。

## 技术栈

Tauri 2 + React 19 + TypeScript + pdf.js，索引使用 SQLite（rusqlite）。锚定算法在 [`src/anchoring.ts`](src/anchoring.ts)，是纯函数，有单元测试覆盖四级回退。结构、同步协议与 AI 检索的细节见 [docs/architecture.md](docs/architecture.md)。

## 文档

| 文档 | 回答的问题 |
| --- | --- |
| [docs/product-design.md](docs/product-design.md) | 为谁做、做什么、不做什么 |
| [docs/architecture.md](docs/architecture.md) | 系统怎么搭、数据怎么存、锚定怎么保证 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 先做什么、验收标准、现在到哪 |
| [docs/build.md](docs/build.md) | 怎么装、怎么跑、怎么自动验证 |
| [docs/decisions.md](docs/decisions.md) | 为什么这样选、放弃了什么 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |

## 参与

欢迎提 [Issue](https://github.com/ranger1112/glossnote/issues) 或 PR。提交前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请不要公开提交，按 [SECURITY.md](SECURITY.md) 的方式私下报告。

## 许可

[Apache License 2.0](LICENSE)。可自由使用、修改与再分发（含商用），需保留版权声明与许可声明。
