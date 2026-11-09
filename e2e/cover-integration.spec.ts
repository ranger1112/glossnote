import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function makeEpub(withCover: boolean): Promise<number[]> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
     <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
       <rootfiles>
         <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
       </rootfiles>
     </container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?>
     <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
         <dc:title>封面集成测试</dc:title>
       </metadata>
       <manifest>
         <item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/>
         ${
           withCover
             ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
             : ''
         }
       </manifest>
       <spine><itemref idref="c1"/></spine>
     </package>`,
  );
  zip.file(
    'OEBPS/chapter.xhtml',
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>',
  );
  if (withCover) {
    zip.file('OEBPS/cover.png', Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0)));
  }
  return Array.from(await zip.generateAsync({ type: 'uint8array' }));
}

async function mountEpub(page: import('@playwright/test').Page, withCover: boolean) {
  const epub = await makeEpub(withCover);

  await page.addInitScript(() => {
    const captured: { source: string | null; bytes: number[] | null } = {
      source: null,
      bytes: null,
    };
    (window as unknown as { __coverTest: typeof captured }).__coverTest = captured;

    const document = {
      id: 'epub-1',
      name: 'book.epub',
      kind: 'epub',
      title: '',
      author: '',
      pageCount: 0,
      path: 'D:\\MockLibrary\\books\\book.epub',
      cover: 'D:\\MockLibrary\\thumbnails\\old.jpg',
      coverSource: '',
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
              documents: 1,
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
            return [document];
          case 'list_folders':
          case 'list_smart_collections':
            return [];
          case 'page_index_status':
            return { documents: 1, indexedDocuments: 0, pages: 0, indexedPages: 0 };
          case 'save_cover':
            captured.source = String(args.source);
            captured.bytes = args.bytes as number[];
            return {
              ...document,
              cover: 'D:\\MockLibrary\\thumbnails\\epub-1.jpg',
              coverSource: args.source,
            };
          default:
            return null;
        }
      },
    };
  });

  await page.route('http://asset.localhost/**', async (route) => {
    const body = (globalThis as unknown as { Buffer: { from(value: Uint8Array): string } })
      .Buffer.from(Uint8Array.from(epub));
    await route.fulfill({
      status: 200,
      contentType: 'application/epub+zip',
      body,
    });
  });

  await page.goto('/');
}

test('Library 为旧 EPUB 提取原生封面并写入 cover_source', async ({ page }) => {
  await mountEpub(page, true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __coverTest?: { source: string | null } }).__coverTest
            ?.source,
      ),
    )
    .toBe('native');

  const bytes = await page.evaluate(
    () =>
      (window as unknown as { __coverTest: { bytes: number[] | null } }).__coverTest.bytes,
  );
  expect(bytes?.slice(0, 2)).toEqual([0xff, 0xd8]);
});

test('无原生封面的 EPUB 回退文字封面', async ({ page }) => {
  await mountEpub(page, false);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __coverTest?: { source: string | null } }).__coverTest
            ?.source,
      ),
    )
    .toBe('text');
});
