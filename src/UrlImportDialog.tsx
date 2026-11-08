import { useEffect, useRef } from 'react';

interface UrlImportDialogProps {
  value: string;
  busy: boolean;
  progress: string;
  error: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UrlImportDialog({
  value,
  busy,
  progress,
  error,
  onChange,
  onConfirm,
  onCancel,
}: UrlImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="confirm-card" role="dialog" aria-modal="true" aria-label="从网址导入">
        <h2>从网址导入</h2>
        <div className="confirm-body">
          <p>只抓取公开网页的正文和图片，不保存登录态；图片会内联进书库。</p>
          <input
            ref={inputRef}
            className="url-import-input"
            type="url"
            placeholder="https://example.com/article"
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy && value.trim()) onConfirm();
            }}
          />
          {error && <p className="url-import-error">{error}</p>}
          {busy && progress && <p className="url-import-progress">{progress}</p>}
        </div>
        <div className="confirm-actions">
          <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !value.trim()}
            onClick={onConfirm}
          >
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
