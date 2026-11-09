import { useCallback, useEffect, useState } from 'react';
import {
  mcpResetToken,
  mcpSetEnabled,
  mcpSetExposeText,
  mcpSetPort,
  mcpStatus,
} from './desktop';
import { errorText } from './errors';
import { isTauri } from './platform';
import type { McpSettingsView } from './types';

export function McpSettingsSection() {
  const [view, setView] = useState<McpSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [portDraft, setPortDraft] = useState('8765');
  const [copied, setCopied] = useState('');
  const [resetArmed, setResetArmed] = useState(false);

  const apply = useCallback(async (task: () => Promise<McpSettingsView>) => {
    setBusy(true);
    setError('');
    try {
      const next = await task();
      setView(next);
      setPortDraft(String(next.port));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await mcpStatus();
      setView(next);
      setPortDraft(String(next.port));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    void load();
  }, [load]);

  // 启动时 MCP 在后台 bind；设置页打开得早时要等运行状态落定。
  const enabled = view?.enabled ?? false;
  const running = view?.running ?? false;
  const viewError = view?.error ?? null;
  useEffect(() => {
    if (!enabled || running || viewError) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void mcpStatus()
        .then((next) => {
          setView(next);
          setPortDraft(String(next.port));
        })
        .catch(() => undefined);
      if (attempts >= 10) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [enabled, running, viewError]);

  if (!isTauri()) {
    return <p className="sidebar-hint">MCP 接入只在桌面端可用。</p>;
  }

  if (loading) {
    return <p className="sidebar-hint">正在读取 MCP 状态…</p>;
  }

  const status = view?.error
    ? `启动失败：${view.error}`
    : running
      ? `运行中 · 127.0.0.1:${view?.actualPort ?? view?.port ?? ''}`
      : enabled
        ? '正在启动…'
        : '已关闭';

  const copyConfig = async () => {
    if (!view?.configJson) return;
    try {
      await navigator.clipboard.writeText(view.configJson);
      setCopied('客户端配置已复制');
    } catch {
      setCopied('复制失败，请手动选择下方文本');
    }
    window.setTimeout(() => setCopied(''), 2400);
  };

  return (
    <div className="mcp-settings">
      <section className="settings-section">
        <h3>MCP 接入</h3>
        <div className="settings-row">
          <div>
            <strong>启用只读 MCP</strong>
            <span>只监听 127.0.0.1，供 Claude Desktop、Cursor 等本机客户端连接。默认关闭。</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.checked;
                void apply(() => mcpSetEnabled(next));
              }}
            />
            <span>{enabled ? '开' : '关'}</span>
          </label>
        </div>

        <div className="settings-row">
          <div>
            <strong>端口</strong>
            <span>默认 8765；修改后会重启监听。端口需在 1024–65535。</span>
          </div>
          <div className="mcp-port">
            <input
              type="number"
              min={1024}
              max={65535}
              value={portDraft}
              disabled={busy}
              onChange={(event) => setPortDraft(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || Number(portDraft) === view?.port}
              onClick={() => void apply(() => mcpSetPort(Number(portDraft)))}
            >
              应用
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <strong>允许读取正文</strong>
            <span>关闭时仍可列文档、读标注；开启后外部 Agent 可搜索并分页读取正文。</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={view?.exposeText ?? false}
              disabled={busy || !enabled}
              onChange={(event) => {
                const next = event.target.checked;
                void apply(() => mcpSetExposeText(next));
              }}
            />
            <span>{view?.exposeText ? '开' : '关'}</span>
          </label>
        </div>

        <p className={`mcp-status ${view?.error ? 'error' : running ? 'running' : ''}`}>
          {status}
        </p>
        {error && <p className="mcp-error">{error}</p>}

        {enabled && (
          <>
            <div className="settings-row">
              <div>
                <strong>客户端 URL</strong>
                <span>URL 内含访问 token，等同于本机读取权限，请只粘贴到可信客户端。</span>
              </div>
            </div>
            <input className="mcp-url" readOnly value={view?.url ?? ''} />
            <div className="mcp-actions">
              <button
                type="button"
                className="primary"
                disabled={!view?.configJson}
                onClick={() => void copyConfig()}
              >
                复制客户端配置
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  if (!resetArmed) {
                    setResetArmed(true);
                    window.setTimeout(() => setResetArmed(false), 4000);
                    return;
                  }
                  setResetArmed(false);
                  void apply(() => mcpResetToken());
                }}
              >
                {resetArmed ? '再次点击确认重置' : '重置 token'}
              </button>
            </div>
            {copied && <p className="sidebar-hint">{copied}</p>}
            <textarea
              className="mcp-config"
              readOnly
              value={view?.configJson ?? ''}
              onFocus={(event) => event.target.select()}
              aria-label="MCP 客户端配置"
            />
          </>
        )}
      </section>
    </div>
  );
}
