import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type {
  AiAnswer,
  AiSettingsInput,
  AiSettingsView,
  Annotation,
  CardView,
  DocumentMeta,
  ImportResult,
  PageTextInput,
  ScanReport,
  SearchHit,
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

export function importPdf(path: string): Promise<ImportResult> {
  return invoke('import_pdf', { path });
}

export function openDocument(docId: string): Promise<ImportResult> {
  return invoke('open_document', { docId });
}

export function listDocuments(): Promise<DocumentMeta[]> {
  return invoke('list_documents');
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

/** 设置收藏或替换文档标签；结果同步写 sidecar。 */
export function organizeDocument(
  docId: string,
  patch: { favorite?: boolean; tags?: string[] },
): Promise<DocumentMeta> {
  return invoke('organize_document', { docId, ...patch });
}

/** 批量设置收藏并向选中文档追加标签。 */
export function organizeDocuments(
  docIds: string[],
  patch: { favorite?: boolean; addTags?: string[]; removeTags?: string[] },
): Promise<DocumentMeta[]> {
  return invoke('organize_documents', {
    docIds,
    favorite: patch.favorite,
    addTags: patch.addTags ?? [],
    removeTags: patch.removeTags ?? [],
  });
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

export function aiSummarize(docId: string, annotationsOnly: boolean): Promise<AiAnswer> {
  return invoke('ai_summarize', { docId, annotationsOnly });
}
