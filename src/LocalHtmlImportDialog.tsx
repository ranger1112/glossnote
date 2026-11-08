import { useEffect, useRef } from 'react';

interface LocalHtmlImportDialogProps {
  fileName: string;
  freeze: boolean;
  onFreezeChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LocalHtmlImportDialog({
  fileName,
  freeze,
  onFreezeChange,
  onConfirm,
  onCancel,
}: LocalHtmlImportDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirm-card" role="dialog" aria-modal="true" aria-label="导入本地 HTML">
        <h2>导入本地 HTML</h2>
        <div className="confirm-body">
          <p className="html-import-file" title={fileName}>
            {fileName}
          </p>
          <label className="html-import-option">
            <input
              type="checkbox"
              checked={freeze}
              onChange={(event) => onFreezeChange(event.target.checked)}
            />
            <span>
              <strong>把图片冻结进书库（推荐）</strong>
              <small>
                读取正文与相对图片，保存为单文件快照；之后移动或删除原文件仍可阅读。
                不勾选则直接导入原文件，图片依赖原目录。
              </small>
            </span>
          </label>
        </div>
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button ref={confirmRef} type="button" className="primary" onClick={onConfirm}>
            {freeze ? '冻结并导入' : '直接导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
