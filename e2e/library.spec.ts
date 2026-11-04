import { test, expect, type Page } from '@playwright/test';

/**
 * 书库只出现在 Tauri 桌面端。这里在页面脚本执行前注入一个内存版的
 * __TAURI_INTERNALS__，把书库命令换成一组可断言的假数据，
 * 用来覆盖侧栏、拖拽归类、批量删除与智能收藏夹。
 */
interface MockDoc {
  id: string;
  name: string;
  title: string;
  folder: string;
  favorite: boolean;
  tags: string[];
  position: number;
}

async function mockLibrary(page: Page) {
  await page.addInitScript(() => {
    const docs = [
      {
        id: 'doc-a',
        name: 'deep-work.pdf',
        title: '深度工作',
        author: '',
        pageCount: 120,
        path: 'D:\\MockLibrary\\books\\deep-work.pdf',
        cover: 'D:\\MockLibrary\\.glossnote\\thumbnails\\a.jpg',
        size: 100,
        addedAt: 30,
        lastOpenedAt: 30,
        lastPage: 0,
        favorite: false,
        tags: ['论文'],
        bookmarks: [],
        folder: '',
        position: 3,
        annotationCount: 2,
      },
      {
        id: 'doc-b',
        name: 'design.pdf',
        title: '设计心理学',
        author: '',
        pageCount: 200,
        path: 'D:\\MockLibrary\\books\\design.pdf',
        cover: 'D:\\MockLibrary\\.glossnote\\thumbnails\\b.jpg',
        size: 100,
        addedAt: 20,
        lastOpenedAt: 20,
        lastPage: 0,
        favorite: false,
        tags: [],
        bookmarks: [],
        folder: '',
        position: 2,
        annotationCount: 0,
      },
      {
        id: 'doc-c',
        name: 'papers.pdf',
        title: '论文合集',
        author: '',
        pageCount: 80,
        path: 'D:\\MockLibrary\\books\\papers.pdf',
        cover: 'D:\\MockLibrary\\.glossnote\\thumbnails\\c.jpg',
        size: 100,
        addedAt: 10,
        lastOpenedAt: 10,
        lastPage: 0,
        favorite: false,
        tags: ['论文'],
        bookmarks: [],
        folder: '',
        position: 1,
        annotationCount: 1,
      },
    ];
    const state = {
      docs,
      folders: [] as string[],
      collections: [] as unknown[],
      lastError: null as string | null,
    };
    (window as unknown as { __mockLibrary: typeof state }).__mockLibrary = state;

    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

    const organize = (args: {
      docIds: string[];
      favorite?: boolean;
      folder?: string;
      addTags?: string[];
      removeTags?: string[];
    }) => {
      const ids = new Set(args.docIds);
      state.docs = state.docs.map((doc) => {
        if (!ids.has(doc.id)) return doc;
        const tags = new Set(doc.tags);
        for (const tag of args.removeTags ?? []) tags.delete(tag);
        for (const tag of args.addTags ?? []) tags.add(tag);
        return {
          ...doc,
          favorite: args.favorite ?? doc.favorite,
          folder: args.folder ?? doc.folder,
          tags: [...tags],
        };
      });
      return copy(state.docs.filter((doc) => ids.has(doc.id)));
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => path,
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        switch (cmd) {
          case 'startup_notice':
            return null;
          case 'ai_settings':
            return {
              enabled: false,
              provider: 'anthropic',
              model: '',
              baseUrl: '',
              apiKeySet: false,
              ready: false,
            };
          case 'scan_library':
            return {
              root: 'D:\\MockLibrary',
              documents: state.docs.length,
              annotations: 3,
              merged: 0,
              archived: 0,
              duplicatePdfs: 0,
              missingDocuments: 0,
              ignoredSidecars: 0,
              mergedCards: 0,
              scannedAt: Date.now(),
            };
          case 'list_documents':
            return copy(state.docs);
          case 'list_folders':
            return copy(state.folders);
          case 'save_folders':
            state.folders = copy(args.folders as string[]);
            return copy(state.folders);
          case 'list_smart_collections':
            return copy(state.collections);
          case 'search_annotations': {
            const query = String(args.query ?? '');
            if (!query.includes('标注')) return [];
            return [
              {
                annotationId: 'ann-1',
                docId: 'doc-a',
                docName: '深度工作',
                page: 0,
                quote: '标注的价值不在数量',
                body: '',
                color: 'yellow',
                tags: ['论文'],
              },
            ];
          }
          case 'search_pages': {
            const query = String(args.query ?? '');
            if (!query.includes('认知')) return [];
            return [
              {
                docId: 'doc-a',
                docName: '深度工作',
                page: 0,
                snippet: '…认知科学是研究心智的科学…',
              },
            ];
          }
          case 'page_index_status':
            return {
              documents: state.docs.length,
              indexedDocuments: 1,
              pages: 400,
              indexedPages: 120,
            };
          case 'load_page_texts':
            return [];
          case 'save_page_texts':
            return (args.pages as unknown[]).length;
          case 'list_sidecar_versions':
            return [];
          case 'save_bookmarks': {
            const doc = state.docs.find((item) => item.id === args.docId);
            if (doc) {
              (doc as unknown as { bookmarks: unknown[] }).bookmarks = copy(
                args.bookmarks as unknown[],
              );
            }
            return copy(doc);
          }
          case 'save_smart_collections':
            state.collections = copy(args.collections as unknown[]);
            return copy(state.collections);
          case 'organize_documents':
            return organize(
              args as unknown as Parameters<typeof organize>[0],
            );
          case 'organize_document': {
            const updated = organize({
              docIds: [args.docId as string],
              favorite: args.favorite as boolean | undefined,
              folder: args.folder as string | undefined,
            });
            return updated[0];
          }
          case 'delete_documents': {
            const ids = args.docIds as string[];
            state.docs = state.docs.filter((doc) => !ids.includes(doc.id));
            return {
              removed: ids.length,
              trashedFiles: ids.length * 2,
              missingFiles: 0,
              failed: [],
            };
          }
          case 'reorder_documents': {
            const order = args.docIds as string[];
            state.docs = state.docs.map((doc) => ({
              ...doc,
              position: order.indexOf(doc.id),
            }));
            return copy(state.docs);
          }
          case 'save_cover':
          case 'update_document_meta': {
            const doc = state.docs.find((item) => item.id === args.docId);
            return copy(doc);
          }
          default:
            return null;
        }
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockLibrary(page);
});

test('书库：新建文件夹并把文档拖进去', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '书库' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.library-item')).toHaveCount(3);

  await page.getByRole('button', { name: '新建文件夹' }).click();
  await page.getByRole('textbox', { name: '新文件夹名' }).fill('研究');
  await page.getByRole('button', { name: '添加' }).click();
  const folderRow = page.locator('.side-folder-row').filter({ hasText: '研究' });
  await expect(folderRow).toBeVisible();

  await page.locator('.library-item').first().dragTo(folderRow);
  await expect(folderRow.locator('.side-count')).toHaveText('1');

  const state = await page.evaluate(
    () => (window as unknown as { __mockLibrary: { docs: MockDoc[]; folders: string[] } }).__mockLibrary,
  );
  expect(state.folders).toEqual(['研究']);
  expect(state.docs.filter((doc) => doc.folder === '研究')).toHaveLength(1);
});

test('书库：多选删除先确认，再移出书库', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.library-item')).toHaveCount(3);

  await page.locator('.library-item').first().hover();
  await page.locator('.library-item').first().locator('.card-select').click();
  await expect(page.getByText('已选 1 份')).toBeVisible();

  await page.getByRole('button', { name: /删除/ }).click();
  await expect(page.getByRole('dialog', { name: /删除 1 份文档/ })).toBeVisible();
  await page.getByRole('button', { name: '移到回收站' }).click();

  await expect(page.locator('.library-item')).toHaveCount(2);
  const state = await page.evaluate(
    () => (window as unknown as { __mockLibrary: { docs: MockDoc[] } }).__mockLibrary,
  );
  expect(state.docs).toHaveLength(2);
});

test('书库：手动排序拖动卡片并持久化位置', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.library-item')).toHaveCount(3);
  await page.getByLabel('排序方式').selectOption('manual');

  const cards = page.locator('.library-item');
  await expect(cards.nth(0)).toContainText('论文合集');
  await expect(cards.nth(2)).toContainText('深度工作');

  await cards.nth(2).dragTo(cards.nth(0));
  await expect(cards.nth(0)).toContainText('深度工作');
  await expect(cards.nth(1)).toContainText('论文合集');

  const positions = await page.evaluate(
    () =>
      (window as unknown as { __mockLibrary: { docs: MockDoc[] } }).__mockLibrary.docs
        .slice()
        .sort((left, right) => left.position - right.position)
        .map((doc) => doc.id),
  );
  expect(positions).toEqual(['doc-a', 'doc-c', 'doc-b']);
});

test('书库：正文与标注搜索结果分组显示', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.library-item')).toHaveCount(3);

  const search = page.getByLabel('搜索标注、批注、标签');
  await search.fill('认知');
  await expect(page.getByText('正文 · 1 条')).toBeVisible();
  await expect(page.getByText('认知科学是研究心智的科学')).toBeVisible();

  await search.fill('标注');
  await expect(page.getByText('标注 · 1 条')).toBeVisible();
  await expect(page.getByText('标注的价值不在数量')).toBeVisible();
});

test('书库：保存并应用智能收藏夹', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.library-item')).toHaveCount(3);

  const firstCard = page.locator('.library-item').first();
  await firstCard.hover();
  await firstCard.locator('.card-star').click();

  // 收藏夹保存的是「筛选条件」，所以先打开收藏筛选。
  const favoriteChip = page.locator('.library-filters .chip').filter({ hasText: '收藏' });
  await favoriteChip.click();
  await expect(page.locator('.library-item')).toHaveCount(1);
  await page.getByRole('button', { name: '保存当前筛选' }).click();
  await page.getByRole('textbox', { name: '收藏夹名' }).fill('收藏夹');
  await page.getByRole('button', { name: '保存' }).click();

  const smartRow = page.locator('.side-smart-row').filter({ hasText: '收藏夹' });
  await expect(smartRow).toBeVisible();
  await expect(smartRow.locator('.side-count')).toHaveText('1');

  // 先关掉筛选，再点收藏夹，确认它确实按保存的条件匹配。
  await favoriteChip.click();
  await expect(page.locator('.library-item')).toHaveCount(3);
  await smartRow.locator('.side-row').click();
  await expect(page.locator('.library-item')).toHaveCount(1);
  await expect(favoriteChip).toHaveClass(/active/);
});
