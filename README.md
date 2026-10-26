# GlossNote · 旁注

在文档上批注，把标注沉淀成知识。

当前是 **0.1.0 锚定原型**：在浏览器里打开 PDF，选中文字即可高亮或批注；缩放、刷新、下次打开，标注都会回到原来那一行。

## 现在能做什么

- 打开 PDF（按钮、拖入、或欢迎页的「先看看示例」）
- 选中文字 → 浮动工具条 → 四色高亮 / 批注
- 跨行、跨文本块选择，按行拆成多个高亮矩形
- 右侧标注栏：按页排序、点击定位、写 Markdown 批注、删除（墓碑）
- 缩放 50%–300%，刷新页面后标注复原
- 文档按内容哈希识别：同名不同内容不会串，改名不丢标注
- 数据暂存于浏览器 `localStorage`

## 还没做

- Tauri 桌面壳与第二个窗口（资料库）
- SQLite 工作库 + 与 PDF 同目录的 sidecar JSON
- 书库导入、封面、搜索、标签
- 云同步（先交给云盘，后续再接同步引擎）
- 区域标注、OCR、手写
- AI：划词解释、基于自己标注的 RAG、复习卡片

## 运行

```bash
npm install
npm run dev        # http://localhost:1420
npm test           # 锚定算法的单元测试
npm run build      # 类型检查 + 生产构建
npm run sample     # 重新生成 public/sample.pdf
```

## 目录

```
src/
├── anchoring.ts        锚定模型与四级回退（纯函数，可单测）
├── anchoring.test.ts
├── pdfjs.ts            pdf.js worker 配置
├── PdfPage.tsx         canvas + 文本层 + 高亮层 + 选区转锚点
├── App.tsx             书库壳、工具条、标注栏、localStorage
├── storage.ts          内容哈希、文档记录读写
├── types.ts            Annotation / DocRecord
└── styles.css
scripts/make-sample.mjs 生成两页示例 PDF
public/sample.pdf       示例文档
```

## 锚定策略

一个标注保存为：

```
{ page, pageHash, pageLength, start, end, quote, prefix, suffix, rects[] }
```

重新打开时按 W3C Web Annotation 的思路逐级回退：

1. 页文本哈希一致 → 直接用字符偏移（`exact`）
2. 原文仍能找到 → 用前后文消歧后重新定位（`relocated`）
3. 原文被轻微改动 → 页内滑窗二元组相似度匹配（`relocated`）
4. 都失败 → 按原偏移比例估算，并标记为低置信度（`estimated`）

坐标一律归一化到页面宽高 (0~1)，与缩放、窗口大小、DPI 无关。

## 下一步

1. 套 Tauri 2 外壳，新增 `library` 窗口；现有前端作为 reader 入口
2. SQLite 工作库 + `<library>/.glossnote/annotations/<sha256>.json` sidecar
3. 导入流程：复制进书库、去重、封面、元数据
4. 书库列表与搜索
5. 同步、知识卡片、AI
