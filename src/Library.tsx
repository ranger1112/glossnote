import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdfjsAssets, pdfjsLib } from './pdfjs';
import {
  assetUrl,
  deleteDocuments,
  importPdf,
  listDocuments,
  listFolders,
  listSmartCollections,
  loadPageTexts,
  organizeDocument,
  organizeDocuments,
  pageIndexStatus,
  reorderDocuments as persistOrder,
  saveCover,
  saveFolders,
  savePageTexts,
  saveSmartCollections,
  scanLibrary,
  searchAnnotations,
  searchPages,
  updateDocumentMeta,
} from './desktop';
import { extractDocumentText } from './pdfText';
import { pickPdfPath } from './platform';
import { IconSearch, IconStar, IconTrash, IconUpload } from './icons';
import type {
  DocumentMeta,
  LibrarySort,
  PageHit,
  PageIndexStatus,
  ScanReport,
  SearchHit,
  SmartCollection,
} from './types';
import { errorText } from './errors';
import { folderNames, matchesFilters, reorderDocuments, sortDocuments } from './libraryView';
import { LibrarySidebar } from './LibrarySidebar';
import { ConfirmDialog } from './ConfirmDialog';

interface LibraryProps {
  onOpen: (docId: string, page?: number) => void;
  onMessage: (message: string) => void;
}

interface Inspection {
  pageCount: number;
  cover: Uint8Array | null;
}

type ConfirmState =
  | { kind: 'delete-docs'; ids: string[] }
  | { kind: 'delete-folder'; name: string };

/** 索引任务跨组件存在：离开书库后仍在后台收尾，重新进入时不能并发再开一轮。 */
let indexRunActive = false;

/** 打开 PDF 拿到页数；缺封面时顺便把首页画成 320px 宽的 JPEG。 */
async function inspectPdf(doc: DocumentMeta): Promise<Inspection> {
  const task = pdfjsLib.getDocument({ url: assetUrl(doc.path), ...pdfjsAssets });
  try {
    const pdf = await task.promise;
    if (doc.cover) return { pageCount: pdf.numPages, cover: null };

    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 320 / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) return { pageCount: pdf.numPages, cover: null };

    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.82);
    });

    return {
      pageCount: pdf.numPages,
      cover: blob ? new Uint8Array(await blob.arrayBuffer()) : null,
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

export function Library({ onOpen, onMessage }: LibraryProps) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pageHits, setPageHits] = useState<PageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [indexStatus, setIndexStatus] = useState<PageIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');
  const indexCancel = useRef(false);
  const [sync, setSync] = useState<ScanReport | null>(null);
  const [sort, setSort] = useState<LibrarySort>('recent');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [collections, setCollections] = useState<SmartCollection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagDraft, setTagDraft] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const coverRun = useRef(0);

  const ensureCovers = useCallback(async (list: DocumentMeta[]) => {
    const run = ++coverRun.current;
    const queue = list.filter((doc) => !doc.cover || doc.pageCount === 0);
    // 每个任务都要把整份 PDF 交给 pdf.js；并发 2 个足够，再多容易顶不住大文件。
    const CONCURRENCY = 2;

    const worker = async () => {
      while (coverRun.current === run) {
        const doc = queue.shift();
        if (!doc) return;

        try {
          const inspection = await inspectPdf(doc);
          if (coverRun.current !== run) return;

          let cover = doc.cover;
          if (inspection.cover) {
            const updated = await saveCover(doc.id, inspection.cover);
            cover = updated.cover;
          }
          if (doc.pageCount !== inspection.pageCount) {
            await updateDocumentMeta(doc.id, { pageCount: inspection.pageCount });
          }
          if (coverRun.current !== run) return;

          setDocs((current) =>
            current.map((item) =>
              item.id === doc.id ? { ...item, cover, pageCount: inspection.pageCount } : item,
            ),
          );
        } catch (error) {
          // 封面只是展示层：个别 PDF 渲染失败不应阻塞书库。
          console.warn('生成封面失败', doc.name, error);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
    );
  }, []);

  const loadDocs = useCallback(async () => {
    const list = await listDocuments();
    setDocs(list);
    void ensureCovers(list);
  }, [ensureCovers]);

  const loadSidebar = useCallback(async () => {
    try {
      const [folderList, collectionList] = await Promise.all([
        listFolders(),
        listSmartCollections(),
      ]);
      setFolders(folderList);
      setCollections(collectionList);
    } catch (error) {
      console.warn('读取书库组织信息失败', error);
    }
  }, []);

  const refreshIndexStatus = useCallback(async () => {
    try {
      setIndexStatus(await pageIndexStatus());
    } catch (error) {
      console.warn('读取正文索引状态失败', error);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const report = await scanLibrary();
      setSync(report);
      await loadDocs();
      await loadSidebar();
      await refreshIndexStatus();
      setLoading(false);
    } catch (error) {
      setLoading(false);
      onMessage(`读取书库失败：${errorText(error)}`);
    }
  }, [loadDocs, loadSidebar, onMessage, refreshIndexStatus]);

  const indexLibrary = useCallback(async () => {
    if (indexing) {
      indexCancel.current = true;
      setIndexProgress('正在停止…');
      return;
    }
    if (indexRunActive) {
      onMessage('上一轮正文索引还在后台收尾，请稍候再试。');
      return;
    }

    indexRunActive = true;
    setIndexing(true);
    indexCancel.current = false;
    let updated = 0;
    let failed = 0;

    try {
      const list = await listDocuments();
      for (let index = 0; index < list.length; index += 1) {
        if (indexCancel.current) break;
        const doc = list[index];
        if (doc.pageCount <= 0) continue;

        const cached = await loadPageTexts(doc.id);
        if (cached.length >= doc.pageCount) continue;

        const label = doc.title || doc.name;
        setIndexProgress(`正在索引「${label}」（${index + 1}/${list.length}）…`);
        const task = pdfjsLib.getDocument({ url: assetUrl(doc.path), ...pdfjsAssets });
        try {
          const pdf = await task.promise;
          const pages = await extractDocumentText(pdf, (done, total) => {
            if (!indexCancel.current) {
              setIndexProgress(`正在索引「${label}」${done}/${total} 页…`);
            }
          });
          for (let start = 0; start < pages.length; start += 50) {
            if (indexCancel.current) break;
            await savePageTexts(doc.id, pages.slice(start, start + 50));
          }
          updated += 1;
        } catch (error) {
          failed += 1;
          console.warn('建立正文索引失败', doc.name, error);
        } finally {
          await task.destroy().catch(() => undefined);
        }
      }

      setSearchRevision((value) => value + 1);
      if (indexCancel.current) {
        onMessage(`已停止索引，本次完成 ${updated} 份文档。`);
      } else if (updated === 0 && failed === 0) {
        onMessage('正文索引已是最新。');
      } else {
        onMessage(
          failed > 0
            ? `正文索引完成，更新 ${updated} 份；${failed} 份读取失败。`
            : `正文索引完成，更新 ${updated} 份文档。`,
        );
      }
    } catch (error) {
      onMessage(`建立正文索引失败：${errorText(error)}`);
    } finally {
      indexRunActive = false;
      setIndexing(false);
      setIndexProgress('');
      await refreshIndexStatus();
    }
  }, [indexing, onMessage, refreshIndexStatus]);

  useEffect(() => {
    void refresh();
    return () => {
      coverRun.current += 1;
      // 书库卸载后索引不能继续无限跑下去；下一轮由新组件重新发起。
      indexCancel.current = true;
    };
  }, [refresh]);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      setPageHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      // 新查询开始前清掉上一轮结果：某个来源失败时，旧命中不能挂在新查询下面。
      setHits([]);
      setPageHits([]);
      const annotations = searchAnnotations(term)
        .then((value) => {
          if (!cancelled) setHits(value);
        })
        .catch((error) => {
          if (!cancelled) onMessage(`搜索失败：${errorText(error)}`);
        });
      const pages = searchPages(term)
        .then((value) => {
          if (!cancelled) setPageHits(value);
        })
        .catch((error) => {
          if (!cancelled) onMessage(`搜索失败：${errorText(error)}`);
        });
      // 标注命中先到先显示；正文扫描慢时不挡标注。
      Promise.allSettled([annotations, pages]).finally(() => {
        if (!cancelled) setSearching(false);
      });
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, onMessage, searchRevision]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    onMessage('正在导入 PDF…');
    try {
      const path = await pickPdfPath();
      if (!path) {
        onMessage('');
        return;
      }

      const result = await importPdf(path);
      let document = result.document;
      // 当前停在某个文件夹里时，新导入的文档直接归进去。
      if (folderFilter) {
        document = await organizeDocument(document.id, { folder: folderFilter });
      }
      setDocs((current) => [document, ...current.filter((item) => item.id !== document.id)]);
      onMessage('');
      onOpen(document.id);
    } catch (error) {
      onMessage(`导入失败：${errorText(error)}`);
    } finally {
      setImporting(false);
    }
  }, [folderFilter, onMessage, onOpen]);

  // 文档里一直写着 Ctrl+O 能导入，这里把它补上。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'o') return;
      event.preventDefault();
      if (!importing) void handleImport();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleImport, importing]);

  const tagOptions = useMemo(
    () =>
      [...new Set(docs.flatMap((doc) => doc.tags))].sort((left, right) =>
        left.localeCompare(right, 'zh'),
      ),
    [docs],
  );

  const folderList = useMemo(() => folderNames(docs, folders), [docs, folders]);

  const visibleDocs = useMemo(() => {
    const filtered = docs.filter((doc) =>
      matchesFilters(doc, { favorite: favoriteOnly, tag: tagFilter, folder: folderFilter }),
    );
    return sortDocuments(filtered, sort);
  }, [docs, favoriteOnly, tagFilter, folderFilter, sort]);

  useEffect(() => {
    if (tagFilter && !tagOptions.includes(tagFilter)) setTagFilter(null);
  }, [tagFilter, tagOptions]);

  useEffect(() => {
    if (folderFilter && !folderList.includes(folderFilter)) setFolderFilter(null);
  }, [folderFilter, folderList]);

  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const valid = new Set(docs.map((doc) => doc.id));
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [docs]);

  const applyDocs = useCallback((updated: DocumentMeta[]) => {
    const map = new Map(updated.map((doc) => [doc.id, doc]));
    setDocs((current) => current.map((doc) => map.get(doc.id) ?? doc));
  }, []);

  const toggleFavorite = useCallback(
    async (doc: DocumentMeta) => {
      try {
        applyDocs([await organizeDocument(doc.id, { favorite: !doc.favorite })]);
      } catch (error) {
        onMessage(`保存收藏失败：${errorText(error)}`);
      }
    },
    [applyDocs, onMessage],
  );

  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const bulkOrganize = useCallback(
    async (patch: { favorite?: boolean; addTags?: string[]; removeTags?: string[] }) => {
      if (selected.size === 0) return;
      setTagBusy(true);
      try {
        const updated = await organizeDocuments([...selected], patch);
        applyDocs(updated);
        const action =
          patch.favorite === true
            ? '已收藏'
            : patch.favorite === false
              ? '已取消收藏'
              : patch.addTags?.length
                ? '已添加标签'
                : '已移除标签';
        onMessage(`${action} ${updated.length} 份文档。`);
      } catch (error) {
        onMessage(`批量整理失败：${errorText(error)}`);
      } finally {
        setTagBusy(false);
      }
    },
    [applyDocs, onMessage, selected],
  );

  const applyTag = useCallback(
    async (mode: 'add' | 'remove') => {
      const value = tagDraft.trim().replace(/^#+/, '').trim();
      if (!value) return;
      await bulkOrganize(mode === 'add' ? { addTags: [value] } : { removeTags: [value] });
      setTagDraft('');
    },
    [bulkOrganize, tagDraft],
  );

  const moveDocuments = useCallback(
    async (ids: string[], folder: string) => {
      if (ids.length === 0) return;
      try {
        const updated = await organizeDocuments(ids, { folder });
        applyDocs(updated);
        if (folder && !folders.includes(folder)) {
          setFolders(await saveFolders([...folders, folder]));
        }
        const suffix = ids.length > 1 ? `（${ids.length} 份）` : '';
        onMessage(folder ? `已移动到「${folder}」${suffix}。` : `已移到未分类${suffix}。`);
      } catch (error) {
        onMessage(`移动文档失败：${errorText(error)}`);
      }
    },
    [applyDocs, folders, onMessage],
  );

  const createFolder = useCallback(
    async (name: string) => {
      const value = name.trim();
      if (!value) return;
      if (folders.includes(value)) {
        onMessage(`已有文件夹「${value}」。`);
        return;
      }
      try {
        setFolders(await saveFolders([...folders, value]));
        onMessage(`已新建文件夹「${value}」，把文档拖到左侧即可归类。`);
      } catch (error) {
        onMessage(`新建文件夹失败：${errorText(error)}`);
      }
    },
    [folders, onMessage],
  );

  const renameFolder = useCallback(
    async (from: string, to: string) => {
      const value = to.trim();
      if (!value || value === from) return;
      if (folders.includes(value)) {
        onMessage(`已有文件夹「${value}」。`);
        return;
      }
      try {
        const ids = docs.filter((doc) => doc.folder === from).map((doc) => doc.id);
        if (ids.length > 0) applyDocs(await organizeDocuments(ids, { folder: value }));
        setFolders(await saveFolders(folders.map((item) => (item === from ? value : item))));
        setFolderFilter((current) => (current === from ? value : current));
        onMessage(`文件夹已重命名为「${value}」。`);
      } catch (error) {
        onMessage(`重命名文件夹失败：${errorText(error)}`);
      }
    },
    [applyDocs, docs, folders, onMessage],
  );

  const deleteFolder = useCallback(
    async (name: string) => {
      setDeleteBusy(true);
      try {
        const ids = docs.filter((doc) => doc.folder === name).map((doc) => doc.id);
        if (ids.length > 0) applyDocs(await organizeDocuments(ids, { folder: '' }));
        setFolders(await saveFolders(folders.filter((item) => item !== name)));
        setFolderFilter((current) => (current === name ? null : current));
        onMessage(
          ids.length > 0
            ? `已删除文件夹「${name}」，${ids.length} 份文档移到未分类。`
            : `已删除文件夹「${name}」。`,
        );
        setConfirm(null);
      } catch (error) {
        onMessage(`删除文件夹失败：${errorText(error)}`);
      } finally {
        setDeleteBusy(false);
      }
    },
    [applyDocs, docs, folders, onMessage],
  );

  const deleteSelected = useCallback(
    async (ids: string[]) => {
      setDeleteBusy(true);
      try {
        const report = await deleteDocuments(ids);
        setDocs(await listDocuments());
        setSelected(new Set());
        if (report.failed.length > 0) {
          onMessage(
            `已移除 ${report.removed} 份；${report.failed.length} 份无法移入回收站：${report.failed.join('；')}`,
          );
        } else {
          onMessage(`已移除 ${report.removed} 份文档，PDF 与标注在系统回收站。`);
        }
        setConfirm(null);
      } catch (error) {
        onMessage(`删除文档失败：${errorText(error)}`);
      } finally {
        setDeleteBusy(false);
      }
    },
    [onMessage],
  );

  const confirmAction = useCallback(async () => {
    if (!confirm) return;
    if (confirm.kind === 'delete-docs') await deleteSelected(confirm.ids);
    else await deleteFolder(confirm.name);
  }, [confirm, deleteFolder, deleteSelected]);

  const saveCollection = useCallback(
    async (name: string) => {
      const value = name.trim();
      if (!value) return;
      if (collections.some((item) => item.name === value)) {
        onMessage(`已有收藏夹「${value}」。`);
        return;
      }
      const collection: SmartCollection = {
        id: crypto.randomUUID(),
        name: value,
        favorite: favoriteOnly,
        tag: tagFilter ?? '',
        folder: folderFilter,
        sort,
      };
      try {
        setCollections(await saveSmartCollections([...collections, collection]));
        onMessage(`已保存智能收藏夹「${value}」。`);
      } catch (error) {
        onMessage(`保存收藏夹失败：${errorText(error)}`);
      }
    },
    [collections, favoriteOnly, folderFilter, onMessage, sort, tagFilter],
  );

  const removeCollection = useCallback(
    async (id: string) => {
      try {
        setCollections(await saveSmartCollections(collections.filter((item) => item.id !== id)));
      } catch (error) {
        onMessage(`删除收藏夹失败：${errorText(error)}`);
      }
    },
    [collections, onMessage],
  );

  const applyCollection = useCallback((collection: SmartCollection) => {
    setFavoriteOnly(collection.favorite);
    setTagFilter(collection.tag || null);
    setFolderFilter(collection.folder);
    setSort(collection.sort);
    setQuery('');
  }, []);

  const handleDropOnFolder = useCallback(
    (folder: string, ids: string[]) => {
      const moving = ids.length > 0 ? ids : draggingIds;
      setDraggingIds([]);
      setDragOverId(null);
      if (moving.length > 0) void moveDocuments(moving, folder);
    },
    [draggingIds, moveDocuments],
  );

  const handleCardDragStart = useCallback(
    (event: React.DragEvent, doc: DocumentMeta) => {
      const ids = selected.has(doc.id) && selected.size > 1 ? [...selected] : [doc.id];
      setDraggingIds(ids);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-glossnote-docs', ids.join('\n'));
      event.dataTransfer.setData('text/plain', doc.name);
    },
    [selected],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggingIds([]);
    setDragOverId(null);
  }, []);

  const handleDropOnCard = useCallback(
    async (targetId: string | null, ids: string[] = draggingIds) => {
      if (sort !== 'manual' || ids.length === 0) return;
      const order = reorderDocuments(docs, ids, targetId);
      setDraggingIds([]);
      setDragOverId(null);

      const positions = new Map(order.map((id, index) => [id, index]));
      setDocs((current) =>
        current.map((doc) =>
          positions.has(doc.id) ? { ...doc, position: positions.get(doc.id) as number } : doc,
        ),
      );
      try {
        applyDocs(await persistOrder(order));
      } catch (error) {
        onMessage(`保存排序失败：${errorText(error)}`);
        setDocs(await listDocuments());
      }
    },
    [applyDocs, docs, draggingIds, onMessage, sort],
  );

  const searchingNow = query.trim().length > 0;
  const mergedBits = sync
    ? [
        sync.merged > 0 ? `${sync.merged} 条标注` : '',
        sync.mergedCards > 0 ? `${sync.mergedCards} 张卡片` : '',
      ].filter(Boolean)
    : [];
  const syncNote = mergedBits.length > 0 ? `合并 ${mergedBits.join('、')}` : '';
  const syncExtra = sync
    ? [
        sync.archived > 0 ? `归档 ${sync.archived} 个冲突副本` : '',
        sync.duplicatePdfs > 0 ? `${sync.duplicatePdfs} 份重复 PDF` : '',
        sync.missingDocuments > 0 ? `${sync.missingDocuments} 份文档文件缺失` : '',
        sync.ignoredSidecars > 0 ? `${sync.ignoredSidecars} 个无效 sidecar` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const folderDeleteCount =
    confirm?.kind === 'delete-folder'
      ? docs.filter((doc) => doc.folder === confirm.name).length
      : 0;

  return (
    <main className="library">
      <div className="library-head">
        <div className="library-title">
          <h1>书库</h1>
          <p>
            {docs.length > 0
              ? `${docs.length} 份文档 · 标注同时写入 SQLite 与 sidecar`
              : '导入的 PDF 会复制进书库，标注随文件夹一起同步'}
          </p>
          {sync && (
            <p className="library-path" title={sync.root}>
              <span className="path-text">书库：{sync.root}</span>
              {syncNote && <span className="sync-note">{syncNote}</span>}
              {syncExtra && <span className="sync-extra">{syncExtra}</span>}
              <span className="sync-time">
                上次扫描 {new Date(sync.scannedAt).toLocaleTimeString()}
              </span>
            </p>
          )}
        </div>

        <div className="library-actions">
          <div className="search-box">
            <IconSearch size={15} />
            <input
              className="search-input"
              type="search"
              value={query}
              aria-label="搜索标注、批注、标签"
              placeholder="搜索标注、批注、标签…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="primary"
            disabled={importing}
            onClick={() => void handleImport()}
          >
            <IconUpload size={15} />
            {importing ? '导入中…' : '导入 PDF'}
          </button>
        </div>
      </div>

      <div className="library-body">
        {!loading && (docs.length > 0 || folderList.length > 0 || collections.length > 0) && (
          <LibrarySidebar
            docs={docs}
            folders={folderList}
            folderFilter={folderFilter}
            collections={collections}
            dragging={draggingIds.length > 0}
            busy={tagBusy}
            canSaveCollection={favoriteOnly || tagFilter !== null || folderFilter !== null}
            onSelectFolder={(folder) => {
              setQuery('');
              setFolderFilter(folder);
            }}
            onDropDocs={handleDropOnFolder}
            onCreateFolder={createFolder}
            onRenameFolder={renameFolder}
            onRequestDeleteFolder={(name) => setConfirm({ kind: 'delete-folder', name })}
            onApplyCollection={applyCollection}
            onDeleteCollection={(id) => void removeCollection(id)}
            onSaveCollection={saveCollection}
          />
        )}

        <div className="library-content">
          {!searchingNow && !loading && docs.length > 0 && (
            <div className="library-tools">
              <div className="library-filters">
                <button
                  type="button"
                  className={`chip ${!favoriteOnly && !tagFilter && folderFilter === null ? 'active' : ''}`}
                  onClick={() => {
                    setFavoriteOnly(false);
                    setTagFilter(null);
                    setFolderFilter(null);
                  }}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={`chip ${favoriteOnly ? 'active' : ''}`}
                  aria-pressed={favoriteOnly}
                  onClick={() => setFavoriteOnly((value) => !value)}
                >
                  收藏
                </button>
                {folderFilter !== null && (
                  <button
                    type="button"
                    className="chip active"
                    title="清除文件夹筛选"
                    onClick={() => setFolderFilter(null)}
                  >
                    {folderFilter || '未分类'} ×
                  </button>
                )}
                {tagOptions.length > 0 && (
                  <select
                    className="chip-select"
                    aria-label="按标签筛选"
                    value={tagFilter ?? ''}
                    onChange={(event) => setTagFilter(event.target.value || null)}
                  >
                    <option value="">全部标签</option>
                    {tagOptions.map((tag) => (
                      <option key={tag} value={tag}>
                        #{tag}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="library-tool-right">
                <label className="library-sort">
                  <span>排序</span>
                  <select
                    aria-label="排序方式"
                    value={sort}
                    onChange={(event) => setSort(event.target.value as LibrarySort)}
                  >
                    <option value="recent">最近阅读</option>
                    <option value="added">添加时间</option>
                    <option value="title">标题</option>
                    <option value="annotations">标注数</option>
                    <option value="manual">手动排序</option>
                  </select>
                </label>
                <div className="library-index">
                  <button
                    type="button"
                    className="ghost"
                    title="在本机提取 PDF 文字层，供全库正文搜索使用"
                    onClick={() => void indexLibrary()}
                  >
                    {indexing ? '停止索引' : '索引正文'}
                  </button>
                  <span className="index-status" title={indexProgress}>
                    {indexProgress ||
                      (indexStatus
                        ? `已索引 ${indexStatus.indexedDocuments}/${indexStatus.documents} 份`
                        : '')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {searchingNow ? (
            <section className="search-results">
              {searching && hits.length === 0 && pageHits.length === 0 ? (
                <p className="library-empty">搜索中…</p>
              ) : hits.length === 0 && pageHits.length === 0 ? (
                <div className="search-empty">
                  <p className="library-empty">没有匹配「{query.trim()}」的正文或标注。</p>
                  {indexStatus && indexStatus.indexedDocuments < indexStatus.documents && (
                    <p className="search-index-hint">
                      正文索引覆盖 {indexStatus.indexedDocuments}/{indexStatus.documents} 份文档。
                      未索引的文档不会出现在正文结果里。
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void indexLibrary()}
                      >
                        {indexing ? '停止索引' : '建立正文索引'}
                      </button>
                    </p>
                  )}
                  {indexing && indexProgress && (
                    <p className="search-index-hint">{indexProgress}</p>
                  )}
                </div>
              ) : (
                <>
                  {pageHits.length > 0 && (
                    <div className="search-group">
                      <p className="search-count">正文 · {pageHits.length} 条</p>
                      {pageHits.map((hit) => (
                        <button
                          key={`${hit.docId}-${hit.page}`}
                          type="button"
                          className="search-hit"
                          onClick={() => onOpen(hit.docId, hit.page)}
                        >
                          <header>
                            <span className="search-doc">{hit.docName}</span>
                            <span>第 {hit.page + 1} 页</span>
                          </header>
                          <blockquote>{hit.snippet}</blockquote>
                        </button>
                      ))}
                    </div>
                  )}
                  {hits.length > 0 && (
                    <div className="search-group">
                      <p className="search-count">标注 · {hits.length} 条</p>
                      {hits.map((hit) => (
                        <button
                          key={hit.annotationId}
                          type="button"
                          className="search-hit"
                          onClick={() => onOpen(hit.docId, hit.page)}
                        >
                          <header>
                            <span className={`color-dot ${hit.color}`} />
                            <span className="search-doc">{hit.docName}</span>
                            <span>第 {hit.page + 1} 页</span>
                          </header>
                          {hit.quote && <blockquote>{hit.quote}</blockquote>}
                          {hit.body && <p>{hit.body}</p>}
                          {hit.tags.length > 0 && (
                            <div className="tag-row">
                              {hit.tags.map((tag) => (
                                <span className="tag" key={tag}>
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {indexStatus && indexStatus.indexedDocuments < indexStatus.documents && (
                    <p className="search-index-hint">
                      正文索引覆盖 {indexStatus.indexedDocuments}/{indexStatus.documents} 份文档，
                      未索引的文档不会出现在正文结果里。
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void indexLibrary()}
                      >
                        {indexing ? '停止索引' : '建立正文索引'}
                      </button>
                    </p>
                  )}
                  {indexing && indexProgress && (
                    <p className="search-index-hint">{indexProgress}</p>
                  )}
                </>
              )}
            </section>
          ) : loading ? (
            <p className="library-empty">正在整理书库…</p>
          ) : docs.length === 0 ? (
            <div className="library-empty-card">
              <div className="welcome-mark">G</div>
              <h2>书库还是空的</h2>
              <p>导入第一份 PDF，选中文字就能高亮和批注。</p>
              <button
                type="button"
                className="primary large"
                disabled={importing}
                onClick={() => void handleImport()}
              >
                <IconUpload size={16} />
                导入 PDF
              </button>
            </div>
          ) : visibleDocs.length === 0 ? (
            <div className="library-empty-card">
              <h2>没有符合条件的文档</h2>
              <p>换个筛选条件，或者导入新的 PDF。</p>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setFavoriteOnly(false);
                  setTagFilter(null);
                  setFolderFilter(null);
                }}
              >
                清除筛选
              </button>
            </div>
          ) : (
            <div
              className={`library-grid ${sort === 'manual' ? 'manual' : ''}`}
              onDragOver={(event) => {
                if (
                  sort === 'manual' &&
                  (draggingIds.length > 0 ||
                    event.dataTransfer.types.includes('application/x-glossnote-docs'))
                ) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                if (sort !== 'manual') return;
                event.preventDefault();
                const raw = event.dataTransfer.getData('application/x-glossnote-docs');
                void handleDropOnCard(
                  null,
                  raw
                    ? raw.split('\n').filter(Boolean)
                    : draggingIds,
                );
              }}
            >
              {visibleDocs.map((doc) => {
                const progress =
                  doc.pageCount > 0 && doc.lastPage > 0
                    ? Math.min(100, Math.round(((doc.lastPage + 1) / doc.pageCount) * 100))
                    : 0;
                const picked = selected.has(doc.id);
                const dragging = draggingIds.includes(doc.id);

                return (
                  <div
                    className={`library-item ${picked ? 'selected' : ''} ${
                      dragging ? 'dragging' : ''
                    } ${dragOverId === doc.id ? 'drop-target' : ''}`}
                    key={doc.id}
                    draggable
                    onDragStart={(event) => handleCardDragStart(event, doc)}
                    onDragEnd={handleCardDragEnd}
                    onDragOver={(event) => {
                      if (
                        sort !== 'manual' ||
                        (draggingIds.length === 0 &&
                          !event.dataTransfer.types.includes('application/x-glossnote-docs'))
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverId(doc.id);
                    }}
                    onDragLeave={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setDragOverId((current) => (current === doc.id ? null : current));
                    }}
                    onDrop={(event) => {
                      if (sort !== 'manual') return;
                      event.preventDefault();
                      event.stopPropagation();
                      const raw = event.dataTransfer.getData('application/x-glossnote-docs');
                      void handleDropOnCard(
                        doc.id,
                        raw
                          ? raw.split('\n').filter(Boolean)
                          : draggingIds,
                      );
                    }}
                  >
                    <button
                      type="button"
                      className="library-card"
                      onClick={() => onOpen(doc.id, doc.lastPage || undefined)}
                    >
                      <div className="cover">
                        {doc.cover ? (
                          <img src={assetUrl(doc.cover)} alt="" loading="lazy" />
                        ) : (
                          <div className="cover-fallback">PDF</div>
                        )}
                        {doc.annotationCount > 0 && (
                          <span className="cover-badge">{doc.annotationCount}</span>
                        )}
                      </div>
                      <div className="card-meta">
                        <strong title={doc.title || doc.name}>{doc.title || doc.name}</strong>
                        <span>
                          {doc.pageCount > 0 ? `${doc.pageCount} 页` : '待扫描'}
                          {doc.lastPage > 0 && doc.pageCount > 0
                            ? ` · 读到第 ${doc.lastPage + 1} 页`
                            : ''}
                        </span>
                        {progress > 0 && (
                          <div className="progress" aria-hidden="true">
                            <i style={{ width: `${progress}%` }} />
                          </div>
                        )}
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`card-star ${doc.favorite ? 'on' : ''}`}
                      title={doc.favorite ? '取消收藏' : '收藏'}
                      aria-label={doc.favorite ? '取消收藏' : '收藏'}
                      aria-pressed={doc.favorite}
                      onClick={() => void toggleFavorite(doc)}
                    >
                      <IconStar size={15} filled={doc.favorite} />
                    </button>

                    <button
                      type="button"
                      className={`card-select ${picked ? 'on' : ''}`}
                      title={picked ? '取消选择' : '选择文档'}
                      aria-label={picked ? '取消选择' : '选择文档'}
                      aria-pressed={picked}
                      onClick={() => toggleSelected(doc.id)}
                    >
                      {picked ? '✓' : ''}
                    </button>

                    {doc.tags.length > 0 && (
                      <div className="card-tags">
                        {doc.tags.map((tag) => (
                          <button
                            type="button"
                            key={tag}
                            className={`tag ${tagFilter === tag ? 'active' : ''}`}
                            title={`按 #${tag} 筛选`}
                            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span className="selection-count">已选 {selected.size} 份</span>
          <button
            type="button"
            className="ghost"
            disabled={tagBusy}
            onClick={() => void bulkOrganize({ favorite: true })}
          >
            收藏
          </button>
          <button
            type="button"
            className="ghost"
            disabled={tagBusy}
            onClick={() => void bulkOrganize({ favorite: false })}
          >
            取消收藏
          </button>
          <form
            className="selection-tag"
            onSubmit={(event) => {
              event.preventDefault();
              void applyTag('add');
            }}
          >
            <input
              value={tagDraft}
              maxLength={24}
              placeholder="文档标签"
              aria-label="文档标签"
              onChange={(event) => setTagDraft(event.target.value)}
            />
            <button type="submit" className="ghost" disabled={tagBusy || !tagDraft.trim()}>
              添加
            </button>
            <button
              type="button"
              className="ghost"
              disabled={tagBusy || !tagDraft.trim()}
              onClick={() => void applyTag('remove')}
            >
              移除
            </button>
          </form>
          <label className="selection-move">
            <span>移动到</span>
            <select
              aria-label="移动选中文档到文件夹"
              value="__move__"
              disabled={tagBusy}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '__move__') return;
                void moveDocuments([...selected], value);
              }}
            >
              <option value="__move__">选择文件夹…</option>
              <option value="">未分类</option>
              {folderList.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ghost danger"
            onClick={() => setConfirm({ kind: 'delete-docs', ids: [...selected] })}
          >
            <IconTrash size={13} />
            删除
          </button>
          <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setSelected(new Set(visibleDocs.map((doc) => doc.id)))}
          >
            全选
          </button>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'delete-docs'
              ? `删除 ${confirm.ids.length} 份文档？`
              : `删除文件夹「${confirm.name}」？`
          }
          body={
            confirm.kind === 'delete-docs' ? (
              <p>
                PDF 与对应标注文件会移到 Windows 回收站，书库索引立即移除。之后可以从系统回收站恢复。
              </p>
            ) : (
              <p>
                {folderDeleteCount > 0
                  ? `文件夹里的 ${folderDeleteCount} 份文档会移到「未分类」，PDF 和标注不受影响。`
                  : '这是一个空文件夹，删除后不会影响任何文档。'}
              </p>
            )
          }
          confirmLabel={confirm.kind === 'delete-docs' ? '移到回收站' : '删除文件夹'}
          danger
          busy={deleteBusy}
          onConfirm={() => void confirmAction()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </main>
  );
}
