import { useState } from 'react';
import { IconFolder, IconPencil, IconPlus, IconStar, IconTrash } from './icons';
import { matchesCollection } from './libraryView';
import type { DocumentMeta, SmartCollection } from './types';

interface LibrarySidebarProps {
  docs: DocumentMeta[];
  folders: string[];
  /** null = 全部，'' = 未分类，其他 = 指定文件夹。 */
  folderFilter: string | null;
  collections: SmartCollection[];
  dragging: boolean;
  busy: boolean;
  canSaveCollection: boolean;
  onSelectFolder: (folder: string | null) => void;
  onDropDocs: (folder: string, ids: string[]) => void;
  onCreateFolder: (name: string) => Promise<void>;
  onRenameFolder: (from: string, to: string) => Promise<void>;
  onRequestDeleteFolder: (name: string) => void;
  onApplyCollection: (collection: SmartCollection) => void;
  onDeleteCollection: (id: string) => void;
  onSaveCollection: (name: string) => Promise<void>;
}

export function LibrarySidebar({
  docs,
  folders,
  folderFilter,
  collections,
  dragging,
  busy,
  canSaveCollection,
  onSelectFolder,
  onDropDocs,
  onCreateFolder,
  onRenameFolder,
  onRequestDeleteFolder,
  onApplyCollection,
  onDeleteCollection,
  onSaveCollection,
}: LibrarySidebarProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [savingCollection, setSavingCollection] = useState(false);
  const [collectionDraft, setCollectionDraft] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const unclassified = docs.filter((doc) => !doc.folder).length;

  const folderCount = (folder: string) =>
    folder === '' ? unclassified : docs.filter((doc) => doc.folder === folder).length;

  const dropProps = (folder: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging && !event.dataTransfer.types.includes('application/x-glossnote-docs')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget(null);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const raw = event.dataTransfer.getData('application/x-glossnote-docs');
      const ids = raw ? raw.split('\n').filter(Boolean) : [];
      onDropDocs(folder, ids);
    },
  });

  const submitFolder = async () => {
    const value = draft.trim();
    if (!value) return;
    await onCreateFolder(value);
    setDraft('');
    setAdding(false);
  };

  const submitRename = async (from: string) => {
    const value = renameDraft.trim();
    setRenaming(null);
    if (!value || value === from) return;
    await onRenameFolder(from, value);
  };

  const submitCollection = async () => {
    const value = collectionDraft.trim();
    if (!value) return;
    await onSaveCollection(value);
    setCollectionDraft('');
    setSavingCollection(false);
  };

  return (
    <aside className="library-side" aria-label="书库组织">
      <section className="side-section">
        <h2 className="side-title">文件夹</h2>

        <button
          type="button"
          className={`side-row ${folderFilter === null ? 'active' : ''}`}
          onClick={() => onSelectFolder(null)}
        >
          <span className="side-label">全部文档</span>
          <span className="side-count">{docs.length}</span>
        </button>

        <button
          type="button"
          className={`side-row ${folderFilter === '' ? 'active' : ''} ${
            dropTarget === '' ? 'drop' : ''
          }`}
          title="拖动文档到这里可移出文件夹"
          onClick={() => onSelectFolder('')}
          {...dropProps('')}
        >
          <IconFolder size={14} />
          <span className="side-label">未分类</span>
          <span className="side-count">{unclassified}</span>
        </button>

        {folders.map((folder) => (
          <div key={folder} className="side-folder-row">
            {renaming === folder ? (
              <form
                className="side-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename(folder);
                }}
              >
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={40}
                  aria-label="文件夹名"
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void submitRename(folder)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              </form>
            ) : (
              <button
                type="button"
                className={`side-row ${folderFilter === folder ? 'active' : ''} ${
                  dropTarget === folder ? 'drop' : ''
                }`}
                title={`拖动文档到「${folder}」`}
                onClick={() => onSelectFolder(folder)}
                {...dropProps(folder)}
              >
                <IconFolder size={14} />
                <span className="side-label" title={folder}>
                  {folder}
                </span>
                <span className="side-count">{folderCount(folder)}</span>
              </button>
            )}

            {renaming !== folder && (
              <span className="side-folder-actions">
                <button
                  type="button"
                  className="side-icon"
                  title="重命名文件夹"
                  aria-label={`重命名文件夹 ${folder}`}
                  onClick={() => {
                    setRenameDraft(folder);
                    setRenaming(folder);
                  }}
                >
                  <IconPencil size={12} />
                </button>
                <button
                  type="button"
                  className="side-icon"
                  title="删除文件夹"
                  aria-label={`删除文件夹 ${folder}`}
                  onClick={() => onRequestDeleteFolder(folder)}
                >
                  <IconTrash size={12} />
                </button>
              </span>
            )}
          </div>
        ))}

        {adding ? (
          <form
            className="side-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFolder();
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={40}
              placeholder="新文件夹"
              aria-label="新文件夹名"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setAdding(false);
                  setDraft('');
                }
              }}
            />
            <button type="submit" className="ghost" disabled={busy || !draft.trim()}>
              添加
            </button>
          </form>
        ) : (
          <button type="button" className="side-add" onClick={() => setAdding(true)}>
            <IconPlus size={13} />
            新建文件夹
          </button>
        )}
      </section>

      <section className="side-section">
        <h2 className="side-title">智能收藏夹</h2>

        {collections.map((collection) => (
          <div key={collection.id} className="side-smart-row">
            <button
              type="button"
              className="side-row"
              title={collection.name}
              onClick={() => onApplyCollection(collection)}
            >
              <IconStar size={13} />
              <span className="side-label">{collection.name}</span>
              <span className="side-count">
                {docs.filter((doc) => matchesCollection(doc, collection)).length}
              </span>
            </button>
            <span className="side-folder-actions">
              <button
                type="button"
                className="side-icon"
                title="删除收藏夹"
                aria-label={`删除收藏夹 ${collection.name}`}
                onClick={() => onDeleteCollection(collection.id)}
              >
                <IconTrash size={12} />
              </button>
            </span>
          </div>
        ))}

        {savingCollection ? (
          <form
            className="side-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCollection();
            }}
          >
            <input
              autoFocus
              value={collectionDraft}
              maxLength={40}
              placeholder="收藏夹名"
              aria-label="收藏夹名"
              disabled={busy}
              onChange={(event) => setCollectionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSavingCollection(false);
                  setCollectionDraft('');
                }
              }}
            />
            <button type="submit" className="ghost" disabled={busy || !collectionDraft.trim()}>
              保存
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="side-add"
            disabled={!canSaveCollection}
            title={canSaveCollection ? '把当前文件夹、收藏和标签筛选保存下来' : '先设置一个筛选条件'}
            onClick={() => setSavingCollection(true)}
          >
            <IconPlus size={13} />
            保存当前筛选
          </button>
        )}

        {collections.length === 0 && !savingCollection && (
          <p className="side-hint">设置收藏、标签或文件夹筛选后，可以存成智能收藏夹。</p>
        )}
      </section>
    </aside>
  );
}
