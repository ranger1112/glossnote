import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function makeEpub(): Promise<number[]> {
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
         <dc:title>测试书</dc:title>
         <dc:creator>测试作者</dc:creator>
       </metadata>
       <manifest>
         <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
         <item id="pic" href="pic.png" media-type="image/png"/>
       </manifest>
       <spine>
         <itemref idref="c1"/>
         <itemref idref="c2"/>
       </spine>
     </package>`,
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>
       <h2>第一章 起点</h2>
       <p>EPUB 的第一段正文，用来验证划词高亮与刷新后的重放。</p>
       <script>window.__pwned = true;</script>
       <p><img src="pic.png" alt="图片" />图片也应该从 zip 内联出来。</p>
     </body></html>`,
  );
  zip.file(
    'OEBPS/chapter2.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>
       <h2>第二章 继续</h2>
       <p>第二章的正文，目录应该能跳到这里。</p>
     </body></html>`,
  );
  zip.file('OEBPS/pic.png', Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0)));

  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return Array.from(bytes);
}

async function openEpub(page: Page, bytes: number[]) {
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  await page.evaluate((data) => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('没有文件输入框');
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], 'book.epub', { type: 'application/epub+zip' }),
    );
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, bytes);
  await expect(page.locator('.flow-page').first()).toBeVisible({ timeout: 20_000 });
}

async function selectFirstParagraph(page: Page, from: number, to: number) {
  await page.evaluate(
    ({ from, to }) => {
      const paragraph = document.querySelector<HTMLElement>('.flow-html p');
      const node = paragraph?.firstChild;
      if (!node || !node.textContent) throw new Error('没有可选择的段落');

      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, Math.min(to, node.textContent.length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      paragraph.closest('.flow-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { from, to },
  );
}

test('EPUB：spine 分章、图片内联、目录与划词高亮', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  const bytes = await makeEpub();
  await openEpub(page, bytes);

  await expect(page.locator('.flow-page')).toHaveCount(2);
  await expect(page.locator('.flow-html h2').first()).toHaveText('第一章 起点');
  await expect(page.locator('.flow-html img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();

  // 两章标题进入目录，第二项可以跳转。
  await page.getByRole('tab', { name: '目录' }).click();
  await expect(page.locator('.outline-row')).toHaveCount(2);
  await page.locator('.outline-row').nth(1).click();
  await expect(page.locator('.page-jump')).toHaveText('2 / 2');
  await page.getByRole('tab', { name: '标注' }).click();

  await selectFirstParagraph(page, 0, 8);
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  await page.locator('.selection-toolbar .swatch.green').click();
  await expect(page.locator('.highlight').first()).toBeVisible();

  // EPUB 标注应额外写入章节内定位符。
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((item) =>
          item.startsWith('glossnote:doc:'),
        );
        if (!key) return false;
        const record = JSON.parse(localStorage.getItem(key) ?? 'null') as {
          annotations?: Array<{ anchor?: { locator?: { kind?: string; path?: number[] } } }>;
        };
        const locator = record?.annotations?.[0]?.anchor?.locator;
        return Boolean(locator?.kind === 'epub' && (locator.path?.length ?? 0) > 0);
      }),
    )
    .toBe(true);

  // 刷新后重新打开同一份 EPUB，标注仍在。
  await page.reload();
  await openEpub(page, bytes);
  await expect(page.locator('.highlight').first()).toBeVisible();
  expect(errors).toEqual([]);
});
