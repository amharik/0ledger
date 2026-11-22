import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error?: Error | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="card" style={{ padding: '2rem', border: '1px solid #ef4444' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <span style={{ fontSize: '1.5rem' }}>⚠️</span>
            <h3 style={{ margin: 0, color: '#ef4444' }}>
              {this.props.fallbackTitle || 'Unable to load panel'}
            </h3>
          </div>
          <p className="muted small" style={{ marginBottom: '1rem' }}>
            An unexpected error occurred while rendering this section:
          </p>
          <pre
            style={{
              padding: '1rem',
              background: 'var(--panel)',
              borderRadius: '6px',
              fontSize: '0.85rem',
              color: '#ef4444',
              overflowX: 'auto',
              marginBottom: '1.5rem',
            }}
          >
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button type="button" className="secondary small-button" onClick={this.handleReset}>
            🔄 Try Again
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
