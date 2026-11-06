import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { activeOutlineEntry, loadOutline, type OutlineEntry } from './outline';

function fakePdf(overrides: Record<string, unknown>): PDFDocumentProxy {
  return overrides as unknown as PDFDocumentProxy;
}

describe('loadOutline', () => {
  it('walks nested items and resolves named destinations', async () => {
    const pdf = fakePdf({
      getOutline: async () => [
        {
          title: '第一章',
          dest: 'chapter-1',
          items: [
            {
              title: '第一节',
              dest: [{ num: 9, gen: 0 }, { name: 'XYZ' }],
              items: [],
            },
          ],
        },
        { title: '外部链接', dest: null, url: 'https://example.com', items: [] },
      ],
      getDestination: async (name: string) =>
        name === 'chapter-1' ? [1, { name: 'Fit' }] : null,
      getPageIndex: async () => 4,
    });

    const entries = await loadOutline(pdf);
    expect(entries).toEqual([
      { id: 'outline-0', title: '第一章', page: 1, depth: 0 },
      { id: 'outline-1', title: '第一节', page: 4, depth: 1 },
    ]);
  });

  it('falls back to action.dest when dest is null', async () => {
    const pdf = fakePdf({
      getOutline: async () => [
        {
          title: '动作章节',
          dest: null,
          action: { dest: [7, { name: 'XYZ' }] },
          items: [],
        },
      ],
      getDestination: async () => null,
      getPageIndex: async () => 7,
    });

    const entries = await loadOutline(pdf);
    expect(entries).toHaveLength(1);
    expect(entries[0].page).toBe(7);
  });

  it('returns an empty list when the PDF has no outline', async () => {
    const pdf = fakePdf({ getOutline: async () => null });
    await expect(loadOutline(pdf)).resolves.toEqual([]);
  });
});

describe('activeOutlineEntry', () => {
  const outline: OutlineEntry[] = [
    { id: 'a', title: '第一章', page: 1, depth: 0 },
    { id: 'b', title: '第一节', page: 4, depth: 1 },
    { id: 'c', title: '第二节', page: 4, depth: 1 },
    { id: 'd', title: '第二章', page: 12, depth: 0 },
  ];

  it('picks the latest entry at or before the current page', () => {
    expect(activeOutlineEntry(outline, 0)).toBeNull();
    expect(activeOutlineEntry(outline, 1)?.id).toBe('a');
    expect(activeOutlineEntry(outline, 6)?.id).toBe('c');
    expect(activeOutlineEntry(outline, 12)?.id).toBe('d');
    expect(activeOutlineEntry(outline, 99)?.id).toBe('d');
  });

  it('tolerates entries that are not sorted by page', () => {
    const unsorted: OutlineEntry[] = [
      { id: 'later', title: '后一节', page: 8, depth: 1 },
      { id: 'earlier', title: '前一节', page: 3, depth: 1 },
    ];
    expect(activeOutlineEntry(unsorted, 5)?.id).toBe('earlier');
    expect(activeOutlineEntry(unsorted, 8)?.id).toBe('later');
  });
});
