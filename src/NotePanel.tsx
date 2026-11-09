import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { errorText } from './errors';
import { NoteMarkdown } from './NoteMarkdown';
import { parseNoteLinks, readNote, resolveNoteTargets, saveNote } from './notes';
import type { NoteFile, NoteLinkTargets } from './types';

interface NotePanelProps {
  docId: string;
  onOpenDoc: (docId: string, page?: number) => void;
  onFocusAnnotation: (docId: string, annotationId: string) => void;
  onJumpPage: (page: number) => void;
}

export interface NotePanelHandle {
  /** false 表示冲突/保存失败，调用方应阻止切换文档。 */
  flush: () => Promise<boolean>;
  /** 用户确认放弃改动后调用，阻止卸载时再尝试保存。 */
  discard: () => void;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; current: NoteFile };

const EMPTY_TARGETS: NoteLinkTargets = { annotations: {}, documents: {} };

function savedTime(at: number): string {
  if (!at) return '已保存';
  return `已保存 ${new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function statusText(state: SaveState): string {
  switch (state.kind) {
    case 'dirty':
      return '未保存';
    case 'saving':
      return '保存中…';
    case 'saved':
      return savedTime(state.at);
    case 'error':
      return '保存失败';
    case 'conflict':
      return '文件已修改';
    default:
      return '已载入';
  }
}

export const NotePanel = forwardRef<NotePanelHandle, NotePanelProps>(function NotePanel(
  { docId, onOpenDoc, onFocusAnnotation, onJumpPage },
  ref,
) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [focusOpen, setFocusOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [targets, setTargets] = useState<NoteLinkTargets>(EMPTY_TARGETS);

  const textRef = useRef('');
  const savedTextRef = useRef('');
  const revisionRef = useRef('');
  const loadingRef = useRef(true);
  const conflictRef = useRef(false);
  const discardRef = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadingRef.current = true;
    setLoading(true);
    setMode('edit');
    setFocusOpen(false);
    setTargets(EMPTY_TARGETS);
    conflictRef.current = false;
    discardRef.current = false;
    textRef.current = '';
    savedTextRef.current = '';
    revisionRef.current = '';

    readNote(docId)
      .then((note) => {
        if (cancelled) return;
        textRef.current = note.text;
        savedTextRef.current = note.text;
        revisionRef.current = note.revision;
        setText(note.text);
        setSaveState({ kind: 'idle' });
        setLoading(false);
        loadingRef.current = false;
      })
      .catch((error) => {
        if (cancelled) return;
        setSaveState({ kind: 'error', message: errorText(error) });
        setLoading(false);
        loadingRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [docId]);

  const startSave = useCallback(async (): Promise<boolean> => {
    if (loadingRef.current) return true;
    if (conflictRef.current) return false;
    if (savingRef.current) return savingRef.current;

    const value = textRef.current;
    if (value === savedTextRef.current) return true;

    const promise = (async (): Promise<boolean> => {
      setSaveState({ kind: 'saving' });
      try {
        const result = await saveNote(docId, value, revisionRef.current);
        if (result.status === 'conflict') {
          conflictRef.current = true;
          setSaveState({ kind: 'conflict', current: result.current });
          return false;
        }
        revisionRef.current = result.note.revision;
        savedTextRef.current = value;
        setSaveState(
          textRef.current === value
            ? { kind: 'saved', at: result.note.updatedAt || Date.now() }
            : { kind: 'dirty' },
        );
        return true;
      } catch (error) {
        setSaveState({ kind: 'error', message: errorText(error) });
        return false;
      }
    })();

    savingRef.current = promise;
    try {
      return await promise;
    } finally {
      savingRef.current = null;
    }
  }, [docId]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (loadingRef.current) return true;
    if (conflictRef.current) return false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (savingRef.current) {
        const saved = await savingRef.current;
        if (!saved) return false;
      }
      if (textRef.current === savedTextRef.current) return true;
      if (!(await startSave())) return false;
    }
    return textRef.current === savedTextRef.current;
  }, [startSave]);

  const discard = useCallback(() => {
    discardRef.current = true;
  }, []);

  useImperativeHandle(ref, () => ({ flush, discard }), [flush, discard]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (textRef.current !== savedTextRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && textRef.current !== savedTextRef.current) {
        void startSave();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [startSave]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (
        !loadingRef.current &&
        !conflictRef.current &&
        !discardRef.current &&
        textRef.current !== savedTextRef.current
      ) {
        void startSave();
      }
    },
    [startSave],
  );

  useEffect(() => {
    if (!focusOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFocusOpen(false);
        void flush();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusOpen, flush]);

  useEffect(() => {
    if (mode !== 'preview') return;
    const tokens = parseNoteLinks(text);
    const annotationIds: string[] = [];
    const docIds: string[] = [];
    for (const token of tokens) {
      if (token.link.kind === 'annotation') annotationIds.push(token.link.id);
      else if (token.link.kind === 'doc') docIds.push(token.link.id);
    }
    if (annotationIds.length === 0 && docIds.length === 0) {
      setTargets(EMPTY_TARGETS);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      resolveNoteTargets(annotationIds, docIds)
        .then((value) => {
          if (!cancelled) setTargets(value);
        })
        .catch(() => {
          if (!cancelled) setTargets(EMPTY_TARGETS);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, text]);

  const scheduleSave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // 保存进行中时 startSave 会返回同一个 Promise；等它结束后如果文本又变了，
      // 必须重新排一轮防抖，否则这次修改会一直停在「未保存」。
      void startSave().then((saved) => {
        if (saved && textRef.current !== savedTextRef.current) scheduleSave();
      });
    }, 600);
  };

  const handleChange = (value: string) => {
    textRef.current = value;
    setText(value);
    if (conflictRef.current) return;
    setSaveState({ kind: 'dirty' });
    scheduleSave();
  };

  const handleShortcut = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void flush();
    }
  };

  const reload = async () => {
    try {
      const note = await readNote(docId);
      textRef.current = note.text;
      savedTextRef.current = note.text;
      revisionRef.current = note.revision;
      conflictRef.current = false;
      setText(note.text);
      setSaveState({ kind: 'idle' });
    } catch (error) {
      setSaveState({ kind: 'error', message: errorText(error) });
    }
  };

  const overwrite = () => {
    if (saveState.kind !== 'conflict') return;
    revisionRef.current = saveState.current.revision;
    conflictRef.current = false;
    setSaveState({ kind: 'dirty' });
    void startSave();
  };

  const conflictBanner =
    saveState.kind === 'conflict' ? (
      <div className="note-conflict" role="status">
        <p>文件已在别处修改。重新载入会丢弃本地改动，覆盖保存会写回当前内容。</p>
        <div>
          <button type="button" className="primary" onClick={() => void reload()}>
            重新载入
          </button>
          <button type="button" className="ghost" onClick={overwrite}>
            覆盖保存
          </button>
        </div>
      </div>
    ) : null;

  const errorBanner =
    saveState.kind === 'error' ? (
      <div className="note-conflict" role="alert">
        <p>{saveState.message}</p>
        <div>
          <button type="button" className="primary" onClick={() => void startSave()}>
            重试保存
          </button>
        </div>
      </div>
    ) : null;

  const editor = (large: boolean) => {
    if (loading) return <p className="sidebar-hint">正在读取笔记…</p>;
    if (mode === 'preview') {
      return (
        <div className={`note-preview ${large ? 'note-preview-large' : ''}`}>
          {text.trim() ? (
            <NoteMarkdown
              text={text}
              targets={targets}
              onOpenDoc={onOpenDoc}
              onFocusAnnotation={onFocusAnnotation}
              onJumpPage={onJumpPage}
            />
          ) : (
            <p className="sidebar-hint">还没有笔记。切到编辑，写下第一条想法。</p>
          )}
        </div>
      );
    }
    return (
      <textarea
        className={`note-textarea ${large ? 'note-textarea-large' : ''}`}
        value={text}
        disabled={loading}
        placeholder="写下笔记… 支持 [[page:12]]、[[annotation:id]]、[[doc:id#page=3]]"
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleShortcut}
        spellCheck={false}
      />
    );
  };

  const toolbar = (large: boolean) => (
    <div className={`note-toolbar ${large ? 'note-toolbar-large' : ''}`}>
      <div className="note-mode" role="group" aria-label="笔记模式">
        <button
          type="button"
          className={mode === 'edit' ? 'active' : ''}
          onClick={() => setMode('edit')}
        >
          编辑
        </button>
        <button
          type="button"
          className={mode === 'preview' ? 'active' : ''}
          onClick={() => setMode('preview')}
        >
          预览
        </button>
      </div>
      <span className={`note-status note-status-${saveState.kind}`}>
        {statusText(saveState)}
      </span>
      <button type="button" className="link-button" onClick={() => void flush()}>
        保存
      </button>
      {!large && (
        <button type="button" className="link-button" onClick={() => setFocusOpen(true)}>
          专注编辑
        </button>
      )}
    </div>
  );

  return (
    <>
      {toolbar(false)}
      {conflictBanner}
      {errorBanner}
      {editor(false)}

      {focusOpen &&
        createPortal(
          <div className="modal-backdrop note-focus-backdrop" onMouseDown={() => setFocusOpen(false)}>
            <div
              className="note-focus"
              role="dialog"
              aria-modal="true"
              aria-label="专注编辑笔记"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="modal-head">
                <h2>专注编辑</h2>
                <button
                  type="button"
                  className="icon-button"
                  title="关闭"
                  aria-label="关闭"
                  onClick={() => setFocusOpen(false)}
                >
                  ×
                </button>
              </header>
              {toolbar(true)}
              {conflictBanner}
              {errorBanner}
              {editor(true)}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});
