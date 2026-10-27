import { useCallback, useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  aiAnswer,
  aiExplain,
  aiSummarize,
  documentIndexStatus,
  indexDocumentText,
} from './desktop';
import { extractDocumentText } from './pdfText';
import type { AiAnswer } from './types';

type PanelMode = 'qa' | 'explain';

interface ExplainInput {
  page: number;
  quote: string;
  context: string;
}

interface AiPanelProps {
  docId: string;
  docName: string;
  pdf: PDFDocumentProxy;
  mode: PanelMode;
  explain?: ExplainInput;
  ready: boolean;
  onClose: () => void;
  onJumpPage: (page: number) => void;
  onOpenSettings: () => void;
  onMessage: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AiPanel({
  docId,
  docName,
  pdf,
  mode,
  explain,
  ready,
  onClose,
  onJumpPage,
  onOpenSettings,
  onMessage,
}: AiPanelProps) {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [indexed, setIndexed] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState('');
  const [chunkCount, setChunkCount] = useState(0);

  const explainPage = explain?.page;
  const explainQuote = explain?.quote;
  const explainContext = explain?.context;

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    if (mode === 'explain' && explainPage !== undefined && explainQuote !== undefined) {
      setBusy(true);
      setError('');
      setAnswer(null);
      aiExplain(docId, explainPage, explainQuote, explainContext ?? '')
        .then((result) => {
          if (!cancelled) setAnswer(result);
        })
        .catch((cause) => {
          if (!cancelled) setError(errorText(cause));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    } else {
      documentIndexStatus(docId)
        .then((value) => {
          if (!cancelled) setIndexed(value);
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [docId, mode, ready, explainPage, explainQuote, explainContext]);

  const handleIndex = useCallback(async () => {
    setIndexing(true);
    setProgress('正在提取文字…');
    try {
      const pages = await extractDocumentText(pdf, (done, total) => {
        setProgress(`正在提取文字 ${done}/${total}…`);
      });
      const count = await indexDocumentText(docId, pages);
      setChunkCount(count);
      setIndexed(count > 0);
      onMessage(
        count > 0
          ? `全文索引完成：${count} 段。`
          : '没有提取到文字，可能是扫描件；仍可基于标注提问。',
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setIndexing(false);
      setProgress('');
    }
  }, [docId, onMessage, pdf]);

  const run = async (kind: 'qa' | 'summary-full' | 'summary-annotations') => {
    if (busy) return;
    if (kind === 'qa' && !question.trim()) return;
    if (kind === 'summary-full' && !indexed) {
      setError('请先提取全文，再进行全文总结。');
      return;
    }

    setBusy(true);
    setError('');
    setAnswer(null);
    try {
      const result =
        kind === 'qa'
          ? await aiAnswer(docId, question.trim())
          : await aiSummarize(docId, kind === 'summary-annotations');
      setAnswer(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ai-panel">
      <header className="ai-panel-head">
        <div className="ai-panel-title">
          <span className="ai-badge">AI</span>
          <strong>{mode === 'explain' ? '解释选段' : '阅读助手'}</strong>
          <span className="ai-doc" title={docName}>
            {docName}
          </span>
        </div>
        <button type="button" className="icon-button" title="关闭" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="ai-panel-body">
        {!ready ? (
          <div className="ai-disabled">
            <p>AI 尚未启用，或还没有填写 API Key。</p>
            <button type="button" className="primary" onClick={onOpenSettings}>
              打开 AI 设置
            </button>
          </div>
        ) : mode === 'explain' ? (
          <>
            {explain?.quote && <blockquote className="ai-quote">{explain.quote}</blockquote>}
            {busy && <p className="ai-loading">正在解释…</p>}
            {error && <p className="ai-error">{error}</p>}
            {answer && (
              <>
                <div className="ai-answer-text">{answer.text}</div>
                <Sources answer={answer} onJumpPage={onJumpPage} />
                <p className="ai-model">模型：{answer.model}</p>
              </>
            )}
          </>
        ) : (
          <>
            <div className="ai-index-row">
              {indexed ? (
                <span className="ai-index-ok">
                  全文已索引{chunkCount > 0 ? ` · ${chunkCount} 段` : ''}
                </span>
              ) : (
                <>
                  <span>全文尚未索引。提取只在本机进行，不上传。</span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={indexing}
                    onClick={() => void handleIndex()}
                  >
                    {indexing ? progress : '提取全文'}
                  </button>
                </>
              )}
            </div>

            <div className="ai-presets">
              <button
                type="button"
                className="ghost"
                disabled={busy || !indexed}
                onClick={() => void run('summary-full')}
              >
                总结全文
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void run('summary-annotations')}
              >
                总结我的标注
              </button>
            </div>

            <div className="ai-ask">
              <textarea
                value={question}
                rows={3}
                placeholder="就这份文档提问，例如：作者的核心论点是什么？"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void run('qa');
                  }
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || !question.trim()}
                onClick={() => void run('qa')}
              >
                {busy ? '回答中…' : '提问'}
              </button>
            </div>

            {error && <p className="ai-error">{error}</p>}

            {answer && (
              <div className="ai-answer">
                <div className="ai-answer-text">{answer.text}</div>
                <Sources answer={answer} onJumpPage={onJumpPage} />
                <p className="ai-model">模型：{answer.model}</p>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="ai-panel-foot">
        只会发送本次问题、选中的文字与检索到的片段；不会上传整座书库。
      </footer>
    </aside>
  );
}

function Sources({
  answer,
  onJumpPage,
}: {
  answer: AiAnswer;
  onJumpPage: (page: number) => void;
}) {
  if (answer.citations.length === 0) return null;

  return (
    <div className="ai-sources">
      <span>来源</span>
      {answer.citations.map((citation) => (
        <button
          key={citation.index}
          type="button"
          className="ai-source"
          title={citation.snippet}
          disabled={citation.page === null}
          onClick={() => {
            if (citation.page !== null) onJumpPage(citation.page);
          }}
        >
          <b>[{citation.index}]</b> {citation.label}
        </button>
      ))}
    </div>
  );
}
