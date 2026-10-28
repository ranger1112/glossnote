import type { Anchor } from './anchoring';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
export type AnnotationKind = 'highlight' | 'underline' | 'note' | 'area' | 'ink';

export interface Annotation {
  id: string;
  page: number;
  anchor: Anchor;
  color: HighlightColor;
  kind: AnnotationKind;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** 墓碑式删除：同步与撤销都依赖它，不做物理删除 */
  deleted?: boolean;
}

export interface DocumentMeta {
  id: string;
  name: string;
  title: string;
  author: string;
  pageCount: number;
  path: string;
  cover: string;
  size: number;
  addedAt: number;
  lastOpenedAt: number;
  lastPage: number;
  annotationCount: number;
}

export interface SearchHit {
  annotationId: string;
  docId: string;
  docName: string;
  page: number;
  quote: string;
  body: string;
  color: HighlightColor;
  tags: string[];
}

export interface ImportResult {
  document: DocumentMeta;
  annotations: Annotation[];
}

export interface LibraryInfo {
  root: string;
  documents: number;
  annotations: number;
}

export interface ScanReport {
  root: string;
  documents: number;
  annotations: number;
  /** 从 sidecar（含冲突副本）合并进索引的标注条数 */
  merged: number;
  /** 合并后归档到 .glossnote/conflicts/ 的冲突副本数量 */
  archived: number;
  duplicatePdfs: number;
  missingDocuments: number;
  ignoredSidecars: number;
  mergedCards: number;
  scannedAt: number;
}

export interface Card {
  id: string;
  title: string;
  body: string;
  sourceAnnotationId: string | null;
  sourceDocId: string | null;
  sourcePage: number | null;
  links: string[];
  /** active | orphaned */
  status: string;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReviewedAt: number;
  /** new | review */
  state: string;
  deleted: boolean;
}

export interface CardRef {
  id: string;
  title: string;
}

export interface RatingPreview {
  rating: number;
  label: string;
  dueAt: number;
  intervalDays: number;
}

export interface CardView {
  card: Card;
  docName: string;
  sourceQuote: string;
  backlinks: CardRef[];
  previews: RatingPreview[];
}

export interface AiSettingsView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
  ready: boolean;
}

export interface AiSettingsInput {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string | null;
  clearKey?: boolean;
}

export interface AiCitation {
  index: number;
  page: number | null;
  kind: string;
  label: string;
  snippet: string;
  annotationId: string | null;
}

export interface AiAnswer {
  text: string;
  citations: AiCitation[];
  model: string;
}

export interface PageTextInput {
  page: number;
  text: string;
}

/** 浏览器原型用的 localStorage 记录；桌面端以 SQLite + sidecar 为准。 */
export interface DocRecord {
  schemaVersion: 1;
  docId: string;
  name: string;
  size: number;
  annotations: Annotation[];
}
