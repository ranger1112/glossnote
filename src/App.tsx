import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfjs';
import { PdfPage } from './PdfPage';
import type { Anchor } from './anchoring';
import type { Annotation, DocRecord, HighlightColor } from './types';
import { loadDoc, saveDoc, sha256Hex } from './storage';

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

const COLORS: Array<{ key: HighlightColor; label: string }> = [
  { key: 'yellow', label: '黄色高亮' },
  { key: 'green', label: '绿色高亮' },
  { key: 'blue', label: '蓝色高亮' },
  { key: 'pink', label: '粉色高亮' },
];

const EMPTY: Annotation[] = [];

export default function App() {
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
    setAnnotations(next);
    const record = recordRef.current;
    if (!record) return;
    record.annotations = next;
    saveDoc(record);
  }, []);

  const openFile = useCallback(async (file: File) => {
    setBusy(true);
    setMessage('正在读取 PDF…');
    try {
      const bytes = await file.arrayBuffer();
      const docId = await sha256Hex(bytes);
      const existing = loadDoc(docId);
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
      const pdf = await loadingTask.promise;

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

      const opened: OpenedDoc = {
        id: docId,
        name: file.name,
        pageCount: pdf.numPages,
        pdf,
        dispose: () => {
          void loadingTask.destroy().catch(() => undefined);
        },
      };
      docRef.current?.dispose();
      docRef.current = opened;

      setDoc(opened);
      setAnnotations(record.annotations);
      setToolbar(null);
      setFocusId(null);
      setMessage('');
      requestAnimationFrame(() => document.querySelector('.viewer')?.scrollTo({ top: 0 }));
    } catch (error) {
      setMessage(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

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
    if (!import.meta.env.DEV) return;
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
        note: '',
        createdAt: now,
        updatedAt: now,
      };
      commit([...(recordRef.current?.annotations ?? []), annotation]);
      setToolbar(null);
      window.getSelection()?.removeAllRanges();
      if (withNote) setEditingId(annotation.id);
    },
    [commit],
  );

  const updateNote = useCallback(
    (id: string, note: string) => {
      commit(
        (recordRef.current?.annotations ?? []).map((annotation) =>
          annotation.id === id ? { ...annotation, note, updatedAt: Date.now() } : annotation,
        ),
      );
    },
    [commit],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      commit(
        (recordRef.current?.annotations ?? []).map((annotation) =>
          annotation.id === id ? { ...annotation, deleted: true, updatedAt: Date.now() } : annotation,
        ),
      );
    },
    [commit],
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
          onClick={() => fileRef.current?.click()}
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
                      onNote={(note) => updateNote(annotation.id, note)}
                      onDelete={() => removeAnnotation(annotation.id)}
                    />
                  ))}
                </div>
              )}

              <div className="sidebar-foot">
                标注暂存于浏览器 localStorage；桌面版将写入 SQLite 与 sidecar。
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
                onClick={() => fileRef.current?.click()}
              >
                打开 PDF
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void openSample()}>
                先看看示例
              </button>
            </div>
            <p className="welcome-hint">
              当前是锚定原型：标注只存在浏览器里，尚未接入 SQLite 与云同步。
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
  onNote: (note: string) => void;
  onDelete: () => void;
}

function AnnotationCard({
  annotation,
  editing,
  onJump,
  onNote,
  onDelete,
}: AnnotationCardProps) {
  const [draft, setDraft] = useState(annotation.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(annotation.note);
  }, [annotation.note]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

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
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => {
          if (draft !== annotation.note) onNote(draft);
        }}
      />
    </article>
  );
}
