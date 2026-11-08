import { test, expect } from '@playwright/test';

test('网页快照：图片内联、相对地址与失败降级', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    // 直接加载模块，避免依赖桌面端 TLS/网络；图片下载用回调模拟。
    const mod = (await new Function('return import("/src/webclip.ts")')()) as typeof import(
      '../src/webclip'
    );
    const source = `<!doctype html><html><head><title>快照标题</title></head><body>
      <article>
        <h1>一篇足够长的文章</h1>
        ${'<p>正文内容，用来让 Readability 认为这是一篇文章。</p>'.repeat(20)}
        <p><img src="pic.png" alt="相对图片"></p>
        <p><img src="https://cdn.example/fail.png" alt="失败图片"></p>
        <p><img src="data:image/png;base64,AAAA" alt="内联图片"></p>
      </article>
    </body></html>`;

    const requested: string[] = [];
    const snapshot = await mod.buildWebSnapshot(
      source,
      'https://example.com/posts/1',
      async (urls) => {
        requested.push(...urls);
        return new Map([
          ['https://example.com/posts/pic.png', 'data:image/png;base64,BBBB'],
        ]);
      },
    );

    return { snapshot, requested };
  });

  expect(result.requested).toContain('https://example.com/posts/pic.png');
  expect(result.requested).toContain('https://cdn.example/fail.png');
  expect(result.snapshot.html).toContain('data:image/png;base64,BBBB');
  expect(result.snapshot.html).toContain('data:image/png;base64,AAAA');
  expect(result.snapshot.html).not.toContain('pic.png');
  expect(result.snapshot.html).not.toContain('https://cdn.example');
  expect(result.snapshot.title).toContain('快照标题');
  expect(result.snapshot.images).toBe(2);
  expect(result.snapshot.failed).toBe(1);
});

test('本地 HTML 冻存：相对图片转 asset 地址并内联，远程图片不抓取', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const mod = (await new Function('return import("/src/webclip.ts")')()) as typeof import(
      '../src/webclip'
    );
    const source = `<!doctype html><html><head><title>本地文章</title></head><body>
      <article>
        <h1>一篇本地文章</h1>
        ${'<p>本地正文内容，用来让 Readability 认为这是一篇文章。</p>'.repeat(20)}
        <p><img src="images/pic.png" alt="本地图片"></p>
        <p><img src="missing.png" alt="缺失图片"></p>
        <p><img src="https://cdn.example/remote.png" alt="远程图片"></p>
        <p><img src="data:image/png;base64,AAAA" alt="内联图片"></p>
      </article>
    </body></html>`;

    const requested: string[] = [];
    const snapshot = await mod.buildLocalHtmlSnapshot(
      source,
      'D:\\articles\\post.html',
      {
        toAssetUrl: (path) => `https://asset.test/${encodeURIComponent(path)}`,
        fetchAsset: async (url) => {
          requested.push(url);
          if (url.includes('pic.png')) {
            return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
          }
          return null;
        },
      },
    );

    return { snapshot, requested };
  });

  expect(result.requested).toContain(
    `https://asset.test/${encodeURIComponent('D:\\articles\\images\\pic.png')}`,
  );
  expect(result.snapshot.html).toContain('data:image/png;base64,');
  expect(result.snapshot.html).toContain('data:image/png;base64,AAAA');
  expect(result.snapshot.html).not.toContain('asset.test');
  expect(result.snapshot.html).not.toContain('https://cdn.example');
  expect(result.snapshot.title).toContain('本地文章');
  expect(result.snapshot.images).toBe(2);
  expect(result.snapshot.failed).toBe(2);
});

test('本地 HTML 读取：UTF-8 失败时回退 GB18030', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const mod = (await new Function('return import("/src/webclip.ts")')()) as typeof import(
      '../src/webclip'
    );
    const gb18030 = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    let binary = '';
    for (const byte of gb18030) binary += String.fromCharCode(byte);
    const dataUrl = `data:text/html;base64,${btoa(binary)}`;
    const text = await mod.readLocalHtml('ignored.html', () => dataUrl);
    return text;
  });

  expect(result).toBe('中文');
});
