import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type {
  AiAnswer,
  AiSettingsInput,
  AiSettingsView,
  Annotation,
  CardView,
  DocumentMeta,
  ImportResult,
  LibraryInfo,
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

export function getLastDocument(): Promise<ImportResult | null> {
  return invoke('last_document');
}

export function listDocuments(): Promise<DocumentMeta[]> {
  return invoke('list_documents');
}

export function listAnnotations(docId: string): Promise<Annotation[]> {
  return invoke('list_annotations', { docId });
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

export function libraryInfo(): Promise<LibraryInfo> {
  return invoke('library_info');
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
