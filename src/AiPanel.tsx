import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  aiAnswer,
  aiExplain,
  aiFollowup,
  aiSummarize,
  documentIndexStatus,
  indexDocumentText,
} from './desktop';
import { extractDocumentText } from './pdfText';
import { errorText } from './errors';
import { Markdown } from './Markdown';
import type { AiAnswer, ChatTurn } from './types';

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

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  answer?: AiAnswer;
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState('');
  const [indexed, setIndexed] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState('');
  const [chunkCount, setChunkCount] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const explainPage = explain?.page;
  const explainQuote = explain?.quote;
  const explainContext = explain?.context;

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    setTurns([]);
    setError('');
    setQuestion('');
    setPending('');

    if (mode === 'explain' && explainPage !== undefined && explainQuote !== undefined) {
      setBusy(true);
      aiExplain(docId, explainPage, explainQuote, explainContext ?? '')
        .then((result) => {
          if (cancelled) return;
          setTurns([{ role: 'assistant', text: result.text, answer: result }]);
        })
        .catch((cause) => {
          if (!cancelled) setError(errorText(cause));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    } else {
      setBusy(false);
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

  // 新消息或等待状态变化时滚到底部。
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [turns.length, busy]);

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

  const ask = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!text || busy || !ready) return;

      const history: ChatTurn[] = turns.map((turn) => ({
        role: turn.role,
        content: turn.text,
      }));

      setBusy(true);
      setError('');
      setPending(text);
      setQuestion('');
      try {
        const result =
          mode === 'qa' && turns.length === 0
            ? await aiAnswer(docId, text)
            : await aiFollowup(
                docId,
                mode,
                mode === 'explain' ? (explainPage ?? null) : null,
                mode === 'explain' ? (explainQuote ?? '') : '',
                mode === 'explain' ? (explainContext ?? '') : '',
                text,
                history,
              );
        setTurns((current) => [
          ...current,
          { role: 'user', text },
          { role: 'assistant', text: result.text, answer: result },
        ]);
      } catch (cause) {
        setError(errorText(cause));
        // 失败时把问题放回输入框，方便修改后重试。
        setQuestion(text);
      } finally {
        setBusy(false);
        setPending('');
      }
    },
    [busy, docId, explainContext, explainPage, explainQuote, mode, ready, turns],
  );

  const summarize = useCallback(
    async (annotationsOnly: boolean) => {
      if (busy) return;
      if (!annotationsOnly && !indexed) {
        setError('请先提取全文，再进行全文总结。');
        return;
      }

      const label = annotationsOnly ? '总结我的标注' : '总结全文';
      setBusy(true);
      setError('');
      setPending(label);
      try {
        const result = await aiSummarize(docId, annotationsOnly);
        setTurns((current) => [
          ...current,
          { role: 'user', text: label },
          { role: 'assistant', text: result.text, answer: result },
        ]);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setBusy(false);
        setPending('');
      }
    },
    [busy, docId, indexed],
  );

  const lastAnswer = [...turns].reverse().find((turn) => turn.answer)?.answer;

  const thread = turns.map((turn, index) =>
    turn.role === 'user' ? (
      <div className="ai-turn-user" key={index}>
        {turn.text}
      </div>
    ) : (
      <div className="ai-turn-assistant" key={index}>
        <div className="ai-answer-text">
          <Markdown text={turn.text} />
        </div>
        {turn.answer && <Sources answer={turn.answer} onJumpPage={onJumpPage} />}
      </div>
    ),
  );

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

      <div className="ai-panel-body" ref={bodyRef}>
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
            {thread}
            {busy && (
              <p className="ai-loading">
                {pending ? '回答中…' : '正在解释…'}
              </p>
            )}
            {error && <p className="ai-error">{error}</p>}
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
                onClick={() => void summarize(false)}
              >
                总结全文
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void summarize(true)}
              >
                总结我的标注
              </button>
            </div>

            {thread}
            {busy && (
              <p className="ai-loading">
                {pending === '总结全文' || pending === '总结我的标注'
                  ? '正在总结…'
                  : '回答中…'}
              </p>
            )}
            {error && <p className="ai-error">{error}</p>}
          </>
        )}

        {lastAnswer && <p className="ai-model">模型：{lastAnswer.model}</p>}
      </div>

      <footer className="ai-panel-foot">
        {ready && (
          <div className="ai-composer">
            <textarea
              rows={2}
              value={question}
              placeholder={
                mode === 'explain' ? '继续追问这段文字…' : '接着问这份文档…（Ctrl+Enter 发送）'
              }
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !question.trim()}
              onClick={() => void ask(question)}
            >
              {busy ? '回答中…' : '发送'}
            </button>
          </div>
        )}
        <p className="ai-panel-note">
          只会发送本次问题、选中的文字与检索到的片段；不会上传整座书库。
        </p>
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
