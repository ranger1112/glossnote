import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type {
  Annotation,
  DocumentMeta,
  ImportResult,
  LibraryInfo,
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
