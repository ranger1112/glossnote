import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdfjsAssets, pdfjsLib } from './pdfjs';
import {
  assetUrl,
  importPdf,
  listDocuments,
  organizeDocument,
  organizeDocuments,
  saveCover,
  scanLibrary,
  searchAnnotations,
  updateDocumentMeta,
} from './desktop';
import { pickPdfPath } from './platform';
import { IconSearch, IconStar, IconUpload } from './icons';
import type { DocumentMeta, ScanReport, SearchHit } from './types';
import { errorText } from './errors';

type SortKey = 'recent' | 'added' | 'title' | 'annotations';

interface LibraryProps {
  onOpen: (docId: string, page?: number) => void;
  onMessage: (message: string) => void;
}

interface Inspection {
  pageCount: number;
  cover: Uint8Array | null;
}

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
  const [searching, setSearching] = useState(false);
  const [sync, setSync] = useState<ScanReport | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagDraft, setTagDraft] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
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

  const refresh = useCallback(async () => {
    try {
      const report = await scanLibrary();
      setSync(report);
      await loadDocs();
      setLoading(false);
    } catch (error) {
      setLoading(false);
      onMessage(`读取书库失败：${errorText(error)}`);
    }
  }, [loadDocs, onMessage]);

  useEffect(() => {
    void refresh();
    return () => {
      coverRun.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchAnnotations(term)
        .then((results) => {
          if (!cancelled) setHits(results);
        })
        .catch((error) => {
          if (!cancelled) onMessage(`搜索失败：${errorText(error)}`);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, onMessage]);

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
      setDocs((current) => [
        result.document,
        ...current.filter((item) => item.id !== result.document.id),
      ]);
      onMessage('');
      onOpen(result.document.id);
    } catch (error) {
      onMessage(`导入失败：${errorText(error)}`);
    } finally {
      setImporting(false);
    }
  }, [onMessage, onOpen]);

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

  const visibleDocs = useMemo(() => {
    const list = docs.filter(
      (doc) => (!favoriteOnly || doc.favorite) && (!tagFilter || doc.tags.includes(tagFilter)),
    );
    return [...list].sort((left, right) => {
      switch (sort) {
        case 'title':
          return (left.title || left.name).localeCompare(right.title || right.name, 'zh');
        case 'added':
          return right.addedAt - left.addedAt;
        case 'annotations':
          return right.annotationCount - left.annotationCount || right.addedAt - left.addedAt;
        default:
          // 没读过的排在读过的后面，同组内再按添加时间。
          return (
            (right.lastOpenedAt || 0) - (left.lastOpenedAt || 0) ||
            right.addedAt - left.addedAt
          );
      }
    });
  }, [docs, favoriteOnly, tagFilter, sort]);

  useEffect(() => {
    if (tagFilter && !tagOptions.includes(tagFilter)) setTagFilter(null);
  }, [tagFilter, tagOptions]);

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

      {!searchingNow && !loading && docs.length > 0 && (
        <div className="library-tools">
          <div className="library-filters">
            <button
              type="button"
              className={`chip ${!favoriteOnly && !tagFilter ? 'active' : ''}`}
              onClick={() => {
                setFavoriteOnly(false);
                setTagFilter(null);
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

          <label className="library-sort">
            <span>排序</span>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              <option value="recent">最近阅读</option>
              <option value="added">添加时间</option>
              <option value="title">标题</option>
              <option value="annotations">标注数</option>
            </select>
          </label>
        </div>
      )}

      {searchingNow ? (
        <section className="search-results">
          {searching ? (
            <p className="library-empty">搜索中…</p>
          ) : hits.length === 0 ? (
            <p className="library-empty">没有匹配「{query.trim()}」的标注。</p>
          ) : (
            <>
              <p className="search-count">{hits.length} 条结果</p>
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
            }}
          >
            清除筛选
          </button>
        </div>
      ) : (
        <div className="library-grid">
          {visibleDocs.map((doc) => {
            const progress =
              doc.pageCount > 0 && doc.lastPage > 0
                ? Math.min(100, Math.round(((doc.lastPage + 1) / doc.pageCount) * 100))
                : 0;
            const picked = selected.has(doc.id);

            return (
              <div className={`library-item ${picked ? 'selected' : ''}`} key={doc.id}>
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
            <button
              type="submit"
              className="ghost"
              disabled={tagBusy || !tagDraft.trim()}
            >
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
          <button
            type="button"
            className="ghost"
            onClick={() => setSelected(new Set())}
          >
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
    </main>
  );
}
