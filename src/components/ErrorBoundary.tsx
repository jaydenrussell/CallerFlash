import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catch-all for render-time crashes. Without this, any thrown exception
 * during React rendering unmounts the entire tree and the user is left
 * staring at a blank window. The boundary shows the actual error instead,
 * plus a reload button that remounts the subtree.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    try {
      // Webview console is not captured in packaged builds - mirror the
      // crash into the diagnostics log so it survives a restart.
      useAppStore.getState().addDiagnosticLog({
        level: 'error',
        category: 'SYSTEM',
        message: `Render crash: ${error.message}`,
      });
    } catch {
      // Never rethrow from componentDidCatch - the fallback UI must render.
    }
  }

  private handleReload = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
        <p className="text-sm font-semibold text-win-warning">Something went wrong on this page.</p>
        <pre className="max-w-full overflow-x-auto text-[11px] text-win-text-secondary bg-win-card border border-win-border rounded-lg p-3 whitespace-pre-wrap">
          {error.message}
        </pre>
        <button
          onClick={this.handleReload}
          className="px-4 py-1.5 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold"
        >
          Reload page
        </button>
      </div>
    );
  }
}
