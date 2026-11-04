import { useState } from 'react';
import { IconBookmark, IconPencil, IconTrash } from './icons';
import type { OutlineEntry } from './outline';
import type { Bookmark } from './types';

interface OutlinePanelProps {
  outline: OutlineEntry[];
  loading: boolean;
  bookmarks: Bookmark[];
  currentPage: number;
  onJump: (page: number) => void;
  onToggleBookmark: () => void;
  onRemoveBookmark: (id: string) => void;
  onRenameBookmark: (id: string, label: string) => void;
}

export function OutlinePanel({
  outline,
  loading,
  bookmarks,
  currentPage,
  onJump,
  onToggleBookmark,
  onRemoveBookmark,
  onRenameBookmark,
}: OutlinePanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const sorted = [...bookmarks].sort((left, right) => left.page - right.page);
  const bookmarked = sorted.some((bookmark) => bookmark.page === currentPage);

  const submitRename = () => {
    if (!editingId) return;
    const id = editingId;
    setEditingId(null);
    onRenameBookmark(id, draft);
  };

  return (
    <div className="sidebar-panel outline-panel">
      <section className="outline-section">
        <div className="outline-head">
          <h3>书签</h3>
          <button type="button" className="outline-add" onClick={onToggleBookmark}>
            <IconBookmark size={13} filled={bookmarked} />
            {bookmarked ? '移除本页' : '加书签'}
          </button>
        </div>

        {sorted.length === 0 ? (
          <p className="sidebar-hint">
            还没有书签。翻到需要记住的页面，点这里或顶栏的书签按钮。
          </p>
        ) : (
          <div className="bookmark-list">
            {sorted.map((bookmark) => (
              <div
                key={bookmark.id}
                className={`bookmark-row ${bookmark.page === currentPage ? 'active' : ''}`}
              >
                {editingId === bookmark.id ? (
                  <form
                    className="bookmark-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitRename();
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      aria-label="书签名称"
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={submitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="bookmark-main"
                    title={`跳到第 ${bookmark.page + 1} 页`}
                    onClick={() => onJump(bookmark.page)}
                  >
                    <IconBookmark size={12} filled />
                    <span className="bookmark-label">{bookmark.label}</span>
                    <span className="bookmark-page">{bookmark.page + 1}</span>
                  </button>
                )}

                {editingId !== bookmark.id && (
                  <span className="bookmark-actions">
                    <button
                      type="button"
                      className="side-icon"
                      title="重命名书签"
                      aria-label={`重命名书签 ${bookmark.label}`}
                      onClick={() => {
                        setDraft(bookmark.label);
                        setEditingId(bookmark.id);
                      }}
                    >
                      <IconPencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="side-icon"
                      title="删除书签"
                      aria-label={`删除书签 ${bookmark.label}`}
                      onClick={() => onRemoveBookmark(bookmark.id)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="outline-section">
        <div className="outline-head">
          <h3>目录</h3>
          <span className="outline-count">{outline.length}</span>
        </div>

        {loading ? (
          <p className="sidebar-hint">正在读取目录…</p>
        ) : outline.length === 0 ? (
          <p className="sidebar-hint">这份 PDF 没有内置目录。</p>
        ) : (
          <div className="outline-list">
            {outline.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`outline-row ${entry.page === currentPage ? 'active' : ''}`}
                style={{ paddingLeft: `${8 + Math.min(entry.depth, 6) * 12}px` }}
                title={`跳到第 ${entry.page + 1} 页`}
                onClick={() => onJump(entry.page)}
              >
                <span className="outline-title">{entry.title}</span>
                <span className="outline-page">{entry.page + 1}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
