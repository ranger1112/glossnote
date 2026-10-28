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
│  ├─ 索引：SQLite（rusqlite, FTS5）+ AI 文字块   │
│  ├─ AI：按需请求 Provider，Key 不进入 WebView   │
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
    ├── thumbnails/<sha256>.jpg       # 首页封面，320px 宽，可重建
    ├── conflicts/                    # 合并后的云盘冲突副本，保留原文
    └── manifest.json                 # 可选：标题、作者、页数、导入时间
```

- 用户可见的只有 `books/`，文件名保持可读。
- 标注 sidecar 用内容哈希命名，放在隐藏目录：重命名、移动文件不会丢标注，顶层也不会被几百个 `.json` 填满。
- 书库根目录可以由用户指到坚果云 / OneDrive / NAS 同步目录。
- **sidecar 是可移植的真相源，SQLite 只是索引。** 删掉 `library.db` 后，扫描 `books/` + `.glossnote/annotations/` 必须能完整重建。

默认位置是系统「文档」下的 `GlossNote`。书库页的「书库位置」用原生目录选择器切换，写入 `%APPDATA%\com.phoebe.glossnote\settings.json` 的 `{"libraryDir": "D:\\GlossNote"}`。切换会清空 SQLite 索引并从新目录的 PDF + sidecar 重建；旧目录里的文件不会被删除。

## 本地数据库

位置：`%APPDATA%\com.phoebe.glossnote\library.db`，不放在书库目录里，避免云盘多端同时写坏。

启动时如果 `library.db` 打不开或已损坏，会把旧文件（连同 `-wal` / `-shm`）改名为 `library.db.broken-<时间戳>`，再从空库重建——索引是派生物，`books/` + sidecar 才是真相源。`settings.json` 解析失败同样会改名备份。两种情况都会通过 `startup_notice` 在界面上提示一次。应用启用单实例保护，重复启动会聚焦已有窗口，避免两个进程同时写同一个库和 sidecar。

0.3 起启动时扫描 `books/` 与 sidecars：命中 path + size + mtime 缓存就跳过哈希，未命中才计算 SHA-256；sidecar 按 `updated_at` 合并进 DB，内容有变化时才回写修复（内容相同不碰文件，避免云盘把每次启动都当成一次修改）。删除 DB 后可完整重建。0.5 起扫描还负责识别云盘冲突副本、归档冲突文件，并报告合并结果。

```sql
documents(
  id TEXT PRIMARY KEY,        -- sha256，内容寻址
  name TEXT NOT NULL,
  title TEXT, author TEXT,
  page_count INTEGER, size INTEGER, mtime INTEGER,
  rel_path TEXT NOT NULL,     -- 相对书库的路径
  added_at INTEGER, last_opened_at INTEGER,
  last_page INTEGER DEFAULT 0,-- 0 基页码，本机阅读进度
  cover TEXT DEFAULT ''       -- 缩略图相对路径
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
  annotation_id UNINDEXED,
  doc_id UNINDEXED,
  quote,
  body
);

cards(
  id TEXT PRIMARY KEY,              -- card-<annotation_id>，一条标注一张卡
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source_annotation_id TEXT,
  source_doc_id TEXT,
  source_page INTEGER,
  links TEXT NOT NULL DEFAULT '[]', -- 出链的卡片 id，双向链接由查询反算
  status TEXT NOT NULL DEFAULT 'active', -- active | orphaned
  created_at INTEGER, updated_at INTEGER,
  due_at INTEGER,
  stability REAL, difficulty REAL,   -- FSRS 记忆状态
  reps INTEGER, lapses INTEGER, last_reviewed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'new', -- new | review
  deleted INTEGER NOT NULL DEFAULT 0
);

chunks(                            -- AI 全文索引，派生数据，不进 sidecar
  id TEXT PRIMARY KEY,             -- doc_id:page:index
  doc_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  text TEXT NOT NULL
);
```

约定：

- 删除只写 `deleted = 1` 墓碑，不物理删除；同步、撤销、冲突合并都依赖它。
- `doc_id` 是文件字节的 SHA-256，不是路径，也不是文件名。
- `body` 与 `quote` 会同步写入 FTS5；0.4 的书库搜索实际走 `LIKE` 子串匹配（覆盖 quote、正文、标签、文档名与标题），先把中文搜索跑通，FTS5 留待压测后接入。
- `last_page` 是本机阅读进度，不写入 sidecar，也不参与跨设备合并。
- 卡片的 `links` 只存出链 id；反向链接在列表查询时用内存反查，避免维护两张表造成不一致。
- 卡片删除写墓碑；来源标注删除时卡片不删除，只把 `status` 改为 `orphaned`。
- `chunks` 是从 PDF 文字派生的本机索引，不进 sidecar、不参与同步；切换书库或删除文档时清空。
- 设置仍走应用配置文件；数据库只放业务数据。

## 导入流程

1. 用户点「导入」，或在书库页按 `Ctrl+O`。拖入文件尚未实现。
2. 流式计算 SHA-256。命中已有 `doc_id` 时直接打开，不重复复制。
3. 复制到 `books/`，文件名做最小清洗；重名但内容不同则追加 ` (2)`。
4. 书库首次展示或打开文档时，用 pdf.js 读页数与元数据，渲染首页生成封面（320px JPEG）。
5. 写 `documents` 与 sidecar，在书库中出现。

文件超过 200 MB 时拒绝导入并提示压缩或拆分。PDF 字节不走 IPC：前端用 `convertFileSrc()` 得到 asset URL 交给 pdf.js，Rust 只负责复制、哈希与索引。

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

- `rects` 是相对页面宽高的归一化坐标（0~1），与缩放、窗口大小、DPI 无关。入库前按行合并相邻矩形并把坐标收到 5 位小数：pdf.js 的文本层按字形切分，一条 100 字的标注会产生 100 多个矩形（约 12 KB），合并后通常每行 1 个（约 0.5 KB）。
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

## 书库与检索

0.4 把单文档阅读器扩展成「书库 ↔ 阅读器」两视图：

- **书库**：扫描书库后列出文档卡片；封面与页数在缺失时由前端用 pdf.js 补齐；标注数来自 `annotations` 子查询。
- **搜索**：输入停顿 240ms 后调用 `search_annotations`，在引文（`json_extract(anchor,'$.quote')`）、`body`、`tags` JSON、文档名与标题上做 `LIKE` 子串匹配，最多返回 100 条，按更新时间倒序。不能直接匹配 `anchor` 整段 JSON——那会把坐标和 `pageHash` 也算进去，搜 `start` 或 `0.5` 会命中所有标注。结果点击后打开文档并滚到对应页。
- **阅读进度**：滚动时按视口顶部命中页更新，700ms 防抖写 `last_page`；返回书库时再同步写一次，避免扫描读到旧值；打开文档时优先使用调用方传入的页码，其次使用 `last_page`。
- **标签**：作为标注的 `tags` 数组存储，随标注写入 SQLite 与 sidecar；搜索命中会返回标签。
- **导出**：`export_markdown(path, docId?)` 在 Rust 侧拼 Markdown 并原子落盘，前端只负责原生保存对话框。
- **深色模式**：`data-theme` 作用在 `<html>`，配色全部走 CSS 变量；偏好存 `localStorage`。

封面写入路径固定为 `.glossnote/thumbnails/<sha256>.jpg`，扫描时若记录里没有 cover 但文件存在，会重新挂上，避免删库后封面丢失。

## 卡片与复习

0.6 把标注变成可复习的卡片，但卡片仍然是“可丢弃的派生层”之上的显式记录：删掉 SQLite 后能从 sidecar 重建，原文锚点永远保留。

- **生成**：阅读器侧栏的「制卡」把标注转成卡片，预填原句/批注；标题与内容可改。卡片 id 为 `card-<annotation_id>`，一条标注一张卡，重复保存是幂等更新。
- **来源**：卡片保存 `source_annotation_id`、`source_doc_id`、`source_page`。详情与复习界面都能「打开原文」，回到对应页。
- **双向链接**：编辑器从现有卡片中选出链；列表查询把其他卡片的 `links` 反查成 `backlinks`。不做 `[[标题]]` 解析，也不做关系图。
- **FSRS**：`src-tauri/src/fsrs.rs` 实现 FSRS-4.5 默认权重（17 个参数），四档评分，保存 stability / difficulty / reps / lapses / lastReviewedAt / dueAt。复习前返回四档预计到期时间，复习后按公式重新排期；again 固定 10 分钟，其余至少 1 天、最多 10 年。
- **队列**：复习视图按 `dueAt` 取全部到期卡片（含来源失效的），跨文档；来源失效会在卡片上明确标注，但仍可复习和编辑。
- **失效**：删除标注写墓碑后，同一事务里把来源卡片标记 `orphaned`；跨设备通过 sidecar 墓碑合并后，`orphan_cards_for_document` 会重新计算失效状态。
- **同步**：sidecar 增加 `cards` 数组（旧文件缺省为空），随来源文档一起写入；扫描时卡片按 `updatedAt` 做 LWW 合并，`ScanReport.mergedCards` 报告合并数量。

边界：

- FSRS 使用固定默认权重，不训练个人参数；同一天内的短时复习用天级公式近似。
- 卡片与标注是一对一；多卡拆分、卡片合并、关系图未实现。
- 卡片目前不参与 Markdown 导出。

## 同步

0.5 采用“零代码”同步：**不做账号与服务端**。书库目录交给用户的云盘（坚果云、OneDrive、Nextcloud、Syncthing），PDF、sidecar、封面自动随目录走；应用默认不联网。

扫描时的合并流程：

1. 读取 `.glossnote/annotations/` 下所有 `*.json`，解析失败或 `docId` 为空的计入 `ignoredSidecars`，文件保留不动。
2. 按文件内的 `docId` 分组，而不是只认 `<sha256>.json`；云盘生成的 `xxx (conflicted copy).json`、`xxx (1).json` 等都会被纳入。
3. 同一 `annotation.id` 按 `updatedAt` 新者胜；墓碑同样参与比较。规范文件先处理，时间戳相同时规范文件优先，结果确定。
4. 合并结果回写规范 sidecar；内容与磁盘上的文件完全相同时跳过写盘（否则云盘客户端会把每次启动都当成一次修改）。非规范的冲突副本移到 `.glossnote/conflicts/`，文件名冲突时追加毫秒时间戳，不静默删除。
5. 同一内容哈希的多个 PDF 只索引路径排序最靠前的一份，其余保留在磁盘上并计入 `duplicatePdfs`，不自动删除。
6. 索引里有、但 PDF 已不在 `books/` 的文档不再出现在书库中，只计入 `missingDocuments`；文件同步回来后下一次扫描会自动恢复，标注不受影响。
7. 返回 `ScanReport`：`merged`、`archived`、`duplicatePdfs`、`missingDocuments`、`ignoredSidecars`、`scannedAt`，书库页展示并提供手动重扫。

约束与边界：

- 同步单位是 `annotation` 与 `card`，每条带 `updatedAt` 与 `deleted`；不做整文件覆盖。卡片跟随来源文档的 sidecar，跨文档移动尚未支持。
- **不上 CRDT。** 标注是准不可变的小记录，LWW 足够；只有出现“两人同时编辑同一段笔记正文”时才重新评估。
- 冲突副本只保留原始 JSON，不提供逐字段 diff 或人工选择；同时间戳的冲突按路径顺序取舍。
- 书库索引是单库模型：切换根目录会清空 SQLite，再扫描新目录；不并行维护多个书库。
- 阅读进度 `last_page` 是设备本地状态，不进入 sidecar，也不参与同步。
- 大文件 PDF 仍随云盘目录整体同步，未做独立的 blob 通道。

## AI

0.7 的目标是“可信的可溯源回答”，不是聊天。AI 默认关闭，开启与每次请求都由用户主动触发。

### 配置与请求

- `settings.json` 的 `ai` 字段保存 `enabled / provider / model / baseUrl / apiKey`；默认 `enabled=false`。
- 支持两类服务：
  - **Anthropic**：`POST /v1/messages`，`x-api-key` + `anthropic-version: 2023-06-01`，默认模型 `claude-sonnet-5-5`。
  - **OpenAI 兼容**：`POST /v1/chat/completions`，可选 Bearer Key，适用于 Ollama、LM Studio 等本地服务。
- 请求由 Rust 的 `reqwest` 发出，不经过 WebView，因此不需要为 AI 放宽 CSP，也不会把 Key 暴露给页面脚本。
- API Key 明文保存在应用数据目录的 `settings.json`；界面明确提示，不进书库、不进 sidecar。切换服务商时会清除旧 Key，避免错发。

### 两条使用路径

**划词解释**：选中文字后发送 quote、前后文、页码；系统提示要求只依据这段文字解释，回答带页码来源。

**问答 / 总结**：

1. 用户点击「提取全文」后，前端用 pdf.js 逐页提取文字，后端按约 900 字、120 字重叠切块，写入 `chunks`，并记录 `documents.text_indexed_at`。索引纯本地，不联网。
2. 提问时，后端把问题拆成中文二元组 + 英文词，对当前文档的 chunks 与标注做词法打分；选最多 6 段原文 + 4 条标注，按 `[1]…[n]` 编号拼进提示词。
3. 模型回答后，后端返回 `citations`（页码、原文/标注、片段）；界面列出来源，点击跳到对应页。正文中的 `[n]` 由模型自行书写，界面不做语法解析。
4. 「总结全文」按页均匀采样切块，再加标注；「总结我的标注」只用当前文档的标注。两者都要求模型引用来源。

### 边界

- 只索引当前文档，跨文档/整库问答未实现。
- 检索是词法匹配，没有向量嵌入；同义改写的召回有限。
- 无流式输出、无会话记忆；请求失败直接显示 HTTP/网络错误。
- 扫描件没有文字层时只能基于手工标注提问。
- 发送内容仅限当前问题、选中的文字与检索到的片段，不上传整份 PDF 或整座书库。

## 界面系统

视觉方向是「纸与墨」：暖纸色底、墨色正文、靛蓝强调色，高亮保留琥珀与绿色。所有颜色、圆角、阴影、字号和过渡都集中在 `src/styles.css` 顶部的 CSS 变量；`data-theme` 同时切换浅色与深色两套值，组件不写死颜色。

- **控件**：按钮统一 34px 高，分 `primary`（墨色/深色下反白）、`ghost`（描边或纯文字）、`icon-button` 三档；危险操作只在文字上使用 `.danger`，不整块涂红。
- **图标**：内联在 `src/icons.tsx`，统一 1.7 描边、`currentColor`，不引图标库，避免额外依赖与字体加载。
- **反馈**：状态提示是左下角浮层 `.status-bar`，按文案区分 info / busy / error，成功提示 5 秒自动消失；它不占据文档流，阅读位置不会因提示跳动。
- **书库页头**：标题块固定在 380px，操作组靠右；书库路径单行省略，完整路径放在 tooltip。窗口变窄时操作组整体折到下一行，不压缩搜索框。
- **高亮**：高亮层用 `mix-blend-mode: multiply` 与下方 canvas 相乘，纸面的字透出来；因此 `.highlight-layer` 不能用 `z-index` 自建层叠上下文（那样只跟空图层混合，字会被整块盖住），改由 `.pdf-page` 的 `isolation: isolate` 建立混合组。pdf.js 的文本项按字形切分且互相压边，绘制前按行合并相邻矩形，避免重叠处乘两次出现深色接缝。
- **可访问性**：所有可聚焦控件有 `:focus-visible` 外圈；`prefers-reduced-motion` 下禁用过渡与动画。

### 阅读器

- **自适应缩放**：打开文档时读取第一页原始尺寸，默认按阅读区宽度「适宽」；顶栏可切「整页」或手动缩放。`ResizeObserver` 在窗口变化时重算，缩放完成后把当前页保持在视口中的相对位置。
- **按需渲染**：只渲染当前页附近的 ±1～±2 页，离屏页保留占位高度并释放画布；单页画布限制在约 1600 万像素内，避免整本书或高倍缩放再次耗尽内存。
- **翻页定位**：所有页面都有占位块，滚动时用二分查找视口顶部的页；跳到指定页时留 24px 顶边，不直接贴住顶栏。点击侧栏标注会按锚点的归一化矩形把标注首行滚到阅读区中间，而不仅是跳到页首。

## 安全与隐私

- 无账号、无遥测；除用户配置的 AI 请求外不联网。
- sidecar 是明文 JSON，可靠性优先于保密性；需要加密时由用户的云盘负责，或后续提供可选的加密容器。
- AI 默认关闭；只有用户主动解释/提问/总结时才发送当前问题、选中的文字与检索到的片段。全文索引本身在本机完成。
- API Key 明文保存在本机 `settings.json`；日志与错误信息不记录 Key，也不记录正文。
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

pdf.js 的 `cmaps/`、`standard_fonts/`、`wasm/`、`iccs/` 是运行时才取的资源，不进 bundle。`scripts/copy-pdfjs-assets.mjs` 在 `dev` 与 `build` 前把它们复制到 `public/pdfjs/`，`src/pdfjs.ts` 的 `pdfjsAssets` 再把这些路径传给每个 `getDocument` 调用。缺了 wasm 时 pdf.js 只打印 `JpxError` 这类警告并把图渲染成黑块，不会抛错，所以判断渲染是否正常不能只看控制台有没有报错。

## 原型与目标的差距

0.1 原型先跑在浏览器里；0.2 套上 Tauri 2 桌面壳，接入原生文件对话框与 asset protocol；0.3 把持久化换成 SQLite + sidecar，并在启动时扫描书库重建索引；0.4 增加书库网格、封面、搜索、标签、阅读进度、Markdown 导出与深色模式；0.5 增加书库目录切换与云盘冲突副本合并；0.6 增加标注制卡、双向链接与 FSRS 复习；0.7 增加划词解释、全文索引与可溯源问答。

| 能力 | 现状 |
| --- | --- |
| 打开文件 | Tauri 原生对话框 + Rust 哈希，导入即入库 |
| 持久化 | SQLite + 哈希 sidecar |
| 书库 | 封面网格、标注数、阅读进度 |
| 搜索 | `LIKE` 子串匹配；FTS5 表已维护未接入 |
| 封面 | 前端渲染首页，Rust 落盘 |
| 导出 | 全库/单文档 Markdown |
| 同步 | 云盘目录 + sidecar 冲突合并（0.5） |
| 卡片 / 复习 | 标注制卡、双向链接、FSRS-4.5 默认参数（0.6） |
| AI | 划词解释、本地全文索引、词法检索问答与来源跳转（0.7） |

浏览器模式仍保留 `src/storage.ts` 作为 localStorage 适配器；桌面模式由 `src/desktop.ts` 直接调用 Tauri 命令，UI 不感知两者的差异。
