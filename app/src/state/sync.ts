/**
 * Binds the game stores to the persistence API.
 *
 * Mounted once from the Shell. Loading is keyed on wallet address, so a player
 * gets their empire back on any device; a wallet with no saved state falls back
 * to the seeded starter collection already in the store.
 */
import { useEffect, useRef } from 'react';
import { coinByMint } from '../lib/coins';
import { loadPlayer, savePlayer, type SavedState } from '../lib/persist';
import { useCollection, type MintedCard } from './collection';
import { useDeck, DECK_SLOTS } from './deck';
import { bytesToHex, localSeed } from '../lib/chestDrop';
import { useEconomy } from './economy';
import { useMatch } from './match';
import { useShop } from './shop';
import { useWallet } from './wallet';

/**
 * Saved state can be older than the coin registry. When the devnet mints were
 * replaced with the real seeded ones, every card persisted before the swap
 * pointed at a mint that no longer exists — and `coin.ticker` on undefined
 * crashed the Battle button for exactly the returning players who had the most
 * invested. Migration rule: cards from retired mints are dropped on load, deck
 * lists are re-pointed at surviving cards, and a deck left short is refilled
 * from the collection (one card per coin) so the player is never handed a deck
 * that cannot fight.
 */
function migrate(saved: SavedState): SavedState {
  const cards = (saved.cards ?? []).filter((c) => coinByMint(c.mint));
  const dropped = (saved.cards?.length ?? 0) - cards.length;
  if (dropped > 0) {
    console.info(`[sync] dropped ${dropped} card(s) from retired mints`);
  }

  const ids = new Set(cards.map((c) => c.id));
  const fixDeck = (deck: string[] | undefined): string[] => {
    const kept = (deck ?? []).filter((id) => ids.has(id));
    if (kept.length >= 8) return kept.slice(0, 8);
    // refill: one card per coin, favouring what is already there
    const usedMints = new Set(kept.map((id) => cards.find((c) => c.id === id)?.mint));
    for (const c of cards) {
      if (kept.length >= 8) break;
      if (!kept.includes(c.id) && !usedMints.has(c.mint)) {
        kept.push(c.id);
        usedMints.add(c.mint);
      }
    }
    return kept;
  };

  return {
    ...saved,
    cards,
    deck: fixDeck(saved.deck),
    slots: (saved.slots ?? []).map(fixDeck),
  };
}

export function usePlayerSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const loadedFor = useRef<string | null>(null);

  // Load on connect (once per address).
  useEffect(() => {
    if (!connected || !address || loadedFor.current === address) return;
    loadedFor.current = address;
    let cancelled = false;
    void loadPlayer(address).then((raw) => {
      if (cancelled || !raw) return;
      const saved = migrate(raw);
      if (saved.cards?.length) {
        useCollection.setState({
          cards: saved.cards as MintedCard[],
          nextId: saved.nextId || saved.cards.length + 1,
        });
      }
      if (saved.deck?.length) {
        const slots = Array.from({ length: DECK_SLOTS }, (_, i) => saved.slots?.[i] ?? []);
        if (!slots[0]?.length) slots[0] = saved.deck.slice(0, 8);
        useDeck.setState({
          active: saved.deck.slice(0, 8),
          tier: saved.tier ?? 0,
          slots,
          slot: Math.min(Math.max(saved.slot ?? 0, 0), DECK_SLOTS - 1),
        });
      }
      if (typeof saved.sol === 'number' && Number.isFinite(saved.sol)) {
        useWallet.setState({ sol: saved.sol });
      }
      if (saved.history?.length) useMatch.setState({ history: saved.history });
      // The premium economy is real progress and must survive a reload:
      // gems, chest slots mid-unlock (absolute timestamps, so a timer that was
      // running keeps running), and the day's shop state.
      if (typeof saved.gems === 'number' && Number.isFinite(saved.gems)) {
        useEconomy.setState({
          gems: Math.max(0, Math.floor(saved.gems)),
          // Chests saved before drops became seed-derived carry no seed, and
          // opening one would throw on decode. Backfilling a local seed keeps
          // them openable and — correctly — labels them as not oracle-rolled,
          // which is exactly what they were.
          chests: Array.isArray(saved.chests)
            ? saved.chests.map((c) => (c.seed
              ? c
              : { ...c, seed: bytesToHex(localSeed()), source: c.source ?? 'local' }))
            : [],
          nextChestId: saved.nextChestId || 1,
          gemsSpent: saved.gemsSpent ?? 0,
          solSpentOnGems: saved.solSpentOnGems ?? 0,
        });
      }
      if (saved.shop?.offers?.length) {
        // a stale day self-heals on the shop's next ensureFresh tick
        useShop.setState({
          offers: saved.shop.offers,
          day: saved.shop.day ?? useShop.getState().day,
          rerollsUsed: saved.shop.rerollsUsed ?? 0,
        });
      }
    });
    return () => { cancelled = true; };
  }, [connected, address]);

  // Save whenever anything meaningful changes (debounced inside savePlayer).
  useEffect(() => {
    if (!connected || !address) return;
    const push = () => {
      // Never persist mid-match. The stake leaves the balance at escrow and
      // returns at settle; a save between the two would freeze the money in
      // flight, and a refresh during a battle then silently ate the stake with
      // no result to show for it. Settlement changes status and history, which
      // triggers the save that captures the true post-match balance.
      const ms = useMatch.getState().status;
      if (ms === 'queuing' || ms === 'found' || ms === 'battle') return;
      const deck = useDeck.getState();
      const eco = useEconomy.getState();
      const shop = useShop.getState();
      savePlayer(address, {
        cards: useCollection.getState().cards,
        deck: deck.active,
        tier: deck.tier,
        slots: deck.slots,
        slot: deck.slot,
        sol: useWallet.getState().sol,
        nextId: useCollection.getState().nextId,
        history: useMatch.getState().history,
        gems: eco.gems,
        chests: eco.chests,
        nextChestId: eco.nextChestId,
        gemsSpent: eco.gemsSpent,
        solSpentOnGems: eco.solSpentOnGems,
        shop: { offers: shop.offers, day: shop.day, rerollsUsed: shop.rerollsUsed },
      });
    };
    const unsubs = [
      useCollection.subscribe(push),
      useDeck.subscribe(push),
      useEconomy.subscribe(push),
      useShop.subscribe(push),
      useWallet.subscribe((s, p) => { if (s.sol !== p.sol) push(); }),
      useMatch.subscribe((s, p) => { if (s.history !== p.history || s.status !== p.status) push(); }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [connected, address]);

  // Reset to a clean slate when the wallet disconnects.
  useEffect(() => {
    if (connected) return;
    loadedFor.current = null;
  }, [connected]);
}
