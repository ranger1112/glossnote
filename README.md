# GlossNote · 旁注

在文档上批注，把标注沉淀成知识。

本地优先的桌面阅读与标注客户端：导入 PDF，在页面上划线、批注，之后把标注沉淀成可检索、可复习、可被 AI 引用的知识。中文名暂定「旁注」。

## 当前状态

**0.1 锚定原型 + 0.2 桌面壳 + 0.3 本地持久化 + 0.4 书库体验 + 0.5 云同步 + 0.6 知识沉淀已完成**：导入 PDF 后进入书库，以封面网格浏览；打开文档可高亮、批注、打标签，搜索标注与原句，导出 Markdown；缩放、刷新、重开文档后，标注回到同一行字上，阅读进度也会恢复。

标注可以转成卡片，卡片之间可建立双向链接，并按 FSRS-4.5 的到期时间进入复习队列；来源标注删除后卡片保留，只标记为来源失效。

导入的 PDF 会复制到 `文档/GlossNote/books/`，标注与卡片写入 SQLite 并镜像到 `.glossnote/annotations/<sha256>.json`；删掉数据库也能从 sidecar 重建。书库位置可在界面切换，指向云盘目录即可多设备同步；云盘产生的冲突副本会在扫描时按记录合并，并归档到 `.glossnote/conflicts/`。下一步是 0.7 AI。阶段进度与验收证据见 [docs/implementation-plan.md](docs/implementation-plan.md)。

## 快速开始

```bash
npm install
npm run dev        # 只在浏览器里跑前端
npm test           # 锚定算法单元测试
npm run build      # 类型检查 + 生产构建

# Windows 桌面（需要 Rust 与 MSVC，见 docs/build.md）
scripts\dev.cmd
scripts\build.cmd
```

浏览器模式打开 http://localhost:1420；桌面模式由 `scripts\dev.cmd` 启动 Tauri。两种模式都可以点「先看看示例」。

## 文档

| 文档 | 回答的问题 |
| --- | --- |
| [docs/product-design.md](docs/product-design.md) | 为谁做、做什么、不做什么 |
| [docs/architecture.md](docs/architecture.md) | 系统怎么搭、数据怎么存、锚定怎么保证 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 先做什么、验收标准、现在到哪 |
| [docs/build.md](docs/build.md) | 怎么装、怎么跑、怎么自动验证 |
| [docs/decisions.md](docs/decisions.md) | 为什么这样选、放弃了什么 |
| [docs/README.md](docs/README.md) | 文档索引与维护约定 |

## 技术栈

Tauri 2 + React + TypeScript + pdf.js。标注锚定算法在 `src/anchoring.ts`，纯函数，先测算法再测 UI。详细结构见 [docs/architecture.md](docs/architecture.md)。

## 许可

尚未确定。在确定之前，代码默认保留所有权利。
