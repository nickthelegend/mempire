import { useEffect, useState } from 'react';

const TIPS = [
  'Your bags are your army — every card is a coin you actually hold.',
  'Staking raises a card\'s level. It never lowers your opponent\'s.',
  'Drag a card onto your half of the arena to deploy it.',
  'Fell a tower to earn a crown. Three crowns ends it early.',
  'Win a battle, earn a chest. Only four fit at a time.',
  'Gems buy time and cosmetics. They never buy stats.',
  'A coin needs $25k liquidity and 48 hours to become a card.',
  'The house takes 10% of every pot, and says so up front.',
];

/**
 * Shown while the battle route and its models load. It exists so the arena is
 * never a blank rectangle: a loading screen that teaches is better than a
 * spinner, and this is the only moment a player is guaranteed to read.
 */
export function Loading({ label = 'Entering the arena' }: { label?: string }) {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [pct, setPct] = useState(8);

  // Real load progress is not observable through Suspense, so the bar eases
  // toward 90% and the unmount completes it. Honest enough: it always moves,
  // and it never claims to be done while work remains.
  useEffect(() => {
    const t = setInterval(() => setPct((p) => (p < 90 ? p + Math.max(1, (90 - p) * 0.09) : p)), 90);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="quilt"
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 22, padding: '0 26px', textAlign: 'center',
      }}
    >
      <img
        src="/art/logo.png"
        alt="Mempire"
        width={270}
        draggable={false}
        style={{ maxWidth: '78%', height: 'auto', animation: 'logoPulse 2.4s ease-in-out infinite' }}
      />

      <div style={{ width: '100%', maxWidth: 320 }}>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label={label}
          style={{
            height: 22, borderRadius: 8, overflow: 'hidden',
            background: 'rgba(6,16,38,.75)',
            border: '2.5px solid var(--ink)', boxShadow: 'var(--bevel-in)',
          }}
        >
          <div style={{
            height: '100%', width: `${pct}%`,
            background: 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 48%, var(--btn-gold-dark))',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5)',
            transition: 'width 220ms linear',
          }}
          />
        </div>
        <p className="display" style={{ fontSize: 15, marginTop: 8 }}>
          {label}… {Math.round(pct)}%
        </p>
      </div>

      <p className="fine" style={{ maxWidth: 320, fontSize: 13 }}>{tip}</p>

      <style>{'@keyframes logoPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}'}</style>
    </div>
  );
}
