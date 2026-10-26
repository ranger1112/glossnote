# GlossNote · 旁注

在文档上批注，把标注沉淀成知识。

本地优先的桌面阅读与标注客户端：导入 PDF，在页面上划线、批注，之后把标注沉淀成可检索、可复习、可被 AI 引用的知识。中文名暂定「旁注」。

## 当前状态

**0.1 锚定原型已完成**：在浏览器里打开 PDF，选中文字高亮或批注；缩放、刷新、重开文档后，标注回到同一行字上。已验证跨行选择、重复语句消歧、批注持久化与墓碑删除。

目前持久化仍在 `localStorage`，下一步是 Tauri 2 桌面壳与书库导入。阶段进度与验收证据见 [docs/implementation-plan.md](docs/implementation-plan.md)。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:1420
npm test           # 锚定算法单元测试
npm run build      # 类型检查 + 生产构建
```

打开页面后点「先看看示例」，或直接选择一份 PDF。

## 文档

| 文档 | 回答的问题 |
| --- | --- |
| [docs/product-design.md](docs/product-design.md) | 为谁做、做什么、不做什么 |
| [docs/architecture.md](docs/architecture.md) | 系统怎么搭、数据怎么存、锚定怎么保证 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 先做什么、验收标准、现在到哪 |
| [docs/decisions.md](docs/decisions.md) | 为什么这样选、放弃了什么 |
| [docs/README.md](docs/README.md) | 文档索引与维护约定 |

## 技术栈

Tauri 2 + React + TypeScript + pdf.js。标注锚定算法在 `src/anchoring.ts`，纯函数，先测算法再测 UI。详细结构见 [docs/architecture.md](docs/architecture.md)。

## 许可

尚未确定。在确定之前，代码默认保留所有权利。
