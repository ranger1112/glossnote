import { test, expect, type Page } from '@playwright/test';

function longText() {
  const paragraphs: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    paragraphs.push(
      `第 ${index + 1} 段：阅读不是把文字搬进脑子，而是把问题带回自己的生活。Anchoring is the heart of annotation.`,
    );
  }
  return paragraphs.join('\n\n');
}

async function openText(page: Page, text: string) {
  // 在页面里构造 File 并触发 change，避免依赖 Node 的 Buffer 类型。
  await page.evaluate((content) => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('没有文件输入框');
    const data = new DataTransfer();
    data.items.add(new File([content], 'sample.txt', { type: 'text/plain' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  await expect(page.locator('.flow-page').first()).toBeVisible({ timeout: 20_000 });
}

async function selectText(page: Page, from: number, to: number) {
  await page.evaluate(
    ({ from, to }) => {
      const root = document.querySelector<HTMLElement>('.flow-text');
      if (!root) throw new Error('没有渲染出 TXT 页面');
      const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
      if (!node || !node.textContent) throw new Error('没有文本节点');

      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, Math.min(to, node.textContent.length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.closest('.flow-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { from, to },
  );
}

test('TXT：分页阅读、划词高亮、页内查找与刷新复原', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  const text = longText();
  await openText(page, text);

  // 长文本按页切分，页码跳转按分页单位走。
  const pages = await page.locator('.flow-page').count();
  expect(pages).toBeGreaterThan(1);
  await expect(page.locator('.page-jump')).toHaveText(`1 / ${pages}`);

  await selectText(page, 0, 12);
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  await page.keyboard.press('Control+f');
  await page.locator('.find-bar input').fill('Anchoring');
  await expect(page.locator('.find-count')).toContainText('/', { timeout: 20_000 });
  await expect(page.locator('.search-hit').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // 刷新后重新打开同一份 TXT，标注仍在。
  await page.reload();
  await openText(page, text);
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  expect(errors).toEqual([]);
});
