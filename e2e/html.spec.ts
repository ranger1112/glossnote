import { test, expect, type Page } from '@playwright/test';

const ARTICLE = `<!doctype html>
<html>
  <head><title>本地文章</title></head>
  <body>
    <nav>站点导航不应进入正文</nav>
    <article>
      <h2>第一章 阅读</h2>
      <p>阅读不是把文字搬进脑子，而是把问题带回自己的生活。</p>
      <script>window.__pwned = true;</script>
      <p onclick="window.__pwned = true">带事件属性的段落也应该被清理。</p>
      <img src="https://example.com/remote.png" alt="远程图片" />
      <h3>第一节 锚定</h3>
      <p>Anchoring is the heart of annotation.</p>
      <p>第二段用来验证划词高亮与刷新后的重放。</p>
    </article>
  </body>
</html>`;

async function openHtml(page: Page) {
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  await page.evaluate((content) => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('没有文件输入框');
    const data = new DataTransfer();
    data.items.add(new File([content], 'article.html', { type: 'text/html' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, ARTICLE);
  await expect(page.locator('.flow-page').first()).toBeVisible({ timeout: 20_000 });
}

async function selectParagraph(page: Page, index: number, from: number, to: number) {
  await page.evaluate(
    ({ index, from, to }) => {
      const paragraph = document.querySelectorAll<HTMLElement>('.flow-html p')[index];
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
    { index, from, to },
  );
}

test('HTML：正文提取、清理脚本、目录与划词高亮', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await openHtml(page);

  // Readability 提取正文，导航被丢掉；脚本与事件属性不进入 DOM。
  await expect(page.locator('.flow-html h2').first()).toHaveText('第一章 阅读');
  await expect(page.locator('.flow-html')).not.toContainText('站点导航');
  await expect(page.locator('.flow-html [onclick]')).toHaveCount(0);
  await expect(page.locator('.flow-html img[src^="http"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();

  // 标题进入目录，点击可以跳转。
  await page.getByRole('tab', { name: '目录' }).click();
  await expect(page.locator('.outline-row')).toHaveCount(2);
  await expect(page.locator('.outline-row').first()).toContainText('第一章 阅读');
  await page.getByRole('tab', { name: '标注' }).click();

  await selectParagraph(page, 0, 0, 10);
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.highlight').first()).toBeVisible();

  // 刷新后重新打开同一份 HTML，标注仍在。
  await page.reload();
  await openHtml(page);
  await expect(page.locator('.highlight').first()).toBeVisible();
  expect(errors).toEqual([]);
});
