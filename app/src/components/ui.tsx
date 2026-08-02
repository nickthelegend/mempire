import type { CSSProperties, ReactNode } from 'react';
import { ARCHETYPE_NAMES, type Archetype } from '../sim/types';
import { click } from '../lib/audio';
import { coinByMint } from '../lib/coins';

type Tone = 'gold' | 'blue' | 'green' | 'red';

const TONES: Record<Tone, { top: string; mid: string; base: string }> = {
  gold: { top: 'var(--btn-gold-hi)', mid: 'var(--btn-gold)', base: 'var(--btn-gold-dark)' },
  blue: { top: 'var(--btn-blue-hi)', mid: 'var(--btn-blue)', base: 'var(--btn-blue-dark)' },
  green: { top: 'var(--btn-green-hi)', mid: 'var(--btn-green)', base: 'var(--btn-green-dark)' },
  red: { top: '#ff8fa3', mid: 'var(--red)', base: '#a01930' },
};

/**
 * The arcade button. A solid colour face over a hard base edge, so it reads as
 * a physical key — and presses into its own shadow on tap. Everything
 * clickable in the game uses this; nothing is a flat rectangle.
 */
export function Pill({
  children, onClick, disabled, ghost, danger, tone = 'gold', style,
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  ghost?: boolean; danger?: boolean; tone?: Tone; style?: CSSProperties;
}) {
  const t = TONES[danger ? 'red' : tone];
  const flat = ghost || disabled;
  return (
    <button
      onClick={onClick ? () => { click(); onClick(); } : undefined}
      disabled={disabled}
      className="btn-3d"
      style={{
        display: 'block', width: '100%', padding: '13px 22px',
        borderRadius: 'var(--r-pill)',
        background: flat
          ? 'rgba(9,22,48,.5)'
          : `linear-gradient(180deg, ${t.top} 0%, ${t.mid} 46%, ${t.mid} 100%)`,
        border: `3px solid ${flat ? 'rgba(0,0,0,.45)' : 'var(--ink)'}`,
        color: disabled ? 'var(--dim)' : 'var(--text)',
        fontFamily: 'var(--font-display)',
        fontWeight: 400, fontSize: 17, letterSpacing: '0.04em', textTransform: 'uppercase',
        WebkitTextStroke: flat ? '0' : '2.5px var(--ink)',
        paintOrder: 'stroke fill',
        minHeight: 48,
        boxShadow: flat
          ? 'var(--bevel-in)'
          : `inset 0 2px 0 rgba(255,255,255,.5), inset 0 -4px 0 rgba(0,0,0,.22), 0 5px 0 ${t.base}, 0 9px 14px rgba(0,0,0,.45)`,
        transition: 'transform 90ms var(--ease-snap), box-shadow 90ms var(--ease-snap), filter 140ms',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Round coin logo. Generated art when present; procedural fallback otherwise. */
export function CoinBadge({ mint, size = 40 }: { mint: string; size?: number }) {
  const coin = coinByMint(mint);
  if (!coin) return null;
  if (coin.logoUrl) {
    return (
      <img
        src={coin.logoUrl}
        alt={coin.ticker}
        width={size}
        height={size}
        loading="lazy"
        draggable={false}
        style={{
          display: 'block',
          filter: `drop-shadow(0 ${Math.max(1, size * 0.03)}px ${size * 0.08}px rgba(0,0,0,.55))`,
        }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={coin.ticker}
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `radial-gradient(circle at 32% 28%, hsl(${coin.hue} 85% 62%), hsl(${coin.hue} 80% 34%))`,
        border: '2px solid var(--gold)',
        boxShadow: 'inset 0 -3px 6px rgba(0,0,0,.35)',
        color: '#fff', fontWeight: 800, fontSize: size * 0.32,
        textShadow: '0 1px 2px rgba(0,0,0,.5)', letterSpacing: '-0.02em',
      }}
    >
      {coin.ticker.slice(0, 2)}
    </div>
  );
}

const ARCH_SLUGS = ['tank', 'swarm', 'ranged', 'splash', 'support', 'spell'] as const;

/** Archetype crest. Generated gold icon, with a text-only fallback. */
export function ArchetypeIcon({ archetype, size = 14 }: { archetype: Archetype; size?: number }) {
  return (
    <img
      src={`/art/icon_${ARCH_SLUGS[archetype]}.png`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      style={{ display: 'block', flexShrink: 0 }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
    />
  );
}

export function ArchetypeTag({ archetype }: { archetype: Archetype }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 12, fontWeight: 700, letterSpacing: '0.06em',
      color: 'var(--dim)', textTransform: 'uppercase',
    }}
    >
      <ArchetypeIcon archetype={archetype} />
      {ARCHETYPE_NAMES[archetype]}
    </span>
  );
}

/** Level as 10 gold pips — the card's power at a glance. */
export function LevelPips({ level }: { level: number }) {
  return (
    <div style={{ display: 'flex', gap: 3 }} role="img" aria-label={`Level ${level} of 10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: i < level ? 'var(--gold)' : 'var(--raised)',
            border: i < level ? 'none' : '1px solid var(--border)',
            boxShadow: i < level ? '0 0 4px rgba(240,185,11,.6)' : 'none',
          }}
        />
      ))}
    </div>
  );
}

export function Crowns({ n, size = 13 }: { n: number; size?: number }) {
  return (
    <span
      role="img"
      aria-label={`${n} crown${n === 1 ? '' : 's'}`}
      style={{ color: 'var(--gold)', fontSize: size, letterSpacing: 1 }}
    >
      <span aria-hidden>{'♛'.repeat(n)}</span>
    </span>
  );
}

/** Sacred money readout: mono, gold, exact. */
/**
 * Money readout. `stack` puts the label above the value — required in
 * narrow two-column grids where side-by-side collides at 375px.
 */
export function MoneyRow({
  label, value, big, stack,
}: { label: string; value: string; big?: boolean; stack?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: stack ? 'column' : 'row',
      alignItems: stack ? 'flex-start' : 'baseline',
      justifyContent: stack ? 'center' : 'space-between',
      gap: stack ? 2 : 8,
      padding: big ? '13px 15px' : '10px 13px',
      background: 'var(--surface)', border: '1px solid rgba(240,185,11,.4)',
      borderRadius: 'var(--r-card)', minWidth: 0,
    }}
    >
      <span className="label" style={{ minWidth: 0, whiteSpace: 'nowrap' }}>{label}</span>
      <span
        className="money"
        style={{ fontSize: big ? 21 : 14, whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {value}
      </span>
    </div>
  );
}
