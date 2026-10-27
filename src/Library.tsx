import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfjsLib } from './pdfjs';
import {
  assetUrl,
  exportMarkdown,
  importPdf,
  listDocuments,
  saveCover,
  scanLibrary,
  searchAnnotations,
  updateDocumentMeta,
} from './desktop';
import { pickMarkdownPath, pickPdfPath } from './platform';
import type { DocumentMeta, SearchHit } from './types';

interface LibraryProps {
  onOpen: (docId: string, page?: number) => void;
  onMessage: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Inspection {
  pageCount: number;
  cover: Uint8Array | null;
}

/** 打开 PDF 拿到页数；缺封面时顺便把首页画成 320px 宽的 JPEG。 */
async function inspectPdf(doc: DocumentMeta): Promise<Inspection> {
  const task = pdfjsLib.getDocument({ url: assetUrl(doc.path) });
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
  const coverRun = useRef(0);

  const ensureCovers = useCallback(async (list: DocumentMeta[]) => {
    const run = ++coverRun.current;

    for (const doc of list) {
      if (coverRun.current !== run) return;
      if (doc.cover && doc.pageCount > 0) continue;

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
  }, []);

  const refresh = useCallback(async () => {
    try {
      await scanLibrary();
      const list = await listDocuments();
      setDocs(list);
      setLoading(false);
      void ensureCovers(list);
    } catch (error) {
      setLoading(false);
      onMessage(`读取书库失败：${errorText(error)}`);
    }
  }, [ensureCovers, onMessage]);

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

  const handleExport = useCallback(async () => {
    try {
      const path = await pickMarkdownPath();
      if (!path) return;
      await exportMarkdown(path);
      onMessage(`已导出 Markdown：${path}`);
    } catch (error) {
      onMessage(`导出失败：${errorText(error)}`);
    }
  }, [onMessage]);

  const searchingNow = query.trim().length > 0;

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
        </div>

        <div className="library-actions">
          <input
            className="search-input"
            type="search"
            value={query}
            placeholder="搜索标注、批注、标签…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="ghost"
            disabled={docs.length === 0}
            onClick={() => void handleExport()}
          >
            导出 Markdown
          </button>
          <button
            type="button"
            className="primary"
            disabled={importing}
            onClick={() => void handleImport()}
          >
            {importing ? '导入中…' : '导入 PDF'}
          </button>
        </div>
      </div>

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
            导入 PDF
          </button>
        </div>
      ) : (
        <div className="library-grid">
          {docs.map((doc) => {
            const progress =
              doc.pageCount > 0 && doc.lastPage > 0
                ? Math.min(100, Math.round(((doc.lastPage + 1) / doc.pageCount) * 100))
                : 0;

            return (
              <button
                key={doc.id}
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
                  <div className="progress">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}
