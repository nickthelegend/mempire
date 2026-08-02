import { useEffect, useState } from 'react';
import {
  CHESTS, CHEST_SLOTS, GEM_BUNDLES, skipCost, useEconomy, type ChestSlot,
} from '../state/economy';

/** One-second ticker, only while something is actually counting down. */
function useTicker(active: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** The chest itself — a lid, a body, a keyhole, and gold bands. */
function ChestArt({ tier, size = 54, glow }: { tier: ChestSlot['tier']; size?: number; glow?: boolean }) {
  const [hi, lo] = CHESTS[tier].colors;
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size * 0.82, position: 'relative',
        filter: glow ? 'drop-shadow(0 0 10px rgba(255,214,102,.95))' : 'drop-shadow(0 3px 4px rgba(0,0,0,.5))',
        animation: glow ? 'chestBob 1.1s ease-in-out infinite' : undefined,
      }}
    >
      {/* body */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: '58%',
        background: `linear-gradient(180deg, ${hi}, ${lo})`,
        border: '2.5px solid var(--ink)', borderRadius: '3px 3px 5px 5px',
        boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45)',
      }}
      />
      {/* lid */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: '48%',
        background: `linear-gradient(180deg, ${hi}, ${lo})`,
        border: '2.5px solid var(--ink)',
        borderRadius: `${size * 0.3}px ${size * 0.3}px 3px 3px`,
        boxShadow: 'inset 0 3px 0 rgba(255,255,255,.55)',
      }}
      />
      {/* gold band + keyhole */}
      <div style={{
        position: 'absolute', left: '38%', right: '38%', top: '30%', bottom: 0,
        background: 'linear-gradient(180deg, var(--gold-hi), var(--gold))',
        border: '2px solid var(--ink)', borderRadius: 2,
      }}
      />
      <div style={{
        position: 'absolute', left: '46%', right: '46%', top: '46%', height: '16%',
        background: 'var(--ink)', borderRadius: 2,
      }}
      />
      <style>{'@keyframes chestBob{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-4px) rotate(1.5deg)}}'}</style>
    </div>
  );
}

function Slot({ chest }: { chest: ChestSlot | null }) {
  const { startUnlock, skipUnlock, collect, gems } = useEconomy();
  const [reward, setReward] = useState<string | null>(null);

  if (!chest) {
    return (
      <div
        role="img"
        aria-label="Empty chest slot"
        className="well"
        style={{
          aspectRatio: '1 / 1.15', display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 3,
        }}
      >
        <span className="label" style={{ fontSize: 9, opacity: 0.7 }}>empty</span>
      </div>
    );
  }

  const def = CHESTS[chest.tier];
  const remaining = chest.unlocking ? Math.max(0, chest.readyAt - Date.now()) : def.unlockMs;
  const ready = chest.unlocking && remaining === 0;
  const cost = skipCost(remaining);

  return (
    <div
      className="well"
      style={{
        aspectRatio: '1 / 1.15', padding: 5, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
        borderColor: ready ? 'var(--gold)' : undefined,
      }}
    >
      <ChestArt tier={chest.tier} size={44} glow={ready} />
      {reward ? (
        <span className="money" style={{ fontSize: 10 }}>{reward}</span>
      ) : ready ? (
        <button
          onClick={() => {
            const got = collect(chest.id);
            if (got) setReward(`+${got.cards} cards +${got.gems}💎`);
          }}
          style={{
            width: '100%', minHeight: 26, borderRadius: 7, fontSize: 10,
            fontFamily: 'var(--font-display)',
            background: 'linear-gradient(180deg,var(--btn-green-hi),var(--btn-green))',
            border: '2px solid var(--ink)', color: '#fff',
            WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
            boxShadow: '0 2px 0 var(--btn-green-dark)',
          }}
        >
          OPEN
        </button>
      ) : chest.unlocking ? (
        <button
          onClick={() => skipUnlock(chest.id)}
          disabled={gems < cost}
          aria-label={`Skip ${fmtLeft(remaining)} for ${cost} gems`}
          style={{
            width: '100%', minHeight: 26, borderRadius: 7, fontSize: 9.5,
            background: 'rgba(6,16,38,.6)', border: '2px solid var(--ink)',
            color: gems < cost ? 'var(--dim)' : 'var(--gold-hi)', fontWeight: 800,
            opacity: gems < cost ? 0.6 : 1,
          }}
        >
          {fmtLeft(remaining)} · {cost}💎
        </button>
      ) : (
        <button
          onClick={() => startUnlock(chest.id)}
          style={{
            width: '100%', minHeight: 26, borderRadius: 7, fontSize: 10,
            fontFamily: 'var(--font-display)',
            background: 'linear-gradient(180deg,var(--btn-blue-hi),var(--btn-blue))',
            border: '2px solid var(--ink)', color: '#fff',
            WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
            boxShadow: '0 2px 0 var(--btn-blue-dark)',
          }}
        >
          START
        </button>
      )}
    </div>
  );
}

/** The chest rail — four slots, exactly like the games this borrows from. */
export function ChestRail() {
  const chests = useEconomy((s) => s.chests);
  useTicker(chests.some((c) => c.unlocking && c.readyAt > Date.now()));

  const slots: (ChestSlot | null)[] = Array.from(
    { length: CHEST_SLOTS },
    (_, i) => chests[i] ?? null,
  );

  return (
    <section aria-label="Chests">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span className="label">Chests</span>
        <span className="label" style={{ fontSize: 10 }}>
          {chests.length}/{CHEST_SLOTS} · win to earn
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 7 }}>
        {slots.map((c, i) => <Slot key={c?.id ?? `empty_${i}`} chest={c} />)}
      </div>
    </section>
  );
}

/** Gem shop sheet — the one place SOL becomes premium currency. */
export function GemShop({ onClose }: { onClose: () => void }) {
  const { gems, buyGems } = useEconomy();

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 55, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Buy gems"
        className="panel"
        style={{
          position: 'absolute', bottom: 0, width: 'min(100vw, 430px)',
          borderRadius: '22px 22px 0 0', borderBottom: 'none',
          padding: '18px 16px calc(20px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 10,
          animation: 'sheetUp 240ms var(--ease-snap)',
        }}
      >
        <style>{'@keyframes sheetUp{from{transform:translateY(42%);opacity:0}to{transform:none;opacity:1}}'}</style>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 className="display" style={{ fontSize: 24 }}>Gems</h2>
          <span className="money" style={{ marginLeft: 10, fontSize: 18 }}>{gems}💎</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)' }}>×</button>
        </div>
        <p className="fine" style={{ color: 'var(--dim-on-wood)', marginTop: -6 }}>
          Gems skip chest timers, enter tournaments and buy cosmetics.
          They never buy stats — card power comes only from staking real tokens.
        </p>
        {GEM_BUNDLES.map((b) => (
          <button
            key={b.gems}
            onClick={() => buyGems(b)}
            className="btn-3d"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, minHeight: 52,
              padding: '8px 14px', borderRadius: 'var(--r-card)',
              background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
              border: '2.5px solid var(--ink)',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)',
            }}
          >
            <span style={{ fontSize: 22 }} aria-hidden>💎</span>
            <span className="display" style={{ fontSize: 19 }}>{b.gems}</span>
            {b.bonus && (
              <span className="label" style={{ fontSize: 9, color: '#d8ffe9' }}>{b.bonus}</span>
            )}
            <span className="money" style={{ marginLeft: 'auto', fontSize: 16 }}>{b.sol} SOL</span>
          </button>
        ))}
        <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center' }}>
          Devnet build — no real SOL is charged.
        </p>
      </div>
    </div>
  );
}
