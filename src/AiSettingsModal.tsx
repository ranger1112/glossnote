import { useEffect, useState } from 'react';
import { saveAiSettings, testAi } from './desktop';
import { errorText } from './errors';
import type { AiSettingsView } from './types';

interface AiSettingsModalProps {
  initial: AiSettingsView;
  onClose: () => void;
  onSaved: (view: AiSettingsView) => void;
  onMessage: (message: string) => void;
}

export function AiSettingsModal({
  initial,
  onClose,
  onSaved,
  onMessage,
}: AiSettingsModalProps) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const changeProvider = (value: string) => {
    setProvider(value);
    if (value === 'anthropic') {
      setBaseUrl('https://api.anthropic.com');
      setModel('claude-sonnet-5-5');
    } else {
      setBaseUrl('http://localhost:11434/v1');
      setModel('llama3.1');
    }
    // 旧 Key 属于上一个服务商，不能继续发给新的 API 地址。
    setApiKey('');
    setClearKey(true);
    setTestResult('切换服务商后需要重新填写 API Key；保存时会清除旧 Key。');
  };

  const persist = async (): Promise<AiSettingsView> => {
    const view = await saveAiSettings({
      enabled,
      provider,
      model,
      baseUrl,
      apiKey: apiKey.trim() || null,
      clearKey,
    });
    onSaved(view);
    setApiKey('');
    setClearKey(false);
    return view;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await persist();
      onMessage('AI 设置已保存。');
      onClose();
    } catch (error) {
      onMessage(`保存 AI 设置失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult('');
    try {
      await persist();
      const reply = await testAi();
      setTestResult(`连接成功：${reply || 'OK'}`);
      onMessage('AI 连接测试成功。');
    } catch (error) {
      const message = errorText(error);
      setTestResult(`连接失败：${message}`);
      onMessage(`AI 连接测试失败：${message}`);
    } finally {
      setTesting(false);
    }
  };

  const canSubmit = model.trim().length > 0 && baseUrl.trim().length > 0 && !saving;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="card-editor ai-settings"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void handleSave();
        }}
      >
        <header className="modal-head">
          <h2>AI 设置</h2>
          <button type="button" className="icon-button" title="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            启用 AI 阅读助手
            <small>关闭时不会发出任何网络请求。</small>
          </span>
        </label>

        <label className="field">
          <span>服务商</span>
          <select value={provider} onChange={(event) => changeProvider(event.target.value)}>
            <option value="anthropic">Anthropic（Claude）</option>
            <option value="openai">OpenAI 兼容（Ollama / LM Studio / 其他）</option>
          </select>
        </label>

        <label className="field">
          <span>模型</span>
          <input
            value={model}
            placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : 'llama3.1'}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>

        <label className="field">
          <span>API 地址</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>
            API Key
            {initial.apiKeySet && <em className="field-note">已保存，留空表示不修改</em>}
          </span>
          <input
            type="password"
            value={apiKey}
            placeholder={initial.apiKeySet ? '输入新 Key 以替换，留空不修改' : '粘贴 API Key'}
            autoComplete="off"
            onChange={(event) => {
              setApiKey(event.target.value);
              setClearKey(false);
            }}
          />
        </label>

        <div className="ai-key-actions">
          <button
            type="button"
            className="ghost danger"
            disabled={!initial.apiKeySet && !apiKey}
            onClick={() => {
              setApiKey('');
              setClearKey(true);
              setTestResult('已标记为清除，保存后生效。');
            }}
          >
            清除已保存的 Key
          </button>
          <span className="field-note">
            Key 明文保存在本机应用数据目录，不会写入书库或 sidecar。
          </span>
        </div>

        <p className="ai-privacy">
          开启后，提问时会把问题、选中的文字与检索到的文档片段发送给所配置的服务商。
          发送前不会上传整座书库。
        </p>

        {testResult && <p className="ai-test-result">{testResult}</p>}
        </div>

        <footer className="modal-foot">
          <button
            type="button"
            className="ghost"
            disabled={testing || saving}
            onClick={() => void handleTest()}
          >
            {testing ? '测试中…' : '保存并测试连接'}
          </button>
          <span className="modal-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}
