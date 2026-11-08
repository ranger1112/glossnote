import { extractHtmlArticle, sanitizeHtml } from './flow';

/** 与 Rust 侧的图片上限保持一致；前后端都拦一道，避免坏页面把 IPC 撑爆。 */
const MAX_IMAGES = 100;

export type AssetFetcher = (urls: string[]) => Promise<Map<string, string>>;

export interface WebSnapshot {
  html: string;
  title?: string;
  author?: string;
  /** 成功内联的图片数（含原本就是 data: 的图片）。 */
  images: number;
  /** 下载失败、超限或被跳过的图片数。 */
  failed: number;
}

/**
 * 把 Readability 提取出的正文做成单文件快照：
 * 图片先按最终 URL 解析、去重、下载成 data URL，再做统一清理。
 */
export async function buildWebSnapshot(
  source: string,
  finalUrl: string,
  fetchAssets: AssetFetcher,
): Promise<WebSnapshot> {
  const article = await extractHtmlArticle(source, finalUrl);
  const container = document.createElement('div');
  container.innerHTML = article.html;

  const plan: Array<{ image: HTMLImageElement; url?: string; inline: boolean }> = [];
  const urls = new Set<string>();

  for (const image of Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const raw = image.getAttribute('src')?.trim();
    if (!raw) continue;

    if (/^data:/i.test(raw)) {
      plan.push({ image, inline: true });
      continue;
    }

    let absolute: string;
    try {
      absolute = new URL(raw, finalUrl).href;
    } catch {
      image.removeAttribute('src');
      continue;
    }
    if (!/^https?:/i.test(absolute)) {
      image.removeAttribute('src');
      continue;
    }

    urls.add(absolute);
    plan.push({ image, url: absolute, inline: false });
  }

  const requested = Array.from(urls).slice(0, MAX_IMAGES);
  const assets = requested.length > 0 ? await fetchAssets(requested) : new Map<string, string>();

  let images = 0;
  let failed = 0;
  for (const entry of plan) {
    if (entry.inline) {
      images += 1;
      continue;
    }

    const dataUrl = entry.url ? assets.get(entry.url) : undefined;
    if (dataUrl) {
      entry.image.setAttribute('src', dataUrl);
      images += 1;
    } else {
      // 超过数量上限或下载失败的图片直接移除，快照里不留远程地址。
      entry.image.removeAttribute('src');
      failed += 1;
    }
  }

  return {
    html: sanitizeHtml(container.innerHTML),
    title: article.title,
    author: article.author,
    images,
    failed,
  };
}
