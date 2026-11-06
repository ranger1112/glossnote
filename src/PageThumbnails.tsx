import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { IconBookmark } from './icons';
import type { Bookmark } from './types';

interface PageThumbnailsProps {
  pdf: PDFDocumentProxy;
  pageCount: number;
  currentPage: number;
  bookmarks: Bookmark[];
  onJump: (page: number) => void;
}

/** 同一份 PDF 的缩略图在标签页来回切换时复用，避免重新渲染整本。 */
const thumbnailCache = new WeakMap<PDFDocumentProxy, Map<number, string>>();

let activeRenders = 0;
const renderQueue: Array<() => void> = [];

/** 关闭文档时 pdf.js 的 getPage 可能永远不 settle；超时兜底，避免永久占住槽位。 */
const RENDER_TIMEOUT_MS = 15_000;

function withRenderSlot<T>(
  task: () => Promise<T>,
  cancelled: () => boolean = () => false,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const run = () => {
      if (cancelled()) {
        resolve(null);
        return;
      }
      activeRenders += 1;
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        activeRenders -= 1;
        renderQueue.shift()?.();
        settle();
      };
      const timer = window.setTimeout(() => finish(() => resolve(null)), RENDER_TIMEOUT_MS);
      task().then(
        (value) => {
          window.clearTimeout(timer);
          finish(() => resolve(value));
        },
        (error) => {
          window.clearTimeout(timer);
          finish(() => reject(error));
        },
      );
    };
    if (activeRenders < 2) run();
    else renderQueue.push(run);
  });
}

async function renderThumbnail(
  pdf: PDFDocumentProxy,
  page: number,
): Promise<string | null> {
  const pageProxy = await pdf.getPage(page + 1);
  try {
    const base = pageProxy.getViewport({ scale: 1 });
    const viewport = pageProxy.getViewport({ scale: 132 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) return null;

    await pageProxy.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally {
    pageProxy.cleanup();
  }
}

interface ThumbnailProps {
  pdf: PDFDocumentProxy;
  page: number;
  current: boolean;
  bookmarked: boolean;
  onJump: (page: number) => void;
}

function Thumbnail({ pdf, page, current, bookmarked, onJump }: ThumbnailProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(
    () => thumbnailCache.get(pdf)?.get(page) ?? null,
  );

  useEffect(() => {
    if (src) return;
    const node = ref.current;
    if (!node) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void withRenderSlot(() => renderThumbnail(pdf, page), () => cancelled)
          .then((data) => {
            if (cancelled || !data) return;
            let cache = thumbnailCache.get(pdf);
            if (!cache) {
              cache = new Map();
              thumbnailCache.set(pdf, cache);
            }
            cache.set(page, data);
            setSrc(data);
          })
          .catch(() => undefined);
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pdf, page, src]);

  return (
    <button
      ref={ref}
      type="button"
      className={`page-thumb ${current ? 'active' : ''}`}
      title={`跳到第 ${page + 1} 页`}
      onClick={() => onJump(page)}
    >
      <span className="page-thumb-frame">
        {src ? (
          <img src={src} alt="" loading="lazy" />
        ) : (
          <span className="page-thumb-skeleton" aria-hidden="true" />
        )}
        {bookmarked && (
          <span className="page-thumb-bookmark" aria-label="已加书签">
            <IconBookmark size={11} filled />
          </span>
        )}
      </span>
      <span className="page-thumb-number">{page + 1}</span>
    </button>
  );
}

export function PageThumbnails({
  pdf,
  pageCount,
  currentPage,
  bookmarks,
  onJump,
}: PageThumbnailsProps) {
  const marked = new Set(bookmarks.map((bookmark) => bookmark.page));

  return (
    <div className="sidebar-panel thumbnail-panel">
      <p className="sidebar-hint">点击缩略图跳到页面；加了书签的页面带标记。</p>
      <div className="thumbnail-list">
        {Array.from({ length: pageCount }, (_, page) => (
          <Thumbnail
            key={page}
            pdf={pdf}
            page={page}
            current={page === currentPage}
            bookmarked={marked.has(page)}
            onJump={onJump}
          />
        ))}
      </div>
    </div>
  );
}
