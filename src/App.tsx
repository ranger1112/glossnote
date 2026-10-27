import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfjs';
import { PdfPage } from './PdfPage';
import type { Anchor } from './anchoring';
import type { Annotation, DocRecord, DocumentMeta, HighlightColor } from './types';
import { loadDoc, saveDoc, sha256Hex } from './storage';
import { isTauri, pickPdfPath } from './platform';
import {
  assetUrl,
  deleteAnnotation,
  getLastDocument,
  importPdf,
  scanLibrary,
  updateDocumentMeta,
  upsertAnnotation,
} from './desktop';

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
}

const COLORS: Array<{ key: HighlightColor; label: string }> = [
  { key: 'yellow', label: '黄色高亮' },
  { key: 'green', label: '绿色高亮' },
  { key: 'blue', label: '蓝色高亮' },
  { key: 'pink', label: '粉色高亮' },
];

const EMPTY: Annotation[] = [];

export default function App() {
  const desktop = isTauri();
  const [doc, setDoc] = useState<OpenedDoc | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [scale, setScale] = useState(1.2);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const recordRef = useRef<DocRecord | null>(null);
  const docRef = useRef<OpenedDoc | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

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
      setMessage(`保存标注失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const removeFromLibrary = useCallback(async (docId: string, id: string) => {
    try {
      await deleteAnnotation(docId, id);
    } catch (error) {
      setMessage(`删除标注失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const activate = useCallback(async (input: Activation) => {
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

    annotationsRef.current = input.annotations;
    setDoc(opened);
    setAnnotations(input.annotations);
    setToolbar(null);
    setFocusId(null);
    setMessage('');
    requestAnimationFrame(() => document.querySelector('.viewer')?.scrollTo({ top: 0 }));

    if (input.desktopMeta) {
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
  }, []);

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

        const task = pdfjsLib.getDocument({ data: bytes.slice(0) });
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
        setMessage(`打开失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [activate],
  );

  const choosePdf = useCallback(async () => {
    if (!isTauri()) {
      fileRef.current?.click();
      return;
    }

    setBusy(true);
    setMessage('正在选择 PDF…');
    try {
      const path = await pickPdfPath();
      if (!path) {
        setMessage('');
        return;
      }

      setMessage('正在导入 PDF…');
      const result = await importPdf(path);
      setMessage('正在打开 PDF…');

      const task = pdfjsLib.getDocument({ url: assetUrl(result.document.path) });
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
      });
    } catch (error) {
      setMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [activate]);

  const openSample = useCallback(async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await openFile(new File([blob], 'sample.pdf', { type: 'application/pdf' }));
    } catch (error) {
      setMessage(`加载示例失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [openFile]);

  useEffect(() => {
    if (!import.meta.env.DEV || isTauri()) return;
    if (new URLSearchParams(window.location.search).has('sample')) void openSample();
  }, [openSample]);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    void (async () => {
      setBusy(true);
      setMessage('正在整理书库…');
      try {
        await scanLibrary();
        if (cancelled) return;

        const last = await getLastDocument();
        if (cancelled) return;
        if (!last) {
          setMessage('');
          return;
        }

        setMessage('正在打开上次的文档…');
        const task = pdfjsLib.getDocument({ url: assetUrl(last.document.path) });
        const pdf = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }

        await activate({
          id: last.document.id,
          name: last.document.name,
          size: last.document.size,
          pageCount: pdf.numPages,
          pdf,
          task,
          annotations: last.annotations,
          desktopMeta: last.document,
        });
      } catch (error) {
        if (!cancelled) {
          setMessage(`整理书库失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activate]);

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

  const removeAnnotation = useCallback(
    (docId: string, id: string) => {
      const existing = annotationsRef.current.find((annotation) => annotation.id === id);
      if (!existing) return;

      const updated: Annotation = { ...existing, deleted: true, updatedAt: Date.now() };
      commit(annotationsRef.current.map((annotation) => (annotation.id === id ? updated : annotation)));
      if (isTauri()) void removeFromLibrary(docId, id);
    },
    [commit, removeFromLibrary],
  );

  const jumpTo = useCallback((annotation: Annotation) => {
    document
      .querySelector(`[data-page-index="${annotation.page}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFocusId(annotation.id);
    window.setTimeout(() => {
      setFocusId((current) => (current === annotation.id ? null : current));
    }, 1600);
  }, []);

  const handleSelect = useCallback((anchor: Anchor, box: { x: number; y: number }) => {
    setToolbar({
      anchor,
      x: Math.min(Math.max(box.x, 90), window.innerWidth - 90),
      y: Math.max(box.y, 70),
    });
  }, []);

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
          Gloss<span className="brand-accent">Note</span>
        </div>

        {doc && (
          <div className="doc-title" title={doc.name}>
            <span className="doc-name">{doc.name}</span>
            <span className="doc-id">#{doc.id.slice(0, 8)}</span>
          </div>
        )}

        <div className="topbar-spacer" />

        {doc && (
          <div className="zoom-controls">
            <button
              type="button"
              title="缩小"
              onClick={() => setScale((value) => Math.max(0.5, +(value - 0.25).toFixed(2)))}
            >
              −
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              type="button"
              title="放大"
              onClick={() => setScale((value) => Math.min(3, +(value + 0.25).toFixed(2)))}
            >
              +
            </button>
          </div>
        )}

        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void choosePdf()}
        >
          {doc ? '换一份' : '打开 PDF'}
        </button>

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

      {message && <div className="status-bar">{message}</div>}

      <main className={doc ? 'workspace' : 'workspace welcome'}>
        {doc ? (
          <>
            <section className="viewer">
              {Array.from({ length: doc.pageCount }, (_, index) => (
                <PdfPage
                  key={index}
                  pdf={doc.pdf}
                  pageIndex={index}
                  scale={scale}
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
                      editing={editingId === annotation.id}
                      onJump={() => jumpTo(annotation)}
                      onBody={(body) => updateBody(doc.id, annotation.id, body)}
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
          </>
        ) : (
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
                onClick={() => void choosePdf()}
              >
                打开 PDF
              </button>
              {!desktop && (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => void openSample()}
                >
                  先看看示例
                </button>
              )}
            </div>
            <p className="welcome-hint">
              {desktop
                ? '导入的 PDF 会复制进书库；标注同时写入 SQLite 与 sidecar。'
                : '当前是浏览器原型：标注只存在 localStorage，尚未接入 SQLite 与云同步。'}
            </p>
          </div>
        )}
      </main>

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
        </div>
      )}
    </div>
  );
}

interface AnnotationCardProps {
  annotation: Annotation;
  editing: boolean;
  onJump: () => void;
  onBody: (body: string) => void;
  onDelete: () => void;
}

function AnnotationCard({ annotation, editing, onJump, onBody, onDelete }: AnnotationCardProps) {
  const [draft, setDraft] = useState(annotation.body);
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
    </article>
  );
}
