import { useCallback, useEffect, useMemo, useState } from 'react';
import { CardEditor, type CardDraft } from './CardEditor';
import { deleteCard, listCards, reviewCard, updateCard } from './desktop';
import { IconRefresh } from './icons';
import { errorText } from './errors';
import type { CardView } from './types';

interface ReviewProps {
  onOpenDoc: (docId: string, page?: number) => void;
  onMessage: (message: string) => void;
}

function previewInterval(dueAt: number): string {
  const diff = Math.max(1, dueAt - Date.now());
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟`;
  if (diff < 172_800_000) return `${Math.round(diff / 3_600_000)} 小时`;
  return `${Math.round(diff / 86_400_000)} 天`;
}

function formatWhen(timestamp: number): string {
  if (!timestamp) return '未安排';

  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;

  const day = date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}/${day} ${time}`;
}

function statusOf(view: CardView): { label: string; className: string } {
  if (view.card.status === 'orphaned') return { label: '来源失效', className: 'orphaned' };
  if (view.card.reps === 0) return { label: '新卡', className: 'new' };
  if (view.card.dueAt <= Date.now()) return { label: '到期', className: 'due' };
  return { label: '已排期', className: 'scheduled' };
}

function scheduleText(view: CardView): string {
  if (view.card.reps === 0) return '新卡片 · 尚未复习';
  return `复习 ${view.card.reps} 次 · 遗忘 ${view.card.lapses} 次 · 下次 ${formatWhen(view.card.dueAt)}`;
}

export function Review({ onOpenDoc, onMessage }: ReviewProps) {
  const [cards, setCards] = useState<CardView[]>([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CardView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listCards();
      const now = Date.now();
      setCards(list);
      setSession(
        list
          .filter((view) => view.card.dueAt <= now)
          .map((view) => view.card.id),
      );
      setIndex(0);
      setRevealed(false);
      setLoading(false);
    } catch (error) {
      setLoading(false);
      onMessage(`读取卡片失败：${errorText(error)}`);
    }
  }, [onMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(
    () => cards.find((view) => view.card.id === session[index]) ?? null,
    [cards, index, session],
  );
  const detail = detailId ? cards.find((view) => view.card.id === detailId) ?? null : null;
  const dueCount = cards.filter((view) => view.card.dueAt <= Date.now()).length;
  const orphaned = cards.filter((view) => view.card.status === 'orphaned').length;
  const finished = session.length > 0 && index >= session.length;
  const nextDue = cards
    .filter((view) => view.card.dueAt > Date.now())
    .map((view) => view.card.dueAt)
    .sort((left, right) => left - right)[0];

  const replaceCard = (updated: CardView) => {
    setCards((current) => current.map((view) => (view.card.id === updated.card.id ? updated : view)));
  };

  const grade = async (rating: number) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const updated = await reviewCard(current.card.id, rating);
      replaceCard(updated);
      setRevealed(false);
      setIndex((value) => value + 1);
    } catch (error) {
      onMessage(`保存复习结果失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (draft: CardDraft) => {
    if (!editing) return;
    setSaving(true);
    try {
      const updated = await updateCard(editing.card.id, draft.title, draft.body, draft.links);
      // 链接变化会影响其他卡片的反向链接，重新拉取整份列表。
      setCards(await listCards());
      setDetailId(updated.card.id);
      setEditing(null);
      onMessage('卡片已更新。');
    } catch (error) {
      onMessage(`保存卡片失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const removeCard = async () => {
    if (!detail) return;
    if (!window.confirm(`删除卡片「${detail.card.title}」？`)) return;

    try {
      await deleteCard(detail.card.id);
      setCards((current) => current.filter((view) => view.card.id !== detail.card.id));
      setSession((current) => current.filter((id) => id !== detail.card.id));
      setDetailId(null);
      onMessage('卡片已删除。');
    } catch (error) {
      onMessage(`删除卡片失败：${errorText(error)}`);
    }
  };

  return (
    <main className="review">
      <div className="library-head">
        <div className="library-title">
          <h1>复习</h1>
          <p>
            {loading
              ? '正在读取卡片…'
              : `${cards.length} 张卡片 · ${dueCount} 张到期 · ${orphaned} 张来源失效`}
          </p>
        </div>
        <div className="library-actions">
          <button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
            <IconRefresh size={14} />
            刷新队列
          </button>
        </div>
      </div>

      {loading ? (
        <p className="library-empty">正在读取卡片…</p>
      ) : finished ? (
        <section className="review-panel review-done">
          <h2>本轮复习完成</h2>
          <p>共复习 {session.length} 张卡片。到期的卡片已经重新排期。</p>
          <button type="button" className="primary" onClick={() => void load()}>
            刷新队列
          </button>
        </section>
      ) : current ? (
        <section className="review-panel">
          <header className="review-progress">
            <span>
              {index + 1} / {session.length}
            </span>
            <span className={`card-status ${statusOf(current).className}`}>
              {statusOf(current).label}
            </span>
          </header>

          <h2>{current.card.title}</h2>

          {current.card.status === 'orphaned' && (
            <p className="orphan-note">来源标注已删除；卡片内容保留，仍可复习。</p>
          )}

          {current.sourceQuote && <blockquote>{current.sourceQuote}</blockquote>}

          {current.card.sourceDocId && (
            <button
              type="button"
              className="source-link"
              onClick={() =>
                onOpenDoc(current.card.sourceDocId as string, current.card.sourcePage ?? 0)
              }
            >
              打开原文 · {current.docName || '文档'}
              {current.card.sourcePage !== null ? ` 第 ${current.card.sourcePage + 1} 页` : ''}
            </button>
          )}

          {!revealed ? (
            <button type="button" className="primary large reveal" onClick={() => setRevealed(true)}>
              显示答案
            </button>
          ) : (
            <>
              <p className="card-body">{current.card.body || '（没有填写答案）'}</p>
              <div className="grade-row">
                {current.previews.map((preview) => (
                  <button
                    key={preview.rating}
                    type="button"
                    className={`grade grade-${preview.rating}`}
                    disabled={busy}
                    onClick={() => void grade(preview.rating)}
                  >
                    {preview.label}
                    <small>{previewInterval(preview.dueAt)}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      ) : (
        <section className="review-panel review-empty-state">
          <h2>今天没有到期卡片</h2>
          <p>
            {nextDue
              ? `下一张卡片将在 ${formatWhen(nextDue)} 到期。`
              : '还没有卡片。在阅读器里选中文字，点侧栏卡片上的「制卡」加入复习。'}
          </p>
          <button type="button" className="ghost" onClick={() => void load()}>
            重新检查
          </button>
        </section>
      )}

      {cards.length > 0 && (
        <section className="card-list">
          <h2>
            全部卡片 <span className="count">{cards.length}</span>
          </h2>
          {cards.map((view) => {
            const status = statusOf(view);
            return (
              <button
                key={view.card.id}
                type="button"
                className="card-row"
                onClick={() => setDetailId(view.card.id)}
              >
                <div className="card-row-head">
                  <strong>{view.card.title}</strong>
                  <span className={`card-status ${status.className}`}>{status.label}</span>
                </div>
                <p>{view.card.body || view.sourceQuote || '（空卡片）'}</p>
                <span className="card-row-meta">
                  {view.docName
                    ? `${view.docName}${view.card.sourcePage !== null ? ` · 第 ${view.card.sourcePage + 1} 页` : ''} · `
                    : ''}
                  {`到期 ${formatWhen(view.card.dueAt)}`}
                  {view.card.status === 'orphaned' ? ' · 来源标注已删除' : ''}
                </span>
              </button>
            );
          })}
        </section>
      )}

      {detail && (
        <div className="modal-backdrop" onMouseDown={() => setDetailId(null)}>
          <article className="card-detail" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <h2>{detail.card.title}</h2>
              <button
                type="button"
                className="icon-button"
                title="关闭"
                onClick={() => setDetailId(null)}
              >
                ×
              </button>
            </header>

            <div className="card-detail-meta">
              <span className={`card-status ${statusOf(detail).className}`}>
                {statusOf(detail).label}
              </span>
              <span>{scheduleText(detail)}</span>
            </div>

            {detail.card.status === 'orphaned' && (
              <p className="orphan-note">来源标注已删除；卡片内容保留，仍可复习。</p>
            )}

            {detail.sourceQuote && <blockquote>{detail.sourceQuote}</blockquote>}
            <p className="card-body">{detail.card.body || '（没有填写答案）'}</p>

            {detail.card.links.length > 0 && (
              <div className="detail-links">
                <span>链接</span>
                {detail.card.links.map((id) => {
                  const linked = cards.find((view) => view.card.id === id);
                  return linked ? (
                    <button
                      key={id}
                      type="button"
                      className="tag"
                      onClick={() => setDetailId(id)}
                    >
                      {linked.card.title}
                    </button>
                  ) : (
                    <span key={id} className="tag faded">
                      已删除的卡片
                    </span>
                  );
                })}
              </div>
            )}

            {detail.backlinks.length > 0 && (
              <div className="detail-links">
                <span>反向链接</span>
                {detail.backlinks.map((ref) => (
                  <button
                    key={ref.id}
                    type="button"
                    className="tag"
                    onClick={() => setDetailId(ref.id)}
                  >
                    {ref.title}
                  </button>
                ))}
              </div>
            )}

            <footer className="modal-foot">
              {detail.card.sourceDocId && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    onOpenDoc(detail.card.sourceDocId as string, detail.card.sourcePage ?? 0)
                  }
                >
                  打开原文
                </button>
              )}
              <span className="modal-spacer" />
              <button type="button" className="ghost" onClick={() => setEditing(detail)}>
                编辑
              </button>
              <button type="button" className="ghost danger" onClick={() => void removeCard()}>
                删除
              </button>
              <button type="button" className="primary" onClick={() => setDetailId(null)}>
                关闭
              </button>
            </footer>
          </article>
        </div>
      )}

      {editing && (
        <CardEditor
          heading="编辑卡片"
          initial={{
            title: editing.card.title,
            body: editing.card.body,
            links: editing.card.links,
          }}
          cards={cards}
          excludeId={editing.card.id}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={(draft) => void saveEdit(draft)}
        />
      )}
    </main>
  );
}
