import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArchetypeIcon, CoinBadge, MoneyRow, Pill } from '../components/ui';
import { isMuted, setMuted } from '../lib/audio';
import { fmtClock, fmtSol } from '../lib/format';
import { ARCHETYPES } from '../sim/archetypes';
import { FP, fp } from '../sim/fixed';
import { BattleScene, clampDrop, isLegalDrop, resolveGroundHit } from '../three/BattleScene';
import { DOUBLE_ELIXIR_AT, OVERTIME_TICKS, REGULATION_TICKS } from '../sim/types';
import { CHESTS } from '../state/economy';
import { useMatch } from '../state/match';

function GoldBurst() {
  const parts = useMemo(() => Array.from({ length: 26 }, (_, i) => ({
    left: 8 + ((i * 37) % 84),
    delay: (i % 9) * 90,
    size: 7 + ((i * 13) % 9),
  })), []);
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <style>{`@keyframes coinFall{0%{transform:translateY(-8vh) rotate(0);opacity:0}12%{opacity:1}100%{transform:translateY(105vh) rotate(540deg);opacity:.9}}`}</style>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{
            position: 'absolute', top: 0, left: `${p.left}%`,
            width: p.size, height: p.size, borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, var(--gold-hi), var(--gold) 65%, #8a6a06)',
            animation: `coinFall 1600ms ${p.delay}ms cubic-bezier(.3,.1,.6,1) infinite`,
          }}
        />
      ))}
    </div>
  );
}

function ResultOverlay() {
  const { result, stakeSol, dismiss } = useMatch();
  const nav = useNavigate();
  if (!result) return null;
  const title = result.draw ? 'Split' : result.won ? 'Pot Secured' : 'Rekt';
  const color = result.draw ? 'var(--dim)' : result.won ? 'var(--gold)' : 'var(--red)';
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30,
      background: 'rgba(6,4,12,.88)', backdropFilter: 'blur(6px)',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '0 22px', gap: 14, textAlign: 'center',
      animation: 'fadeIn 300ms var(--ease-snap)',
    }}
    >
      <style>{'@keyframes fadeIn{from{opacity:0}to{opacity:1}}'}</style>
      {result.won && <GoldBurst />}
      <h2
        className={result.won ? 'display display--gold' : 'display'}
        style={{ fontSize: 48, color: result.won ? undefined : color, lineHeight: 1.05 }}
      >
        {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MoneyRow label="Pot" value={fmtSol(result.potSol)} />
        <MoneyRow label={`House rake (${result.draw ? 5 : 10}%)`} value={`−${fmtSol(result.rakeSol)}`} />
        <MoneyRow
          big
          label={result.won ? 'You take' : result.draw ? 'Returned' : 'You lost'}
          value={result.payoutSol > 0 ? `+${fmtSol(result.payoutSol)}` : `−${fmtSol(stakeSol)}`}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 14, alignItems: 'center' }}>
        <CrownScore crowns={result.crowns} />
      </div>
      {result.won && (
        <div className="well" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden style={{ fontSize: 22 }}>🎁</span>
          <span style={{ textAlign: 'left', minWidth: 0 }}>
            <span className="display" style={{ fontSize: 15, display: 'block' }}>
              {result.chest ? `${CHESTS[result.chest].name} earned` : 'Chest slots full'}
            </span>
            <span className="fine" style={{ fontSize: 11 }}>
              {result.chest ? 'Open it on the Cards tab' : 'Open one to make room'}
            </span>
          </span>
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--dim)' }}>
        {result.hashes} state hashes committed · settlement verified by final-state signature (devnet sim)
      </p>
      <Pill onClick={() => { dismiss(); nav('/'); }}>Return to Arena</Pill>
    </div>
  );
}

interface DragState {
  handIndex: number; // hand slot, for highlighting
  deckIndex: number; // what actually gets played — the cycle rotates
  pointerId: number;
  startX: number;
  startY: number;
  screenX: number;
  screenY: number;
  moved: boolean;
  ground: { x: number; z: number; legal: boolean } | null;
}

const TAP_SLOP_PX = 8;

/** Crowns earned — the Clash Royale scoreline, one per tower felled. */
function CrownScore({ crowns }: { crowns: [number, number] }) {
  const Side = ({ n, mine }: { n: number; mine: boolean }) => (
    <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          style={{
            fontSize: 15, lineHeight: 1,
            color: i < n ? 'var(--gold)' : 'rgba(142,133,168,.32)',
            textShadow: i < n ? '0 0 8px rgba(240,185,11,.7)' : 'none',
            transform: i < n ? 'scale(1.05)' : 'none',
            transition: 'color 240ms var(--ease-snap), transform 240ms var(--ease-snap)',
          }}
        >
          ♛
        </span>
      ))}
      <span className="mono" style={{ fontSize: 11, color: mine ? 'var(--teal)' : 'var(--red)', marginLeft: 2 }}>
        {n}
      </span>
    </span>
  );
  return (
    <div
      role="img"
      aria-label={`Crowns: you ${crowns[0]}, opponent ${crowns[1]}`}
      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
    >
      <Side n={crowns[0]} mine />
      <span style={{ color: 'var(--dim)', fontSize: 11 }}>vs</span>
      <Side n={crowns[1]} mine={false} />
    </div>
  );
}

export function Battle() {
  const match = useMatch();
  const version = useMatch((s) => s.version);
  void version; // tick-rate subscription keeps the HUD live
  // stable action reference — depending on `match` would rebuild the drag
  // listeners 20x/second for the whole match
  const playCard = useMatch((s) => s.playCard);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [, setMuteTick] = useState(0); // re-render the mute glyph
  const sceneEl = useRef<HTMLDivElement>(null);
  const shakeEl = useRef<HTMLDivElement>(null);
  const shockId = match.shock?.id ?? 0;

  // Tower-fall impact. Driven off a ref so the WebGL context is never remounted.
  // Escape backs out of the forfeit confirm.
  useEffect(() => {
    if (!confirmQuit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmQuit(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmQuit]);

  useEffect(() => {
    if (!shockId || !shakeEl.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shakeEl.current.animate(
      [
        { transform: 'none' },
        { transform: 'translate3d(0, 6px, 0) scale(1.014)', offset: 0.18 },
        { transform: 'translate3d(0, -4px, 0) scale(1.006)', offset: 0.44 },
        { transform: 'none' },
      ],
      { duration: 360, easing: 'cubic-bezier(.2,.9,.3,1)' },
    );
  }, [shockId]);

  const sim = match.sim;
  const elixir = sim ? sim.players[0].elixirFP / FP : 0;

  const project = useCallback((clientX: number, clientY: number) => {
    const el = sceneEl.current;
    if (!el) return null;
    const hit = resolveGroundHit(clientX, clientY, el);
    if (!hit) return null;
    return { x: hit.x, z: hit.z, legal: isLegalDrop(hit.x, hit.z) };
  }, []);

  // Drag lives on window so the pointer can leave the card and cross the arena.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      setDrag((d) => {
        if (!d) return d;
        const moved = d.moved
          || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > TAP_SLOP_PX;
        return {
          ...d, moved, screenX: e.clientX, screenY: e.clientY,
          ground: project(e.clientX, e.clientY),
        };
      });
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      const travelled = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travelled <= TAP_SLOP_PX) {
        // a tap, not a drag → arm the card; next arena tap deploys it
        setSelected((s) => (s === drag.handIndex ? null : drag.handIndex));
      } else {
        const g = project(e.clientX, e.clientY);
        const snapped = g ? clampDrop(g.x, g.z) : null;
        if (snapped) playCard(drag.deckIndex, fp(snapped.x), fp(snapped.z));
        setSelected(null);
      }
      setDrag(null);
    };
    const cancel = () => setDrag(null);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag, project, playCard]);

  if (!sim || match.status === 'idle') return <Navigate to="/" replace />;

  const me = sim.players[0];
  const hand = me.cycle.slice(0, 4).map((deckIndex) => ({ deckIndex, card: match.playerDeck[deckIndex] }));
  const next = match.playerDeck[me.cycle[4]];
  const remaining = sim.phase === 'overtime'
    ? REGULATION_TICKS + OVERTIME_TICKS - sim.tick
    : REGULATION_TICKS - sim.tick;
  const doubleElixir = sim.phase === 'overtime' || sim.tick >= DOUBLE_ELIXIR_AT;
  const dragCard = drag ? hand[drag.handIndex]?.card : null;

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      {/* top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
        padding: '6px 8px 14px',
        background: 'linear-gradient(rgba(6,16,38,.95), rgba(6,16,38,.55) 62%, transparent)',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            onClick={() => setConfirmQuit(true)}
            aria-label="Forfeit match"
            style={{
              color: 'var(--dim)', fontSize: 19, lineHeight: 1,
              width: 44, height: 44, flexShrink: 0,
            }}
          >
            ✕
          </button>
          <span
            className="mono"
            style={{
              marginLeft: 'auto', marginRight: 'auto',
              fontSize: 19, fontWeight: 700, whiteSpace: 'nowrap',
              // urgency is not a money moment — never gold here
              color: sim.phase === 'overtime' || remaining < 600 ? 'var(--red)' : 'var(--text)',
            }}
          >
            {sim.phase === 'overtime' ? 'OT ' : ''}{fmtClock(remaining)}
          </span>
          <button
            onClick={() => { setMuted(!isMuted()); setMuteTick((n) => n + 1); }}
            aria-label={isMuted() ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={isMuted()}
            style={{ fontSize: 15, width: 44, height: 44, flexShrink: 0, opacity: isMuted() ? 0.5 : 1 }}
          >
            {isMuted() ? '🔇' : '🔊'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <CrownScore crowns={match.crowns} />
          <span className="money" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {fmtSol(match.stakeSol * 2)}
          </span>
        </div>
      </div>

      {doubleElixir && sim.phase !== 'ended' && (
        <div style={{
          position: 'absolute', top: 46, left: 0, right: 0, zIndex: 10, textAlign: 'center',
          fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: 'var(--teal)',
        }}
        >
          2× ELIXIR
        </div>
      )}

      <div ref={shakeEl} style={{ position: 'absolute', inset: 0 }}>
        <BattleScene
          sceneRef={sceneEl}
          onPlace={(x, y) => {
            if (drag || selected === null) return;
            const snapped = clampDrop(x / FP, y / FP);
            if (snapped) {
              playCard(hand[selected].deckIndex, fp(snapped.x), fp(snapped.z));
              setSelected(null);
            }
          }}
          placing={drag !== null || selected !== null}
          marker={drag?.ground ?? null}
        />
      </div>

      {/* dragged card ghost following the finger */}
      {drag?.moved && dragCard && (
        <div
          aria-hidden
          style={{
            position: 'fixed', left: drag.screenX, top: drag.screenY, zIndex: 25,
            transform: 'translate(-50%, -120%) scale(1.12)', pointerEvents: 'none',
            filter: drag.ground?.legal === false ? 'grayscale(.7)' : 'none',
            transition: 'filter 120ms linear',
          }}
        >
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '8px 10px', borderRadius: 14,
            background: 'rgba(25,19,39,.92)',
            border: `1.5px solid ${drag.ground?.legal ? 'var(--teal)' : 'var(--red)'}`,
            boxShadow: '0 10px 26px rgba(0,0,0,.6)',
          }}
          >
            <CoinBadge mint={dragCard.coinId} size={46} />
            <span style={{ fontSize: 10, fontWeight: 800 }}>{dragCard.name}</span>
          </div>
        </div>
      )}

      {/* bottom HUD */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
        padding: '9px 10px calc(10px + env(safe-area-inset-bottom))',
        background:
          "linear-gradient(180deg, rgba(255,255,255,.09), transparent 26%),"
          + "url('/art/wood_seamless.png') center / 340px repeat, var(--wood)",
        borderTop: '3px solid var(--wood-edge)',
        boxShadow: '0 -6px 18px rgba(0,0,0,.55), inset 0 2px 0 rgba(255,255,255,.16)',
        display: 'flex', flexDirection: 'column', gap: 7,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            role="progressbar"
            aria-label="Elixir"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={Math.floor(elixir)}
            style={{
              flex: 1, height: 20, borderRadius: 7,
              background: 'rgba(6,16,38,.75)',
              border: '2.5px solid var(--ink)',
              boxShadow: 'var(--bevel-in)',
              overflow: 'hidden', position: 'relative',
            }}
          >
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg, #ff9cf5, var(--elixir) 48%, #8c1f8c)',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4)',
              transform: `scaleX(${elixir / 10})`, transformOrigin: 'left',
              transition: 'transform 110ms linear',
            }}
            />
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} style={{
                position: 'absolute', left: `${((i + 1) / 10) * 100}%`, top: 0, bottom: 0,
                width: 2, background: 'rgba(6,16,38,.6)',
              }}
              />
            ))}
          </div>
          <span
            className="display"
            style={{ fontSize: 21, color: '#ff9cf5', minWidth: 30, textAlign: 'right' }}
          >
            {Math.floor(elixir)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          {hand.map(({ card, deckIndex }, i) => {
            const cost = ARCHETYPES[card.archetype].elixir;
            const afford = elixir >= cost;
            const isDragging = drag?.handIndex === i && drag.moved;
            const isArmed = selected === i;
            return (
              <button
                key={`${card.coinId}_${i}`}
                disabled={!afford}
                aria-pressed={isArmed}
                aria-label={`Deploy ${card.name}, ${cost} elixir`}
                onPointerDown={(e) => {
                  if (!afford) return;
                  e.preventDefault();
                  setDrag({
                    handIndex: i, deckIndex, pointerId: e.pointerId,
                    startX: e.clientX, startY: e.clientY,
                    screenX: e.clientX, screenY: e.clientY,
                    moved: false,
                    ground: project(e.clientX, e.clientY),
                  });
                }}
                style={{
                  flex: 1, minWidth: 0, position: 'relative',
                  borderRadius: 11, padding: 3,
                  background: isArmed
                    ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 55%, var(--btn-gold-dark))'
                    : 'linear-gradient(180deg, #8fa8d8, #5d76ad 52%, #3b4f7d)',
                  border: '2.5px solid var(--ink)',
                  boxShadow: isArmed
                    ? 'inset 0 2px 0 rgba(255,255,255,.55), 0 3px 0 #7a4f04'
                    : 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 #26324f',
                  opacity: afford ? (isDragging ? 0.4 : 1) : 0.45,
                  filter: afford ? 'none' : 'saturate(.3)',
                  transform: isArmed ? 'translateY(-7px)' : isDragging ? 'translateY(-4px)' : 'none',
                  transition: 'transform 150ms var(--ease-snap), opacity 150ms linear',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  touchAction: 'none',
                }}
              >
                <div style={{
                  width: '100%', borderRadius: 7, padding: '6px 2px 3px',
                  background: 'rgba(6,16,38,.42)',
                  boxShadow: 'inset 0 2px 5px rgba(0,0,0,.45)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                }}
                >
                  <CoinBadge mint={card.coinId} size={42} />
                  <span style={{
                    fontFamily: 'var(--font-display)', fontSize: 10,
                    WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
                    display: 'flex', alignItems: 'center', gap: 3,
                    maxWidth: '100%', minWidth: 0,
                  }}
                  >
                    <ArchetypeIcon archetype={card.archetype} size={11} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ${card.name.replace(/^\$+/, '')}
                    </span>
                  </span>
                </div>
                <span
                  aria-hidden
                  style={{
                    position: 'absolute', top: -9, left: -5,
                    width: 25, height: 25, borderRadius: '50%',
                    background: 'radial-gradient(circle at 34% 28%, #ff9cf5, var(--elixir) 58%, #7a1d7a)',
                    border: '2.5px solid var(--ink)',
                    boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5), 0 2px 4px rgba(0,0,0,.55)',
                    fontFamily: 'var(--font-display)', fontSize: 14, color: '#fff',
                    WebkitTextStroke: '2px var(--ink)', paintOrder: 'stroke fill',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {cost}
                </span>
              </button>
            );
          })}
          <div style={{
            width: 44, display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 3, opacity: 0.6,
          }}
          >
            <span className="label" style={{ fontSize: 8 }}>next</span>
            {next && <CoinBadge mint={next.coinId} size={26} />}
          </div>
        </div>
        <p style={{
          fontSize: 11, color: drag || selected !== null ? 'var(--teal)' : 'var(--dim)',
          textAlign: 'center', margin: 0, height: 14,
        }}
        >
          {drag?.moved
            ? (drag.ground?.legal ? 'release to deploy' : 'your half only')
            : selected !== null
              ? 'tap your half to deploy'
              : 'drag a card onto your half of the arena'}
        </p>
      </div>

      {confirmQuit && match.status === 'battle' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm forfeit"
          style={{
            position: 'absolute', inset: 0, zIndex: 40, background: 'var(--scrim)',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 28, gap: 12,
          }}
        >
          <p style={{ textAlign: 'center', fontSize: 15 }}>
            Forfeit the match? Your opponent takes the {fmtSol(match.stakeSol * 2)} pot.
          </p>
          <Pill danger onClick={() => { setConfirmQuit(false); match.forfeit(); }}>
            Forfeit — lose {fmtSol(match.stakeSol)}
          </Pill>
          <Pill ghost onClick={() => setConfirmQuit(false)}>Keep fighting</Pill>
        </div>
      )}

      {match.status === 'settled' && <ResultOverlay />}
    </div>
  );
}
