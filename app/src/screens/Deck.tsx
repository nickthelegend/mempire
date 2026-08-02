import { useMemo } from 'react';
import { CardFrame } from '../components/CardFrame';
import { COINS } from '../lib/coins';
import { ARCHETYPES } from '../sim/archetypes';
import { useCollection } from '../state/collection';
import { useDeck } from '../state/deck';

export function Deck() {
  const cards = useCollection((s) => s.cards);
  const deck = useDeck();

  const inDeck = useMemo(
    () => deck.active.map((id) => cards.find((c) => c.id === id)).filter(Boolean),
    [deck.active, cards],
  );
  const bench = useMemo(() => cards.filter((c) => !deck.active.includes(c.id)), [cards, deck.active]);

  const avgElixir = inDeck.length
    ? (inDeck.reduce((s, c) => s + ARCHETYPES[c!.archetype].elixir, 0) / inDeck.length).toFixed(1)
    : '—';

  const deckMints = new Set(inDeck.map((c) => c!.mint));

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 className="display" style={{ fontSize: 30 }}>Deck</h1>
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--dim)', alignItems: 'center' }}>
          <span>{deck.active.length}/8</span>
          <span className="mono">power {deck.power()}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              aria-hidden
              style={{
                width: 9, height: 9, borderRadius: '50%',
                background: 'var(--grad-solana)', display: 'inline-block',
              }}
            />
            avg {avgElixir}
          </span>
        </div>
      </header>

      <section
        aria-label="active deck"
        className="panel"
        style={{
          padding: 12, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8,
          borderColor: deck.isComplete() ? 'rgba(20,241,149,.5)' : 'var(--border)',
        }}
      >
        {Array.from({ length: 8 }, (_, i) => {
          const c = inDeck[i];
          return c ? (
            <CardFrame key={c.id} card={c} width={70} fluid selected onClick={() => deck.toggleCard(c.id)} />
          ) : (
            <div
              key={`empty_${i}`}
              role="img"
              aria-label="Empty deck slot"
              style={{
                width: '100%', aspectRatio: '3 / 4', borderRadius: 'var(--r-card)',
                border: '1.5px dashed var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--dim)', fontSize: 20,
              }}
            >
              <span aria-hidden>+</span>
            </div>
          );
        })}
      </section>
      {!deck.isComplete() && (
        <p style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', marginTop: -10 }}>
          fill all 8 slots to battle — tap a card below
        </p>
      )}

      <section aria-label="collection">
        <div className="label" style={{ marginBottom: 8 }}>Collection · one card per coin</div>
        {bench.length === 0 ? (
          <div className="panel" style={{ padding: 20, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
            everything you own is already enlisted, ser
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {bench.map((c) => {
              const coin = COINS.find((k) => k.mint === c.mint);
              const dupe = deckMints.has(c.mint);
              const blocked = dupe || deck.active.length >= 8;
              return (
                <div key={c.id} style={{ position: 'relative' }}>
                  <CardFrame
                    card={c}
                    width={96}
                    fluid
                    dimmed={blocked}
                    disabled={blocked}
                    onClick={() => deck.toggleCard(c.id)}
                  />
                  {dupe && (
                    <span style={{
                      position: 'absolute', bottom: 6, left: 0, right: 0,
                      fontSize: 9, textAlign: 'center', color: 'var(--red)',
                      fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                    }}
                    >
                      {coin?.ticker} in deck
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
