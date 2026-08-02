import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CardFrame } from '../components/CardFrame';
import { Tutorial, resetTutorial, tutorialDone } from '../components/Tutorial';
import { Crowns, Pill } from '../components/ui';
import { fmtSol, shortAddr } from '../lib/format';
import { FEES, useCollection } from '../state/collection';
import { TIERS, useDeck } from '../state/deck';
import { useMatch } from '../state/match';
import { useWallet } from '../state/wallet';

const FEED = [
  ['chad.sol', '0.45'], ['ser_liquidator', '1.80'], ['anon_4231', '0.09'],
  ['wagmi_warlord', '9.00'], ['rekt_ranger', '0.45'], ['moon_marchesa', '1.80'],
];

export function Logo({ width = 260 }: { width?: number }) {
  return (
    <img
      src="/art/logo.png"
      alt="Mempire"
      width={width}
      draggable={false}
      style={{ display: 'block', margin: '0 auto', height: 'auto', maxWidth: '100%' }}
    />
  );
}

/** Resource chip — the gold/gem pills along the top of a Supercell HUD. */
function Chip({ icon, value, tone }: { icon: string; value: string; tone: 'gold' | 'blue' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 10px 3px 5px', borderRadius: 999,
      background: 'var(--recess)',
      border: '2px solid var(--ink)',
      boxShadow: 'var(--bevel-in)',
      minWidth: 0,
    }}
    >
      <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>
      <span
        className="money"
        style={{ fontSize: 14, color: tone === 'gold' ? 'var(--gold-hi)' : 'var(--blue-pale)', whiteSpace: 'nowrap' }}
      >
        {value}
      </span>
    </div>
  );
}

function ConnectHero() {
  const openPicker = useWallet((s) => s.openPicker);
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '40px 22px', gap: 20, textAlign: 'center',
    }}
    >
      <Logo width={320} />
      <p className="display" style={{ fontSize: 21, lineHeight: 1.2 }}>
        Your bags are your army
      </p>
      <p style={{ color: 'var(--dim)', fontSize: 14, maxWidth: 300, margin: '-8px auto 0' }}>
        Mint cards from the meme coins you hold, stake them for power, and battle for the pot.
      </p>
      <div style={{ padding: '0 12px', marginTop: 6 }}>
        <Pill onClick={openPicker} tone="gold" style={{ fontSize: 19 }}>Connect Wallet</Pill>
      </div>
      <span className="label" style={{ fontSize: 12 }}>devnet · no real funds</span>
    </div>
  );
}

function TopHud({ onReplayTutorial }: { onReplayTutorial: () => void }) {
  const wallet = useWallet();
  const history = useMatch((s) => s.history);
  const [open, setOpen] = useState(false);
  const wins = history.filter((h) => h.won).length;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account menu"
        className="btn-3d"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
          padding: '4px 12px 4px 4px', borderRadius: 999, minHeight: 44,
          background: 'var(--recess)', border: '2px solid var(--ink)',
          boxShadow: 'var(--bevel-in)', minWidth: 0,
        }}
      >
        <img
          src="/art/avatar_guest.png"
          alt=""
          aria-hidden
          width={34}
          height={34}
          style={{ display: 'block', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.6))' }}
        />
        <span style={{ minWidth: 0 }}>
          <span
            className="display display--sm"
            style={{ display: 'block', fontSize: 14 }}
          >
            anon_king
          </span>
          <span
            className="mono"
            style={{
              display: 'block', fontSize: 12, color: 'var(--dim)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {wallet.walletName} · {shortAddr(wallet.address)}
          </span>
        </span>
      </button>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <Chip icon="👑" value={String(wins)} tone="blue" />
        <Chip icon="◎" value={fmtSol(wallet.sol).replace(' SOL', '')} tone="gold" />
      </div>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 24 }} onClick={() => setOpen(false)} />
          <div
            className="panel"
            style={{ position: 'absolute', top: 48, left: 0, zIndex: 25, padding: 6, minWidth: 200 }}
          >
            <button
              onClick={() => { void navigator.clipboard?.writeText(wallet.address); setOpen(false); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--dim-on-wood)' }}
            >
              Copy address
            </button>
            <button
              onClick={() => { resetTutorial(); setOpen(false); onReplayTutorial(); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--dim-on-wood)' }}
            >
              Replay tutorial
            </button>
            <button
              onClick={() => { wallet.disconnect(); setOpen(false); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--red-on-wood)' }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Arena() {
  const wallet = useWallet();
  const deck = useDeck();
  const cards = useCollection((s) => s.cards);
  const match = useMatch();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [feedIdx, setFeedIdx] = useState(0);
  // First connect only; replay lives in the account menu.
  const [showTutorial, setShowTutorial] = useState(false);
  useEffect(() => {
    if (wallet.connected && !tutorialDone()) setShowTutorial(true);
  }, [wallet.connected]);

  useEffect(() => {
    const t = setInterval(() => setFeedIdx((i) => i + 1), 2600);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (match.status === 'battle') nav('/battle');
  }, [match.status, nav]);

  const deckCards = useMemo(
    () => deck.active.map((id) => cards.find((c) => c.id === id)).filter(Boolean),
    [deck.active, cards],
  );

  if (!wallet.connected) return <ConnectHero />;

  const tier = TIERS[deck.tier];
  const pot = tier.stakeSol * 2;
  const queueing = match.status === 'queuing' || match.status === 'found';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 16px 8px' }}>
      <TopHud onReplayTutorial={() => setShowTutorial(true)} />
      <Logo width={210} />

      {/* tier picker — carved wood rail of stake plates */}
      <section className="panel" data-tut="tier" style={{ padding: 9 }}>
        <div className="label" style={{ marginBottom: 7, textAlign: 'center' }}>
          Stake tier
        </div>
        <div role="radiogroup" aria-label="Stake tier" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7 }}>
          {TIERS.map((t, i) => {
            const active = deck.tier === i;
            const affordable = wallet.sol >= t.stakeSol;
            return (
              <button
                key={t.name}
                role="radio"
                aria-checked={active}
                aria-label={`${t.name} tier, ${t.stakeSol} SOL`}
                onClick={() => deck.setTier(i)}
                disabled={!affordable || queueing}
                className="btn-3d"
                style={{
                  padding: '7px 2px 6px', minHeight: 52, borderRadius: 9, textAlign: 'center',
                  background: active
                    ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: active
                    ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 3px 0 var(--btn-blue-dark)'
                    : 'var(--bevel-in)',
                  filter: affordable ? 'none' : 'saturate(.3)',
                  transition: 'background 160ms var(--ease-snap), box-shadow 120ms var(--ease-snap)',
                }}
              >
                <Crowns n={t.crowns} size={11} />
                <div
                  className="money"
                  style={{
                    fontSize: 13, marginTop: 2,
                    color: !affordable ? 'var(--red-on-wood)' : 'var(--gold-hi)',
                  }}
                >
                  {t.stakeSol}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* the moment */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {queueing ? (
          <>
            <div
              className="panel"
              style={{
                padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              {/* three pulsing crowns — a search that visibly progresses */}
              <span aria-hidden style={{ display: 'flex', gap: 3 }}>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 17, color: 'var(--gold)',
                      animation: `searchPulse 1.1s ${i * 0.18}s ease-in-out infinite`,
                    }}
                  >
                    ♛
                  </span>
                ))}
              </span>
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span className="display display--sm" style={{ fontSize: 17, display: 'block' }}>
                  {match.status === 'found' ? 'Opponent found!' : 'Finding opponent'}
                </span>
                <span className="fine" style={{ color: 'var(--dim-on-wood)', fontSize: 12 }}>
                  {match.status === 'found'
                    ? `${match.opponentName} · entering arena`
                    : `matching your deck power (${deck.power()})`}
                </span>
              </span>
              <style>{'@keyframes searchPulse{0%,100%{opacity:.28;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}'}</style>
            </div>
            {/* Once found, the die is cast — stake escrowed, opponent committed.
                Offering Cancel there would either lie or forfeit; it does neither. */}
            {match.status === 'queuing' && (
              <Pill tone="blue" onClick={() => match.cancelQueue()} style={{ fontSize: 15, minHeight: 46, padding: '10px 18px' }}>
                Cancel search
              </Pill>
            )}
          </>
        ) : (
          <>
            <div data-tut="battle">
              <Pill onClick={() => setError(match.startQueue())} tone="gold" style={{ fontSize: 25, padding: '19px 24px' }}>
                Battle
              </Pill>
            </div>
            {/* No stake, no rake, no chest — somewhere to learn the controls
                without paying tuition in SOL. */}
            <div data-tut="practice">
              <Pill
                tone="green"
                onClick={() => setError(match.startQueue({ practice: true }))}
                style={{ fontSize: 15, minHeight: 46, padding: '10px 18px' }}
              >
                Practice · free
              </Pill>
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="well" style={{ color: 'var(--red-on-wood)', fontSize: 13, textAlign: 'center', padding: '8px 10px', fontWeight: 700 }}>
            {error}
          </div>
        )}

        <div className="panel" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="label">Pot</span>
          <span className="money" style={{ fontSize: 22 }}>{fmtSol(pot)}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dim-on-wood)', textAlign: 'right', lineHeight: 1.25 }}>
            you stake {fmtSol(tier.stakeSol)}<br />
            winner takes {100 - FEES.rakePct}%
          </span>
        </div>
      </section>

      {/* live feed */}
      <section aria-label="Recent settlements" className="well" style={{ padding: '9px 12px', overflow: 'hidden' }}>
        <div key={feedIdx} style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'feedIn 400ms var(--ease-snap)' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: 'var(--teal)',
            boxShadow: '0 0 8px var(--teal)', flexShrink: 0,
          }}
          />
          <span style={{ fontSize: 13, color: 'var(--dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--text)' }}>{FEED[feedIdx % FEED.length][0]}</strong> won
          </span>
          <span className="money" style={{ marginLeft: 'auto', fontSize: 14, whiteSpace: 'nowrap' }}>
            +{FEED[feedIdx % FEED.length][1]}
          </span>
        </div>
        <style>{'@keyframes feedIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'}</style>
      </section>

      {/* deck strip */}
      <section data-tut="deck">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span className="label">Battle deck</span>
          {/* power is a game stat, not money — gold stays reserved for SOL */}
          <span className="label" style={{ color: 'var(--blue-pale)' }}>power {deck.power()}</span>
        </div>
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 7,
          }}
        >
          {deckCards.slice(0, 4).map((c) => c && <CardFrame key={c.id} card={c} width={74} fluid />)}
        </div>
      </section>

      {showTutorial && <Tutorial onDone={() => setShowTutorial(false)} />}
    </div>
  );
}
