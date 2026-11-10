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
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  await page.evaluate((content) => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('没有文件输入框');
    const data = new DataTransfer();
    data.items.add(new File([content], 'notes.txt', { type: 'text/plain' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  await expect(page.locator('.flow-page').first()).toBeVisible({ timeout: 20_000 });
}

async function highlightFirstLine(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.flow-text');
    if (!root) throw new Error('没有渲染出 TXT 页面');
    const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    if (!node?.textContent) throw new Error('没有文本节点');
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.closest('.flow-page')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('.selection-toolbar .swatch.yellow').click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
}

async function firstAnnotationId(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith('glossnote:doc:')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const record = JSON.parse(raw) as { annotations?: Array<{ id: string; deleted?: boolean }> };
      const annotation = record.annotations?.find((item) => !item.deleted);
      if (annotation) return annotation.id;
    }
    return '';
  });
}

async function noteKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('glossnote:note:')) return key;
    }
    return '';
  });
}

test('笔记：自动保存、刷新复原、页面引用与专注编辑', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  const text = longText();
  await openText(page, text);

  await page.getByRole('tab', { name: '笔记' }).click();
  const textarea = page.locator('.note-textarea');
  await textarea.fill('第一条想法，见 [[page:2]]。');
  await expect(page.locator('.note-status')).toContainText('已保存', { timeout: 5_000 });

  await page.getByRole('button', { name: '专注编辑' }).click();
  await expect(page.getByRole('dialog', { name: '专注编辑笔记' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '专注编辑笔记' })).not.toBeVisible();

  await page.locator('.note-mode button').filter({ hasText: '预览' }).click();
  await expect(page.locator('.note-page-chip')).toBeVisible();
  await page.locator('.note-page-chip').click();
  await page.getByRole('tab', { name: /标注/ }).click();
  await expect(page.locator('.page-jump')).toContainText('2 /');

  await page.reload();
  await openText(page, text);
  await page.getByRole('tab', { name: '笔记' }).click();
  await expect(page.locator('.note-textarea')).toHaveValue('第一条想法，见 [[page:2]]。');

  expect(errors).toEqual([]);
});

test('笔记：标注引用可跳回标注页签', async ({ page }) => {
  await page.goto('/');
  const text = longText();
  await openText(page, text);
  await highlightFirstLine(page);
  const annotationId = await firstAnnotationId(page);
  expect(annotationId).not.toBe('');

  await page.getByRole('tab', { name: '笔记' }).click();
  await page.locator('.note-textarea').fill(`引用 [[annotation:${annotationId}]]。`);
  await expect(page.locator('.note-status')).toContainText('已保存', { timeout: 5_000 });
  await page.locator('.note-mode button').filter({ hasText: '预览' }).click();

  await expect(page.locator('.note-link-chip')).toBeVisible();
  await page.locator('.note-link-chip').click();
  await expect(page.getByRole('tab', { name: /标注/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.annotation-card')).toHaveCount(1);
});

test('笔记：外部修改后保存显示冲突，可重新载入', async ({ page }) => {
  await page.goto('/');
  const text = longText();
  await openText(page, text);
  await page.getByRole('tab', { name: '笔记' }).click();

  const textarea = page.locator('.note-textarea');
  await textarea.fill('本地第一版');
  await expect(page.locator('.note-status')).toContainText('已保存', { timeout: 5_000 });

  const key = await noteKey(page);
  expect(key).not.toBe('');
  await page.evaluate((storageKey) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ text: '外部修改的版本', updatedAt: Date.now(), revision: 'stale' }),
    );
  }, key);

  await textarea.fill('本地第二版');
  await expect(page.locator('.note-conflict')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.note-conflict')).not.toBeVisible();
  await expect(page.locator('.note-textarea')).toHaveValue('外部修改的版本');
});

test('笔记：冲突下改回原文后覆盖保存仍会写盘', async ({ page }) => {
  await page.goto('/');
  const text = longText();
  await openText(page, text);
  await page.getByRole('tab', { name: '笔记' }).click();

  const textarea = page.locator('.note-textarea');
  await textarea.fill('本地第一版');
  await expect(page.locator('.note-status')).toContainText('已保存', { timeout: 5_000 });

  const key = await noteKey(page);
  expect(key).not.toBe('');
  await page.evaluate((storageKey) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ text: '外部修改的版本', updatedAt: Date.now(), revision: 'stale' }),
    );
  }, key);

  await textarea.fill('本地第二版');
  await expect(page.locator('.note-conflict')).toBeVisible({ timeout: 5_000 });
  // 改回与上次保存相同的文本，再点覆盖保存：仍必须把原文写回磁盘/存储。
  await textarea.fill('本地第一版');
  await page.getByRole('button', { name: '覆盖保存' }).click();
  await expect(page.locator('.note-conflict')).not.toBeVisible();
  await expect(page.locator('.note-status')).toContainText('已保存', { timeout: 5_000 });

  const stored = await page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as { text?: string }).text : null;
  }, key);
  expect(stored).toBe('本地第一版');
});
