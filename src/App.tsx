import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib, pdfjsOpenOptions } from './pdfjs';
import { PdfPage, cachedPageSize } from './PdfPage';
import { FlowPage, FLOW_PAGE_WIDTH } from './FlowPage';
import { textAnchorStrategy, normalizeDocKind, type DocKind } from './document';
import { buildHtmlDocument, buildTextDocument, type FlowDocument } from './flow';
import { buildEpubDocument } from './epub';
import { Library } from './Library';
import { Review } from './Review';
import { CardEditor, type CardDraft } from './CardEditor';
import { AiPanel } from './AiPanel';
import { AiSettingsModal } from './AiSettingsModal';
import { SettingsModal } from './SettingsModal';
import { ShortcutList } from './ShortcutList';
import { HistoryModal } from './HistoryModal';
import { OutlinePanel } from './OutlinePanel';
import { PageJump } from './PageJump';
import { PageThumbnails } from './PageThumbnails';
import { loadOutline, type OutlineEntry } from './outline';
import {
  IconArrowLeft,
  IconBookmark,
  IconDownload,
  IconHistory,
  IconList,
  IconPages,
  IconRedo,
  IconSettings,
  IconSparkles,
  IconUndo,
} from './icons';
import type { Anchor } from './anchoring';
import type {
  AiSettingsView,
  Annotation,
  AnnotationKind,
  Bookmark,
  CardView,
  DocRecord,
  DocumentMeta,
  HighlightColor,
  ImportResult,
  PageTextInput,
} from './types';
import { loadDoc, saveDoc, sha256Hex } from './storage';
import { joinPdfItems } from './pdfText';
import { mergeSelectionRects, type SelectionBox } from './selection';
import {
  annotationKey,
  buildImportedAnnotations,
  draftsToAnnotations,
  PDF_IMPORT_TAG,
  scanNativeAnnotations,
  scanNativePage,
  type NativePage,
  type NativeScan,
} from './pdfAnnotations';
import type { PdfTextItem } from './pdfjs';
import { errorText } from './errors';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri, pickDirectory, pickMarkdownPath, pickPdfSavePath } from './platform';
import { findUpdate, installUpdate, type AvailableUpdate } from './updater';
import {
  aiSettings,
  assetUrl,
  createCard,
  deleteAnnotation,
  exportAnnotatedPdf,
  exportMarkdown,
  indexDocumentText,
  libraryRoot,
  listCards,
  loadPageTexts,
  openDocument,
  readDocumentText,
  saveBookmarks,
  savePageTexts,
  saveProgress,
  scanLibrary,
  setLibraryRoot,
  startupNotice,
  updateCard,
  updateDocumentMeta,
  upsertAnnotation,
  upsertAnnotations,
} from './desktop';
import { applyTheme, initialTheme, type Theme } from './theme';

interface OpenedDoc {
  id: string;
  name: string;
  kind: DocKind;
  pageCount: number;
  /** PDF 的 pdf.js 代理；TXT / HTML / EPUB 为 null。 */
  pdf: PDFDocumentProxy | null;
  /** 流式文档的分页内容；PDF 为 null。 */
  flow: FlowDocument | null;
  bookmarks: Bookmark[];
  /** 书库封面（首页缩略图）；打开文档时先垫在首屏下面，避免长时间白屏。 */
  cover?: string;
  dispose: () => void;
}

interface ToolbarState {
  anchor: Anchor;
  /** 选区前后各一段正文，只用于 AI 解释，不写入锚点。 */
  context: string;
  x: number;
  y: number;
}

interface HoverState {
  annotation: Annotation;
  /** 悬停标注所在页的前后文，供 AI 解释复用。 */
  context: string;
  x: number;
  y: number;
  /** 标注贴近阅读区顶部时，工具条改到文字下方展开。 */
  below: boolean;
}

interface PdfImportSummary {
  total: number;
  annotatedPages: number;
  byKind: NativeScan['byKind'];
  pages: { page: number; count: number }[];
}

/** 侧栏一次渲染的卡片数；滚动到底部再追加，避免上千条标注一次挂载。 */
const SIDEBAR_PAGE = 100;

const SIDEBAR_WIDTH_KEY = 'glossnote:sidebar-width';
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 720;
const SIDEBAR_DEFAULT_WIDTH = 350;

function initialSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH) {
      return Math.min(saved, SIDEBAR_MAX_WIDTH);
    }
  } catch {
    // 隐私模式或存储被禁用时用默认宽度。
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

type RenderQuality = 'standard' | 'high';
const RENDER_QUALITY_KEY = 'glossnote:render-quality';
const SCAN_ENHANCE_DOCS_KEY = 'glossnote:scan-enhance-docs';

function initialRenderQuality(): RenderQuality {
  try {
    return localStorage.getItem(RENDER_QUALITY_KEY) === 'high' ? 'high' : 'standard';
  } catch {
    return 'standard';
  }
}

/** 扫描件增黑按文档记忆；只存开启的文档，新文档默认关闭。 */
function initialScanEnhanceDocs(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SCAN_ENHANCE_DOCS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === true) result[id] = true;
    }
    return result;
  } catch {
    return {};
  }
}

function persistScanEnhanceDocs(docs: Record<string, boolean>): void {
  try {
    localStorage.setItem(SCAN_ENHANCE_DOCS_KEY, JSON.stringify(docs));
  } catch {
    // 隐私模式或存储被禁用时只影响下次启动，不阻止当前切换。
  }
}

function groupAnnotations(list: Annotation[]): [number, Annotation[]][] {
  const map = new Map<number, Annotation[]>();
  for (const annotation of list) {
    const items = map.get(annotation.page) ?? [];
    items.push(annotation);
    map.set(annotation.page, items);
  }
  return [...map.entries()].sort(([left], [right]) => left - right);
}

interface FindMatch {
  page: number;
  start: number;
  end: number;
  snippet: string;
}

interface SearchTarget {
  page: number;
  start: number;
  end: number;
  token: number;
}

interface Activation {
  id: string;
  name: string;
  size: number;
  kind: DocKind;
  pageCount: number;
  /** PDF 文档；与 flow 二选一。 */
  pdf?: PDFDocumentProxy;
  task?: ReturnType<typeof pdfjsLib.getDocument>;
  /** TXT / HTML / EPUB 的分页内容。 */
  flow?: FlowDocument;
  annotations: Annotation[];
  bookmarks?: Bookmark[];
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

/** 侧栏类型筛选的固定顺序；只显示当前文档里真实存在的类型。 */
const KIND_ORDER: AnnotationKind[] = [
  'highlight',
  'underline',
  'strikethrough',
  'note',
  'area',
  'ink',
];

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** 撤销栈按整份标注数组存快照；50 步足够覆盖一次阅读里的误操作，内存也不至于失控。 */
const HISTORY_LIMIT = 50;

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

/** 输入控件内的按键属于文本编辑，阅读器快捷键不能拦截。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable
  );
}

function annotationKindLabel(kind: AnnotationKind): string {
  switch (kind) {
    case 'underline':
      return '下划线';
    case 'strikethrough':
      return '删除线';
    case 'note':
      return '批注';
    case 'area':
      return '区域';
    case 'ink':
      return '墨迹';
    default:
      return '高亮';
  }
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
  const [renderQuality, setRenderQuality] =
    useState<RenderQuality>(initialRenderQuality);
  const [scanEnhanceDocs, setScanEnhanceDocs] = useState(initialScanEnhanceDocs);

  const changeRenderQuality = useCallback((quality: RenderQuality) => {
    setRenderQuality(quality);
    try {
      localStorage.setItem(RENDER_QUALITY_KEY, quality);
    } catch {
      // 隐私模式或存储被禁用时只影响下次启动，不阻止当前切换。
    }
  }, []);

  const [doc, setDoc] = useState<OpenedDoc | null>(null);
  const [sideTab, setSideTab] = useState<'annotations' | 'outline' | 'pages'>('annotations');
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const scanEnhance = doc ? scanEnhanceDocs[doc.id] === true : false;

  const changeScanEnhance = useCallback(
    (enabled: boolean) => {
      if (!doc) return;
      setScanEnhanceDocs((current) => {
        const next = { ...current };
        if (enabled) next[doc.id] = true;
        else delete next[doc.id];
        return next;
      });
    },
    [doc],
  );

  useEffect(() => {
    persistScanEnhanceDocs(scanEnhanceDocs);
  }, [scanEnhanceDocs]);

  useEffect(() => {
    // 拖动过程中宽度每帧都在变，松手后再写一次，别让 localStorage 跟着每帧写入。
    if (sidebarResizing) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)));
    } catch {
      // 存储不可用时只影响下次启动的宽度记忆。
    }
  }, [sidebarWidth, sidebarResizing]);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      sidebarDrag.current = { startX: event.clientX, startWidth: sidebarWidth };
      setSidebarResizing(true);
    },
    [sidebarWidth],
  );

  const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current;
    if (!drag) return;
    const workspace = event.currentTarget.parentElement;
    // 至少给阅读区留 360px，窗口变窄时也不会把正文挤没。
    const max = workspace
      ? Math.max(SIDEBAR_MIN_WIDTH, workspace.clientWidth - 360)
      : SIDEBAR_MAX_WIDTH;
    const next = Math.min(
      Math.max(drag.startWidth - (event.clientX - drag.startX), SIDEBAR_MIN_WIDTH),
      Math.min(max, SIDEBAR_MAX_WIDTH),
    );
    setSidebarWidth(next);
  }, []);

  const endSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDrag.current) return;
    sidebarDrag.current = null;
    setSidebarResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [scale, setScale] = useState(1.2);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [hoverConfirmDelete, setHoverConfirmDelete] = useState(false);
  const hoverHideTimer = useRef<number | null>(null);
  const [pdfImport, setPdfImport] = useState<PdfImportSummary | null>(null);
  const [pdfImportBusy, setPdfImportBusy] = useState(false);
  const [pdfImportProgress, setPdfImportProgress] = useState('');
  const pdfScanRef = useRef<NativeScan | null>(null);
  const [rowLimit, setRowLimit] = useState(SIDEBAR_PAGE);
  const pendingRevealRef = useRef<string | null>(null);
  const [pageNativeCount, setPageNativeCount] = useState(0);
  const [pageHintDismissed, setPageHintDismissed] = useState<Set<number>>(new Set());
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
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findResults, setFindResults] = useState<FindMatch[]>([]);
  const [findIndex, setFindIndex] = useState(-1);
  const [findBusy, setFindBusy] = useState(false);
  const [findProgress, setFindProgress] = useState({ done: 0, total: 0 });
  const [findTruncated, setFindTruncated] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const [filterColor, setFilterColor] = useState<HighlightColor | null>(null);
  const [filterKind, setFilterKind] = useState<AnnotationKind | null>(null);
  const [filterSource, setFilterSource] = useState<'all' | 'manual' | 'imported'>('all');
  const [helpOpen, setHelpOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRoot, setSettingsRoot] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [libraryBusy, setLibraryBusy] = useState<
    'scanning' | 'switching' | 'exporting' | null
  >(null);
  /** 书库扫描或切换后强制重挂书库/复习视图，重新读取索引。 */
  const [libraryKey, setLibraryKey] = useState(0);
  /** 只在页面比阅读区宽（高倍缩放）时允许触摸横向平移，避免平时滑动误触横移。 */
  const [panXAllowed, setPanXAllowed] = useState(false);

  const findInputRef = useRef<HTMLInputElement>(null);
  const findTokenRef = useRef(0);
  const pageTextsRef = useRef<Map<number, string>>(new Map());
  const textCacheLoadedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recordRef = useRef<DocRecord | null>(null);
  const docRef = useRef<OpenedDoc | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  // 每条记录都是一份完整的标注数组；所有改动都走不可变更新，快照可以安全复用。
  const undoRef = useRef<Annotation[][]>([]);
  const redoRef = useRef<Annotation[][]>([]);
  const savingRef = useRef(0);
  // 书签保存是并发命令：用序号丢弃过期响应，避免较早的保存或回滚覆盖较新的编辑。
  const bookmarkSaveSeq = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const viewerRef = useRef<HTMLElement | null>(null);
  const currentPageRef = useRef(0);
  const scaleRef = useRef(scale);
  /** 缩放目标：连按时按目标累加，渲染等 140ms 空闲后只做一次。 */
  const zoomTargetRef = useRef(scale);
  const zoomTimerRef = useRef<number | null>(null);
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

  // 适宽时锁死横向触摸；只有页面真的超出阅读区才放开横向平移。
  useEffect(() => {
    if (!doc) {
      setPanXAllowed(false);
      return;
    }
    const viewer = viewerRef.current;
    if (!viewer) return;

    const frame = requestAnimationFrame(() => {
      setPanXAllowed(viewer.scrollWidth > viewer.clientWidth + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [baseSize, doc, scale]);

  // 自适应缩放或文档切换会直接改 scale；此时目标值跟着同步。
  useEffect(() => {
    zoomTargetRef.current = scale;
  }, [scale]);

  // 自适应缩放：首屏按页面尺寸算出比例，窗口变化时重算。
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!doc || !baseSize || zoomMode === 'custom' || !viewer) return;

    let frame = 0;

    const update = () => {
      const next = fitScale(viewer, baseSize, zoomMode);
      // 切回适宽/整页时取消待执行的缩放，避免防抖计时器随后覆盖。
      if (zoomTimerRef.current !== null) {
        window.clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = null;
      }
      zoomTargetRef.current = next;
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

  // 索引重建、设置回退这类启动事件要告诉用户，否则他们只会看到「书库空了」。
  useEffect(() => {
    if (!desktop) return;
    void startupNotice()
      .then((notice) => {
        if (notice) setMessage(notice);
      })
      .catch(() => undefined);
  }, [desktop]);

  // 更新只在用户点按钮时联网：应用默认仍然不发任何请求。
  const handleUpdate = useCallback(async () => {
    if (!desktop || checkingUpdate || installingUpdate) return;

    if (availableUpdate) {
      setInstallingUpdate(true);
      setMessage('正在下载更新…');
      try {
        await installUpdate(availableUpdate.update, (percent) => {
          setMessage(percent === null ? '正在下载更新…' : `正在下载更新 ${percent}%…`);
        });
      } catch (error) {
        setInstallingUpdate(false);
        setMessage(`更新失败：${errorText(error)}`);
      }
      return;
    }

    setCheckingUpdate(true);
    try {
      const found = await findUpdate();
      if (found) {
        setAvailableUpdate(found);
        setMessage(`发现新版本 ${found.version}，再次点击更新按钮开始下载。`);
      } else {
        setMessage('已是最新版本。');
      }
    } catch (error) {
      console.error('检查更新失败', error);
      const detail = errorText(error);
      setMessage(
        /request|network|timed? ?out|connect|dns/i.test(detail)
          ? '检查更新失败：连不上 GitHub，请检查网络或代理后再试。'
          : `检查更新失败：${detail}`,
      );
    } finally {
      setCheckingUpdate(false);
    }
  }, [availableUpdate, checkingUpdate, desktop, installingUpdate]);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    if (!desktop) return;
    if (!settingsRoot) {
      void libraryRoot()
        .then(setSettingsRoot)
        .catch(() => undefined);
    }
    if (!appVersion) {
      void getVersion()
        .then(setAppVersion)
        .catch(() => undefined);
    }
  }, [appVersion, desktop, settingsRoot]);

  const handleSettingsScan = useCallback(async () => {
    if (!desktop || libraryBusy) return;
    setLibraryBusy('scanning');
    setMessage('正在重新扫描书库…');
    try {
      const report = await scanLibrary();
      setSettingsRoot(report.root);
      setLibraryKey((key) => key + 1);
      setMessage(`扫描完成：${report.documents} 份文档，${report.annotations} 条标注`);
    } catch (error) {
      setMessage(`扫描失败：${errorText(error)}`);
    } finally {
      setLibraryBusy(null);
    }
  }, [desktop, libraryBusy]);

  const handleSettingsChangeRoot = useCallback(async () => {
    if (!desktop || libraryBusy) return;
    try {
      const path = await pickDirectory('选择书库目录');
      if (!path) return;
      if (path === settingsRoot) {
        setMessage('这个目录已经是当前书库');
        return;
      }

      setLibraryBusy('switching');
      setMessage('正在切换书库并重建索引…');
      const report = await setLibraryRoot(path);
      setSettingsRoot(report.root);
      setLibraryKey((key) => key + 1);
      setMessage(`书库已切换到 ${report.root}`);
    } catch (error) {
      setMessage(`切换书库失败：${errorText(error)}`);
    } finally {
      setLibraryBusy(null);
    }
  }, [desktop, libraryBusy, settingsRoot]);

  const handleSettingsExport = useCallback(async () => {
    if (!desktop || libraryBusy) return;
    try {
      const path = await pickMarkdownPath();
      if (!path) return;
      setLibraryBusy('exporting');
      await exportMarkdown(path);
      setMessage(`已导出 Markdown：${path}`);
    } catch (error) {
      setMessage(`导出失败：${errorText(error)}`);
    } finally {
      setLibraryBusy(null);
    }
  }, [desktop, libraryBusy]);

  const handleExportPdf = useCallback(async () => {
    const current = docRef.current;
    if (!current || exportingPdf) return;

    const defaultName = `${current.name.replace(/\.pdf$/i, '')}-标注.pdf`;
    try {
      const path = await pickPdfSavePath(defaultName);
      if (!path) return;

      setExportingPdf(true);
      setMessage('正在导出带标注的 PDF…');
      const result = await exportAnnotatedPdf(current.id, path);
      setMessage(`${result}：${path}`);
    } catch (error) {
      setMessage(`导出 PDF 失败：${errorText(error)}`);
    } finally {
      setExportingPdf(false);
    }
  }, [exportingPdf]);

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
    (mode: 'qa' | 'explain', anchor?: Anchor, contextText?: string) => {
      if (!docRef.current) return;
      if (!ai?.ready) {
        setMessage('请先在 AI 设置中启用并填写 API Key。');
        void openAiSettings();
        return;
      }

      if (mode === 'explain' && anchor) {
        // 优先用阅读器给出的宽上下文；没有时退回锚点自带的前后 24 字。
        const context =
          contextText?.trim() ||
          [anchor.prefix.trim(), anchor.suffix.trim()].filter(Boolean).join('\n…\n');
        setAiPanel({
          mode: 'explain',
          page: anchor.page,
          quote: anchor.quote,
          context,
        });
        setToolbar(null);
        setHover(null);
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

  const kindsPresent = useMemo(() => {
    const present = new Set(visible.map((annotation) => annotation.kind));
    return KIND_ORDER.filter((kind) => present.has(kind));
  }, [visible]);

  const hasImported = useMemo(
    () => visible.some((annotation) => annotation.tags.includes(PDF_IMPORT_TAG)),
    [visible],
  );

  const filtered = useMemo(
    () =>
      visible.filter(
        (annotation) =>
          (!filterColor || annotation.color === filterColor) &&
          (!filterKind || annotation.kind === filterKind) &&
          (filterSource === 'all' ||
            (filterSource === 'imported') === annotation.tags.includes(PDF_IMPORT_TAG)),
      ),
    [visible, filterColor, filterKind, filterSource],
  );

  const currentPageHasImported = useMemo(
    () =>
      visible.some(
        (annotation) =>
          annotation.page === currentPage && annotation.tags.includes(PDF_IMPORT_TAG),
      ),
    [visible, currentPage],
  );

  /** 侧栏按页分组，组头可直接跳到对应页。 */
  const allGroups = useMemo(() => groupAnnotations(visible), [visible]);
  const groups = useMemo(() => groupAnnotations(filtered), [filtered]);
  const allGroupsRef = useRef(allGroups);
  allGroupsRef.current = allGroups;

  /** 严格按卡片上限渲染；同一页标注很多时先显示前一部分，组头仍显示总数。 */
  const visibleGroups = useMemo(() => {
    const result: { page: number; total: number; items: Annotation[] }[] = [];
    let remaining = rowLimit;
    for (const [page, items] of groups) {
      if (remaining <= 0) break;
      const take = Math.min(items.length, remaining);
      result.push({ page, total: items.length, items: items.slice(0, take) });
      remaining -= take;
    }
    return result;
  }, [groups, rowLimit]);

  const renderedCards = useMemo(
    () => visibleGroups.reduce((total, group) => total + group.items.length, 0),
    [visibleGroups],
  );
  const hasMoreGroups = renderedCards < filtered.length;

  const loadMoreAnnotations = useCallback(() => {
    setRowLimit((current) => (current >= filtered.length ? current : current + SIDEBAR_PAGE));
  }, [filtered.length]);

  /** 从悬停工具或新批注跳到侧栏卡片时，确保它已经渲染；被筛选隐藏时先清筛选。 */
  const revealAnnotation = useCallback(
    (id: string) => {
      const inFiltered = groups.some(([, items]) => items.some((item) => item.id === id));
      if (!inFiltered) {
        const inAll = allGroups.some(([, items]) => items.some((item) => item.id === id));
        if (!inAll) return;
        if (filterColor || filterKind || filterSource !== 'all') {
          pendingRevealRef.current = id;
          setFilterColor(null);
          setFilterKind(null);
          setFilterSource('all');
          return;
        }
      }

      let cards = 0;
      for (const [, items] of inFiltered ? groups : allGroups) {
        cards += items.length;
        if (items.some((item) => item.id === id)) {
          setRowLimit((current) => Math.max(current, cards));
          return;
        }
      }
    },
    [allGroups, filterColor, filterKind, filterSource, groups],
  );

  // 编辑某条批注时，用最新分组把卡片渲染出来；只在 editingId 变化时触发，
  // 避免用户随后改筛选又被强行清掉。
  const revealRef = useRef(revealAnnotation);
  revealRef.current = revealAnnotation;
  useEffect(() => {
    if (editingId) revealRef.current(editingId);
  }, [editingId]);

  const handleAnnotationScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      if (element.scrollTop + element.clientHeight < element.scrollHeight - 600) return;
      loadMoreAnnotations();
    },
    [loadMoreAnnotations],
  );

  const clearFilters = useCallback(() => {
    setFilterColor(null);
    setFilterKind(null);
    setFilterSource('all');
  }, []);

  // 放大后一页可达数千像素；减少同时渲染的页数，避免画布内存再次爆掉。
  const pageHeight = baseSize ? baseSize.height * scale : 0;
  const activeRadius = pageHeight > 1100 ? 1 : 2;
  // 只挂载当前页附近的 PdfPage；其余页用等尺寸占位 div 撑住滚动高度，
  // 500 页的书 DOM 从 500 个组件降到十几个。
  const pageMountWindow = activeRadius + 4;
  // 提前取出，避免在 JSX 回调里丢失非空收窄。
  const activePdf = doc?.pdf ?? null;

  const syncHistory = useCallback(() => {
    setHistoryDepth({ undo: undoRef.current.length, redo: redoRef.current.length });
  }, []);

  const resetHistory = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    syncHistory();
  }, [syncHistory]);

  const commit = useCallback(
    (next: Annotation[], record = true) => {
      if (record) {
        undoRef.current.push(annotationsRef.current);
        if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
        redoRef.current = [];
        syncHistory();
      }

      annotationsRef.current = next;
      setAnnotations(next);
      if (isTauri()) return;

      const recordDoc = recordRef.current;
      if (recordDoc) {
        recordDoc.annotations = next;
        saveDoc(recordDoc);
      }
    },
    [syncHistory],
  );

  const beginSave = useCallback(() => {
    savingRef.current += 1;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveState('saving');
  }, []);

  const endSave = useCallback(() => {
    savingRef.current = Math.max(0, savingRef.current - 1);
    if (savingRef.current > 0) return;
    setSaveState('saved');
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      setSaveState('idle');
    }, 1600);
  }, []);

  const resetSaveState = useCallback(() => {
    savingRef.current = 0;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveState('idle');
  }, []);

  const persistAnnotation = useCallback(
    async (docId: string, annotation: Annotation) => {
      beginSave();
      try {
        await upsertAnnotation(docId, annotation);
      } catch (error) {
        setMessage(`保存标注失败：${errorText(error)}`);
      } finally {
        endSave();
      }
    },
    [beginSave, endSave],
  );

  const removeFromLibrary = useCallback(
    async (docId: string, id: string) => {
      beginSave();
      try {
        await deleteAnnotation(docId, id);
      } catch (error) {
        setMessage(`删除标注失败：${errorText(error)}`);
      } finally {
        endSave();
      }
    },
    [beginSave, endSave],
  );

  const refreshCards = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setCards(await listCards());
    } catch (error) {
      setMessage(`读取卡片失败：${errorText(error)}`);
    }
  }, []);

  /**
   * 撤销/重做共用：写回目标快照，并把与当前状态的差异落盘。
   * 变更的记录要换新的 updatedAt，否则 sidecar 合并时会输给较新的墓碑。
   */
  const applyHistory = useCallback(
    (target: Annotation[]) => {
      const before = annotationsRef.current;
      const now = Date.now();
      const targetIds = new Set(target.map((item) => item.id));
      const changed: Annotation[] = [];

      const next = target.map((item) => {
        if (before.includes(item)) return item;
        const updated = { ...item, updatedAt: now };
        changed.push(updated);
        return updated;
      });

      // 快照里没有、当前却存在的记录：撤销「添加」时要补一条墓碑。
      for (const item of before) {
        if (targetIds.has(item.id)) continue;
        changed.push({ ...item, deleted: true, updatedAt: now });
      }

      annotationsRef.current = next;
      setAnnotations(next);

      if (!isTauri()) {
        const record = recordRef.current;
        if (record) {
          record.annotations = next;
          saveDoc(record);
        }
        return;
      }

      const docId = docRef.current?.id;
      if (!docId) return;

      beginSave();
      void (async () => {
        try {
          for (const item of changed) {
            try {
              await upsertAnnotation(docId, item);
            } catch (error) {
              setMessage(`保存撤销/重做结果失败：${errorText(error)}`);
              return;
            }
          }
          // 恢复被删标注时 Rust 会让来源卡片重新可用；重新读一次卡片列表。
          void refreshCards();
        } finally {
          endSave();
        }
      })();
    },
    [beginSave, endSave, refreshCards],
  );

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;

    redoRef.current.push(annotationsRef.current);
    if (redoRef.current.length > HISTORY_LIMIT) redoRef.current.shift();
    syncHistory();
    applyHistory(previous);
    setMessage('已撤销上一步标注操作。');
  }, [applyHistory, syncHistory]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;

    undoRef.current.push(annotationsRef.current);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    syncHistory();
    applyHistory(next);
    setMessage('已重做标注操作。');
  }, [applyHistory, syncHistory]);

  const activate = useCallback(async (input: Activation) => {
    if (progressTimer.current !== null) {
      window.clearTimeout(progressTimer.current);
      progressTimer.current = null;
    }
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
    if (zoomTimerRef.current !== null) {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
    pendingAnchor.current = null;
    pinnedPage.current = null;
    docRef.current?.dispose();

    const pdf = input.pdf ?? null;
    const flow = input.flow ?? null;
    const opened: OpenedDoc = {
      id: input.id,
      name: input.name,
      kind: input.kind,
      pageCount: input.pageCount,
      pdf,
      flow,
      bookmarks: input.bookmarks ?? [],
      cover: input.desktopMeta?.cover ? assetUrl(input.desktopMeta.cover) : undefined,
      dispose: () => {
        void input.task?.destroy().catch(() => undefined);
      },
    };
    docRef.current = opened;
    if (input.desktopMeta) recordRef.current = null;

    // PDF 用第一页的原始尺寸作为占位与自适应缩放的基准；流式文档用固定版心。
    let pageSize = flow
      ? { width: FLOW_PAGE_WIDTH, height: 1000 }
      : { width: 595, height: 842 };
    if (pdf) {
      try {
        const first = await pdf.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        pageSize = { width: viewport.width, height: viewport.height };
      } catch {
        // 尺寸只影响缩放基准，失败不阻止打开。
      }
    }
    setBaseSize(pageSize);
    setZoomMode('fit-width');

    const startPage = Math.max(0, Math.min(input.initialPage ?? 0, input.pageCount - 1));
    currentPageRef.current = startPage;
    setCurrentPage(startPage);
    annotationsRef.current = input.annotations;
    setDoc(opened);
    setAnnotations(input.annotations);
    resetHistory();
    resetSaveState();
    setToolbar(null);
    setHover(null);
    setHoverConfirmDelete(false);
    setPdfImport(null);
    setPdfImportProgress('');
    pdfScanRef.current = null;
    setFocusId(null);
    setAiPanel(null);
    setMessage('');
    setSideTab('annotations');
    setOutline([]);
    if (pdf) {
      setOutlineLoading(true);
      void loadOutline(pdf)
        .then((entries) => {
          if (docRef.current?.id === input.id) setOutline(entries);
        })
        .catch(() => undefined)
        .finally(() => {
          if (docRef.current?.id === input.id) setOutlineLoading(false);
        });
    } else {
      // HTML 的标题大纲随解析结果一起返回；TXT 没有目录。
      setOutline(flow?.outline ?? []);
      setOutlineLoading(false);
    }

    requestAnimationFrame(() => {
      if (startPage > 0) scrollToPage(startPage);
      else viewerRef.current?.scrollTo({ top: 0 });
    });

    if (input.desktopMeta) {
      void refreshCards();
      if (pdf) {
        try {
          const metadata = await pdf.getMetadata();
          const info = (metadata.info ?? {}) as { Title?: string; Author?: string };
          await updateDocumentMeta(input.id, {
            pageCount: pdf.numPages,
            title: info.Title,
            author: info.Author,
          });
        } catch {
          // 元数据是锦上添花，失败不影响阅读与标注。
        }
      } else if (flow) {
        // 流式文档的页数由前端分页得出；顺便把正文写进索引，书库搜索立刻可用。
        void updateDocumentMeta(input.id, {
          pageCount: input.pageCount,
          // 只在书库还没有标题/作者时采用 HTML 提取结果，不覆盖用户改过的元数据。
          title: input.desktopMeta.title ? undefined : flow.title,
          author: input.desktopMeta.author ? undefined : flow.author,
        }).catch(() => undefined);
        if (isTauri()) {
          const pages = flow.units.map((unit, index) => ({ page: index, text: unit.text }));
          void (async () => {
            for (let start = 0; start < pages.length; start += 50) {
              await savePageTexts(input.id, pages.slice(start, start + 50)).catch(() => undefined);
            }
            // 同时建立 AI 检索用的分段索引；失败不影响阅读。
            await indexDocumentText(input.id, pages).catch(() => undefined);
          })();
        }
      }
    }
  }, [refreshCards, resetHistory, resetSaveState]);

  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setMessage('正在读取文档…');
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

        if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') {
          const flow = await buildEpubDocument(bytes);
          await activate({
            id: docId,
            name: file.name,
            size: file.size,
            kind: 'epub',
            pageCount: flow.units.length,
            flow,
            annotations: record.annotations,
            bookmarks: [],
          });
          return;
        }

        const text = /\.(txt|html?)$/i.test(file.name) || file.type.startsWith('text/')
          ? new TextDecoder().decode(bytes)
          : null;
        if (text !== null) {
          const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
          const flow = isHtml ? await buildHtmlDocument(text) : buildTextDocument(text);
          await activate({
            id: docId,
            name: file.name,
            size: file.size,
            kind: isHtml ? 'html' : 'txt',
            pageCount: flow.units.length,
            flow,
            annotations: record.annotations,
            bookmarks: [],
          });
          return;
        }

        const task = pdfjsLib.getDocument({ data: bytes.slice(0), ...pdfjsOpenOptions });
        const pdf = await task.promise;
        await activate({
          id: docId,
          name: file.name,
          size: file.size,
          kind: 'pdf',
          pageCount: pdf.numPages,
          pdf,
          task,
          annotations: record.annotations,
          bookmarks: [],
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
        const kind = normalizeDocKind(result.document.kind);
        if (kind === 'txt' || kind === 'html') {
          const text = await readDocumentText(result.document.id);
          const flow =
            kind === 'html' ? await buildHtmlDocument(text) : buildTextDocument(text);
          await activate({
            id: result.document.id,
            name: result.document.name,
            size: result.document.size,
            kind,
            pageCount: flow.units.length,
            flow,
            annotations: result.annotations,
            bookmarks: result.document.bookmarks,
            desktopMeta: result.document,
            initialPage: page ?? result.document.lastPage,
          });
        } else if (kind === 'epub') {
          const response = await fetch(assetUrl(result.document.path));
          if (!response.ok) throw new Error(`读取 EPUB 失败：HTTP ${response.status}`);
          const flow = await buildEpubDocument(await response.arrayBuffer());
          await activate({
            id: result.document.id,
            name: result.document.name,
            size: result.document.size,
            kind,
            pageCount: flow.units.length,
            flow,
            annotations: result.annotations,
            bookmarks: result.document.bookmarks,
            desktopMeta: result.document,
            initialPage: page ?? result.document.lastPage,
          });
        } else {
          const task = pdfjsLib.getDocument({
            url: assetUrl(result.document.path),
            ...pdfjsOpenOptions,
          });
          const pdf = await task.promise;
          await activate({
            id: result.document.id,
            name: result.document.name,
            size: result.document.size,
            kind,
            pageCount: pdf.numPages,
            pdf,
            task,
            annotations: result.annotations,
            bookmarks: result.document.bookmarks,
            desktopMeta: result.document,
            initialPage: page ?? result.document.lastPage,
          });
        }
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
    if (zoomTimerRef.current !== null) {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }

    const finish = () => {
      // 关闭文档后在途的书签保存不应再写回状态。
      bookmarkSaveSeq.current += 1;
      docRef.current?.dispose();
      docRef.current = null;
      recordRef.current = null;
      currentPageRef.current = 0;
      pendingAnchor.current = null;
      pinnedPage.current = null;
      setDoc(null);
      setAnnotations([]);
      resetHistory();
      resetSaveState();
      setToolbar(null);
      setHover(null);
      setHoverConfirmDelete(false);
      setPdfImport(null);
      setPdfImportProgress('');
      pdfScanRef.current = null;
      setFocusId(null);
      setEditingId(null);
      setCurrentPage(0);
      setCards([]);
      setCardEditing(null);
      setAiPanel(null);
      setSideTab('annotations');
      setOutline([]);
      setOutlineLoading(false);
      setHistoryOpen(false);
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
  }, [resetHistory, resetSaveState]);

  const currentBookmark =
    doc?.bookmarks.find((bookmark) => bookmark.page === currentPage) ?? null;

  const persistBookmarks = useCallback(
    async (next: Bookmark[]) => {
      const active = doc;
      if (!active) return;
      const previous = active.bookmarks;
      const seq = bookmarkSaveSeq.current + 1;
      bookmarkSaveSeq.current = seq;
      setDoc((current) =>
        current && current.id === active.id ? { ...current, bookmarks: next } : current,
      );
      if (!isTauri()) return;

      try {
        const updated = await saveBookmarks(active.id, next);
        // 已有更新的保存发出：它的响应/回滚才是当前状态。
        if (bookmarkSaveSeq.current !== seq) return;
        setDoc((current) =>
          current && current.id === active.id
            ? { ...current, bookmarks: updated.bookmarks }
            : current,
        );
      } catch (error) {
        if (bookmarkSaveSeq.current !== seq) return;
        setDoc((current) =>
          current && current.id === active.id
            ? { ...current, bookmarks: previous }
            : current,
        );
        setMessage(`保存书签失败：${errorText(error)}`);
      }
    },
    [doc, setMessage],
  );

  const toggleBookmark = useCallback(() => {
    if (!doc) return;
    const page = currentPageRef.current;
    const exists = doc.bookmarks.some((bookmark) => bookmark.page === page);
    const next = exists
      ? doc.bookmarks.filter((bookmark) => bookmark.page !== page)
      : [
          ...doc.bookmarks,
          {
            id: crypto.randomUUID(),
            page,
            label: `第 ${page + 1} 页`,
            createdAt: Date.now(),
          },
        ].sort((left, right) => left.page - right.page);
    void persistBookmarks(next);
  }, [doc, persistBookmarks]);

  const removeBookmark = useCallback(
    (id: string) => {
      if (!doc) return;
      void persistBookmarks(doc.bookmarks.filter((bookmark) => bookmark.id !== id));
    },
    [doc, persistBookmarks],
  );

  const renameBookmark = useCallback(
    (id: string, label: string) => {
      if (!doc) return;
      const value = label.trim();
      if (!value) return;
      void persistBookmarks(
        doc.bookmarks.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, label: value } : bookmark,
        ),
      );
    },
    [doc, persistBookmarks],
  );

  const handleRestored = useCallback(
    (result: ImportResult) => {
      annotationsRef.current = result.annotations;
      setAnnotations(result.annotations);
      resetHistory();
      resetSaveState();
      setToolbar(null);
      setHover(null);
      setDoc((current) =>
        current && current.id === result.document.id
          ? { ...current, bookmarks: result.document.bookmarks }
          : current,
      );
      void refreshCards();
    },
    [refreshCards, resetHistory, resetSaveState],
  );

  const handleViewerScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const viewer = viewerRef.current;
      if (!viewer || !docRef.current) return;

      // 浮动工具固定在视口坐标上，滚动后若不移除就会悬在错误的位置。
      setToolbar(null);
      if (hoverHideTimer.current !== null) {
        window.clearTimeout(hoverHideTimer.current);
        hoverHideTimer.current = null;
      }
      setHover(null);
      setHoverConfirmDelete(false);

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

  const addAnnotation = useCallback(
    (anchor: Anchor, color: HighlightColor, kind: AnnotationKind, withNote: boolean) => {
      const now = Date.now();
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        page: anchor.page,
        anchor,
        color,
        kind,
        body: '',
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      commit([...annotationsRef.current, annotation]);
      const docId = docRef.current?.id;
      if (isTauri() && docId) void persistAnnotation(docId, annotation);
      setToolbar(null);
      setHover(null);
      window.getSelection()?.removeAllRanges();
      if (withNote) setEditingId(annotation.id);
    },
    [commit, persistAnnotation],
  );

  const updateColor = useCallback(
    (docId: string, id: string, color: HighlightColor) => {
      const existing = annotationsRef.current.find((annotation) => annotation.id === id);
      if (!existing || existing.color === color) return;

      const updated: Annotation = { ...existing, color, updatedAt: Date.now() };
      commit(
        annotationsRef.current.map((annotation) =>
          annotation.id === id ? updated : annotation,
        ),
      );
      if (isTauri()) void persistAnnotation(docId, updated);
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
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    zoomTargetRef.current = clamped;

    const viewer = viewerRef.current;
    const visible = viewer ? visiblePage(viewer) : null;
    if (viewer && visible && Math.abs(clamped - scaleRef.current) >= 0.002) {
      const rect = visible.element.getBoundingClientRect();
      if (rect.height > 0) {
        pendingAnchor.current = {
          index: visible.index,
          offset: (viewer.getBoundingClientRect().top - rect.top) / rect.height,
          scale: clamped,
        };
      }
    }
    setZoomMode('custom');

    // 连按缩放只渲染最终比例：每一步都重绘三张大页会明显卡顿。
    if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      zoomTimerRef.current = null;
      setScale(zoomTargetRef.current);
    }, 140);
  }, []);

  // Ctrl/⌘ + 滚轮缩放阅读区；触控板双指捏合也会以 ctrlKey 的 wheel 事件到达。
  const openDocId = doc?.id;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !openDocId) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // 用指数曲线跟随滚轮/捏合幅度，鼠标一格约 15%，触控板小步长更细腻。
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * 0.0015)));
      zoomTo(+(zoomTargetRef.current * factor).toFixed(3));
    };
    viewer.addEventListener('wheel', onWheel, { passive: false });
    return () => viewer.removeEventListener('wheel', onWheel);
  }, [openDocId, zoomTo]);

  /** 键盘翻页按视口高度滚动，略小于一屏，保留上一页的上下文。 */
  const scrollPages = useCallback((direction: 1 | -1) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.scrollBy({ top: direction * viewer.clientHeight * 0.92, behavior: 'smooth' });
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

  // 换书或关书时清空搜索缓存、结果与侧栏筛选。
  useEffect(() => {
    pageTextsRef.current.clear();
    findTokenRef.current += 1;
    setFindOpen(false);
    setFindQuery('');
    setFindResults([]);
    setFindIndex(-1);
    setSearchTarget(null);
    setFindBusy(false);
    setFindTruncated(false);
    setFilterColor(null);
    setFilterKind(null);
    setFilterSource('all');
    setPageHintDismissed(new Set());
    textCacheLoadedRef.current = false;
    // 流式文档的分页文字本来就在内存里，直接灌进查找缓存，不必再读 SQLite。
    const flow = docRef.current?.flow;
    if (flow) {
      flow.units.forEach((unit, index) => pageTextsRef.current.set(index, unit.text));
      textCacheLoadedRef.current = true;
    }
  }, [doc?.id]);

  // 换书或改筛选后从第一批重新渲染；若刚才是为了显示某张卡片清掉筛选，再补足到它。
  useEffect(() => {
    setRowLimit(SIDEBAR_PAGE);
    const pending = pendingRevealRef.current;
    if (!pending) return;
    pendingRevealRef.current = null;

    let cards = 0;
    for (const [, items] of allGroupsRef.current) {
      cards += items.length;
      if (items.some((item) => item.id === pending)) {
        setRowLimit(Math.max(SIDEBAR_PAGE, cards));
        return;
      }
    }
  }, [doc?.id, filterColor, filterKind, filterSource]);

  // 只查当前页的内嵌标注，给“本页有 N 条可导入”提示用；不扫整本。
  useEffect(() => {
    setPageNativeCount(0);
    if (!doc?.pdf) return;

    let cancelled = false;
    void scanNativePage(doc.pdf, currentPage)
      .then((page) => {
        if (!cancelled && docRef.current?.id === doc.id) setPageNativeCount(page.marks.length);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [doc, currentPage]);

  // 页内查找的文字缓存按文档懒加载：打开查找栏时才读，不拖慢打开文档。
  useEffect(() => {
    if (!findOpen || !doc || !desktop || textCacheLoadedRef.current) return;
    textCacheLoadedRef.current = true;
    const docId = doc.id;
    void loadPageTexts(docId)
      .then((pages) => {
        if (docRef.current?.id !== docId) return;
        for (const page of pages) {
          if (!pageTextsRef.current.has(page.page)) {
            pageTextsRef.current.set(page.page, page.text);
          }
        }
      })
      .catch(() => undefined);
  }, [desktop, doc, findOpen]);

  useEffect(() => {
    if (!findOpen || !doc) return;
    const query = findQuery.trim();
    if (!query) {
      setFindResults([]);
      setFindIndex(-1);
      setSearchTarget(null);
      setFindBusy(false);
      setFindTruncated(false);
      return;
    }

    const token = ++findTokenRef.current;
    setFindBusy(true);
    setFindTruncated(false);
    setFindProgress({ done: 0, total: doc.pageCount });

    const timer = window.setTimeout(() => {
      void (async () => {
        const needle = query.toLowerCase();
        const matches: FindMatch[] = [];
        const docId = doc.id;
        const fresh: PageTextInput[] = [];
        let truncated = false;

        // 本轮新提取的文字写回 SQLite；重复搜索直接走缓存。
        const flush = () => {
          if (fresh.length === 0 || !isTauri()) return;
          const pages = fresh.splice(0);
          void savePageTexts(docId, pages).catch(() => undefined);
        };

        for (let pageIndex = 0; pageIndex < doc.pageCount; pageIndex += 1) {
          if (findTokenRef.current !== token) {
            flush();
            return;
          }

          let text = pageTextsRef.current.get(pageIndex);
          if (text === undefined && doc.pdf) {
            try {
              const page = await doc.pdf.getPage(pageIndex + 1);
              const content = await page.getTextContent();
              const items = (content.items as unknown[]).filter(
                (item): item is PdfTextItem => typeof (item as PdfTextItem).str === 'string',
              );
              text = joinPdfItems(items).text;
              pageTextsRef.current.set(pageIndex, text);
              fresh.push({ page: pageIndex, text });
            } catch (error) {
              console.warn('提取页面文字失败', pageIndex + 1, error);
              text = '';
            }
          }
          if (text === undefined) text = '';

          const haystack = text.toLowerCase();
          let from = 0;
          while (matches.length < 500) {
            const index = haystack.indexOf(needle, from);
            if (index < 0) break;
            matches.push({
              page: pageIndex,
              start: index,
              end: index + needle.length,
              snippet: text
                .slice(Math.max(0, index - 16), Math.min(text.length, index + needle.length + 42))
                .replace(/\s+/g, ' ')
                .trim(),
            });
            from = index + Math.max(1, needle.length);
          }
          if (matches.length >= 500) {
            truncated = true;
            break;
          }
          if (pageIndex % 16 === 0) {
            setFindProgress({ done: pageIndex + 1, total: doc.pageCount });
          }
        }

        flush();
        if (findTokenRef.current !== token) return;
        setFindBusy(false);
        setFindTruncated(truncated);
        setFindResults(matches);
        if (matches.length > 0) {
          setFindIndex(0);
          setSearchTarget({
            page: matches[0].page,
            start: matches[0].start,
            end: matches[0].end,
            token: Date.now(),
          });
          goToPage(matches[0].page);
        } else {
          setFindIndex(-1);
          setSearchTarget(null);
        }
      })();
    }, 250);

    return () => {
      window.clearTimeout(timer);
      findTokenRef.current += 1;
    };
  }, [doc, findOpen, findQuery, goToPage]);

  const stepFind = useCallback(
    (delta: number) => {
      if (findResults.length === 0) return;
      const next = (findIndex + delta + findResults.length) % findResults.length;
      const match = findResults[next];
      setFindIndex(next);
      setSearchTarget({
        page: match.page,
        start: match.start,
        end: match.end,
        token: Date.now(),
      });
      goToPage(match.page);
    },
    [findIndex, findResults, goToPage],
  );

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || !doc) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doc]);

  const handleSelect = useCallback(
    (anchor: Anchor, box: { x: number; y: number }, context: string) => {
      setHover(null);
      setToolbar({
        anchor,
        context,
        x: Math.min(Math.max(box.x, 200), window.innerWidth - 200),
        y: Math.max(box.y, 70),
      });
    },
    [],
  );

  /** 悬停标注时显示快捷工具；空值延迟收起，留出从文字移到工具条的时间。 */
  const handleHover = useCallback(
    (annotation: Annotation | null, box?: { x: number; y: number; below: boolean }, context = '') => {
      if (hoverHideTimer.current !== null) {
        window.clearTimeout(hoverHideTimer.current);
        hoverHideTimer.current = null;
      }

      if (!annotation || !box) {
        hoverHideTimer.current = window.setTimeout(() => {
          hoverHideTimer.current = null;
          setHover(null);
          setHoverConfirmDelete(false);
        }, 200);
        return;
      }

      setHover({
        annotation,
        context,
        x: Math.min(Math.max(box.x, 230), window.innerWidth - 230),
        y: Math.max(box.y, 10),
        below: box.below,
      });
      setHoverConfirmDelete(false);
    },
    [],
  );

  const keepHoverAlive = useCallback(() => {
    if (hoverHideTimer.current !== null) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
  }, []);

  const dismissHover = useCallback(() => {
    if (hoverHideTimer.current !== null) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
    setHover(null);
    setHoverConfirmDelete(false);
  }, []);

  /** 用圆角矩形自己画选区，替代浏览器默认的直角高亮。 */
  const paintSelectionOverlay = useCallback(() => {
    const viewer = viewerRef.current;
    for (const layer of document.querySelectorAll<HTMLElement>('.selection-layer')) {
      layer.replaceChildren();
    }
    const selection = window.getSelection();
    if (!viewer || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!viewer.contains(range.commonAncestorContainer)) return;

    const view = viewer.getBoundingClientRect();
    const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.pdf-page'));
    const pageRects = new Map(pages.map((page) => [page, page.getBoundingClientRect()]));
    const groups = new Map<HTMLElement, SelectionBox[]>();

    for (const rect of Array.from(range.getClientRects())) {
      const left = Math.max(rect.left, view.left);
      const top = Math.max(rect.top, view.top);
      const right = Math.min(rect.right, view.right);
      const bottom = Math.min(rect.bottom, view.bottom);
      if (right - left < 1 || bottom - top < 1) continue;

      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const page = pages.find((element) => {
        const box = pageRects.get(element);
        return box && centerX >= box.left && centerX <= box.right && centerY >= box.top && centerY <= box.bottom;
      });
      if (!page) continue;
      const pageRect = pageRects.get(page);
      if (!pageRect) continue;

      const pageLeft = Math.max(left, pageRect.left);
      const pageTop = Math.max(top, pageRect.top);
      const pageRight = Math.min(right, pageRect.right);
      const pageBottom = Math.min(bottom, pageRect.bottom);
      if (pageRight - pageLeft < 1 || pageBottom - pageTop < 1) continue;

      const boxes = groups.get(page) ?? [];
      boxes.push({
        left: pageLeft - pageRect.left,
        top: pageTop - pageRect.top,
        right: pageRight - pageRect.left,
        bottom: pageBottom - pageRect.top,
      });
      groups.set(page, boxes);
    }

    for (const [page, boxes] of groups) {
      const layer = page.querySelector<HTMLElement>('.selection-layer');
      if (!layer) continue;
      const fragment = document.createDocumentFragment();
      for (const box of mergeSelectionRects(boxes)) {
        const element = document.createElement('div');
        element.className = 'selection-rect';
        element.style.left = `${box.left}px`;
        element.style.top = `${box.top + 1}px`;
        element.style.width = `${box.right - box.left}px`;
        element.style.height = `${Math.max(2, box.bottom - box.top - 2)}px`;
        fragment.append(element);
      }
      layer.replaceChildren(fragment);
    }
  }, []);

  // 取消选择、点空白处、选中别处文字或滚动时，浮动工具都应立刻收起。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('.selection-toolbar, .annotation-toolbar')) return;
      setToolbar(null);
      dismissHover();
    };
    const onSelectionChange = () => {
      paintSelectionOverlay();
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setToolbar(null);
        return;
      }
      const viewer = viewerRef.current;
      if (viewer && !viewer.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        setToolbar(null);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [dismissHover, paintSelectionOverlay]);

  // 滚动和缩放时选区矩形会移动；节流到下一帧重画。
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        paintSelectionOverlay();
      });
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [paintSelectionOverlay]);

  useEffect(() => {
    paintSelectionOverlay();
  }, [doc, scale, paintSelectionOverlay]);

  useEffect(() => {
    if (!hoverConfirmDelete) return;
    const timer = window.setTimeout(() => setHoverConfirmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [hoverConfirmDelete]);

  useEffect(
    () => () => {
      if (hoverHideTimer.current !== null) window.clearTimeout(hoverHideTimer.current);
    },
    [],
  );

  const pdfImportCurrent = useMemo(
    () => pdfImport?.pages.find((item) => item.page === currentPage)?.count ?? 0,
    [currentPage, pdfImport],
  );

  const showPageHint =
    pageNativeCount > 0 &&
    !currentPageHasImported &&
    !pageHintDismissed.has(currentPage) &&
    !pdfImport &&
    !pdfImportProgress &&
    !pdfImportBusy;

  /** 先只扫描注解，不读页面文字；用户确认范围后再建锚点。 */
  const dismissPdfImport = useCallback(() => {
    pdfScanRef.current = null;
    setPdfImport(null);
    setPdfImportProgress('');
  }, []);

  const startPdfImport = useCallback(async () => {
    if (!doc?.pdf || pdfImportBusy) return;

    setPdfImportBusy(true);
    setPdfImport(null);
    setPdfImportProgress('正在检查 PDF 自带标注…');
    try {
      const scan = await scanNativeAnnotations(doc.pdf, (done, total) => {
        setPdfImportProgress(`正在检查 PDF 自带标注 ${done}/${total} 页…`);
      });
      if (docRef.current?.id !== doc.id) return;
      pdfScanRef.current = scan;

      if (scan.total === 0) {
        setMessage('这份 PDF 没有可导入的高亮、下划线或删除线标注。');
        setPdfImportProgress('');
        return;
      }

      setPdfImport({
        total: scan.total,
        annotatedPages: scan.annotatedPages,
        byKind: scan.byKind,
        pages: scan.pages.map((page) => ({ page: page.page, count: page.marks.length })),
      });
      setPdfImportProgress('');
    } catch (error) {
      setMessage(`检查 PDF 标注失败：${errorText(error)}`);
      setPdfImportProgress('');
    } finally {
      setPdfImportBusy(false);
    }
  }, [doc, pdfImportBusy]);

  /** 把选定页面落成文本锚点并批量保存；全量导入与“导入本页”共用。 */
  const persistNativePages = useCallback(
    async (pages: NativePage[]) => {
      const active = doc;
      const pdf = active?.pdf;
      if (!active || !pdf || pages.length === 0) return;

      setPdfImportBusy(true);
      setPdfImportProgress('正在读取页面文字…');
      try {
        const existing = new Set(
          annotationsRef.current.map((annotation) =>
            annotationKey(annotation.page, annotation.anchor.quote),
          ),
        );
        const { drafts, skipped } = await buildImportedAnnotations(
          pdf,
          pages,
          existing,
          (done, total) => setPdfImportProgress(`正在整理 ${done}/${total} 页…`),
        );
        if (docRef.current?.id !== active.id) return;

        if (drafts.length === 0) {
          setMessage(
            skipped > 0
              ? `没有新的标注可导入（跳过 ${skipped} 条重复或无法定位）。`
              : '没有新的标注可导入。',
          );
          dismissPdfImport();
          return;
        }

        const created = draftsToAnnotations(drafts);
        setPdfImportProgress(`正在保存 ${created.length} 条标注…`);
        beginSave();
        try {
          if (isTauri()) await upsertAnnotations(active.id, created);
        } finally {
          endSave();
        }

        commit([...annotationsRef.current, ...created]);
        setFilterColor(null);
        setFilterKind(null);
        setFilterSource('all');
        dismissPdfImport();
        setMessage(
          `已导入 ${created.length} 条 PDF 标注${
            skipped > 0 ? `，跳过 ${skipped} 条重复或无法定位` : ''
          }。`,
        );
      } catch (error) {
        setMessage(`导入 PDF 标注失败：${errorText(error)}`);
        dismissPdfImport();
      } finally {
        setPdfImportBusy(false);
      }
    },
    [beginSave, commit, dismissPdfImport, doc, endSave],
  );

  const runPdfImport = useCallback(
    async (scope: 'all' | 'current') => {
      const scan = pdfScanRef.current;
      if (!scan || !doc || pdfImportBusy) return;

      const pages =
        scope === 'all'
          ? scan.pages
          : scan.pages.filter((page) => page.page === currentPageRef.current);
      if (pages.length === 0) {
        setMessage('当前页没有可导入的 PDF 标注。');
        return;
      }

      await persistNativePages(pages);
    },
    [doc, pdfImportBusy, persistNativePages],
  );

  /** 当前页提示条只读这一页；点“导入本页”直接落库，不先扫整本。 */
  const importCurrentPageNative = useCallback(async () => {
    const active = doc;
    const pdf = active?.pdf;
    if (!active || !pdf || pdfImportBusy) return;

    const pageIndex = currentPageRef.current;
    setPdfImportBusy(true);
    setPdfImportProgress('正在检查本页 PDF 自带标注…');
    try {
      const page = await scanNativePage(pdf, pageIndex);
      if (docRef.current?.id !== active.id) return;
      if (page.marks.length === 0) {
        setMessage('这一页没有 PDF 自带标注。');
        setPdfImportProgress('');
        return;
      }
      await persistNativePages([page]);
    } catch (error) {
      setMessage(`导入 PDF 标注失败：${errorText(error)}`);
      setPdfImportProgress('');
    } finally {
      setPdfImportBusy(false);
    }
  }, [doc, persistNativePages, pdfImportBusy]);

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
        setHover(null);
        setHoverConfirmDelete(false);
        setFindOpen(false);
        setHelpOpen(false);
        // AI 设置叠在设置面板上时，只关最上层，回到设置。
        if (!aiSettingsOpen) setSettingsOpen(false);
        setSearchTarget(null);
        window.getSelection()?.removeAllRanges();
        return;
      }

      // 输入控件里的按键交给文本自身：撤销、空格与翻页都不拦截。
      if (isTypingTarget(event.target)) return;
      // 设置、帮助、版本历史或卡片弹窗打开时，不让快捷键操作后面的文档。
      if (settingsOpen || helpOpen || aiSettingsOpen || cardEditing || historyOpen) return;

      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
          return;
        }
        if (key === 'y') {
          event.preventDefault();
          redo();
          return;
        }

        if (!doc) return;
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          zoomTo(Math.min(MAX_SCALE, +(zoomTargetRef.current + 0.25).toFixed(2)));
        } else if (event.key === '-') {
          event.preventDefault();
          zoomTo(Math.max(MIN_SCALE, +(zoomTargetRef.current - 0.25).toFixed(2)));
        } else if (event.key === '0') {
          event.preventDefault();
          setZoomMode('fit-width');
        }
        return;
      }

      if (!doc) return;
      const key = event.key;
      if (key === 'PageDown' || (key === ' ' && !event.shiftKey)) {
        // 焦点在按钮/链接上时，空格应当触发控件本身。
        if (key === ' ' && (event.target as HTMLElement | null)?.closest('button, a')) return;
        event.preventDefault();
        scrollPages(1);
      } else if (key === 'PageUp' || (key === ' ' && event.shiftKey)) {
        event.preventDefault();
        scrollPages(-1);
      } else if (key === 'j') {
        scrollPages(1);
      } else if (key === 'k') {
        scrollPages(-1);
      } else if (key === 'Home') {
        event.preventDefault();
        goToPage(0);
      } else if (key === 'End') {
        event.preventDefault();
        goToPage(doc.pageCount - 1);
      } else if (key === '?' || (key === '/' && event.shiftKey)) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    aiSettingsOpen,
    cardEditing,
    doc,
    goToPage,
    helpOpen,
    historyOpen,
    redo,
    scrollPages,
    settingsOpen,
    undo,
    zoomTo,
  ]);

  return (
    <div className="app">
      {/* 扫描件增黑：只对 canvas 显示做 gamma，不影响文本层、高亮层与导出。 */}
      <svg className="scan-enhance-filter" width="0" height="0" aria-hidden="true">
        <filter id="glossnote-scan-enhance">
          <feComponentTransfer>
            <feFuncR type="gamma" exponent="1.8" />
            <feFuncG type="gamma" exponent="1.8" />
            <feFuncB type="gamma" exponent="1.8" />
          </feComponentTransfer>
        </filter>
      </svg>
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
              onClick={() => zoomTo(Math.max(MIN_SCALE, +(zoomTargetRef.current - 0.25).toFixed(2)))}
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
              onClick={() => zoomTo(Math.min(MAX_SCALE, +(zoomTargetRef.current + 0.25).toFixed(2)))}
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

        {doc && desktop && saveState !== 'idle' && (
          <span className={`save-state ${saveState}`} aria-live="polite">
            {saveState === 'saving' ? '保存中…' : '已保存'}
          </span>
        )}

        {doc && (
          <div className="history-controls">
            <button
              type="button"
              className="theme-toggle"
              title="撤销 (Ctrl+Z)"
              aria-label="撤销"
              disabled={historyDepth.undo === 0}
              onClick={undo}
            >
              <IconUndo size={16} />
            </button>
            <button
              type="button"
              className="theme-toggle"
              title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
              aria-label="重做"
              disabled={historyDepth.redo === 0}
              onClick={redo}
            >
              <IconRedo size={16} />
            </button>
            <button
              type="button"
              className={`theme-toggle ${currentBookmark ? 'ready' : ''}`}
              title={currentBookmark ? '移除本页书签' : '给本页加书签'}
              aria-label={currentBookmark ? '移除本页书签' : '给本页加书签'}
              aria-pressed={!!currentBookmark}
              onClick={toggleBookmark}
            >
              <IconBookmark size={16} filled={!!currentBookmark} />
            </button>
            {desktop && (
              <button
                type="button"
                className="theme-toggle"
                title="版本历史"
                aria-label="版本历史"
                onClick={() => setHistoryOpen(true)}
              >
                <IconHistory size={16} />
              </button>
            )}
          </div>
        )}

        {doc?.pdf && desktop && (
          <button
            type="button"
            className="theme-toggle"
            title="导出带标注的 PDF"
            aria-label="导出带标注的 PDF"
            disabled={exportingPdf}
            onClick={() => void handleExportPdf()}
          >
            <IconDownload size={16} />
          </button>
        )}

        <button
          type="button"
          className="theme-toggle"
          title="设置"
          aria-label="设置"
          onClick={openSettings}
        >
          <IconSettings size={16} />
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
          accept="application/pdf,.txt,text/plain,.html,.htm,text/html,.epub,application/epub+zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void openFile(file);
          }}
        />
      </header>

      {doc && findOpen && (
        <div className="find-bar" role="search">
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder="在本书中查找…"
            aria-label="在本书中查找"
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                setFindOpen(false);
                setSearchTarget(null);
              }
            }}
          />
          <span className="find-count">
            {findBusy
              ? `搜索中 ${findProgress.done}/${findProgress.total}…`
              : findQuery.trim()
                ? findResults.length > 0
                  ? `${findIndex + 1} / ${findResults.length}${findTruncated ? '+' : ''}`
                  : '无结果'
                : ''}
          </span>
          {!findBusy && findResults[findIndex] && (
            <span className="find-snippet" title={findResults[findIndex].snippet}>
              {findResults[findIndex].snippet}
            </span>
          )}
          <button
            type="button"
            title="上一个"
            aria-label="上一个"
            disabled={findResults.length === 0}
            onClick={() => stepFind(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            title="下一个"
            aria-label="下一个"
            disabled={findResults.length === 0}
            onClick={() => stepFind(1)}
          >
            ↓
          </button>
          <button
            type="button"
            title="关闭"
            aria-label="关闭查找"
            onClick={() => {
              setFindOpen(false);
              setSearchTarget(null);
            }}
          >
            ×
          </button>
        </div>
      )}

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
        <main
          className="workspace"
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <section
            className="viewer"
            ref={viewerRef}
            onScroll={handleViewerScroll}
            data-pan-x={panXAllowed ? 'true' : 'false'}
          >
            {doc.flow &&
              doc.flow.units.map((unit, index) => (
                <FlowPage
                  key={`${doc.id}-${index}`}
                  unit={unit}
                  pageIndex={index}
                  scale={scale}
                  anchorStrategy={textAnchorStrategy}
                  annotations={byPage.get(index) ?? EMPTY}
                  focusId={focusId}
                  onSelect={handleSelect}
                  onHover={handleHover}
                  hoverId={hover?.annotation.id ?? null}
                  onHoverKeepAlive={keepHoverAlive}
                  searchMatch={
                    searchTarget?.page === index
                      ? {
                          start: searchTarget.start,
                          end: searchTarget.end,
                          token: searchTarget.token,
                        }
                      : undefined
                  }
                />
              ))}
            {activePdf &&
              baseSize &&
              Array.from({ length: doc.pageCount }, (_, index) => {
                if (Math.abs(index - currentPage) > pageMountWindow) {
                  const size = cachedPageSize(activePdf, index) ?? baseSize;
                  return (
                    <div
                      key={`${doc.id}-${index}`}
                      className="pdf-page"
                      data-page-index={index}
                      style={{
                        width: Math.round(size.width * scale),
                        height: Math.round(size.height * scale),
                      }}
                    >
                      <span className="page-number">{index + 1}</span>
                    </div>
                  );
                }
                return (
                  <PdfPage
                    key={`${doc.id}-${index}`}
                    pdf={activePdf}
                    pageIndex={index}
                    scale={scale}
                    baseSize={baseSize}
                    active={Math.abs(index - currentPage) <= activeRadius}
                    priority={index === currentPage}
                    pixelBudget={renderQuality === 'high' ? 32_000_000 : 16_000_000}
                    scanEnhance={scanEnhance}
                    annotations={byPage.get(index) ?? EMPTY}
                    preview={index === 0 ? doc.cover : undefined}
                    anchorStrategy={textAnchorStrategy}
                    focusId={focusId}
                    onSelect={handleSelect}
                    onHover={handleHover}
                    hoverId={hover?.annotation.id ?? null}
                    onHoverKeepAlive={keepHoverAlive}
                    searchMatch={
                      searchTarget?.page === index
                        ? {
                            start: searchTarget.start,
                            end: searchTarget.end,
                            token: searchTarget.token,
                          }
                        : undefined
                    }
                  />
                );
              })}
          </section>

          <div
            className={`sidebar-resizer ${sidebarResizing ? 'dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整标注栏宽度"
            title="拖动调整标注栏宽度，双击恢复默认"
            onPointerDown={startSidebarResize}
            onPointerMove={moveSidebarResize}
            onPointerUp={endSidebarResize}
            onPointerCancel={endSidebarResize}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          />

          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>
                {sideTab === 'annotations'
                  ? '标注'
                  : sideTab === 'outline'
                    ? '目录'
                    : '页面'}
              </h2>
              {sideTab === 'annotations' && (
                <span
                  className="count"
                  title={
                    filtered.length === visible.length
                      ? undefined
                      : `已筛选 ${filtered.length} 条，共 ${visible.length} 条`
                  }
                >
                  {filtered.length === visible.length
                    ? visible.length
                    : `${filtered.length} / ${visible.length}`}
                </span>
              )}
              <PageJump
                currentPage={currentPage}
                pageCount={doc.pageCount}
                onJump={goToPage}
              />
              {doc.pdf && (
                <button
                  type="button"
                  className="ai-head-button import-head-button"
                  title="导入 PDF 内置的高亮、下划线与删除线"
                  disabled={pdfImportBusy}
                  onClick={() => void startPdfImport()}
                >
                  <IconDownload size={12} />
                  导入 PDF
                </button>
              )}
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

            <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === 'annotations'}
                className={sideTab === 'annotations' ? 'active' : ''}
                onClick={() => setSideTab('annotations')}
              >
                标注
                <span className="tab-count">{filtered.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === 'outline'}
                className={sideTab === 'outline' ? 'active' : ''}
                onClick={() => setSideTab('outline')}
              >
                <IconList size={13} />
                目录
              </button>
              {doc.pdf && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={sideTab === 'pages'}
                  className={sideTab === 'pages' ? 'active' : ''}
                  onClick={() => setSideTab('pages')}
                >
                  <IconPages size={13} />
                  页面
                </button>
              )}
            </div>

            {/* 导入入口在侧栏头部，横幅必须对所有标签页可见，否则在目录/页面页触发后看不到进度与确认。 */}
            {(pdfImport || pdfImportProgress) && (
              <div className="pdf-import-banner">
                {pdfImportProgress ? (
                  <p>{pdfImportProgress}</p>
                ) : pdfImport ? (
                  <>
                    <p>
                      PDF 自带 <strong>{pdfImport.total}</strong> 条标注（
                      {pdfImport.byKind.highlight} 高亮
                      {pdfImport.byKind.underline > 0
                        ? ` · ${pdfImport.byKind.underline} 下划线`
                        : ''}
                      {pdfImport.byKind.strikethrough > 0
                        ? ` · ${pdfImport.byKind.strikethrough} 删除线`
                        : ''}
                      ，共 {pdfImport.annotatedPages} 页）。已有相同文字的标注会跳过。
                    </p>
                    <div className="pdf-import-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={pdfImportBusy}
                        onClick={() => void runPdfImport('all')}
                      >
                        全部导入
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={pdfImportBusy || pdfImportCurrent === 0}
                        onClick={() => void runPdfImport('current')}
                      >
                        仅本页 {pdfImportCurrent} 条
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={pdfImportBusy}
                        onClick={dismissPdfImport}
                      >
                        忽略
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            )}

            {sideTab === 'annotations' ? (
              <>
            {showPageHint && (
              <div className="pdf-page-hint">
                <span>本页有 {pageNativeCount} 条 PDF 自带标注</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void importCurrentPageNative()}
                >
                  导入本页
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="不再提示本页"
                  aria-label="忽略本页提示"
                  onClick={() =>
                    setPageHintDismissed((current) => new Set(current).add(currentPage))
                  }
                >
                  ×
                </button>
              </div>
            )}

            {visible.length > 0 && (
              <div className="sidebar-filters">
                <button
                  type="button"
                  className={`filter-all ${
                    filterColor === null && filterKind === null && filterSource === 'all'
                      ? 'active'
                      : ''
                  }`}
                  onClick={clearFilters}
                >
                  全部
                </button>
                <span className="filter-dots">
                  {COLORS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`filter-dot ${option.key} ${
                        filterColor === option.key ? 'active' : ''
                      }`}
                      title={`只看${option.label}`}
                      aria-label={`只看${option.label}`}
                      aria-pressed={filterColor === option.key}
                      onClick={() =>
                        setFilterColor((current) =>
                          current === option.key ? null : option.key,
                        )
                      }
                    />
                  ))}
                </span>
                {kindsPresent.length > 1 && (
                  <select
                    className="filter-kind"
                    aria-label="按类型筛选"
                    value={filterKind ?? ''}
                    onChange={(event) =>
                      setFilterKind((event.target.value || null) as AnnotationKind | null)
                    }
                  >
                    <option value="">全部类型</option>
                    {kindsPresent.map((kind) => (
                      <option key={kind} value={kind}>
                        {annotationKindLabel(kind)}
                      </option>
                    ))}
                  </select>
                )}
                {hasImported && (
                  <select
                    className="filter-source"
                    aria-label="按来源筛选"
                    value={filterSource}
                    onChange={(event) =>
                      setFilterSource(
                        event.target.value as 'all' | 'manual' | 'imported',
                      )
                    }
                  >
                    <option value="all">全部来源</option>
                    <option value="manual">手工标注</option>
                    <option value="imported">PDF 导入</option>
                  </select>
                )}
              </div>
            )}

            {visible.length === 0 ? (
              <p className="sidebar-hint">
                选中正文即可高亮；点浮动栏里的「批注」写下你的想法。
                {doc.pdf && 'PDF 文件自带的高亮可用右上角「导入 PDF」收进来；'}
                所有标注会在刷新、缩放后回到原来的位置。
              </p>
            ) : filtered.length === 0 ? (
              <p className="sidebar-hint">
                没有符合筛选条件的标注。
                <button type="button" className="link-button" onClick={clearFilters}>
                  清除筛选
                </button>
              </p>
            ) : (
              <div className="annotation-list" onScroll={handleAnnotationScroll}>
                {visibleGroups.map(({ page, total, items }) => (
                  <section className="annotation-group" key={page}>
                    <button
                      type="button"
                      className="annotation-group-head"
                      title={`跳到第 ${page + 1} 页`}
                      onClick={() => goToPage(page)}
                    >
                      <span>第 {page + 1} 页</span>
                      <span className="group-count">{total}</span>
                    </button>
                    {items.map((annotation) => (
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
                        onColor={(color) => updateColor(doc.id, annotation.id, color)}
                      />
                    ))}
                  </section>
                ))}
                {hasMoreGroups && (
                  <button
                    type="button"
                    className="annotation-more"
                    onClick={loadMoreAnnotations}
                  >
                    加载更多标注…
                  </button>
                )}
              </div>
            )}
              </>
            ) : sideTab === 'outline' ? (
              <OutlinePanel
                outline={outline}
                loading={outlineLoading}
                bookmarks={doc.bookmarks}
                currentPage={currentPage}
                onJump={goToPage}
                onToggleBookmark={toggleBookmark}
                onRemoveBookmark={removeBookmark}
                onRenameBookmark={renameBookmark}
              />
            ) : activePdf ? (
              <PageThumbnails
                key={doc.id}
                pdf={activePdf}
                pageCount={doc.pageCount}
                currentPage={currentPage}
                bookmarks={doc.bookmarks}
                onJump={goToPage}
              />
            ) : null}

            <div className="sidebar-foot">
              {desktop
                ? '标注写入本地 SQLite，并镜像到书库的 sidecar。'
                : '浏览器原型暂存于 localStorage；桌面版写入 SQLite 与 sidecar。'}
            </div>
          </aside>
        </main>
      ) : desktop ? (
        view === 'review' ? (
          <Review key={libraryKey} onOpenDoc={openById} onMessage={setMessage} />
        ) : (
          <Library key={libraryKey} onOpen={openById} onMessage={setMessage} />
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
          role="toolbar"
          aria-label="标注工具"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {COLORS.map((color) => (
            <button
              key={color.key}
              type="button"
              className={`swatch ${color.key}`}
              title={color.label}
              aria-label={color.label}
              onClick={() => addAnnotation(toolbar.anchor, color.key, 'highlight', false)}
            />
          ))}
          <span className="toolbar-sep" />
          <button
            type="button"
            className="toolbar-note"
            title="在选中文字下方画线"
            onClick={() => addAnnotation(toolbar.anchor, 'blue', 'underline', false)}
          >
            <span className="kind-preview underline">下划线</span>
          </button>
          <button
            type="button"
            className="toolbar-note"
            title="给选中文字加删除线"
            onClick={() => addAnnotation(toolbar.anchor, 'pink', 'strikethrough', false)}
          >
            <span className="kind-preview strike">删除线</span>
          </button>
          <span className="toolbar-sep" />
          <button
            type="button"
            className="toolbar-note"
            onClick={() => addAnnotation(toolbar.anchor, 'yellow', 'highlight', true)}
          >
            批注
          </button>
          {desktop && (
            <>
              <span className="toolbar-sep" />
              <button
                type="button"
                className="toolbar-note ai"
                onClick={() => openAssistant('explain', toolbar.anchor, toolbar.context)}
              >
                <IconSparkles size={13} />
                AI 解释
              </button>
            </>
          )}
        </div>
      )}

      {doc && hover && !toolbar && (
        <div
          className={`selection-toolbar annotation-toolbar${hover.below ? ' below' : ''}`}
          role="toolbar"
          aria-label="标注快捷工具"
          style={{ left: hover.x, top: hover.y }}
          data-hover-id={hover.annotation.id}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => {
            if (hoverHideTimer.current !== null) {
              window.clearTimeout(hoverHideTimer.current);
              hoverHideTimer.current = null;
            }
          }}
          onMouseLeave={() => handleHover(null)}
        >
          {COLORS.map((color) => (
            <button
              key={color.key}
              type="button"
              className={`swatch ${color.key}${hover.annotation.color === color.key ? ' active' : ''}`}
              title={`改为${color.label}`}
              aria-label={`改为${color.label}`}
              aria-pressed={hover.annotation.color === color.key}
              onClick={() => {
                updateColor(doc.id, hover.annotation.id, color.key);
                setHover((current) =>
                  current && current.annotation.id === hover.annotation.id
                    ? { ...current, annotation: { ...current.annotation, color: color.key } }
                    : current,
                );
              }}
            />
          ))}
          <span className="toolbar-sep" />
          <button
            type="button"
            className="toolbar-note"
            title="在右侧写批注"
            onClick={() => {
              setEditingId(hover.annotation.id);
              dismissHover();
            }}
          >
            批注
          </button>
          {desktop && (
            <>
              <span className="toolbar-sep" />
              <button
                type="button"
                className="toolbar-note ai"
                onClick={() => {
                  dismissHover();
                  openAssistant('explain', hover.annotation.anchor, hover.context);
                }}
              >
                <IconSparkles size={13} />
                AI 解释
              </button>
            </>
          )}
          <span className="toolbar-sep" />
          <button
            type="button"
            className={`toolbar-note ${hoverConfirmDelete ? 'danger' : ''}`}
            title={hoverConfirmDelete ? '再点一次删除这条标注' : '删除标注'}
            onClick={() => {
              if (!hoverConfirmDelete) {
                setHoverConfirmDelete(true);
                return;
              }
              removeAnnotation(doc.id, hover.annotation.id);
              dismissHover();
            }}
          >
            {hoverConfirmDelete ? '确认删除' : '删除'}
          </button>
        </div>
      )}

      {doc && aiPanel && (
        <AiPanel
          key={`${doc.id}:${aiPanel.mode}:${aiPanel.mode === 'explain' ? aiPanel.page : ''}`}
          docId={doc.id}
          docName={doc.name}
          pdf={activePdf}
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

      {historyOpen && doc && (
        <HistoryModal
          docId={doc.id}
          docName={doc.name}
          onClose={() => setHistoryOpen(false)}
          onRestored={handleRestored}
          onMessage={setMessage}
        />
      )}

      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="shortcut-card"
            role="dialog"
            aria-modal="true"
            aria-label="快捷键"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <h2>快捷键</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setHelpOpen(false)}
              >
                ×
              </button>
            </header>
            <ShortcutList />
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          desktop={desktop}
          theme={theme}
          onTheme={setTheme}
          renderQuality={renderQuality}
          onRenderQuality={changeRenderQuality}
          scanEnhance={scanEnhance}
          onScanEnhance={changeScanEnhance}
          ai={ai}
          onOpenAi={() => void openAiSettings()}
          docOpen={!!doc}
          libraryRoot={settingsRoot}
          libraryBusy={libraryBusy}
          onScanLibrary={() => void handleSettingsScan()}
          onChangeLibrary={() => void handleSettingsChangeRoot()}
          onExportMarkdown={() => void handleSettingsExport()}
          version={appVersion}
          update={availableUpdate}
          checkingUpdate={checkingUpdate}
          installingUpdate={installingUpdate}
          onCheckUpdate={() => void handleUpdate()}
          onClose={() => setSettingsOpen(false)}
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
  onColor: (color: HighlightColor) => void;
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
  onColor,
}: AnnotationCardProps) {
  const [draft, setDraft] = useState(annotation.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const articleRef = useRef<HTMLElement>(null);
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
    if (!editing) return;
    articleRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    textareaRef.current?.focus();
  }, [editing]);

  // 删除标注会同步墓碑到 sidecar，先让用户点第二次确认；4 秒内没点就收回。
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  useEffect(() => {
    if (!paletteOpen) return;
    const close = () => setPaletteOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [paletteOpen]);

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
    <article ref={articleRef} className="annotation-card" onClick={onJump}>
      <header className="annotation-head">
        <span className="annotation-color">
          <button
            type="button"
            className={`color-dot ${annotation.color}`}
            title="更换颜色"
            aria-label="更换颜色"
            onClick={(event) => {
              event.stopPropagation();
              setPaletteOpen((open) => !open);
            }}
          />
          {paletteOpen && (
            <span className="color-menu" onClick={(event) => event.stopPropagation()}>
              {COLORS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`swatch ${option.key}`}
                  title={option.label}
                  aria-label={option.label}
                  onClick={() => {
                    onColor(option.key);
                    setPaletteOpen(false);
                  }}
                />
              ))}
            </span>
          )}
        </span>
        {annotation.kind !== 'highlight' && (
          <span className="annotation-kind">{annotationKindLabel(annotation.kind)}</span>
        )}
        <button
          type="button"
          className={`icon-button ${confirmingDelete ? 'confirming' : ''}`}
          title={confirmingDelete ? '再次点击删除这条标注' : '删除标注'}
          onClick={(event) => {
            event.stopPropagation();
            if (!confirmingDelete) {
              setConfirmingDelete(true);
              return;
            }
            onDelete();
          }}
        >
          {confirmingDelete ? '确认' : '×'}
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
