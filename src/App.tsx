import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsAssets, pdfjsLib } from './pdfjs';
import { PdfPage } from './PdfPage';
import { Library } from './Library';
import { Review } from './Review';
import { CardEditor, type CardDraft } from './CardEditor';
import { AiPanel } from './AiPanel';
import { AiSettingsModal } from './AiSettingsModal';
import { SettingsModal } from './SettingsModal';
import { ShortcutList } from './ShortcutList';
import {
  IconArrowLeft,
  IconDownload,
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
  CardView,
  DocRecord,
  DocumentMeta,
  HighlightColor,
  PageTextInput,
} from './types';
import { loadDoc, saveDoc, sha256Hex } from './storage';
import { joinPdfItems } from './pdfText';
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
  libraryRoot,
  listCards,
  loadPageTexts,
  openDocument,
  savePageTexts,
  saveProgress,
  scanLibrary,
  setLibraryRoot,
  startupNotice,
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

  const [doc, setDoc] = useState<OpenedDoc | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [scale, setScale] = useState(1.2);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [hoverConfirmDelete, setHoverConfirmDelete] = useState(false);
  const hoverHideTimer = useRef<number | null>(null);
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

  const filtered = useMemo(
    () =>
      visible.filter(
        (annotation) =>
          (!filterColor || annotation.color === filterColor) &&
          (!filterKind || annotation.kind === filterKind),
      ),
    [visible, filterColor, filterKind],
  );

  /** 侧栏按页分组，组头可直接跳到对应页。 */
  const groups = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of filtered) {
      const list = map.get(annotation.page) ?? [];
      list.push(annotation);
      map.set(annotation.page, list);
    }
    return [...map.entries()].sort(([left], [right]) => left - right);
  }, [filtered]);

  const clearFilters = useCallback(() => {
    setFilterColor(null);
    setFilterKind(null);
  }, []);

  // 放大后一页可达数千像素；减少同时渲染的页数，避免画布内存再次爆掉。
  const pageHeight = baseSize ? baseSize.height * scale : 0;
  const activeRadius = pageHeight > 1100 ? 1 : 2;

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
    resetHistory();
    resetSaveState();
    setToolbar(null);
    setHover(null);
    setHoverConfirmDelete(false);
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
  }, [refreshCards, resetHistory, resetSaveState]);

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
    if (zoomTimerRef.current !== null) {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
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
      resetHistory();
      resetSaveState();
      setToolbar(null);
      setHover(null);
      setHoverConfirmDelete(false);
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
  }, [resetHistory, resetSaveState]);

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
    textCacheLoadedRef.current = false;
  }, [doc?.id]);

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
          if (text === undefined) {
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
        x: Math.min(Math.max(box.x, 90), window.innerWidth - 90),
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
        x: Math.min(Math.max(box.x, 185), window.innerWidth - 185),
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

  // 取消选择、点空白处、选中别处文字或滚动时，浮动工具都应立刻收起。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('.selection-toolbar, .annotation-toolbar')) return;
      setToolbar(null);
      dismissHover();
    };
    const onSelectionChange = () => {
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
  }, [dismissHover]);

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
      // 设置、帮助或卡片弹窗打开时，不让快捷键操作后面的文档。
      if (settingsOpen || helpOpen || aiSettingsOpen || cardEditing) return;

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
    redo,
    scrollPages,
    settingsOpen,
    undo,
    zoomTo,
  ]);

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
          </div>
        )}

        {doc && desktop && (
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
          accept="application/pdf"
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
        <main className="workspace">
          <section
            className="viewer"
            ref={viewerRef}
            onScroll={handleViewerScroll}
            data-pan-x={panXAllowed ? 'true' : 'false'}
          >
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
          </section>

          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>标注</h2>
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

            {visible.length > 0 && (
              <div className="sidebar-filters">
                <button
                  type="button"
                  className={`filter-all ${
                    filterColor === null && filterKind === null ? 'active' : ''
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
              </div>
            )}

            {visible.length === 0 ? (
              <p className="sidebar-hint">
                选中正文即可高亮；点浮动栏里的「批注」写下你的想法。
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
              <div className="annotation-list">
                {groups.map(([page, items]) => (
                  <section className="annotation-group" key={page}>
                    <button
                      type="button"
                      className="annotation-group-head"
                      title={`跳到第 ${page + 1} 页`}
                      onClick={() => goToPage(page)}
                    >
                      <span>第 {page + 1} 页</span>
                      <span className="group-count">{items.length}</span>
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
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {COLORS.map((color) => (
            <button
              key={color.key}
              type="button"
              className={`swatch ${color.key}`}
              title={color.label}
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
                className="toolbar-note"
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
              className={`swatch ${color.key}`}
              title={`改为${color.label}`}
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
                className="toolbar-note"
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
