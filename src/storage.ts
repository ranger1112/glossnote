import type { Annotation, DocRecord } from './types';

const PREFIX = 'glossnote:doc:';

/** 内容哈希作为文档身份：改名、移动、重新下载都不会丢标注。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** 0.1/0.2 的 localStorage 记录只有 note，没有 kind/tags；读入时补齐。 */
function normalizeAnnotation(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.anchor || typeof value.anchor !== 'object') {
    return null;
  }

  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now();
  const body =
    typeof value.body === 'string'
      ? value.body
      : typeof value.note === 'string'
        ? value.note
        : '';

  return {
    id: value.id,
    page: typeof value.page === 'number' ? value.page : 0,
    anchor: value.anchor as Annotation['anchor'],
    color: (value.color as Annotation['color']) ?? 'yellow',
    kind: (value.kind as Annotation['kind']) ?? 'highlight',
    body,
    tags: Array.isArray(value.tags) ? (value.tags as string[]) : [],
    createdAt,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : createdAt,
    deleted: value.deleted === true,
  };
}

export function loadDoc(docId: string): DocRecord | null {
  try {
    const raw = localStorage.getItem(PREFIX + docId);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as DocRecord;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.docId !== docId ||
      !Array.isArray(parsed.annotations)
    ) {
      return null;
    }

    return {
      ...parsed,
      annotations: parsed.annotations
        .map(normalizeAnnotation)
        .filter((annotation): annotation is Annotation => annotation !== null),
    };
  } catch (error) {
    console.error('读取本地标注失败', error);
    return null;
  }
}

export function saveDoc(record: DocRecord): void {
  localStorage.setItem(PREFIX + record.docId, JSON.stringify(record));
}

export function listDocs(): DocRecord[] {
  const records: DocRecord[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;

    const docId = key.slice(PREFIX.length);
    const record = loadDoc(docId);
    if (record) records.push(record);
  }
  return records;
}
