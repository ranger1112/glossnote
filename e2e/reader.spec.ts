import { test, expect } from '@playwright/test';

/**
 * 浏览器模式的冒烟测试：示例文档 → 划词 → 高亮 → 刷新复原。
 * 它覆盖 React、pdf.js 文本层、锚定与 localStorage 持久化；
 * Rust / Tauri 命令由 cargo 单测覆盖，WebView2 特有问题仍靠手工 CDP。
 */
test('示例文档：划词高亮，刷新后复原', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?sample');
  const firstPage = page.locator('.pdf-page').first();
  await expect(firstPage.locator('.text-layer span').first()).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>('.pdf-page');
    if (!pageElement) throw new Error('没有渲染出页面');

    const spans = [...pageElement.querySelectorAll<HTMLElement>('.text-layer span')].filter(
      (span) => span.textContent?.trim() && span.firstChild,
    );
    const start = spans[1]?.firstChild;
    const end = spans[4]?.firstChild;
    if (!start || !end) throw new Error('文本层没有足够的 span');

    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, Math.min(10, end.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    pageElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  await page.reload();
  await expect(firstPage.locator('.text-layer span').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  expect(errors).toEqual([]);
});
