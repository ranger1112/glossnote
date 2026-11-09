import {
  readDocumentNote,
  resolveNoteLinks,
  saveDocumentNote,
  searchNotes as searchNotesDesktop,
} from './desktop';
import type { DocKind } from './document';
import { isTauri } from './platform';
import { loadDoc, sha256Hex } from './storage';
import type {
  Annotation,
  NoteFile,
  NoteHit,
  NoteLinkTargets,
  NoteSaveResult,
} from './types';

export const NOTE_MAX_BYTES = 2 * 1024 * 1024;
const NOTE_PREFIX = 'glossnote:note:';
const EMPTY_NOTE: NoteFile = { text: '', updatedAt: 0, revision: '' };

export type NoteLink =
  | { kind: 'annotation'; id: string }
  | { kind: 'doc'; id: string; page?: number }
  | { kind: 'page'; page: number };

export interface NoteLinkToken {
  raw: string;
  start: number;
  end: number;
  link: NoteLink;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LINK_PATTERN = /\[\[(annotation|doc|page):([^\]\n]+)\]\]/g;

export function parseNoteLink(raw: string): NoteLink | null {
  const match = /^\[\[(annotation|doc|page):([^\]\n]+)\]\]$/.exec(raw);
  if (!match) return null;
  const kind = match[1];
  const body = match[2];

  if (kind === 'annotation') {
    return ID_PATTERN.test(body) ? { kind: 'annotation', id: body } : null;
  }

  if (kind === 'page') {
    if (!/^\d+$/.test(body)) return null;
    const page = Number(body);
    return page > 0 && Number.isSafeInteger(page) ? { kind: 'page', page } : null;
  }

  const doc = /^([A-Za-z0-9_-]{1,128})(?:#page=(\d+))?$/.exec(body);
  if (!doc) return null;
  if (doc[2] === undefined) return { kind: 'doc', id: doc[1] };
  const page = Number(doc[2]);
  if (!Number.isSafeInteger(page) || page <= 0) return null;
  return { kind: 'doc', id: doc[1], page };
}

export function parseNoteLinks(text: string): NoteLinkToken[] {
  const tokens: NoteLinkToken[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[0];
    const link = parseNoteLink(raw);
    if (!link) continue;
    const start = match.index ?? 0;
    tokens.push({ raw, start, end: start + raw.length, link });
  }
  return tokens;
}

export async function noteRevision(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256Hex(bytes.buffer as ArrayBuffer);
}

function noteKey(docId: string): string {
  return `${NOTE_PREFIX}${docId}`;
}

async function readBrowserNote(docId: string): Promise<NoteFile> {
  const raw = localStorage.getItem(noteKey(docId));
  if (!raw) return { ...EMPTY_NOTE };
  try {
    const parsed = JSON.parse(raw) as Partial<NoteFile>;
    if (typeof parsed.text !== 'string') return { ...EMPTY_NOTE };
    return {
      text: parsed.text,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      // 与桌面端一致：空文本视为「没有笔记」，revision 为空，首次保存不会误报冲突。
      revision: parsed.text ? await noteRevision(parsed.text) : '',
    };
  } catch {
    return { ...EMPTY_NOTE };
  }
}

async function saveBrowserNote(
  docId: string,
  text: string,
  expectedRevision: string,
): Promise<NoteSaveResult> {
  const current = await readBrowserNote(docId);
  if (current.revision !== expectedRevision) {
    return { status: 'conflict', current };
  }
  if (new TextEncoder().encode(text).length > NOTE_MAX_BYTES) {
    throw new Error('笔记超过 2 MB，无法保存');
  }
  if (text.trim().length === 0) {
    localStorage.removeItem(noteKey(docId));
    return {
      status: 'saved',
      note: { text: '', updatedAt: Date.now(), revision: '' },
    };
  }
  const note: NoteFile = {
    text,
    updatedAt: Date.now(),
    revision: await noteRevision(text),
  };
  localStorage.setItem(noteKey(docId), JSON.stringify(note));
  return { status: 'saved', note };
}

export async function readNote(docId: string): Promise<NoteFile> {
  return isTauri() ? readDocumentNote(docId) : readBrowserNote(docId);
}

export async function saveNote(
  docId: string,
  text: string,
  expectedRevision: string,
): Promise<NoteSaveResult> {
  return isTauri()
    ? saveDocumentNote(docId, text, expectedRevision)
    : saveBrowserNote(docId, text, expectedRevision);
}

function quoteOf(annotation: Annotation): string {
  const quote = annotation.anchor && (annotation.anchor as { quote?: unknown }).quote;
  return typeof quote === 'string' ? quote : '';
}

function browserTargets(annotationIds: string[], docIds: string[]): NoteLinkTargets {
  const annotations: NoteLinkTargets['annotations'] = {};
  const documents: NoteLinkTargets['documents'] = {};
  const wantedAnnotations = new Set(annotationIds);
  const wantedDocs = new Set(docIds);

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith('glossnote:doc:')) continue;
    const record = loadDoc(key.slice('glossnote:doc:'.length));
    if (!record) continue;
    if (wantedDocs.has(record.docId)) {
      documents[record.docId] = {
        title: record.name,
        name: record.name,
        pageCount: 0,
        kind: 'pdf' as DocKind,
      };
    }
    if (wantedAnnotations.size === 0) continue;
    for (const annotation of record.annotations) {
      if (!wantedAnnotations.has(annotation.id) || annotation.deleted) continue;
      annotations[annotation.id] = {
        docId: record.docId,
        page: annotation.page,
        quote: quoteOf(annotation),
        color: annotation.color,
        kind: annotation.kind,
      };
    }
  }
  return { annotations, documents };
}

export async function resolveNoteTargets(
  annotationIds: string[],
  docIds: string[],
): Promise<NoteLinkTargets> {
  const uniqueAnnotations = [...new Set(annotationIds)].slice(0, 200);
  const uniqueDocs = [...new Set(docIds)].slice(0, 200);
  if (uniqueAnnotations.length === 0 && uniqueDocs.length === 0) {
    return { annotations: {}, documents: {} };
  }
  const result = isTauri()
    ? await resolveNoteLinks(uniqueAnnotations, uniqueDocs)
    : browserTargets(uniqueAnnotations, uniqueDocs);
  return result ?? { annotations: {}, documents: {} };
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - 60);
  return text.slice(start, start + 160).replace(/\s+/g, ' ').trim();
}

function searchBrowserNotes(query: string): NoteHit[] {
  const term = query.trim();
  if (!term) return [];
  const needle = term.toLowerCase();
  const hits: NoteHit[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(NOTE_PREFIX)) continue;
    const docId = key.slice(NOTE_PREFIX.length);
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<NoteFile>;
      if (typeof parsed.text !== 'string') continue;
      const position = parsed.text.toLowerCase().indexOf(needle);
      if (position < 0) continue;
      const record = loadDoc(docId);
      hits.push({
        docId,
        docName: record?.name ?? docId.slice(0, 8),
        docTitle: record?.name ?? '',
        snippet: snippetAround(parsed.text, position),
        position,
      });
    } catch {
      // 损坏的本地记录直接跳过。
    }
    if (hits.length >= 50) break;
  }
  return hits;
}

export async function searchNotes(query: string): Promise<NoteHit[]> {
  const result = isTauri() ? await searchNotesDesktop(query) : searchBrowserNotes(query);
  return Array.isArray(result) ? result : [];
}
