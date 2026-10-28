import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 兜住渲染异常：书库与 sidecar 都在磁盘上，重新加载就能回来。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染失败', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>界面遇到问题</h1>
          <p>
            标注没有丢：它们已经写入书库的 sidecar。重新加载后可以继续使用；
            如果反复出现，请把下面的错误信息附到 Issue 里。
          </p>
          <pre>{error.message}</pre>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
