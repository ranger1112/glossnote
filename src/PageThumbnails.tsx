import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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

type RegisterThumbnail = (node: HTMLElement | null, onVisible: (() => void) | null) => void;

interface ThumbnailProps {
  pdf: PDFDocumentProxy;
  page: number;
  current: boolean;
  bookmarked: boolean;
  onJump: (page: number) => void;
  register: RegisterThumbnail;
}

function Thumbnail({ pdf, page, current, bookmarked, onJump, register }: ThumbnailProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(
    () => thumbnailCache.get(pdf)?.get(page) ?? null,
  );

  useEffect(() => {
    if (src) return;
    const node = ref.current;
    if (!node) return;

    let cancelled = false;
    const onVisible = () => {
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
    };
    register(node, onVisible);

    return () => {
      cancelled = true;
      register(node, null);
    };
  }, [pdf, page, src, register]);

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
  const listRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const callbacksRef = useRef(new Map<Element, () => void>());
  const [intrinsicHeight, setIntrinsicHeight] = useState(220);

  // 一本 500 页的书会挂 500 个缩略图；共用一个 observer，避免每页各建一个。
  const getObserver = useCallback(() => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const callback = callbacksRef.current.get(entry.target);
            if (!callback) continue;
            observerRef.current?.unobserve(entry.target);
            callbacksRef.current.delete(entry.target);
            callback();
          }
        },
        { rootMargin: '240px' },
      );
    }
    return observerRef.current;
  }, []);

  const register = useCallback<RegisterThumbnail>(
    (node, onVisible) => {
      if (!node) return;
      if (!onVisible) {
        callbacksRef.current.delete(node);
        observerRef.current?.unobserve(node);
        return;
      }
      callbacksRef.current.set(node, onVisible);
      getObserver().observe(node);
    },
    [getObserver],
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      callbacksRef.current.clear();
    };
  }, []);

  // 两列网格的缩略图高度只跟侧栏宽度有关；用它给屏外内容一个准确的占位高度，
  // 这样 content-visibility 跳过布局时不会让滚动条跳动。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const itemWidth = Math.max(1, (list.clientWidth - 10) / 2);
      setIntrinsicHeight(Math.round((itemWidth * 4.15) / 3 + 22));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const marked = new Set(bookmarks.map((bookmark) => bookmark.page));

  return (
    <div className="sidebar-panel thumbnail-panel">
      <p className="sidebar-hint">点击缩略图跳到页面；加了书签的页面带标记。</p>
      <div
        ref={listRef}
        className="thumbnail-list"
        style={{ '--thumb-intrinsic': `${intrinsicHeight}px` } as CSSProperties}
      >
        {Array.from({ length: pageCount }, (_, page) => (
          <Thumbnail
            key={page}
            pdf={pdf}
            page={page}
            current={page === currentPage}
            bookmarked={marked.has(page)}
            onJump={onJump}
            register={register}
          />
        ))}
      </div>
    </div>
  );
}
