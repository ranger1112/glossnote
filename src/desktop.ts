import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AiAnswer,
  AiSettingsInput,
  AiSettingsView,
  Annotation,
  Bookmark,
  CardView,
  ChatTurn,
  DeleteReport,
  DocumentMeta,
  ImportResult,
  PageHit,
  PageIndexStatus,
  PageTextInput,
  ScanReport,
  SearchHit,
  SidecarVersion,
  SmartCollection,
} from './types';

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export function scanLibrary(): Promise<ScanReport> {
  return invoke('scan_library');
}

export function libraryRoot(): Promise<string> {
  return invoke('library_root');
}

/** 启动时如果重建过索引或回退过设置，返回一条提示；只会返回一次。 */
export function startupNotice(): Promise<string | null> {
  return invoke('startup_notice');
}

/** 切换书库目录；Rust 会清空旧索引并扫描新目录。 */
export function setLibraryRoot(path: string): Promise<ScanReport> {
  return invoke('set_library_root', { path });
}

export function importDocument(path: string): Promise<ImportResult> {
  return invoke('import_document', { path });
}

/** 读取 TXT / HTML 的原始文本；PDF 与 EPUB 走各自的解析路径。 */
export function readDocumentText(docId: string): Promise<string> {
  return invoke('read_document_text', { docId });
}

export function openDocument(docId: string): Promise<ImportResult> {
  return invoke('open_document', { docId });
}

export function listDocuments(): Promise<DocumentMeta[]> {
  return invoke('list_documents');
}

export function upsertAnnotations(docId: string, annotations: Annotation[]): Promise<void> {
  return invoke('upsert_annotations', { docId, annotations });
}

export function upsertAnnotation(docId: string, annotation: Annotation): Promise<void> {
  return invoke('upsert_annotation', { docId, annotation });
}

export function deleteAnnotation(docId: string, id: string): Promise<void> {
  return invoke('delete_annotation', { docId, id });
}

export function updateDocumentMeta(
  docId: string,
  patch: { pageCount?: number; title?: string; author?: string },
): Promise<DocumentMeta> {
  return invoke('update_document_meta', { docId, patch });
}

/** 设置收藏、文件夹或替换文档标签；结果同步写 sidecar。 */
export function organizeDocument(
  docId: string,
  patch: { favorite?: boolean; tags?: string[]; folder?: string },
): Promise<DocumentMeta> {
  return invoke('organize_document', { docId, ...patch });
}

/** 批量设置收藏/文件夹，并向选中文档追加或移除标签。 */
export function organizeDocuments(
  docIds: string[],
  patch: {
    favorite?: boolean;
    addTags?: string[];
    removeTags?: string[];
    folder?: string;
  },
): Promise<DocumentMeta[]> {
  return invoke('organize_documents', {
    docIds,
    favorite: patch.favorite,
    addTags: patch.addTags ?? [],
    removeTags: patch.removeTags ?? [],
    folder: patch.folder,
  });
}

/** 批量删除：PDF 与标注进系统回收站，索引立即移除。 */
export function deleteDocuments(docIds: string[]): Promise<DeleteReport> {
  return invoke('delete_documents', { docIds });
}

/** 手动排序：按传入的文档顺序重写位置。 */
export function reorderDocuments(docIds: string[]): Promise<DocumentMeta[]> {
  return invoke('reorder_documents', { docIds });
}

export function listFolders(): Promise<string[]> {
  return invoke('list_folders');
}

/** 保存虚拟文件夹列表（允许空文件夹）。 */
export function saveFolders(folders: string[]): Promise<string[]> {
  return invoke('save_folders', { folders });
}

export function listSmartCollections(): Promise<SmartCollection[]> {
  return invoke('list_smart_collections');
}

export function saveSmartCollections(collections: SmartCollection[]): Promise<SmartCollection[]> {
  return invoke('save_smart_collections', { collections });
}

/** 前端把首页渲染成 JPEG，Rust 落到书库的 .glossnote/thumbnails 下。 */
export function saveCover(docId: string, bytes: Uint8Array): Promise<DocumentMeta> {
  return invoke('save_cover', { docId, bytes: Array.from(bytes) });
}

export function saveProgress(docId: string, lastPage: number): Promise<void> {
  return invoke('save_progress', { docId, lastPage });
}

export function searchAnnotations(query: string): Promise<SearchHit[]> {
  return invoke('search_annotations', { query });
}

/** 全库正文搜索；只覆盖已经缓存过页面文字的文档。 */
export function searchPages(query: string): Promise<PageHit[]> {
  return invoke('search_pages', { query });
}

export function pageIndexStatus(): Promise<PageIndexStatus> {
  return invoke('page_index_status');
}

export function saveBookmarks(docId: string, bookmarks: Bookmark[]): Promise<DocumentMeta> {
  return invoke('save_bookmarks', { docId, bookmarks });
}

export function listSidecarVersions(docId: string): Promise<SidecarVersion[]> {
  return invoke('list_sidecar_versions', { docId });
}

/** 把某份历史快照恢复为当前标注/书签/整理信息。 */
export function restoreSidecarVersion(docId: string, versionId: string): Promise<ImportResult> {
  return invoke('restore_sidecar_version', { docId, versionId });
}

export function exportMarkdown(path: string, docId?: string): Promise<string> {
  return invoke('export_markdown', { path, docId: docId ?? null });
}

/** 导出一份把高亮/下划线/删除线与批注写进去的 PDF 副本。 */
export function exportAnnotatedPdf(docId: string, path: string): Promise<string> {
  return invoke('export_annotated_pdf', { docId, path });
}

export function listCards(): Promise<CardView[]> {
  return invoke('list_cards');
}

export function createCard(
  docId: string,
  annotationId: string,
  title: string,
  body: string,
  links: string[],
): Promise<CardView> {
  return invoke('create_card', { docId, annotationId, title, body, links });
}

export function updateCard(
  cardId: string,
  title: string,
  body: string,
  links: string[],
): Promise<CardView> {
  return invoke('update_card', { cardId, title, body, links });
}

export function deleteCard(cardId: string): Promise<void> {
  return invoke('delete_card', { cardId });
}

export function reviewCard(cardId: string, rating: number): Promise<CardView> {
  return invoke('review_card', { cardId, rating });
}

export function aiSettings(): Promise<AiSettingsView> {
  return invoke('ai_settings');
}

export function saveAiSettings(settings: AiSettingsInput): Promise<AiSettingsView> {
  return invoke('save_ai_settings', { settings });
}

export function testAi(): Promise<string> {
  return invoke('test_ai');
}

export function indexDocumentText(
  docId: string,
  pages: PageTextInput[],
): Promise<number> {
  return invoke('index_document_text', { docId, pages });
}

export function documentIndexStatus(docId: string): Promise<boolean> {
  return invoke('document_index_status', { docId });
}

/** 读取页内查找的逐页文字缓存；没有缓存时返回空数组。 */
export function loadPageTexts(docId: string): Promise<PageTextInput[]> {
  return invoke('load_page_texts', { docId });
}

/** 把本次搜索新提取的页面文字写回缓存。 */
export function savePageTexts(docId: string, pages: PageTextInput[]): Promise<number> {
  return invoke('save_page_texts', { docId, pages });
}

export function aiExplain(
  docId: string,
  page: number,
  quote: string,
  context: string,
): Promise<AiAnswer> {
  return invoke('ai_explain', { docId, page, quote, context });
}

export function aiAnswer(docId: string, question: string): Promise<AiAnswer> {
  return invoke('ai_answer', { docId, question });
}

/** 追问：带上最近几轮对话；解释模式继续沿用选段作为资料。 */
export function aiFollowup(
  docId: string,
  mode: 'explain' | 'qa',
  page: number | null,
  quote: string,
  context: string,
  question: string,
  history: ChatTurn[],
): Promise<AiAnswer> {
  return invoke('ai_followup', { docId, mode, page, quote, context, question, history });
}

export function aiSummarize(docId: string, annotationsOnly: boolean): Promise<AiAnswer> {
  return invoke('ai_summarize', { docId, annotationsOnly });
}

export interface AiStreamChunk {
  requestId: string;
  text: string;
}

/** 订阅本次请求的增量事件；命令返回的完整回答仍是最终结果。 */
async function streamRequest(
  command: string,
  args: Record<string, unknown>,
  onChunk: (text: string) => void,
): Promise<AiAnswer> {
  const requestId = crypto.randomUUID();
  const unlisten = await listen<AiStreamChunk>('ai-stream', (event) => {
    if (event.payload.requestId === requestId) onChunk(event.payload.text);
  });

  try {
    return await invoke<AiAnswer>(command, { ...args, requestId });
  } finally {
    unlisten();
  }
}

export function aiExplainStream(
  docId: string,
  page: number,
  quote: string,
  context: string,
  onChunk: (text: string) => void,
): Promise<AiAnswer> {
  return streamRequest('ai_explain_stream', { docId, page, quote, context }, onChunk);
}

export function aiAnswerStream(
  docId: string,
  question: string,
  onChunk: (text: string) => void,
): Promise<AiAnswer> {
  return streamRequest('ai_answer_stream', { docId, question }, onChunk);
}

export function aiFollowupStream(
  docId: string,
  mode: 'explain' | 'qa',
  page: number | null,
  quote: string,
  context: string,
  question: string,
  history: ChatTurn[],
  onChunk: (text: string) => void,
): Promise<AiAnswer> {
  return streamRequest(
    'ai_followup_stream',
    { docId, mode, page, quote, context, question, history },
    onChunk,
  );
}

export function aiSummarizeStream(
  docId: string,
  annotationsOnly: boolean,
  onChunk: (text: string) => void,
): Promise<AiAnswer> {
  return streamRequest(
    'ai_summarize_stream',
    { docId, annotationsOnly },
    onChunk,
  );
}
