import { useEffect, useMemo, useState } from 'react';
import { buzz, click, play } from '../lib/audio';
import {
  CHESTS, CHEST_SLOTS, GEM_BUNDLES, skipCost, useEconomy,
  type ChestDef, type ChestSlot,
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

/** Generated chest art; bobs and glows once it is ready to open. */
function ChestArt({ tier, size = 54, glow }: { tier: ChestSlot['tier']; size?: number; glow?: boolean }) {
  return (
    <>
      <img
        src={`/art/chest_${tier}.png`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        style={{
          display: 'block',
          filter: glow
            ? 'drop-shadow(0 0 12px rgba(255,214,102,.95)) drop-shadow(0 2px 4px rgba(0,0,0,.5))'
            : 'drop-shadow(0 3px 5px rgba(0,0,0,.55))',
          animation: glow ? 'chestBob 1.1s ease-in-out infinite' : undefined,
        }}
      />
      <style>{'@keyframes chestBob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-5px) rotate(2deg)}}'}</style>
    </>
  );
}

/**
 * The reward moment. A chest that shakes, bursts, and sprays its contents —
 * this is the payoff the whole timer mechanic is selling, so it gets a full
 * screen rather than a toast.
 */
function OpenCeremony({
  def, onDone,
}: { def: ChestDef; onDone: () => void }) {
  const [phase, setPhase] = useState<'shake' | 'burst'>('shake');

  useEffect(() => {
    play('chestOpen');
    buzz(24);
    const t1 = setTimeout(() => { setPhase('burst'); play('reward'); }, 700);
    return () => clearTimeout(t1);
  }, []);

  const sparks = useMemo(
    () => Array.from({ length: 22 }, (_, i) => ({
      angle: (i / 22) * Math.PI * 2,
      dist: 90 + ((i * 37) % 70),
      delay: (i % 6) * 40,
      size: 7 + ((i * 13) % 8),
    })),
    [],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${def.name} opened`}
      onClick={onDone}
      style={{
        position: 'fixed', inset: 0, zIndex: 70,
        background: 'radial-gradient(60% 45% at 50% 42%, rgba(255,214,102,.3), var(--scrim) 70%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 18,
      }}
    >
      <style>{`
        @keyframes chestShake{0%,100%{transform:rotate(-5deg) scale(1)}25%{transform:rotate(5deg) scale(1.04)}50%{transform:rotate(-6deg) scale(1)}75%{transform:rotate(6deg) scale(1.05)}}
        @keyframes chestBurst{0%{transform:scale(.7);opacity:0}40%{transform:scale(1.18);opacity:1}100%{transform:scale(1);opacity:1}}
        @keyframes sparkFly{0%{transform:translate(0,0) scale(.4);opacity:0}18%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(1);opacity:0}}
        @keyframes rayspin{to{transform:rotate(360deg)}}
      `}</style>

      {/* light rays behind the burst */}
      {phase === 'burst' && (
        <div
          aria-hidden
          style={{
            position: 'absolute', width: 460, height: 460,
            background: 'conic-gradient(from 0deg, rgba(255,226,138,.5) 0 6deg, transparent 6deg 30deg)',
            animation: 'rayspin 9s linear infinite',
            borderRadius: '50%', pointerEvents: 'none',
          }}
        />
      )}

      {/* sparks */}
      {phase === 'burst' && sparks.map((s, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            position: 'absolute', width: s.size, height: s.size, borderRadius: '50%',
            background: 'radial-gradient(circle at 34% 30%, #fff6d0, var(--gold) 62%, #b5820a)',
            ['--dx' as string]: `${Math.cos(s.angle) * s.dist}px`,
            ['--dy' as string]: `${Math.sin(s.angle) * s.dist}px`,
            animation: `sparkFly 1100ms ${s.delay}ms cubic-bezier(.2,.7,.3,1) forwards`,
          }}
        />
      ))}

      <img
        src={phase === 'burst' ? '/art/chest_open.png' : `/art/chest_${def.tier}.png`}
        alt=""
        aria-hidden
        width={phase === 'burst' ? 210 : 150}
        draggable={false}
        style={{
          animation: phase === 'shake'
            ? 'chestShake 220ms linear infinite'
            : 'chestBurst 520ms var(--ease-snap)',
          filter: 'drop-shadow(0 0 26px rgba(255,214,102,.9))',
        }}
      />

      {phase === 'burst' && (
        <>
          <h2 className="display display--gold" style={{ fontSize: 34, textAlign: 'center' }}>
            {def.name}
          </h2>
          <div style={{ display: 'flex', gap: 10 }}>
            <span className="well" style={{ padding: '9px 15px' }}>
              <span className="display" style={{ fontSize: 19 }}>+{def.cards} cards</span>
            </span>
            <span className="well" style={{ padding: '9px 15px' }}>
              <span className="display" style={{ fontSize: 19 }}>+{def.gems} 💎</span>
            </span>
          </div>
          <p className="fine" style={{ color: 'var(--dim)' }}>tap to continue</p>
        </>
      )}
    </div>
  );
}

function Slot({ chest, onOpened }: {
  chest: ChestSlot | null;
  onOpened: (def: ChestDef) => void;
}) {
  const { startUnlock, skipUnlock, collect, gems } = useEconomy();

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
      {ready ? (
        <button
          onClick={() => {
            click();
            const got = collect(chest.id);
            if (got) onOpened(got);
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
          onClick={() => { click(); skipUnlock(chest.id); }}
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
          onClick={() => { click(); startUnlock(chest.id); }}
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
  const [opened, setOpened] = useState<ChestDef | null>(null);
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
        {slots.map((c, i) => (
          <Slot key={c?.id ?? `empty_${i}`} chest={c} onOpened={setOpened} />
        ))}
      </div>
      {opened && <OpenCeremony def={opened} onDone={() => setOpened(null)} />}
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
          <button onClick={() => { click(); onClose(); }} aria-label="Close" style={{ marginLeft: 'auto', fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)' }}>×</button>
        </div>
        <p className="fine" style={{ color: 'var(--dim-on-wood)', marginTop: -6 }}>
          Gems skip chest timers, enter tournaments and buy cosmetics.
          They never buy stats — card power comes only from staking real tokens.
        </p>
        {GEM_BUNDLES.map((b) => (
          <button
            key={b.gems}
            onClick={() => { click(); buyGems(b); }}
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
