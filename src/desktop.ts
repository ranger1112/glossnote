import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type {
  Annotation,
  DocumentMeta,
  ImportResult,
  LibraryInfo,
} from './types';

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export function scanLibrary(): Promise<LibraryInfo> {
  return invoke('scan_library');
}

export function importPdf(path: string): Promise<ImportResult> {
  return invoke('import_pdf', { path });
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

export function libraryInfo(): Promise<LibraryInfo> {
  return invoke('library_info');
}
