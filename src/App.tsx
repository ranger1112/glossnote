import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsAssets, pdfjsLib } from './pdfjs';
import { PdfPage } from './PdfPage';
import { Library } from './Library';
import { Review } from './Review';
import { CardEditor, type CardDraft } from './CardEditor';
import { AiPanel } from './AiPanel';
import { AiSettingsModal } from './AiSettingsModal';
import {
  IconArrowLeft,
  IconMoon,
  IconSparkles,
  IconSun,
} from './icons';
import type { Anchor } from './anchoring';
import type {
  AiSettingsView,
  Annotation,
  CardView,
  DocRecord,
  DocumentMeta,
  HighlightColor,
} from './types';
import { loadDoc, saveDoc, sha256Hex } from './storage';
import { isTauri } from './platform';
import {
  aiSettings,
  assetUrl,
  createCard,
  deleteAnnotation,
  listCards,
  openDocument,
  saveProgress,
  updateCard,
  updateDocumentMeta,
  upsertAnnotation,
} from './desktop';
import { applyTheme, initialTheme, type Theme } from './theme';

interface OpenedDoc {
  id: string;
  name: string;
  pageCount: number;
  pdf: PDFDocumentProxy;
  dispose: () => void;
}

interface ToolbarState {
  anchor: Anchor;
  x: number;
  y: number;
}

interface Activation {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  pdf: PDFDocumentProxy;
  task: ReturnType<typeof pdfjsLib.getDocument>;
  annotations: Annotation[];
  desktopMeta?: DocumentMeta;
  initialPage?: number;
}

const COLORS: Array<{ key: HighlightColor; label: string }> = [
  { key: 'yellow', label: '黄色高亮' },
  { key: 'green', label: '绿色高亮' },
  { key: 'blue', label: '蓝色高亮' },
  { key: 'pink', label: '粉色高亮' },
];

const EMPTY: Annotation[] = [];

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

function fitScale(
  viewer: HTMLElement,
  base: { width: number; height: number },
  mode: 'fit-width' | 'fit-page',
): number {
  const style = getComputedStyle(viewer);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padTop = parseFloat(style.paddingTop);
  // clientWidth/clientHeight 已经排除了滚动条；再扣掉内边距才是页面可用空间。
  const width = Math.max(120, viewer.clientWidth - padX - 2);
  const height = Math.max(120, viewer.clientHeight - padTop - 32);
  const byWidth = width / base.width;
  const next = mode === 'fit-page' ? Math.min(byWidth, height / base.height) : byWidth;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 1000) / 1000));
}

type AiPanelState =
  | { mode: 'qa' }
  | { mode: 'explain'; page: number; quote: string; context: string }
  | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultCardTitle(annotation: Annotation): string {
  const line = (annotation.anchor.quote || annotation.body).trim().split('\n')[0]?.trim() ?? '';
  if (!line) return '未命名卡片';
  const chars = Array.from(line);
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : line;
}

/**
 * 占位页在挂载时就有固定高度，通常可以立即滚动；
 * 保留重试只是为了兜住首批 DOM 尚未提交的极短窗口。
 */
function scrollToPage(page: number, attempt = 0) {
  const target = document.querySelector<HTMLElement>(`[data-page-index="${page}"]`);
  if (target && target.style.height) {
    const viewer = document.querySelector<HTMLElement>('.viewer');
    if (viewer) {
      // 页顶留一点灰边，不要直接贴住顶栏。
      const offset =
        target.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 24;
      viewer.scrollTo({ top: viewer.scrollTop + offset, behavior: 'instant' });
    } else {
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
    return;
  }
  if (attempt < 60) window.setTimeout(() => scrollToPage(page, attempt + 1), 80);
}

interface VisiblePage {
  index: number;
  element: HTMLElement;
}

/** 页面按 DOM 顺序排列，页底坐标单调递增；二分找视口顶部命中的那一页。 */
function visiblePage(viewer: HTMLElement): VisiblePage | null {
  const threshold = viewer.getBoundingClientRect().top + 60;
  const elements = viewer.querySelectorAll<HTMLElement>('[data-page-index]');
  let low = 0;
  let high = elements.length - 1;
  let found: VisiblePage | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const element = elements[middle];
    if (element.getBoundingClientRect().bottom > threshold) {
      found = { index: Number(element.dataset.pageIndex), element };
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return found;
}

export default function App() {
  const desktop = isTauri();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const [doc, setDoc] = useState<OpenedDoc | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [scale, setScale] = useState(1.2);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [view, setView] = useState<'library' | 'review'>('library');
  const [cards, setCards] = useState<CardView[]>([]);
  const [cardEditing, setCardEditing] = useState<{
    annotation: Annotation;
    existing?: CardView;
  } | null>(null);
  const [cardSaving, setCardSaving] = useState(false);
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiPanel, setAiPanel] = useState<AiPanelState>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const recordRef = useRef<DocRecord | null>(null);
  const docRef = useRef<OpenedDoc | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const viewerRef = useRef<HTMLElement | null>(null);
  const currentPageRef = useRef(0);
  const scaleRef = useRef(scale);
  const pendingAnchor = useRef<{
    index: number;
    offset?: number;
    topGap?: number;
    scale: number;
  } | null>(null);
  const progressTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pinnedPage = useRef<number | null>(null);
  const openingRef = useRef(false);
  const closingRef = useRef(false);
  annotationsRef.current = annotations;
  scaleRef.current = scale;

  useEffect(() => applyTheme(theme), [theme]);

  // 自适应缩放：首屏按页面尺寸算出比例，窗口变化时重算。
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!doc || !baseSize || zoomMode === 'custom' || !viewer) return;

    let frame = 0;

    const update = () => {
      const next = fitScale(viewer, baseSize, zoomMode);
      // ResizeObserver 会在缩放生效后再通知一次；比例没变就不要重新锚定。
      if (Math.abs(scaleRef.current - next) < 0.002) return;

      // 缩放前后保持视口里那一页的相对位置；否则切到「整页」会跳到别的页。
      const visible = visiblePage(viewer);
      let anchor: { index: number; offset?: number; topGap?: number } | null = null;
      if (visible) {
        const rect = visible.element.getBoundingClientRect();
        if (rect.height > 0) {
          anchor =
            zoomMode === 'fit-page'
              ? // 整页模式要让整页可见，直接从当前页顶部开始。
                { index: visible.index, topGap: 24 }
              : {
                  index: visible.index,
                  offset: (viewer.getBoundingClientRect().top - rect.top) / rect.height,
                };
        }
      }

      pendingAnchor.current = anchor ? { ...anchor, scale: next } : null;
      setScale(next);
    };

    update();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(viewer);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [doc, baseSize, zoomMode]);

  // 新的缩放已经落到 DOM 后，再把同一页的相对位置校正回来。
  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    if (!pending || Math.abs(scale - pending.scale) > 0.002) return;
    pendingAnchor.current = null;

    const viewer = viewerRef.current;
    const page = viewer?.querySelector<HTMLElement>(`[data-page-index="${pending.index}"]`);
    if (!viewer || !page) return;

    const pageRect = page.getBoundingClientRect();
    if (pageRect.height <= 0) return;
    const top = viewer.getBoundingClientRect().top;
    const desired =
      pending.topGap !== undefined
        ? top + pending.topGap
        : top - (pending.offset ?? 0) * pageRect.height;
    const delta = pageRect.top - desired;
    // viewer 有 scroll-behavior: smooth；直接改 scrollTop 会走动画，导致下一次布局读到旧位置。
    if (Math.abs(delta) > 1) {
      viewer.scrollTo({ top: viewer.scrollTop + delta, behavior: 'instant' });
    }
  }, [scale]);

  useEffect(() => {
    if (!message) return;
    // 进行中的提示保持到状态更新；成功提示自动收起；错误留给用户处理。
    if (/正在/.test(message) || /失败|错误|无法|不可|超时|不存在/.test(message)) return;
    const timer = window.setTimeout(() => setMessage(''), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!desktop) return;
    void aiSettings()
      .then(setAi)
      .catch((error) => setMessage(`读取 AI 设置失败：${errorText(error)}`));
  }, [desktop]);

  const openAiSettings = useCallback(async () => {
    if (!ai) {
      try {
        setAi(await aiSettings());
      } catch (error) {
        setMessage(`读取 AI 设置失败：${errorText(error)}`);
        return;
      }
    }
    setAiSettingsOpen(true);
  }, [ai]);

  const openAssistant = useCallback(
    (mode: 'qa' | 'explain', anchor?: Anchor) => {
      if (!docRef.current) return;
      if (!ai?.ready) {
        setMessage('请先在 AI 设置中启用并填写 API Key。');
        void openAiSettings();
        return;
      }

      if (mode === 'explain' && anchor) {
        const context = [anchor.prefix.trim(), anchor.suffix.trim()]
          .filter(Boolean)
          .join('\n…\n');
        setAiPanel({
          mode: 'explain',
          page: anchor.page,
          quote: anchor.quote,
          context,
        });
        setToolbar(null);
        window.getSelection()?.removeAllRanges();
      } else {
        setAiPanel({ mode: 'qa' });
      }
    },
    [ai, openAiSettings],
  );

  const visible = useMemo(
    () =>
      annotations
        .filter((annotation) => !annotation.deleted)
        .sort((left, right) => left.page - right.page || left.anchor.start - right.anchor.start),
    [annotations],
  );

  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of visible) {
      const list = map.get(annotation.page) ?? [];
      list.push(annotation);
      map.set(annotation.page, list);
    }
    return map;
  }, [visible]);

  // 放大后一页可达数千像素；减少同时渲染的页数，避免画布内存再次爆掉。
  const pageHeight = baseSize ? baseSize.height * scale : 0;
  const activeRadius = pageHeight > 1100 ? 1 : 2;

  const commit = useCallback((next: Annotation[]) => {
    annotationsRef.current = next;
    setAnnotations(next);
    if (isTauri()) return;

    const record = recordRef.current;
    if (record) {
      record.annotations = next;
      saveDoc(record);
    }
  }, []);

  const persistAnnotation = useCallback(async (docId: string, annotation: Annotation) => {
    try {
      await upsertAnnotation(docId, annotation);
    } catch (error) {
      setMessage(`保存标注失败：${errorText(error)}`);
    }
  }, []);

  const removeFromLibrary = useCallback(async (docId: string, id: string) => {
    try {
      await deleteAnnotation(docId, id);
    } catch (error) {
      setMessage(`删除标注失败：${errorText(error)}`);
    }
  }, []);

  const refreshCards = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setCards(await listCards());
    } catch (error) {
      setMessage(`读取卡片失败：${errorText(error)}`);
    }
  }, []);

  const activate = useCallback(async (input: Activation) => {
    if (progressTimer.current !== null) {
      window.clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
    pendingAnchor.current = null;
    pinnedPage.current = null;
    docRef.current?.dispose();

    const opened: OpenedDoc = {
      id: input.id,
      name: input.name,
      pageCount: input.pageCount,
      pdf: input.pdf,
      dispose: () => {
        void input.task.destroy().catch(() => undefined);
      },
    };
    docRef.current = opened;
    if (input.desktopMeta) recordRef.current = null;

    // 用第一页的原始尺寸作为占位与自适应缩放的基准；拿不到时退回 A4。
    let pageSize = { width: 595, height: 842 };
    try {
      const first = await input.pdf.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      pageSize = { width: viewport.width, height: viewport.height };
    } catch {
      // 尺寸只影响缩放基准，失败不阻止打开。
    }
    setBaseSize(pageSize);
    setZoomMode('fit-width');

    const startPage = Math.max(0, Math.min(input.initialPage ?? 0, input.pageCount - 1));
    currentPageRef.current = startPage;
    setCurrentPage(startPage);
    annotationsRef.current = input.annotations;
    setDoc(opened);
    setAnnotations(input.annotations);
    setToolbar(null);
    setFocusId(null);
    setAiPanel(null);
    setMessage('');

    requestAnimationFrame(() => {
      if (startPage > 0) scrollToPage(startPage);
      else viewerRef.current?.scrollTo({ top: 0 });
    });

    if (input.desktopMeta) {
      void refreshCards();
      try {
        const metadata = await input.pdf.getMetadata();
        const info = (metadata.info ?? {}) as { Title?: string; Author?: string };
        await updateDocumentMeta(input.id, {
          pageCount: input.pdf.numPages,
          title: info.Title,
          author: info.Author,
        });
      } catch {
        // 元数据是锦上添花，失败不影响阅读与标注。
      }
    }
  }, [refreshCards]);

  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setMessage('正在读取 PDF…');
      try {
        const bytes = await file.arrayBuffer();
        const docId = await sha256Hex(bytes);
        const existing = loadDoc(docId);
        const record: DocRecord = existing ?? {
          schemaVersion: 1,
          docId,
          name: file.name,
          size: file.size,
          annotations: [],
        };
        record.name = file.name;
        record.size = file.size;
        saveDoc(record);
        recordRef.current = record;

        const task = pdfjsLib.getDocument({ data: bytes.slice(0), ...pdfjsAssets });
        const pdf = await task.promise;
        await activate({
          id: docId,
          name: file.name,
          size: file.size,
          pageCount: pdf.numPages,
          pdf,
          task,
          annotations: record.annotations,
        });
      } catch (error) {
        setMessage(`打开失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [activate],
  );

  const openById = useCallback(
    async (docId: string, page?: number) => {
      if (openingRef.current) return;
      openingRef.current = true;
      setBusy(true);
      setMessage('正在打开文档…');
      try {
        const result = await openDocument(docId);
        const task = pdfjsLib.getDocument({ url: assetUrl(result.document.path), ...pdfjsAssets });
        const pdf = await task.promise;
        await activate({
          id: result.document.id,
          name: result.document.name,
          size: result.document.size,
          pageCount: pdf.numPages,
          pdf,
          task,
          annotations: result.annotations,
          desktopMeta: result.document,
          initialPage: page ?? result.document.lastPage,
        });
      } catch (error) {
        setMessage(`打开失败：${errorText(error)}`);
      } finally {
        openingRef.current = false;
        setBusy(false);
      }
    },
    [activate],
  );

  const closeDoc = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;

    if (progressTimer.current !== null) {
      window.clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }

    const finish = () => {
      docRef.current?.dispose();
      docRef.current = null;
      recordRef.current = null;
      currentPageRef.current = 0;
      pendingAnchor.current = null;
      pinnedPage.current = null;
      setDoc(null);
      setAnnotations([]);
      setToolbar(null);
      setFocusId(null);
      setEditingId(null);
      setCurrentPage(0);
      setCards([]);
      setCardEditing(null);
      setAiPanel(null);
      setMessage('');
      closingRef.current = false;
    };

    // 等进度落盘再回书库：书库挂载时会重新扫描，避免读到旧页码。
    const id = docRef.current?.id;
    if (id) {
      saveProgress(id, currentPageRef.current).catch(() => undefined).finally(finish);
    } else {
      finish();
    }
  }, []);

  const handleViewerScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const viewer = viewerRef.current;
      if (!viewer || !docRef.current) return;

      // 标注跳转后的第一次滚动来自代码本身，不要把页码改回页边界所在的上一页。
      if (pinnedPage.current !== null) {
        pinnedPage.current = null;
      } else {
        const visible = visiblePage(viewer);
        if (visible && visible.index !== currentPageRef.current) {
          currentPageRef.current = visible.index;
          setCurrentPage(visible.index);
        }
      }

      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
      progressTimer.current = window.setTimeout(() => {
        progressTimer.current = null;
        const id = docRef.current?.id;
        if (id) void saveProgress(id, currentPageRef.current).catch(() => undefined);
      }, 700);
    });
  }, []);

  const openSample = useCallback(async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await openFile(new File([blob], 'sample.pdf', { type: 'application/pdf' }));
    } catch (error) {
      setMessage(`加载示例失败：${errorText(error)}`);
    }
  }, [openFile]);

  useEffect(() => {
    if (!import.meta.env.DEV || isTauri()) return;
    if (new URLSearchParams(window.location.search).has('sample')) void openSample();
  }, [openSample]);

  const addHighlight = useCallback(
    (anchor: Anchor, color: HighlightColor, withNote: boolean) => {
      const now = Date.now();
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        page: anchor.page,
        anchor,
        color,
        kind: 'highlight',
        body: '',
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      commit([...annotationsRef.current, annotation]);
      const docId = docRef.current?.id;
      if (isTauri() && docId) void persistAnnotation(docId, annotation);
      setToolbar(null);
      window.getSelection()?.removeAllRanges();
      if (withNote) setEditingId(annotation.id);
    },
    [commit, persistAnnotation],
  );

  const updateBody = useCallback(
    (docId: string, id: string, body: string) => {
      const existing = annotationsRef.current.find((annotation) => annotation.id === id);
      if (!existing) return;

      const updated: Annotation = { ...existing, body, updatedAt: Date.now() };
      commit(annotationsRef.current.map((annotation) => (annotation.id === id ? updated : annotation)));
      if (isTauri()) void persistAnnotation(docId, updated);
    },
    [commit, persistAnnotation],
  );

  const updateTags = useCallback(
    (docId: string, id: string, tags: string[]) => {
      const existing = annotationsRef.current.find((annotation) => annotation.id === id);
      if (!existing) return;

      const updated: Annotation = { ...existing, tags, updatedAt: Date.now() };
      commit(annotationsRef.current.map((annotation) => (annotation.id === id ? updated : annotation)));
      if (isTauri()) void persistAnnotation(docId, updated);
    },
    [commit, persistAnnotation],
  );

  const removeAnnotation = useCallback(
    (docId: string, id: string) => {
      const existing = annotationsRef.current.find((annotation) => annotation.id === id);
      if (!existing) return;

      const updated: Annotation = { ...existing, deleted: true, updatedAt: Date.now() };
      commit(annotationsRef.current.map((annotation) => (annotation.id === id ? updated : annotation)));
      setCards((current) =>
        current.map((view) =>
          view.card.sourceAnnotationId === id
            ? { ...view, card: { ...view.card, status: 'orphaned' } }
            : view,
        ),
      );
      if (isTauri()) void removeFromLibrary(docId, id);
    },
    [commit, removeFromLibrary],
  );

  const zoomTo = useCallback((next: number) => {
    const viewer = viewerRef.current;
    const visible = viewer ? visiblePage(viewer) : null;
    if (viewer && visible && Math.abs(next - scaleRef.current) >= 0.002) {
      const rect = visible.element.getBoundingClientRect();
      if (rect.height > 0) {
        pendingAnchor.current = {
          index: visible.index,
          offset: (viewer.getBoundingClientRect().top - rect.top) / rect.height,
          scale: next,
        };
      }
    }
    setZoomMode('custom');
    setScale(next);
  }, []);

  const goToPage = useCallback((page: number) => {
    // 先移动当前页，让目标页立刻进入渲染窗口，再滚过去。
    currentPageRef.current = page;
    setCurrentPage(page);
    scrollToPage(page);
  }, []);

  const jumpTo = useCallback(
    (annotation: Annotation) => {
      const viewer = viewerRef.current;
      const rect = annotation.anchor.rects[0];
      currentPageRef.current = annotation.page;
      pinnedPage.current = annotation.page;
      setCurrentPage(annotation.page);

      if (viewer && rect) {
        const page = viewer.querySelector<HTMLElement>(
          `[data-page-index="${annotation.page}"]`,
        );
        if (page) {
          // 不只跳到页首：把标注的第一行滚到阅读区中间，长页面也能看到原句。
          const pageRect = page.getBoundingClientRect();
          const viewerRect = viewer.getBoundingClientRect();
          const anchorCenter = pageRect.top + (rect.y + rect.h / 2) * pageRect.height;
          const delta = anchorCenter - (viewerRect.top + viewer.clientHeight / 2);
          viewer.scrollTo({
            top: Math.max(0, viewer.scrollTop + delta),
            behavior: 'instant',
          });
        }
      } else {
        scrollToPage(annotation.page);
      }

      setFocusId(annotation.id);
      window.setTimeout(() => {
        setFocusId((current) => (current === annotation.id ? null : current));
      }, 2400);
    },
    [],
  );

  const handleSelect = useCallback((anchor: Anchor, box: { x: number; y: number }) => {
    setToolbar({
      anchor,
      x: Math.min(Math.max(box.x, 90), window.innerWidth - 90),
      y: Math.max(box.y, 70),
    });
  }, []);

  const saveCard = useCallback(
    async (draft: CardDraft) => {
      const editing = cardEditing;
      const docId = docRef.current?.id;
      if (!editing || !docId) return;

      setCardSaving(true);
      try {
        const saved = editing.existing
          ? await updateCard(editing.existing.card.id, draft.title, draft.body, draft.links)
          : await createCard(docId, editing.annotation.id, draft.title, draft.body, draft.links);

        setCards((current) => [saved, ...current.filter((view) => view.card.id !== saved.card.id)]);
        setCardEditing(null);
        setMessage(editing.existing ? '卡片已更新。' : '已加入复习队列。');
      } catch (error) {
        setMessage(`保存卡片失败：${errorText(error)}`);
      } finally {
        setCardSaving(false);
      }
    },
    [cardEditing],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setToolbar(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <span className="brand-text">
            Gloss<span className="brand-accent">Note</span>
          </span>
        </div>

        {!doc && desktop && (
          <nav className="topbar-nav">
            <button
              type="button"
              className={view === 'library' ? 'active' : ''}
              onClick={() => setView('library')}
            >
              书库
            </button>
            <button
              type="button"
              className={view === 'review' ? 'active' : ''}
              onClick={() => setView('review')}
            >
              复习
            </button>
          </nav>
        )}

        {doc && (
          <div className="doc-title" title={doc.name}>
            <span className="doc-name">{doc.name}</span>
            <span className="doc-id">
              第 {currentPage + 1} / {doc.pageCount} 页
            </span>
          </div>
        )}

        <div className="topbar-spacer" />

        {doc && (
          <div className="zoom-controls">
            <button
              type="button"
              title="缩小"
              onClick={() => zoomTo(Math.max(MIN_SCALE, +(scaleRef.current - 0.25).toFixed(2)))}
            >
              −
            </button>
            <span
              title={
                zoomMode === 'fit-width'
                  ? '适应宽度'
                  : zoomMode === 'fit-page'
                    ? '适应整页'
                    : '手动缩放'
              }
            >
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              title="放大"
              onClick={() => zoomTo(Math.min(MAX_SCALE, +(scaleRef.current + 0.25).toFixed(2)))}
            >
              +
            </button>
            <div className="zoom-modes">
              <button
                type="button"
                className={zoomMode === 'fit-width' ? 'active' : ''}
                title="页面宽度铺满阅读区"
                onClick={() => setZoomMode('fit-width')}
              >
                适宽
              </button>
              <button
                type="button"
                className={zoomMode === 'fit-page' ? 'active' : ''}
                title="整页完整显示"
                onClick={() => setZoomMode('fit-page')}
              >
                整页
              </button>
            </div>
          </div>
        )}

        {desktop && (
          <button
            type="button"
            className={`theme-toggle ai-topbutton ${ai?.ready ? 'ready' : ''}`}
            title={ai?.ready ? 'AI 阅读助手设置' : '配置 AI'}
            aria-label="AI 阅读助手设置"
            onClick={() => void openAiSettings()}
          >
            <IconSparkles size={15} />
          </button>
        )}

        <button
          type="button"
          className="theme-toggle"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>

        {doc ? (
          <button type="button" className="ghost topbar-back" onClick={closeDoc}>
            <IconArrowLeft size={14} />
            书库
          </button>
        ) : (
          !desktop && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              打开 PDF
            </button>
          )
        )}

        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void openFile(file);
          }}
        />
      </header>

      {message && (
        <div
          className={`status-bar ${
            /失败|错误|无法|不可|超时|不存在/.test(message)
              ? 'error'
              : /正在/.test(message)
                ? 'busy'
                : 'info'
          }`}
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      )}

      {doc ? (
        <main className="workspace">
          <section className="viewer" ref={viewerRef} onScroll={handleViewerScroll}>
            {baseSize &&
              Array.from({ length: doc.pageCount }, (_, index) => (
                <PdfPage
                  key={`${doc.id}-${index}`}
                  pdf={doc.pdf}
                  pageIndex={index}
                  scale={scale}
                  baseSize={baseSize}
                  active={Math.abs(index - currentPage) <= activeRadius}
                  annotations={byPage.get(index) ?? EMPTY}
                  focusId={focusId}
                  onSelect={handleSelect}
                />
              ))}
          </section>

          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>标注</h2>
              <span className="count">{visible.length}</span>
              <span className="sidebar-progress">
                {currentPage + 1} / {doc.pageCount}
              </span>
              {desktop && (
                <button
                  type="button"
                  className="ai-head-button"
                  title="基于这份文档提问"
                  onClick={() => openAssistant('qa')}
                >
                  <IconSparkles size={12} />
                  问 AI
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <p className="sidebar-hint">
                选中正文即可高亮；点浮动栏里的「批注」写下你的想法。
                所有标注会在刷新、缩放后回到原来的位置。
              </p>
            ) : (
              <div className="annotation-list">
                {visible.map((annotation) => (
                  <AnnotationCard
                    key={annotation.id}
                    annotation={annotation}
                    card={cards.find(
                      (view) => view.card.sourceAnnotationId === annotation.id,
                    )}
                    editing={editingId === annotation.id}
                    onJump={() => jumpTo(annotation)}
                    onBody={(body) => updateBody(doc.id, annotation.id, body)}
                    onTags={(tags) => updateTags(doc.id, annotation.id, tags)}
                    onCard={() =>
                      setCardEditing({
                        annotation,
                        existing: cards.find(
                          (view) => view.card.sourceAnnotationId === annotation.id,
                        ),
                      })
                    }
                    onDelete={() => removeAnnotation(doc.id, annotation.id)}
                  />
                ))}
              </div>
            )}

            <div className="sidebar-foot">
              {desktop
                ? '标注写入本地 SQLite，并镜像到书库的 sidecar。'
                : '浏览器原型暂存于 localStorage；桌面版写入 SQLite 与 sidecar。'}
            </div>
          </aside>
        </main>
      ) : desktop ? (
        view === 'review' ? (
          <Review onOpenDoc={openById} onMessage={setMessage} />
        ) : (
          <Library onOpen={openById} onMessage={setMessage} />
        )
      ) : (
        <main className="workspace welcome">
          <div className="welcome-card">
            <div className="welcome-mark">G</div>
            <h1>把阅读留在页面上</h1>
            <p>
              打开一份 PDF，选中文字即可高亮或批注。缩放、刷新、下次打开，
              标注都会回到原来那一行。
            </p>
            <div className="welcome-actions">
              <button
                type="button"
                className="primary large"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                打开 PDF
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void openSample()}
              >
                先看看示例
              </button>
            </div>
            <p className="welcome-hint">
              当前是浏览器原型：标注只存在 localStorage，尚未接入 SQLite 与云同步。
            </p>
          </div>
        </main>
      )}

      {toolbar && (
        <div
          className="selection-toolbar"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {COLORS.map((color) => (
            <button
              key={color.key}
              type="button"
              className={`swatch ${color.key}`}
              title={color.label}
              onClick={() => addHighlight(toolbar.anchor, color.key, false)}
            />
          ))}
          <span className="toolbar-sep" />
          <button
            type="button"
            className="toolbar-note"
            onClick={() => addHighlight(toolbar.anchor, 'yellow', true)}
          >
            批注
          </button>
          {desktop && (
            <>
              <span className="toolbar-sep" />
              <button
                type="button"
                className="toolbar-note"
                onClick={() => openAssistant('explain', toolbar.anchor)}
              >
                <IconSparkles size={13} />
                AI 解释
              </button>
            </>
          )}
        </div>
      )}

      {doc && aiPanel && (
        <AiPanel
          key={`${doc.id}:${aiPanel.mode}:${aiPanel.mode === 'explain' ? aiPanel.page : ''}`}
          docId={doc.id}
          docName={doc.name}
          pdf={doc.pdf}
          mode={aiPanel.mode}
          explain={
            aiPanel.mode === 'explain'
              ? { page: aiPanel.page, quote: aiPanel.quote, context: aiPanel.context }
              : undefined
          }
          ready={!!ai?.ready}
          onClose={() => setAiPanel(null)}
          onJumpPage={goToPage}
          onOpenSettings={() => void openAiSettings()}
          onMessage={setMessage}
        />
      )}

      {aiSettingsOpen && ai && (
        <AiSettingsModal
          initial={ai}
          onClose={() => setAiSettingsOpen(false)}
          onSaved={setAi}
          onMessage={setMessage}
        />
      )}

      {cardEditing && (
        <CardEditor
          heading={cardEditing.existing ? '编辑卡片' : '制作卡片'}
          initial={{
            title: cardEditing.existing?.card.title ?? defaultCardTitle(cardEditing.annotation),
            body: cardEditing.existing?.card.body ?? cardEditing.annotation.body,
            links: cardEditing.existing?.card.links ?? [],
          }}
          cards={cards}
          excludeId={cardEditing.existing?.card.id}
          saving={cardSaving}
          onCancel={() => setCardEditing(null)}
          onSave={(draft) => void saveCard(draft)}
        />
      )}
    </div>
  );
}

interface AnnotationCardProps {
  annotation: Annotation;
  card?: CardView;
  editing: boolean;
  onJump: () => void;
  onBody: (body: string) => void;
  onTags: (tags: string[]) => void;
  onCard: () => void;
  onDelete: () => void;
}

function AnnotationCard({
  annotation,
  card,
  editing,
  onJump,
  onBody,
  onTags,
  onCard,
  onDelete,
}: AnnotationCardProps) {
  const [draft, setDraft] = useState(annotation.body);
  const [tagDraft, setTagDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(annotation.body);
  const savedRef = useRef(annotation.body);
  const timerRef = useRef<number | null>(null);
  const onBodyRef = useRef(onBody);
  onBodyRef.current = onBody;

  useEffect(() => {
    setDraft(annotation.body);
    draftRef.current = annotation.body;
    savedRef.current = annotation.body;
  }, [annotation.body]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  /** 输入停顿 600ms 或失焦时落盘；组件卸载时也补一次，避免切换文档丢字。 */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (draftRef.current === savedRef.current) return;
    savedRef.current = draftRef.current;
    onBodyRef.current(draftRef.current);
  }, []);

  useEffect(() => () => flush(), [flush]);

  const handleChange = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 600);
  };

  const addTag = () => {
    const value = tagDraft.trim().replace(/^#+/, '');
    if (!value) return;
    if (!annotation.tags.includes(value)) onTags([...annotation.tags, value]);
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    onTags(annotation.tags.filter((item) => item !== tag));
  };

  return (
    <article className="annotation-card" onClick={onJump}>
      <header className="annotation-head">
        <span className={`color-dot ${annotation.color}`} />
        <span>第 {annotation.page + 1} 页</span>
        <button
          type="button"
          className="icon-button"
          title="删除标注"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      </header>

      <blockquote>{annotation.anchor.quote}</blockquote>

      <textarea
        ref={textareaRef}
        className="note-input"
        value={draft}
        placeholder="写下你的批注…"
        onChange={(event) => handleChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={flush}
      />

      <div className="tag-editor" onClick={(event) => event.stopPropagation()}>
        {annotation.tags.map((tag) => (
          <span className="tag" key={tag}>
            #{tag}
            <button type="button" title="移除标签" onClick={() => removeTag(tag)}>
              ×
            </button>
          </span>
        ))}
        <input
          value={tagDraft}
          placeholder="+ 标签"
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={addTag}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addTag();
            } else if (
              event.key === 'Backspace' &&
              tagDraft.length === 0 &&
              annotation.tags.length > 0
            ) {
              removeTag(annotation.tags[annotation.tags.length - 1]);
            }
          }}
        />
      </div>

      <button
        type="button"
        className="card-button"
        onClick={(event) => {
          event.stopPropagation();
          onCard();
        }}
      >
        {card
          ? card.card.status === 'orphaned'
            ? '卡片 · 来源失效'
            : card.card.reps > 0
              ? `卡片 · 复习 ${card.card.reps} 次`
              : '卡片 · 新'
          : '制卡'}
      </button>
    </article>
  );
}
