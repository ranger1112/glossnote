import { test, expect } from '@playwright/test';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/**
 * 书库只在 Tauri 桌面端显示。这里模拟文件对话框与 asset 协议，
 * 验证「导入本地 HTML → 勾选冻结 → import_html_snapshot」这条完整链路。
 */
test('本地 HTML 导入：弹窗勾选冻结后生成自包含快照', async ({ page }) => {
  await page.addInitScript(() => {
    const captured = {
      snapshot: null as null | {
        name: string;
        html: string;
        title: string;
        author: string;
        sourceUrl: string;
      },
      importedDocuments: 0,
      directImports: 0,
    };
    (window as unknown as { __localHtmlTest: typeof captured }).__localHtmlTest = captured;

    const document = {
      id: 'snap-1',
      name: '本地文章.html',
      kind: 'html',
      title: '本地文章',
      author: '',
      pageCount: 1,
      path: 'D:\\MockLibrary\\books\\本地文章.html',
      cover: '',
      size: 100,
      addedAt: 1,
      lastOpenedAt: 1,
      lastPage: 0,
      favorite: false,
      tags: [] as string[],
      bookmarks: [] as unknown[],
      folder: '',
      position: 0,
      sourcePath: '',
      sourceUrl: '',
      annotationCount: 0,
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
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
              documents: captured.importedDocuments,
              annotations: 0,
              merged: 0,
              archived: 0,
              duplicatePdfs: 0,
              missingDocuments: 0,
              ignoredSidecars: 0,
              mergedCards: 0,
              scannedAt: Date.now(),
            };
          case 'list_documents':
            return captured.importedDocuments > 0 ? [document] : [];
          case 'list_folders':
          case 'list_smart_collections':
            return [];
          case 'page_index_status':
            return { documents: 0, indexedDocuments: 0, pages: 0, indexedPages: 0 };
          case 'plugin:dialog|open':
            return 'D:\\articles\\post.html';
          case 'import_html_snapshot': {
            captured.snapshot = args.input as typeof captured.snapshot;
            captured.importedDocuments = 1;
            return { document, annotations: [] };
          }
          case 'import_document': {
            captured.directImports += 1;
            return {
              document: {
                ...document,
                id: 'direct-1',
                name: 'post.html',
                sourcePath: 'D:\\articles\\post.html',
              },
              annotations: [],
            };
          }
          case 'save_cover':
            return { ...document, cover: 'D:\\MockLibrary\\thumbnails\\snap-1.jpg' };
          case 'open_document':
            return { document, annotations: [] };
          case 'read_document_text':
            return '<html><body><p>打开后的正文</p></body></html>';
          case 'update_document_meta':
            return document;
          case 'document_index_status':
            return true;
          case 'list_cards':
            return [];
          case 'save_page_texts':
            return 1;
          default:
            return null;
        }
      },
    };
  });

  await page.route('http://asset.localhost/**', async (route) => {
    const url = decodeURIComponent(new URL(route.request().url()).pathname);
    if (url.includes('post.html')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><title>本地文章</title></head><body>
          <article>
            <h1>一篇本地文章</h1>
            ${'<p>本地正文内容，用来让 Readability 认为这是一篇文章。</p>'.repeat(20)}
            <p><img src="images/pic.png" alt="本地图片"></p>
            <p><img src="missing.png" alt="缺失图片"></p>
            <p><img src="https://cdn.example/remote.png" alt="远程图片"></p>
          </article>
        </body></html>`,
      });
      return;
    }
    if (url.includes('pic.png')) {
      const bytes = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
      // tsconfig 不引入 Node 类型；运行时全局 Buffer 仍然存在。
      const body = (
        globalThis as unknown as { Buffer: { from(value: Uint8Array): string } }
      ).Buffer.from(bytes);
      await route.fulfill({ status: 200, contentType: 'image/png', body });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '导入文档' }).first().click();

  await expect(page.getByRole('dialog', { name: '导入本地 HTML' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: '冻结并导入' }).click();

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __localHtmlTest?: { snapshot: { html: string } | null } })
            .__localHtmlTest?.snapshot?.html ?? '',
      ),
    )
    .toContain('data:image/png;base64,');

  const captured = await page.evaluate(
    () =>
      (window as unknown as { __localHtmlTest: { snapshot: Record<string, string> } })
        .__localHtmlTest.snapshot,
  );
  expect(captured.name).toBe('post');
  expect(captured.title).toBe('本地文章');
  expect(captured.sourceUrl).toBe('');
  expect(captured.html).not.toContain('asset.localhost');
  expect(captured.html).not.toContain('https://cdn.example');
  expect(captured.html).not.toContain('missing.png');

  // 不勾选时保持原有 import_document 路径。
  await page.getByRole('button', { name: '书库' }).click();
  await page.getByRole('button', { name: '导入文档' }).first().click();
  await expect(page.getByRole('dialog', { name: '导入本地 HTML' })).toBeVisible();
  await page.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: '直接导入' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __localHtmlTest: { directImports: number } })
            .__localHtmlTest.directImports,
      ),
    )
    .toBe(1);
});
