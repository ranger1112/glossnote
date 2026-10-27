# 技术架构

## 形态与分层

0.2 起是一个 Tauri 2 桌面应用，单个主窗口，窗口内切换「书库」和「阅读器」两个视图。第一版不拆第二个窗口，也不提供全局速记浮窗。

```
┌──────────────────────────────────────────────┐
│ WebView（React + TypeScript）                 │
│  ├─ 书库视图：封面、搜索、标签、导入           │
│  └─ 阅读视图：pdf.js canvas + 文本层 + 标注层  │
├──────────────────────────────────────────────┤
│ Rust（Tauri commands）                        │
│  ├─ 文件：导入、哈希、读取、sidecar 原子写      │
│  ├─ 索引：SQLite（rusqlite, FTS5）             │
│  └─ 系统：原生文件对话框、窗口、更新            │
├──────────────────────────────────────────────┤
│ 书库目录（可放在云盘同步目录）                  │
│  ├─ books/*.pdf                               │
│  └─ .glossnote/annotations/<sha256>.json      │
└──────────────────────────────────────────────┘
```

Rust 侧只做 WebView 做不了或做起来不划算的事：文件系统、哈希、SQLite、系统对话框。渲染、选区、标注交互全部留在 WebView，pdf.js 的文本层是锚定的基础。

## 书库目录

```
<Library>/
├── books/
│   ├── 深度工作.pdf
│   └── 设计心理学.pdf
└── .glossnote/
    ├── annotations/<sha256>.json     # 每份文档一份 sidecar，按内容哈希命名
    ├── thumbnails/<sha256>.webp      # 首页封面，可重建
    └── manifest.json                 # 可选：标题、作者、页数、导入时间
```

- 用户可见的只有 `books/`，文件名保持可读。
- 标注 sidecar 用内容哈希命名，放在隐藏目录：重命名、移动文件不会丢标注，顶层也不会被几百个 `.json` 填满。
- 书库根目录可以由用户指到坚果云 / OneDrive / NAS 同步目录。
- **sidecar 是可移植的真相源，SQLite 只是索引。** 删掉 `library.db` 后，扫描 `books/` + `.glossnote/annotations/` 必须能完整重建。

## 本地数据库

位置：`%APPDATA%\com.phoebe.glossnote\library.db`，不放在书库目录里，避免云盘多端同时写坏。

```sql
documents(
  id TEXT PRIMARY KEY,        -- sha256，内容寻址
  path TEXT,                  -- 相对书库的路径
  title TEXT, author TEXT,
  page_count INTEGER, size INTEGER, mtime INTEGER,
  added_at INTEGER, last_opened_at INTEGER,
  progress TEXT,              -- JSON: { page, scrollTop, scale }
  cover TEXT                  -- 缩略图相对路径
);

annotations(
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  anchor TEXT NOT NULL,       -- JSON，见「锚定模型」
  color TEXT NOT NULL,
  kind TEXT NOT NULL,         -- highlight / underline / note / area / ink
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER, updated_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE annotation_fts USING fts5(
  quote, body, content='annotations', content_rowid='rowid'
);

cards(                        -- 0.6 才建
  id TEXT PRIMARY KEY,
  annotation_ids TEXT,        -- JSON 数组
  body TEXT,
  links TEXT, created_at INTEGER, updated_at INTEGER
);
```

约定：

- 删除只写 `deleted = 1` 墓碑，不物理删除；同步、撤销、冲突合并都依赖它。
- `doc_id` 是文件字节的 SHA-256，不是路径，也不是文件名。
- `body` 与 `quote` 进 FTS5；标签和文档标题在 0.4 接入。
- 设置仍走应用配置文件；数据库只放业务数据。

## 导入流程

1. 用户点「导入」、拖入文件，或 `Ctrl+O`。
2. 流式计算 SHA-256。命中已有 `doc_id` 时直接打开，不重复复制。
3. 复制到 `books/`，文件名做最小清洗；重名但内容不同则追加 ` (2)`。
4. 首次打开时用 pdf.js 读页数与元数据，渲染首页生成封面。
5. 写 `documents`、`manifest.json`，在书库中出现。

大文件先用 Rust 读取字节经 IPC 交给 WebView；超过 50 MB 给出提示，后续改用 Tauri asset protocol，避免一次性复制。

## 锚定模型

一个标注保存为：

```json
{
  "page": 0,
  "pageHash": "f1a4122c",
  "pageLength": 802,
  "start": 200,
  "end": 237,
  "quote": "Anchoring is the heart of annotation.",
  "prefix": "ack into your own life.\n",
  "suffix": "\nA highlight that cannot",
  "rects": [{ "x": 0.1175, "y": 0.2116, "w": 0.3472, "h": 0.0200 }]
}
```

- `rects` 是相对页面宽高的归一化坐标（0~1），与缩放、窗口大小、DPI 无关。
- `start/end` 是页面纯文本中的字符偏移；纯文本由 pdf.js 文本层按 item 顺序拼接，并用 `hasEOL` 与间距补空格/换行。
- 重新打开时按四级回退：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 页文本哈希一致且切片等于 quote | `exact`，直接用偏移 |
| 2 | quote 仍能在页内找到 | `relocated`，用 prefix/suffix 消歧 |
| 3 | quote 被轻微改动 | `relocated`，滑窗二元组相似度 ≥ 0.6 |
| 4 | 以上都失败 | `estimated`，按 `start/pageLength` 比例估算并标低置信度 |

已知边界：

- 旋转页面按未旋转的原始 viewport 计算坐标。
- 双栏 PDF 依赖文本层阅读顺序，不按视觉顺序。
- 扫描件没有文本层：0.1 明确提示，不假装能高亮；OCR 在 1.0 之后。
- 页面指纹是页级 FNV-1a，不是文档级；单页改动不会影响其他页。

算法在 `src/anchoring.ts`，纯函数，单测覆盖 exact / relocated / 相似度 / 比例回退。

## 同步

**0.5 之前不做应用内同步。** 书库目录交给用户的云盘（坚果云、OneDrive、Nextcloud），PDF 与 sidecar 自动随目录走；应用默认不联网。

0.5 之后按记录同步，不按文件覆盖：

- 同步单位是 `annotation`，每条带 `updated_at` 与 `deleted`。
- 合并规则：按 `id` 对齐，`updated_at` 新者胜；删除用墓碑；两边同时删保持删除。
- 云盘产生的 `xxx.conflict-*.json` 在启动扫描时按记录合并，不整文件覆盖。
- **不上 CRDT。** 标注是准不可变的小记录，LWW 足够；只有出现“两人同时编辑同一段笔记正文”时才重新评估。
- 大文件 PDF 单独走 blob 同步，不塞进记录流。

## AI

分两个阶段，先做可信的，再做聪明的。

**阅读中**：划词解释、上下文翻译、“这段和上文什么关系”。上下文窗口取当前段落前后各一段，不整本塞入。

**阅读后**：

- 文本抽取时保留页码与字符偏移，切块后每块带 `doc_id + page + offset`。
- 嵌入与检索只针对用户导入的文档和自己的标注。
- RAG 回答必须携带引用；点击引用跳回对应的标注或原文位置。
- 卡片可由标注生成，复习调度用 FSRS。
- 默认不上传全文；云端 AI 与本地模型都作为可选项，用户明确开启才发送。

## 安全与隐私

- 无账号、无遥测、无默认联网。
- sidecar 是明文 JSON，可靠性优先于保密性；需要加密时由用户的云盘负责，或后续提供可选的加密容器。
- AI 请求不携带未开启文档的内容；日志不记录正文与标注内容。
- 打开外部链接一律交给系统浏览器，不在 WebView 内导航。

## 技术选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 外壳 | Tauri 2 | 体积小、内存低，Rust 适合做文件与索引 |
| UI | React + TypeScript | 阅读器状态多，组件化收益明显 |
| PDF | pdf.js | canvas 渲染 + 可选择的文本层，坐标可得 |
| 索引 | SQLite（rusqlite bundled）+ FTS5 | 单文件、可重建、全文检索够用 |
| 测试 | Vitest | 锚定算法是纯函数，先测算法再测 UI |
| 可移植数据 | 明文 JSON sidecar | 用户可读、可脚本处理、云盘可搬运 |

Tauri 侧注意：pdf.js 的 worker 需要 `worker-src 'self'`；部分扫描件的 JPEG2000 解码需要 WASM，CSP 要允许 `'wasm-unsafe-eval'`。具体值在接入桌面壳时验证，不凭记忆写死。

## 原型与目标的差距

0.1 原型先跑在浏览器里；0.2 已套上 Tauri 2 桌面壳，接入原生文件对话框与 asset protocol。持久化仍然是 localStorage。

| 能力 | 现状 |
| --- | --- |
| 打开文件 | 已替换为 Tauri 原生对话框 + Rust 哈希 |
| 持久化 | 仍是 localStorage，0.3 替换为 SQLite + sidecar |
| 单文档 | 仍是单文档，0.3 起接入书库与导入 |
| 封面 / 搜索 | 未实现，0.4 |
| 同步 | 未实现，0.5 |

`src/storage.ts` 是唯一的数据读写边界，替换持久化层时保持接口不变，UI 不动。
