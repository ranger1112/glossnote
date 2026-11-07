import { describe, expect, it } from 'vitest';
import type { DocumentMeta } from './types';
import {
  folderNames,
  matchesCollection,
  matchesFilters,
  reorderDocuments,
  sortDocuments,
} from './libraryView';

function doc(id: string, patch: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id,
    name: `${id}.pdf`,
    kind: 'pdf',
    title: '',
    author: '',
    pageCount: 1,
    path: `books/${id}.pdf`,
    cover: '',
    size: 1,
    addedAt: 1,
    lastOpenedAt: 0,
    lastPage: 0,
    favorite: false,
    tags: [],
    bookmarks: [],
    folder: '',
    position: 0,
    sourcePath: '',
    annotationCount: 0,
    ...patch,
  };
}

describe('matchesFilters', () => {
  it('组合收藏、标签和文件夹条件', () => {
    const filters = { favorite: true, tag: '论文', folder: '研究' };
    expect(
      matchesFilters(doc('a', { favorite: true, tags: ['论文'], folder: '研究' }), filters),
    ).toBe(true);
    expect(
      matchesFilters(doc('b', { favorite: false, tags: ['论文'], folder: '研究' }), filters),
    ).toBe(false);
    expect(
      matchesFilters(doc('c', { favorite: true, tags: ['其他'], folder: '研究' }), filters),
    ).toBe(false);
    expect(
      matchesFilters(doc('d', { favorite: true, tags: ['论文'], folder: '' }), filters),
    ).toBe(false);
  });

  it('空字符串文件夹筛选只匹配未分类文档', () => {
    expect(matchesFilters(doc('a', { folder: '' }), { favorite: false, tag: null, folder: '' })).toBe(
      true,
    );
    expect(
      matchesFilters(doc('b', { folder: '研究' }), { favorite: false, tag: null, folder: '' }),
    ).toBe(false);
    expect(
      matchesFilters(doc('c', { folder: '研究' }), { favorite: false, tag: null, folder: null }),
    ).toBe(true);
  });
});

describe('matchesCollection', () => {
  it('按收藏夹保存的条件动态匹配', () => {
    const collection = {
      id: 's1',
      name: '收藏的论文',
      favorite: true,
      tag: '论文',
      folder: '研究',
      sort: 'recent' as const,
    };
    expect(
      matchesCollection(doc('a', { favorite: true, tags: ['论文'], folder: '研究' }), collection),
    ).toBe(true);
    expect(matchesCollection(doc('b', { favorite: true, tags: ['论文'] }), collection)).toBe(false);
  });
});

describe('sortDocuments', () => {
  it('手动排序按位置，位置相同再按添加时间倒序', () => {
    const docs = [
      doc('a', { position: 2, addedAt: 10 }),
      doc('b', { position: 1, addedAt: 10 }),
      doc('c', { position: 1, addedAt: 20 }),
    ];
    expect(sortDocuments(docs, 'manual').map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('folderNames', () => {
  it('合并设置里的空文件夹与文档实际归属并排序', () => {
    const names = folderNames([doc('a', { folder: '资料' }), doc('b', { folder: '' })], [
      '研究',
      '资料',
    ]);
    expect(names).toEqual(['研究', '资料']);
  });
});

describe('reorderDocuments', () => {
  it('把拖动的一组文档放到目标之前，其他文档保持相对顺序', () => {
    const docs = [
      doc('a', { position: 0 }),
      doc('b', { position: 1 }),
      doc('c', { position: 2 }),
      doc('d', { position: 3 }),
    ];
    expect(reorderDocuments(docs, ['d'], 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderDocuments(docs, ['a', 'c'], 'd')).toEqual(['b', 'a', 'c', 'd']);
    expect(reorderDocuments(docs, ['a'], null)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('拖到自身或没有拖动内容时不改变顺序', () => {
    const docs = [doc('a', { position: 0 }), doc('b', { position: 1 })];
    expect(reorderDocuments(docs, ['a'], 'a')).toEqual(['a', 'b']);
    expect(reorderDocuments(docs, [], 'b')).toEqual(['a', 'b']);
  });
});
