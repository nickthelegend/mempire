import { useEffect, useRef } from 'react';
import { coinByMint, tickerOf } from '../lib/coins';
import { fmtTokens, fmtUsd } from '../lib/format';
import { nextLevelAt } from '../lib/leveling';
import { ARCHETYPES, scaleByLevel } from '../sim/archetypes';
import { ARCHETYPE_NAMES } from '../sim/types';
import { FP } from '../sim/fixed';
import type { MintedCard } from '../state/collection';
import { ArchetypeIcon, CoinBadge, LevelPips } from './ui';

/** One labelled stat plate — the Supercell card-info grammar. */
function Stat({ icon, label, value, delta }: {
  icon: string; label: string; value: string; delta?: string;
}) {
  return (
    <div className="well" style={{ padding: '7px 9px', display: 'flex', alignItems: 'center', gap: 7 }}>
      <span aria-hidden style={{ fontSize: 15 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span className="label" style={{ fontSize: 12, display: 'block' }}>{label}</span>
        <span className="display" style={{ fontSize: 15, WebkitTextStroke: '2px var(--ink)' }}>
          {value}
          {delta && (
            <span style={{ color: 'var(--teal)', fontSize: 12, marginLeft: 4 }}>{delta}</span>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * Full card inspector. Two jobs: show the coin as a real asset (its own art and
 * live market data) and show it as a game piece (stats at this level, and the
 * exact cost of the next one). Seeing both together is what turns a browse into
 * a stake.
 */
export function CardDetail({
  card, onClose, onStake,
}: { card: MintedCard; onClose: () => void; onStake?: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const coin = coinByMint(card.mint);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    sheet.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!coin) return null;
  const def = ARCHETYPES[card.archetype];
  const next = nextLevelAt(card.stakedUsd);
  const hp = scaleByLevel(def.hp, card.level);
  const dmg = scaleByLevel(def.damage, card.level);
  const dps = def.hitTicks > 0 ? Math.round((dmg * 20) / def.hitTicks) : dmg;
  const nextHp = scaleByLevel(def.hp, Math.min(10, card.level + 1));
  const nextDmg = scaleByLevel(def.damage, Math.min(10, card.level + 1));
  const up = coin.change24h ?? 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${tickerOf(coin)} card details`}
        className="panel"
        style={{
          position: 'absolute', bottom: 0, width: 'min(100vw, 430px)',
          maxHeight: '92dvh', overflowY: 'auto',
          borderRadius: '22px 22px 0 0', borderBottom: 'none',
          padding: '16px 14px calc(18px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 10, outline: 'none',
          animation: 'sheetUp 250ms var(--ease-snap)',
        }}
      >
        <style>{'@keyframes sheetUp{from{transform:translateY(44%);opacity:0}to{transform:none;opacity:1}}'}</style>

        {/* hero: the coin's own art, big */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{
            padding: 5, borderRadius: 14,
            background: `linear-gradient(180deg, hsl(${coin.hue} 62% 46%), hsl(${coin.hue} 55% 24%))`,
            border: '2.5px solid var(--ink)', boxShadow: 'inset 0 2px 0 rgba(255,255,255,.3)',
          }}
          >
            <CoinBadge mint={card.mint} size={64} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="display" style={{ fontSize: 25, lineHeight: 1.1 }}>{tickerOf(coin)}</h2>
            <p className="fine" style={{ color: 'var(--dim-on-wood)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {coin.name}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <ArchetypeIcon archetype={card.archetype} size={15} />
              <span className="label" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>
                {ARCHETYPE_NAMES[card.archetype]}
              </span>
              <span className="money" style={{ fontSize: 13, marginLeft: 'auto' }}>{def.elixir}⚡</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)', alignSelf: 'flex-start' }}>×</button>
        </div>

        <LevelPips level={card.level} />

        {/* the coin as a real asset */}
        <div>
          <div className="label" style={{ marginBottom: 5, color: 'var(--dim-on-wood)' }}>
            Market {coin.pumpFun && <span style={{ color: 'var(--teal)' }}>· pump.fun</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Stat icon="◎" label="Price" value={fmtUsd(coin.priceUsd)} />
            <Stat
              icon={up >= 0 ? '📈' : '📉'}
              label="24h"
              value={`${up >= 0 ? '+' : ''}${up.toFixed(2)}%`}
            />
            <Stat icon="🌊" label="Liquidity" value={fmtUsd(coin.liquidityUsd)} />
            <Stat icon="🏦" label="Market cap" value={coin.fdvUsd ? fmtUsd(coin.fdvUsd) : '—'} />
          </div>
        </div>

        {/* the coin as a game piece */}
        <div>
          <div className="label" style={{ marginBottom: 5, color: 'var(--dim-on-wood)' }}>
            Battle stats · level {card.level}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Stat
              icon="❤️" label="Hitpoints" value={String(hp)}
              delta={card.level < 10 ? `+${nextHp - hp}` : undefined}
            />
            <Stat
              icon="⚔️" label="Damage" value={String(dmg)}
              delta={card.level < 10 ? `+${nextDmg - dmg}` : undefined}
            />
            <Stat icon="💥" label="Damage / sec" value={String(dps)} />
            <Stat icon="🏃" label="Speed" value={`${((def.speedFP / FP) * 20).toFixed(1)} t/s`} />
            <Stat icon="🎯" label="Range" value={`${(def.rangeFP / FP).toFixed(1)} tiles`} />
            <Stat icon="👥" label="Count" value={def.count > 0 ? `x${def.count}` : 'spell'} />
          </div>
        </div>

        {/* your position */}
        <div className="well" style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ minWidth: 0 }}>
            <span className="label" style={{ fontSize: 12, display: 'block' }}>You have staked</span>
            <span className="money" style={{ fontSize: 19 }}>{fmtUsd(card.stakedUsd)}</span>
            <span className="fine" style={{ display: 'block', fontSize: 12 }}>
              {fmtTokens(card.stakedTokens)} {tickerOf(coin)}
            </span>
          </span>
          <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <span className="label" style={{ fontSize: 12, display: 'block' }}>Next level</span>
            <span className="display" style={{ fontSize: 15 }}>
              {next ? `${fmtUsd(next.usd)} → Lv ${next.level}` : 'MAX'}
            </span>
          </span>
        </div>

        {onStake && (
          <button
            onClick={onStake}
            className="btn-3d"
            style={{
              minHeight: 50, borderRadius: 'var(--r-pill)',
              background: 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 50%)',
              border: '3px solid var(--ink)',
              fontFamily: 'var(--font-display)', fontSize: 18, color: '#fff',
              WebkitTextStroke: '2.5px var(--ink)', paintOrder: 'stroke fill',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5), 0 5px 0 var(--btn-gold-dark)',
            }}
          >
            Stake to level up
          </button>
        )}

        {coin.url && (
          <a
            href={coin.url}
            target="_blank"
            rel="noopener noreferrer"
            className="fine"
            style={{ color: 'var(--blue-pale)', textAlign: 'center', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            View {tickerOf(coin)} chart ↗
          </a>
        )}
      </div>
    </div>
  );
}
