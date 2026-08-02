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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="label" style={{ fontSize: 11 }}>{deck.active.length}/8</span>
          <span className="label" style={{ fontSize: 11, color: 'var(--gold-hi)' }}>power {deck.power()}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              aria-hidden
              style={{
                width: 9, height: 9, borderRadius: '50%',
                background: 'radial-gradient(circle at 34% 30%, #ff9cf5, var(--elixir))',
                border: '1.5px solid var(--ink)', display: 'inline-block',
              }}
            />
            <span className="label" style={{ fontSize: 11 }}>avg {avgElixir}</span>
          </span>
        </div>
      </header>

      <section
        aria-label="active deck"
        className="panel"
        style={{
          padding: 12, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8,
          borderColor: deck.isComplete() ? 'var(--teal)' : undefined,
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
                border: '2.5px dashed rgba(255,255,255,.28)',
                background: 'rgba(6,16,38,.4)',
                boxShadow: 'var(--bevel-in)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--dim)', fontSize: 22,
              }}
            >
              <span aria-hidden>+</span>
            </div>
          );
        })}
      </section>
      {!deck.isComplete() && (
        <p className="fine" style={{ textAlign: 'center', marginTop: -6 }}>
          fill all 8 slots to battle — tap a card below
        </p>
      )}

      <section aria-label="collection">
        <div className="label" style={{ marginBottom: 8 }}>Collection · one card per coin</div>
        {bench.length === 0 ? (
          <div className="well" style={{ padding: 20, textAlign: 'center' }}>
            <span className="fine">everything you own is already enlisted, ser</span>
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
                      fontSize: 9, textAlign: 'center', color: '#ffb3c0',
                      fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                      textShadow: '0 1px 2px rgba(6,16,38,.9)',
                    }}
                    >
                      ${coin?.ticker} in deck
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
