# 实现计划

## 状态快照

- 日期：2026-10-27
- 版本：0.1.0（0.2 / 0.3 / 0.4 / 0.5 / 0.6 尚未发版）
- 提交：0.2 `c96ffec`，0.3 `efb45d4`，0.4 `9d32162`，0.5 `a96cff1`，0.6 知识沉淀待提交
- 阶段：0.6 知识沉淀完成，下一步 0.7 AI

## 里程碑

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| 0.1 | PDF 阅读、高亮、批注、重开复原（浏览器） | 已完成 |
| 0.2 | Tauri 2 桌面外壳、原生打开文件 | 已完成 |
| 0.3 | 书库导入、SQLite、sidecar、内容哈希 | 已完成 |
| 0.4 | 书库列表、封面、搜索、标签、导出 | 已完成 |
| 0.5 | 云同步 | 已完成 |
| 0.6 | 卡片、双链、FSRS 复习 | 已完成 |
| 0.7 | AI 划词解释、可溯源 RAG | 未开始 |
| 1.0 | EPUB / HTML / TXT | 未开始 |

## 0.1 锚定原型（已完成）

交付：

- Vite + React + TypeScript + pdf.js 阅读器。
- 四色高亮、批注、标注侧栏、点击定位、删除墓碑。
- 跨行/跨文本块选择按行拆矩形。
- 内容哈希识别文档，`localStorage` 持久化。
- 锚定四级回退：exact / text search / similarity / ratio。

验收证据（2026-10-27，Chrome + Playwright）：

- 刷新后高亮坐标与刷新前完全一致。
- 缩放 120% → 145%，页面与高亮按同一比例变化。
- 跨两行选择生成 2 个矩形。
- 同一句话出现两次时，选中第二处，高亮落在第二处。
- 批注失焦保存、刷新后恢复；删除后墓碑生效。
- `npm run build` 通过；`npm test` 7/7 通过。

## 0.2 Tauri 桌面外壳（已完成）

工具链：Rust 1.94.1 在 `D:\Rust`，MSVC 在 `D:\BuildTools`，由 `scripts\_env.cmd` 加载。细节见 [build.md](build.md)。

任务：

1. 在仓库内初始化 `src-tauri`，标识符 `com.phoebe.glossnote`，产品名 GlossNote。
2. 主窗口 1280×860，最小 900×600，普通窗口（非置顶、非透明、占任务栏）。
3. Capabilities 只开放必要权限：核心、文件对话框、窗口控制。
4. Rust 命令：
   - `open_pdf_dialog()` 返回路径；
   - `read_pdf(path)` 返回文件名、大小、sha256、字节（首版限制 50 MB）。
5. 前端增加平台适配层：浏览器用 `<input type=file>`，Tauri 用命令；`storage.ts` 接口不变。
6. CSP 允许 pdf.js worker；验证扫描件 WASM 解码是否需要 `'wasm-unsafe-eval'`。
7. 保持浏览器开发模式可用，不为了桌面壳破坏 `npm run dev`。

验收：

- `npm run tauri dev` 启动后可用原生对话框打开 PDF。
- 渲染、选择、高亮、批注与浏览器版一致。
- 关闭再启动应用，标注复原。
- 断开网络不影响任何功能。

非目标：书库、SQLite、sidecar、同步。

验收证据（2026-10-27，WebView2 CDP + 桌面截图）：

- `scripts\check-env.cmd` 找到 cargo 1.94.1 与 MSVC，`cargo check` 通过。
- `scripts\dev.cmd` 成功启动 `target\debug\glossnote.exe`，窗口 1280×860。
- 原生「打开 PDF」对话框正常弹出，选择示例 PDF 后渲染 2 页。
- `read_pdf_meta` 返回 sha256 `c665d327…`，与浏览器计算的内容哈希一致。
- asset protocol 返回 200、2460 字节、开头 `%PDF-`；pdf.js 从 asset URL 读到 2 页、16 个文本 item。
- 重启应用后，之前的高亮与批注卡片自动恢复。
- 未自动验证：文件对话框的完整键盘/鼠标交互（只验证了弹出与选择路径），后续手工回归即可。

## 0.3 本地持久化与导入（已完成）

任务：

1. 建 SQLite schema 与迁移；`documents` / `annotations` / `annotation_fts`。
2. 导入流程：哈希 → 去重 → 复制进 `books/` → 元数据 → 封面。
3. sidecar：`<Library>/.glossnote/annotations/<sha256>.json`，临时文件 + rename，1 秒防抖。
4. 启动扫描：`books/` + sidecars → 重建或校正索引。
5. 用 SQLite + sidecar 替换 `localStorage` 适配器。
6. 文件改名/移动后的重挂接（按哈希）。

验收：

- 删除 `library.db` 后重启，标注与书库完整恢复。
- 同一文件重复导入不产生副本，直接打开已有记录。
- 在应用外重命名 PDF，重启后标注仍在该文档上。
- 应用崩溃或断电后，sidecar 不出现半截 JSON。
- 100 份文档导入后，书库加载与标注查询无明显卡顿。

非目标：书库 UI 的完整设计、云同步、标签体系。

验收证据（2026-10-27，WebView2 CDP + 文件检查）：

- 书库根目录 `C:\Users\weicheng\Documents\GlossNote`，包含 `books/sample.pdf` 与 `.glossnote/annotations/<sha256>.json`。
- SQLite 在 `%APPDATA%\com.phoebe.glossnote\library.db`，FTS5 建表成功。
- 首次导入复制文件并生成 sidecar；重复导入同一文件不产生副本，直接打开已有文档。
- 新增高亮并写批注后，sidecar、`annotations` 表与 `annotation_fts` 三处内容一致。
- 删除 `library.db` 后重启，启动扫描从 PDF + sidecar 重建 1 份文档和 1 条标注，界面完整恢复。
- 在应用外把 `sample.pdf` 改名为 `renamed.pdf` 后重启，文档 id 不变、路径更新、标注保留。
- 删除标注后 sidecar 写 `deleted: true`，DB 墓碑为 1，FTS 行移除；重启后不复活。
- 浏览器模式回归通过；旧 localStorage 的 `note` 字段迁移为 `body`，并补齐 `kind` / `tags`。

## 0.4 书库体验（已完成）

任务：封面网格/列表、阅读进度、全文搜索、标签、按文档/全库导出 Markdown、深色模式。

实现：

1. 书库网格：`Library.tsx` 展示封面、书名、页数、标注数、阅读进度；点击封面进入阅读器。
2. 封面：前端用 pdf.js 渲染首页到 canvas，导出 320px 宽 JPEG，经 `save_cover` 写入 `.glossnote/thumbnails/<sha256>.jpg`；同时读取页数并回填 `documents.page_count`。
3. 阅读进度：`documents.last_page` 记录 0 基页码；阅读器滚动时按可见页更新，700ms 防抖落盘，返回书库时再等待一次写入，重新打开直接滚到该页。
4. 搜索：书库搜索框 240ms 防抖，经 `search_annotations` 在 quote、批注正文、标签、文档名/标题上做大小写不敏感的子串匹配（SQL `LIKE`），结果可点击跳到对应页。
5. 标签：标注卡片内可增删标签，写入 `annotations.tags` 并随 sidecar 同步。
6. 导出：`export_markdown` 支持全库或单文档，输出标题、文件名、作者、页数、标注数，以及每条的页码、原句、批注与 `#标签`；经原生保存对话框选择位置。
7. 深色模式：顶栏切换，`data-theme` + CSS 变量，偏好写入 `localStorage`。
8. 新命令：`open_document`、`save_cover`、`save_progress`、`search_annotations`、`export_markdown`；capabilities 增加 `dialog:allow-save`。

验收证据（2026-10-27，WebView2 CDP + 文件检查）：

- 导入示例 PDF 后，书库出现 1 张卡片，封面 JPEG 实际渲染宽度 320px，页数回填为 2。
- 点击卡片进入阅读器；滚到第 2 页后返回，卡片显示「读到第 2 页」，进度条 100%；再次打开直接落在第 2 页（`scrollTop` 1012.8）。
- 搜索「测试」命中 1 条，结果含文档名、页码、原句、批注正文与 `#测试` `#重点` 标签。
- 在卡片上新增/移除标签，SQLite 与 sidecar JSON 同步更新。
- 经原生保存对话框导出 Markdown，文件包含标题、文件信息、页码、引用、批注与标签。
- 深色模式切换后 `data-theme=dark`，背景/卡片/正文颜色按预期变化；偏好可持久化。
- `npm run build`、`npm test`（7/7）、`cargo check`、`cargo test`（2/2）通过。

已知差距：

- 搜索目前用 `LIKE` 子串匹配，FTS5 表仍在维护但未接入查询；中文分词与 1000 条规模性能尚未压测。
- 书库目录选择器、拖拽导入、后台扫描与进度提示尚未实现。
- 阅读进度只存本地 SQLite，不写入 sidecar，未参与跨设备同步。

## 0.5 云同步（已完成）

采用“零代码”路线：书库放在云盘同步目录，应用负责识别并合并 sidecar 冲突副本；不做账号与服务端同步。

实现：

1. **书库位置 UI**：书库页显示当前目录与上次扫描时间；「书库位置」调用原生目录选择器，确认后写入 `settings.json`、清空旧索引并扫描新目录。运行时通过 `RwLock<PathBuf>` 切换，不需要重启。
2. **冲突识别**：扫描 `.glossnote/annotations/*.json` 的全部文件（不仅是 `<docId>.json`），解析后按文件内的 `docId` 分组，兼容 OneDrive、Dropbox、Syncthing、Nextcloud 等不同冲突命名。
3. **按记录合并**：同一 `annotation.id` 按 `updatedAt` 新者胜；墓碑同样参与比较；规范文件先处理，时间戳相同时规范文件优先，保证结果确定。
4. **归档原文**：合并成功后，把非规范的冲突副本移到 `.glossnote/conflicts/`，保留原始 JSON 便于追溯；重名时追加毫秒时间戳。
5. **重复 PDF**：同一内容哈希的多个 PDF 只索引一个，其余保留文件但计数提示，不自动删除用户文件。
6. **可见状态**：`ScanReport` 返回合并条数、归档数、重复 PDF、无效 sidecar 与扫描时间；书库页展示，并提供手动「重新扫描」。

验收证据（2026-10-27，WebView2 CDP + 文件检查 + Rust 单测）：

- 模拟云盘冲突副本：同一条标注被改成更新版本，另一个副本新增 1 条；扫描后状态栏显示「合并 2 条，归档 1 个冲突副本」，阅读器里两条批注正确。
- 归档文件出现在 `.glossnote/conflicts/`，原冲突文件从 `annotations/` 消失；规范 sidecar 回写为合并后的 2 条。
- 关闭应用后写入新冲突副本，重启自动合并 2 条并归档 1 个，说明启动扫描路径生效。
- 通过原生目录对话框切换书库：路径、`settings.json`、空书库状态同步更新；切换回原目录后，从 PDF + sidecar 重建 1 份文档、2 条标注。
- 复制一份同名同内容的 PDF 后扫描：文档数不变，报告「1 份重复 PDF 已忽略」。
- 墓碑冲突单测、冲突合并与归档单测通过；`cargo test` 4/4，`npm test` 7/7，`npm run build` 通过。

已知差距：

- 没有自动定时扫描；依赖启动与手动「重新扫描」，云盘在应用运行中写入的新冲突需要手动刷新。
- 冲突副本只按记录合并，不提供逐字段 diff 或人工选择保留哪一版；同时间戳的冲突按文件路径顺序取舍。
- 重复 PDF 不会自动清理；需要用户自行决定删除哪一份。
- 书库索引是单库模型，切换根目录会清空 SQLite 并重建，不做多库并存。

## 0.6 知识沉淀（已完成）

任务：标注转卡片、双向链接、FSRS 调度、复习界面。

实现：

1. **卡片模型**：`cards` 表 + sidecar 的 `cards` 字段；卡片记录标题、内容、来源标注/文档/页码、链接、状态与 FSRS 记忆参数。一条标注对应一张卡片，卡片 id 固定为 `card-<annotationId>`，重复保存是幂等的。
2. **从标注制卡**：标注卡片新增「制卡」按钮，预填原句或批注正文；编辑器可改标题、内容并选择要链接的卡片。已有卡片时入口变为「卡片」，打开同一编辑器修改。
3. **双向链接**：卡片保存 `links`（出链 id）；列表查询时反算 `backlinks`。详情弹窗可点击链接与反向链接互相跳转；目标已删除时显示为不可点的「已删除的卡片」。
4. **FSRS-4.5**：Rust 纯函数实现默认权重的 FSRS-4.5（again/hard/good/easy），保存 stability、difficulty、reps、lapses、lastReviewedAt、dueAt；复习前展示四档预计间隔，复习后按新记忆状态排期。again 固定 10 分钟，其余至少 1 天（上限 10 年）。
5. **复习界面**：顶栏新增「复习」视图；按到期时间给出队列，显示来源原句、打开原文入口、四档评分与间隔；队列为空时显示下一张到期时间；下方列出全部卡片与状态（新卡/到期/已排期/来源失效）。
6. **来源失效**：删除标注只写墓碑，并把来源卡片标记为 `orphaned`，保留卡片内容与复习记录；跨设备删除通过 sidecar 墓碑合并后同样触发。
7. **同步**：`write_sidecar` 写入该文档的卡片（含卡片墓碑）；扫描时按卡片 `updatedAt` 与标注同样的 LWW 规则合并，`ScanReport` 增加 `mergedCards`。

验收证据（2026-10-27，WebView2 CDP + 文件检查 + Rust 单测）：

- 从标注制卡：预填标题/正文，保存后侧栏显示「卡片 · 新」，sidecar 出现卡片记录。
- 复习：新卡显示「重来 10 分钟 / 困难 28 小时 / 良好 3 天 / 容易 15 天」；点「良好」后卡片变为「已排期」，复习次数 1，`dueAt` 约为 3 天后，sidecar 中 stability=3.1262。
- 双向链接：第二张卡片链接第一张后，第一张卡片的详情显示反向链接「第二张卡片」，点击可跳转。
- 删除来源标注后，卡片状态变为 `orphaned`，内容与链接保留，侧栏入口消失；复习页仍可查看、编辑和复习，并明确提示来源失效。
- 删除卡片写墓碑；sidecar 保留 `deleted: true`，列表不再显示。
- 模拟云盘卡片冲突副本：重新扫描后卡片标题采用较新版本，冲突副本归档到 `.glossnote/conflicts/`。
- 删除 `library.db` 后重启：从 sidecar 重建 2 张卡片，包含失效率、复习次数与遗忘次数。
- `cargo test` 12/12（FSRS 6 项 + 卡片同步/失效）、`npm test` 7/7、`npm run build` 通过。

已知差距：

- FSRS 使用固定默认权重，不根据个人复习历史训练；同一天内的短时复习按天级公式近似，未实现分钟级学习步。
- 一条标注只允许一张卡片；多卡拆分、卡片合并未做。
- 链接是手动选择，不支持 `[[标题]]` 语法解析，也不提供关系图。
- 卡片不参与 Markdown 导出；复习统计只有次数与到期时间，没有热力图或正确率报表。

## 0.7 AI

任务：划词解释（带上文窗口）、文档切块与嵌入、基于标注/文档的 RAG、引用跳转。

验收：

- 每个 AI 回答都能点回原文或标注。
- 未开启 AI 的文档不进入索引、不发出请求。
- 断网或超时给出明确降级提示，不吞错。

## 1.0 多格式

EPUB（CFI）、HTML（Readability + SingleFile 冻存快照）、TXT。锚定接口抽象成 `AnchorStrategy`，不同格式各自实现，上层 UI 不感知。

验收：三种格式都能高亮、批注、重开复原；HTML 改版不影响已冻存快照上的标注。

## 阻塞与风险

| 项 | 影响 | 处理 |
| --- | --- | --- |
| Rust 不在系统 PATH | 直接跑 npm/tauri 会找不到 cargo | 网关脚本先加载 `_env.cmd`，并直接调用 `.bin\tauri.cmd`；见 [build.md](build.md) |
| Tauri CSP 与 pdf.js worker/WASM | 桌面端渲染失败 | 0.2 第一件事就验证，不凭记忆写 CSP |
| 大 PDF 经 IPC 传输 | 内存与卡顿 | 先限 50 MB，后续 asset protocol |
| 扫描件无文本层 | 无法高亮 | 明确提示；OCR 推迟 |
| 首次扫描大书库需要逐文件哈希 | 启动变慢 | 仍为启动时同步扫描；后续改为后台扫描 + 进度提示 |
| 书库位置尚无 UI | 只能手改 settings.json | 目录选择器推迟到 0.5 前后 |
| 搜索用 LIKE 子串匹配 | 大书库或复杂查询变慢 | FTS5 表已维护；接入前先压测中文分词方案 |
| FSRS 无个性化权重 | 排期不完全贴合个人记忆 | 先用默认参数；积累复习日志后再评估优化器 |
| 云盘冲突副本 | 标注重复/丢失 | 0.5 已按 docId 识别、按记录合并并归档 |
| AI 成本与幻觉 | 信任受损 | 强制引用；默认关闭；本地模型可选 |

## 完成定义

每个阶段结束前必须同时满足：

1. `npm run build` 与 `npm test` 通过。
2. 在真实 PDF 上手工走一遍验收清单（普通、双栏、扫描件至少各一份）。
3. 新增或改变的行为已写入 `docs/` 对应文档。
4. 没有把测试数据、个人文档或凭据提交进仓库。
