import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * A crash mid-match would otherwise white-screen the app with a stake already
 * escrowed. R3F re-throws canvas failures to the parent, so this also catches
 * WebGL init and asset-load errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Mempire crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: '100dvh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          padding: 28, textAlign: 'center',
        }}
      >
        <h1 className="display" style={{ fontSize: 30 }}>Something broke</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14, maxWidth: 320 }}>
          The arena crashed. Any escrowed stake is recoverable from the match
          account — nothing is lost onchain.
        </p>
        <code
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--red)',
            maxWidth: 320, wordBreak: 'break-word',
          }}
        >
          {error.message}
        </code>
        <button
          onClick={() => { window.location.hash = '#/'; window.location.reload(); }}
          style={{
            padding: '15px 28px', borderRadius: 'var(--r-pill)',
            background: 'var(--grad-solana)', color: 'var(--void)',
            fontWeight: 800, fontSize: 14, letterSpacing: '.09em',
            textTransform: 'uppercase', minHeight: 44,
          }}
        >
          Back to Arena
        </button>
      </div>
    );
  }
}
