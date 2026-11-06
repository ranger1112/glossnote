import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** 阅读器远跳时如果有该页的缩略图缓存，先拿它垫一帧。 */
export function cachedThumbnail(pdf: PDFDocumentProxy, page: number): string | null {
  return thumbnailCache.get(pdf)?.get(page) ?? null;
}

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

/** 两列网格的行距，和 .thumbnail-list 的 row-gap 保持一致。 */
const ROW_GAP = 12;
/** 视口上下各多渲染几行，快速滚动时不会露出空白。 */
const OVERSCAN_ROWS = 3;

function initialRange(pageCount: number, currentPage: number) {
  const row = Math.floor(currentPage / 2);
  const startRow = Math.max(0, row - OVERSCAN_ROWS);
  const endRow = Math.min(Math.ceil(pageCount / 2), row + OVERSCAN_ROWS + 4);
  return { start: startRow * 2, end: Math.min(pageCount, endRow * 2) };
}

export function PageThumbnails({
  pdf,
  pageCount,
  currentPage,
  bookmarks,
  onJump,
}: PageThumbnailsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const callbacksRef = useRef(new Map<Element, () => void>());
  // 行高必须用真实渲染值：估值误差会在几百行后累积成整屏偏移。
  // 0 表示还没量到，此时先不撑占位高度，量到后在同一帧内重排再定位。
  const [rowHeight, setRowHeight] = useState(0);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  // 500 页的书没必要挂 500 个按钮；只渲染视口附近的行，上下用 padding 撑住高度。
  const [range, setRange] = useState(() => initialRange(pageCount, currentPage));
  const didInitialScroll = useRef(false);

  // 缩略图列表共用一个 observer，避免每页各建一个。
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

  // 侧栏宽度变了，缩略图行高跟着变；用真实渲染出来的第一项测量。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const item = list.querySelector<HTMLElement>('.page-thumb');
      const measured = item?.offsetHeight ?? 0;
      if (measured > 0) {
        setRowHeight((current) => (current === measured + ROW_GAP ? current : measured + ROW_GAP));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const updateRange = useCallback(() => {
    const panel = panelRef.current;
    const list = listRef.current;
    if (!panel || !list || rowHeightRef.current <= 0) return;

    const totalRows = Math.ceil(pageCount / 2);
    // 行 i 相对列表顶部的偏移恒为 i * rowHeight：上方 padding 正好补上被裁掉的行。
    const listTop =
      list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    const offset = Math.max(0, panel.scrollTop - listTop);
    const firstRow = Math.floor(offset / rowHeightRef.current);
    const visibleRows = Math.ceil(panel.clientHeight / rowHeightRef.current) + 1;
    const startRow = Math.max(0, firstRow - OVERSCAN_ROWS);
    const endRow = Math.min(totalRows, firstRow + visibleRows + OVERSCAN_ROWS);
    const start = startRow * 2;
    const end = Math.min(pageCount, endRow * 2);
    setRange((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, [pageCount]);

  // 行高量准后（绘制前）再定位当前页；之后翻页只更新渲染窗口，
  // 不强行滚动列表，避免打断用户浏览缩略图。
  useLayoutEffect(() => {
    if (rowHeight === 0) return;
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      listRef.current
        ?.querySelector<HTMLElement>('.page-thumb.active')
        ?.scrollIntoView({ block: 'center' });
    }
    updateRange();
  }, [rowHeight, updateRange]);

  const marked = new Set(bookmarks.map((bookmark) => bookmark.page));
  const totalRows = Math.ceil(pageCount / 2);
  const startRow = Math.floor(range.start / 2);
  const endRow = Math.ceil(range.end / 2);

  return (
    <div ref={panelRef} className="sidebar-panel thumbnail-panel" onScroll={updateRange}>
      <p className="sidebar-hint">点击缩略图跳到页面；加了书签的页面带标记。</p>
      <div
        ref={listRef}
        className="thumbnail-list"
        style={{
          paddingTop: startRow * rowHeight,
          paddingBottom: (totalRows - endRow) * rowHeight + 12,
        }}
      >
        {Array.from({ length: range.end - range.start }, (_, offset) => {
          const page = range.start + offset;
          return (
            <Thumbnail
              key={page}
              pdf={pdf}
              page={page}
              current={page === currentPage}
              bookmarked={marked.has(page)}
              onJump={onJump}
              register={register}
            />
          );
        })}
      </div>
    </div>
  );
}
