import { test, expect, type Page } from '@playwright/test';

/** 在示例 PDF 第一页上选中第 from..to 个非空文本 span。 */
async function selectSpans(page: Page, from: number, to: number) {
  await page.evaluate(
    ({ from, to }) => {
      const pageElement = document.querySelector<HTMLElement>('.pdf-page');
      if (!pageElement) throw new Error('没有渲染出页面');

      const spans = [...pageElement.querySelectorAll<HTMLElement>('.text-layer span')].filter(
        (span) => span.textContent?.trim() && span.firstChild,
      );
      const start = spans[from]?.firstChild;
      const end = spans[to]?.firstChild;
      if (!start || !end) throw new Error('文本层没有足够的 span');

      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, Math.min(10, end.textContent?.length ?? 0));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      pageElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { from, to },
  );
}

/**
 * 浏览器模式的冒烟测试：示例文档 → 划词 → 高亮/下划线 → 刷新复原。
 * 它覆盖 React、pdf.js 文本层、锚定与 localStorage 持久化；
 * Rust / Tauri 命令由 cargo 单测覆盖，WebView2 特有问题仍靠手工 CDP。
 */
test('示例文档：划词高亮与下划线，刷新后复原', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?sample');
  const firstPage = page.locator('.pdf-page').first();
  await expect(firstPage.locator('.text-layer span').first()).toBeVisible({ timeout: 30_000 });

  await selectSpans(page, 1, 4);
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  await selectSpans(page, 7, 9);
  await page.locator('.selection-toolbar button', { hasText: '下划线' }).click();
  // 一个选区常跨多行，每行一个矩形；只要第一段画出了线即可。
  const underline = page.locator('.highlight.kind-underline');
  await expect(underline.first()).toBeVisible();
  const line = await underline.first().evaluate((element) => {
    const after = getComputedStyle(element, '::after');
    return {
      height: after.height,
      background: after.backgroundColor,
      mark: getComputedStyle(element).getPropertyValue('--mark-color').trim(),
    };
  });
  expect(line.height).toBe('2px');
  expect(line.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(line.mark).not.toBe('');
  await expect(page.locator('.annotation-card')).toHaveCount(2);

  // 改颜色：卡片上的色点打开色板，线条颜色随之变化。
  const underlineCard = page.locator('.annotation-card').nth(1);
  await underlineCard.locator('button.color-dot').click();
  await underlineCard.locator('.color-menu .swatch.green').click();
  await expect(underlineCard.locator('.color-dot.green')).toBeVisible();
  await expect
    .poll(() =>
      underline.first().evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--mark-color').trim(),
      ),
    )
    .toBe('#1f9d63');

  await page.reload();
  await expect(firstPage.locator('.text-layer span').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.highlight').first()).toBeVisible();
  await expect(page.locator('.highlight.kind-underline').first()).toBeVisible();
  await expect(page.locator('.annotation-card')).toHaveCount(2);
  await expect(page.locator('.annotation-card').nth(1).locator('.color-dot.green')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.highlight.kind-underline').first().evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--mark-color').trim(),
      ),
    )
    .toBe('#1f9d63');

  expect(errors).toEqual([]);
});

test('撤销与重做标注操作', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await selectSpans(page, 1, 4);
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await expect(page.locator('.highlight').first()).toBeVisible();

  // 撤销新增：卡片与页面上的高亮一起消失。
  await page.keyboard.press('Control+z');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(page.locator('.highlight')).toHaveCount(0);

  // 重做：标注回来。
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  // 删除（两段确认）后再撤销，标注与卡片都恢复。
  const card = page.locator('.annotation-card').first();
  await card.locator('button.icon-button').click();
  await card.locator('button.icon-button').click();
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  // 顶栏按钮与 Ctrl+Y 同样可用。
  await page.locator('.history-controls button[aria-label="撤销"]').click();
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await page.locator('.history-controls button[aria-label="重做"]').click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.annotation-card')).toHaveCount(1);

  // 撤销/重做的结果也要落盘。
  await page.reload();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
});

test('已标注文字悬停快捷工具，取消选择后浮动工具收起', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await selectSpans(page, 1, 4);
  await page.locator('.selection-toolbar .swatch.yellow').click();
  const highlight = page.locator('.highlight').first();
  await expect(highlight).toBeVisible();

  // 悬停已有标注：出现换色、批注与删除入口。
  const box = await highlight.boundingBox();
  if (!box) throw new Error('高亮没有布局');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const hover = page.locator('.annotation-toolbar');
  await expect(hover).toBeVisible();
  await expect(hover).toContainText('批注');
  await expect(hover).toContainText('删除');

  // 点击工具条以外的地方立即收起。
  await page.locator('.sidebar-head h2').click();
  await expect(hover).toHaveCount(0);

  // 选区工具同样在取消选择后收起。
  await selectSpans(page, 7, 9);
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(page.locator('.selection-toolbar')).toHaveCount(0);
});

test('侧栏按页分组，并按颜色和类型筛选', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await selectSpans(page, 1, 3);
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await selectSpans(page, 4, 6);
  await page.locator('.selection-toolbar .swatch.blue').click();
  await selectSpans(page, 7, 9);
  await page.locator('.selection-toolbar button', { hasText: '下划线' }).click();
  await expect(page.locator('.annotation-card')).toHaveCount(3);

  // 同一页的标注收在同一个分组里，组头显示页码与数量。
  await expect(page.locator('.annotation-group')).toHaveCount(1);
  const group = page.locator('.annotation-group').first();
  await expect(group.locator('.annotation-group-head')).toContainText('第 1 页');
  await expect(group.locator('.group-count')).toHaveText('3');

  // 颜色筛选。
  await page.locator('.sidebar-filters .filter-dot.yellow').click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await expect(page.locator('.sidebar-head .count')).toHaveText('1 / 3');

  // 颜色与类型叠加时可能没有结果，提示里给出清除入口。
  await page.locator('.filter-kind').selectOption('underline');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(page.locator('.sidebar-hint')).toContainText('没有符合筛选条件');

  // 取消颜色筛选后只剩划线。
  await page.locator('.sidebar-filters .filter-dot.yellow').click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await expect(page.locator('.annotation-kind').first()).toHaveText('下划线');

  // 全部：恢复完整列表。
  await page.locator('.filter-all').click();
  await expect(page.locator('.annotation-card')).toHaveCount(3);
});

test('阅读器快捷键：帮助、翻页与缩放', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press('Shift+/');
  await expect(page.locator('.shortcut-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.shortcut-card')).toHaveCount(0);

  const pageLabel = page.locator('.doc-id');
  await expect(pageLabel).toContainText('第 1 /');
  await page.keyboard.press('End');
  await expect(pageLabel).toContainText('第 2 /');
  await page.keyboard.press('Home');
  await expect(pageLabel).toContainText('第 1 /');

  const viewer = page.locator('.viewer');
  const before = await viewer.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageDown');
  await expect
    .poll(() => viewer.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);

  const zoom = page.locator('.zoom-controls > span').first();
  const original = (await zoom.textContent()) ?? '';
  await page.keyboard.press('Control+=');
  await expect(zoom).not.toHaveText(original);
  await page.keyboard.press('Control+0');
  await expect(zoom).toHaveText(original);
});

test('设置面板：主题切换、快捷键列表与关闭', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '设置' }).click();
  const modal = page.locator('.settings-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('外观');
  await expect(modal).toContainText('快捷键');
  await expect(modal).toContainText('关于');
  await expect(modal.locator('.shortcut-list > div')).toHaveCount(10);

  // 浏览器模式没有书库命令，相关的设置节不出现。
  await expect(modal).not.toContainText('书库位置');

  await modal.locator('.theme-choice button', { hasText: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await modal.locator('.theme-choice button', { hasText: '浅色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // 标题栏和底部按钮固定，只有中间内容滚动。
  const head = modal.locator('.settings-head');
  const before = await head.boundingBox();
  await modal.locator('.settings-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const after = await head.boundingBox();
  expect(after?.y).toBe(before?.y);
  await expect(modal.getByRole('button', { name: '完成' })).toBeVisible();

  await modal.getByRole('button', { name: '完成' }).click();
  await expect(modal).toHaveCount(0);
});

test('页内查找：Ctrl+F 搜索并定位命中', async ({ page }) => {
  await page.goto('/?sample');
  await expect(
    page.locator('.pdf-page').first().locator('.text-layer span').first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press('Control+f');
  const input = page.locator('.find-bar input');
  await expect(input).toBeVisible();
  await input.fill('Anchoring');

  await expect(page.locator('.find-count')).toContainText('/', { timeout: 20_000 });
  await expect(page.locator('.search-hit').first()).toBeVisible();

  const firstCount = (await page.locator('.find-count').textContent()) ?? '';
  await page.locator('.find-bar button[title="下一个"]').click();
  await expect(page.locator('.find-count')).not.toHaveText(firstCount);

  await page.keyboard.press('Escape');
  await expect(page.locator('.find-bar')).toHaveCount(0);
});
