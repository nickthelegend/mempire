import { useEffect } from 'react';
import { isInstalled, useWallet, WALLETS, type WalletId } from '../state/wallet';

/** Wallet marks drawn in the world's own grammar — no external icon deps. */
function WalletMark({ id, size = 30 }: { id: WalletId; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': true } as const;
  if (id === 'phantom') {
    return (
      <svg {...common}>
        <rect width="32" height="32" rx="9" fill="#AB9FF2" />
        <path
          d="M25 16.2c0 4.6-3.9 8.3-8.7 8.3H8.2c-.7 0-1.1-.8-.6-1.3 1.6-1.9 3.9-5.1 4.7-8.6.1-.4.4-.6.8-.6h1.7c.4 0 .7.4.6.8-.2 1-.3 1.9-.3 2.6 0 .5.4.8.8.6 1.4-.7 2.6-2.4 3.2-4.1.1-.4.4-.6.8-.6h1.6c.4 0 .7.4.6.8-.2.9-.3 1.7-.3 2.4 0 .5.5.8.9.5 1-.7 1.7-1.9 2-3 .1-.4.4-.6.8-.6h.9c.4 0 .7.3.7.7v2.1z"
          fill="#fff"
        />
      </svg>
    );
  }
  if (id === 'backpack') {
    return (
      <svg {...common}>
        <rect width="32" height="32" rx="9" fill="#E33E3F" />
        <path d="M11 13a5 5 0 0 1 10 0v1h-2v-1a3 3 0 1 0-6 0v1h-2v-1z" fill="#fff" />
        <rect x="8" y="14.5" width="16" height="10" rx="3" fill="#fff" />
        <rect x="13.5" y="17.5" width="5" height="2.2" rx="1.1" fill="#E33E3F" />
      </svg>
    );
  }
  if (id === 'solflare') {
    return (
      <svg {...common}>
        <rect width="32" height="32" rx="9" fill="#FC7227" />
        <circle cx="16" cy="16" r="4.2" fill="#fff" />
        <path d="M16 5.5v4.2M16 22.3v4.2M5.5 16h4.2M22.3 16h4.2M8.6 8.6l3 3M20.4 20.4l3 3M23.4 8.6l-3 3M11.6 20.4l-3 3"
          stroke="#fff" strokeWidth="2.1" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect width="32" height="32" rx="9" fill="#2A2140" />
      <circle cx="16" cy="13" r="4.2" fill="#8E85A8" />
      <path d="M8.5 25c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" fill="#8E85A8" />
    </svg>
  );
}

function Row({
  onClick, disabled, mark, title, sub, right, accent,
}: {
  onClick: () => void; disabled?: boolean; mark: React.ReactNode;
  title: string; sub: string; right?: React.ReactNode; accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%',
        padding: '13px 14px', borderRadius: 14, textAlign: 'left',
        background: accent ? 'var(--raised)' : 'var(--surface)',
        border: `1px solid ${accent ? 'var(--purple)' : 'var(--border)'}`,
        opacity: disabled ? 0.55 : 1,
        transition: 'border-color 160ms var(--ease-snap), transform 160ms var(--ease-snap)',
      }}
    >
      {mark}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 800, fontSize: 15 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>{sub}</span>
      </span>
      {right}
    </button>
  );
}

export function WalletPicker() {
  const {
    pickerOpen, closePicker, connect, connecting, error,
  } = useWallet();

  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, closePicker]);

  if (!pickerOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
      onClick={closePicker}
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'center' }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(4,3,8,.78)', backdropFilter: 'blur(6px)' }} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: 0, width: 'min(100vw, 430px)',
          background: 'var(--surface)', borderRadius: '22px 22px 0 0',
          border: '1px solid var(--border)', borderBottom: 'none',
          padding: '20px 18px calc(22px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 10,
          animation: 'sheetUp 260ms var(--ease-snap)',
        }}
      >
        <style>{'@keyframes sheetUp{from{transform:translateY(46%);opacity:0}to{transform:none;opacity:1}}'}</style>

        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
          <div>
            <h2 className="display" style={{ fontSize: 26, lineHeight: 1.1 }}>Connect Wallet</h2>
            <p style={{ fontSize: 12.5, color: 'var(--dim)' }}>Devnet · no real funds move</p>
          </div>
          <button
            onClick={closePicker}
            aria-label="Close"
            style={{ marginLeft: 'auto', color: 'var(--dim)', fontSize: 26, lineHeight: 1, padding: 4 }}
          >
            ×
          </button>
        </div>

        {WALLETS.map((w) => {
          const installed = isInstalled(w);
          const busy = connecting === w.id;
          return (
            <Row
              key={w.id}
              accent={installed}
              disabled={connecting !== null}
              onClick={() => {
                if (installed) void connect(w.id);
                else window.open(w.installUrl, '_blank', 'noopener,noreferrer');
              }}
              mark={<WalletMark id={w.id} />}
              title={w.name}
              sub={busy ? 'Approve in your wallet…' : installed ? w.tagline : 'Not installed — get it'}
              right={(
                <span style={{
                  fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase',
                  color: installed ? 'var(--teal)' : 'var(--dim)',
                }}
                >
                  {busy ? '…' : installed ? 'Detected' : 'Install'}
                </span>
              )}
            />
          );
        })}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 2px' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span className="label" style={{ fontSize: 10 }}>or</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <Row
          disabled={connecting !== null}
          onClick={() => void connect('guest')}
          mark={<WalletMark id="guest" />}
          title="Play as Guest"
          sub="Simulated wallet — full game, nothing onchain"
        />

        {error && (
          <p role="alert" style={{ color: 'var(--red)', fontSize: 12.5, textAlign: 'center', marginTop: 2 }}>
            {error}
          </p>
        )}
        <p style={{ fontSize: 11, color: 'var(--dim)', textAlign: 'center', marginTop: 2 }}>
          Mempire never asks for your seed phrase.
        </p>
      </div>
    </div>
  );
}
