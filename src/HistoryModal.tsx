import { useEffect, useState } from 'react';
import { listSidecarVersions, restoreSidecarVersion } from './desktop';
import { errorText } from './errors';
import type { ImportResult, SidecarVersion } from './types';

interface HistoryModalProps {
  docId: string;
  docName: string;
  onClose: () => void;
  onRestored: (result: ImportResult) => void;
  onMessage: (message: string) => void;
}

export function HistoryModal({
  docId,
  docName,
  onClose,
  onRestored,
  onMessage,
}: HistoryModalProps) {
  const [versions, setVersions] = useState<SidecarVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSidecarVersions(docId)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((error) => {
        if (!cancelled) onMessage(`读取版本历史失败：${errorText(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, onMessage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const current = versions.find((version) => version.id === selected) ?? null;

  const restore = async (version: SidecarVersion) => {
    setBusy(true);
    try {
      const result = await restoreSidecarVersion(docId, version.id);
      onRestored(result);
      onMessage(`已恢复 ${new Date(version.createdAt).toLocaleString()} 的版本。`);
      onClose();
    } catch (error) {
      onMessage(`恢复版本失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="history-modal" role="dialog" aria-modal="true" aria-label="版本历史">
        <header className="modal-head">
          <div>
            <h2>版本历史</h2>
            <p className="history-doc">{docName}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <p className="history-hint">
          修改标注、书签或整理信息后会自动保留最近 30 个版本。恢复前会把当前状态再存一份。
        </p>

        {loading ? (
          <p className="history-empty">正在读取版本…</p>
        ) : versions.length === 0 ? (
          <p className="history-empty">还没有历史版本。下一次修改标注后会出现。</p>
        ) : (
          <div className="history-list">
            {versions.map((version) => (
              <button
                key={version.id}
                type="button"
                className={`history-item ${selected === version.id ? 'selected' : ''}`}
                onClick={() => setSelected(version.id)}
              >
                <span className="history-time">
                  {new Date(version.createdAt).toLocaleString()}
                </span>
                <span className="history-meta">
                  {version.annotations} 条标注 · {version.bookmarks} 个书签
                  {version.folder ? ` · ${version.folder}` : ''}
                </span>
                {version.tags.length > 0 && (
                  <span className="history-tags">
                    {version.tags.map((tag) => `#${tag}`).join(' ')}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {current && (
          <div className="history-confirm">
            <p>
              恢复 {new Date(current.createdAt).toLocaleString()} 的版本？当前标注、书签与整理信息会被替换；
              当前状态会先保存为新版本。
            </p>
            <div className="history-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void restore(current)}
              >
                {busy ? '恢复中…' : '恢复此版本'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
