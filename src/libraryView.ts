import type { DocumentMeta, LibrarySort, SmartCollection } from './types';

export interface LibraryFilters {
  favorite: boolean;
  /** null 表示不限标签。 */
  tag: string | null;
  /** null 表示全部文件夹；空字符串表示「未分类」。 */
  folder: string | null;
}

export function matchesFilters(doc: DocumentMeta, filters: LibraryFilters): boolean {
  if (filters.favorite && !doc.favorite) return false;
  if (filters.tag && !doc.tags.includes(filters.tag)) return false;
  if (filters.folder !== null && doc.folder !== filters.folder) return false;
  return true;
}

export function matchesCollection(doc: DocumentMeta, collection: SmartCollection): boolean {
  return matchesFilters(doc, {
    favorite: collection.favorite,
    tag: collection.tag || null,
    folder: collection.folder,
  });
}

export function sortDocuments(docs: DocumentMeta[], sort: LibrarySort): DocumentMeta[] {
  return [...docs].sort((left, right) => {
    switch (sort) {
      case 'title':
        return (left.title || left.name).localeCompare(right.title || right.name, 'zh');
      case 'added':
        return right.addedAt - left.addedAt;
      case 'annotations':
        return right.annotationCount - left.annotationCount || right.addedAt - left.addedAt;
      case 'manual':
        return left.position - right.position || right.addedAt - left.addedAt;
      default:
        // 没读过的排在读过的后面，同组内再按添加时间。
        return (
          (right.lastOpenedAt || 0) - (left.lastOpenedAt || 0) ||
          right.addedAt - left.addedAt
        );
    }
  });
}

/** 设置里的文件夹与文档实际归属的并集；空文件夹也要显示。 */
export function folderNames(docs: DocumentMeta[], saved: string[]): string[] {
  const names = new Set(saved.filter(Boolean));
  for (const doc of docs) {
    if (doc.folder) names.add(doc.folder);
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'zh'));
}

/**
 * 把拖动的一组文档放到目标文档之前；目标为空时放到末尾。
 * 返回全部文档的新顺序，隐藏的文档保持原有相对顺序。
 */
export function reorderDocuments(
  docs: DocumentMeta[],
  movingIds: string[],
  targetId: string | null,
): string[] {
  const ordered = sortDocuments(docs, 'manual').map((doc) => doc.id);
  const moving = new Set(movingIds.filter((id) => id !== targetId));
  if (moving.size === 0) return ordered;

  const rest = ordered.filter((id) => !moving.has(id));
  const moved = ordered.filter((id) => moving.has(id));
  const targetIndex = targetId ? rest.indexOf(targetId) : rest.length;
  const insertAt = targetIndex < 0 ? rest.length : targetIndex;
  return [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
}
