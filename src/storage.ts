import type { DocRecord } from './types';

const PREFIX = 'glossnote:doc:';

/** 内容哈希作为文档身份：改名、移动、重新下载都不会丢标注。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
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
    return parsed;
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

    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '') as DocRecord;
      if (parsed.schemaVersion === 1) records.push(parsed);
    } catch {
      // 损坏的记录直接跳过，不影响其他文档
    }
  }
  return records;
}
