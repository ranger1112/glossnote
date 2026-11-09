import { test, expect, type Page } from '@playwright/test';

interface McpMockState {
  enabled: boolean;
  port: number;
  exposeText: boolean;
  resetCount: number;
  copied: string;
}

async function mockMcp(page: Page) {
  await page.addInitScript(() => {
    const state: McpMockState = {
      enabled: false,
      port: 8765,
      exposeText: false,
      resetCount: 0,
      copied: '',
    };
    (window as unknown as { __mcpMock: McpMockState }).__mcpMock = state;

    const view = () => {
      const token = state.resetCount === 0 ? 'a'.repeat(64) : 'b'.repeat(64);
      const url = state.enabled
        ? `http://127.0.0.1:${state.port}/mcp/${token}`
        : '';
      return {
        enabled: state.enabled,
        port: state.port,
        exposeText: state.exposeText,
        running: state.enabled,
        actualPort: state.enabled ? state.port : null,
        error: null,
        url,
        configJson: url
          ? JSON.stringify({ mcpServers: { glossnote: { url } } })
          : '',
        tokenSet: true,
      };
    };

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          state.copied = text;
        },
      },
    });

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
              documents: 0,
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
          case 'list_folders':
          case 'list_smart_collections':
          case 'load_page_texts':
            return [];
          case 'page_index_status':
            return {
              documents: 0,
              indexedDocuments: 0,
              pages: 0,
              indexedPages: 0,
            };
          case 'search_annotations':
          case 'search_pages':
          case 'search_notes':
            return [];
          case 'mcp_status':
            return view();
          case 'mcp_set_enabled':
            state.enabled = Boolean(args.enabled);
            return view();
          case 'mcp_set_port':
            state.port = Number(args.port);
            return view();
          case 'mcp_set_expose_text':
            state.exposeText = Boolean(args.exposeText);
            return view();
          case 'mcp_reset_token':
            state.resetCount += 1;
            return view();
          default:
            return null;
        }
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockMcp(page);
});

test('MCP 设置：开启、改端口、正文开关与复制配置', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '书库', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '设置' }).click();

  await expect(page.getByText('MCP 接入')).toBeVisible();
  const switches = page.locator('.mcp-settings .switch input');
  await expect(switches).toHaveCount(2);

  await switches.nth(0).check();
  await expect(page.getByText(/运行中 · 127\.0\.0\.1:8765/)).toBeVisible();
  await expect(page.locator('.mcp-url')).toHaveValue(/\/mcp\/a{64}$/);

  await page.locator('.mcp-port input').fill('9000');
  await page.locator('.mcp-port button').click();
  await expect(page.getByText(/运行中 · 127\.0\.0\.1:9000/)).toBeVisible();

  await switches.nth(1).check();
  const state = await page.evaluate(
    () => (window as unknown as { __mcpMock: { exposeText: boolean } }).__mcpMock,
  );
  expect(state.exposeText).toBe(true);

  await page.getByRole('button', { name: '复制客户端配置' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __mcpMock: { copied: string } }).__mcpMock.copied,
      ),
    )
    .toContain('/mcp/');
});

test('MCP 设置：重置 token 需要二次确认', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '书库', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('.mcp-settings .switch input').first().check();

  const reset = page.getByRole('button', { name: '重置 token' });
  await reset.click();
  await expect(page.getByRole('button', { name: '再次点击确认重置' })).toBeVisible();
  await page.getByRole('button', { name: '再次点击确认重置' }).click();

  await expect(page.locator('.mcp-url')).toHaveValue(/\/mcp\/b{64}$/);
  const state = await page.evaluate(
    () => (window as unknown as { __mcpMock: { resetCount: number } }).__mcpMock,
  );
  expect(state.resetCount).toBe(1);
});
