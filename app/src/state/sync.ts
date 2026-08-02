/**
 * Binds the game stores to the persistence API.
 *
 * Mounted once from the Shell. Loading is keyed on wallet address, so a player
 * gets their empire back on any device; a wallet with no saved state falls back
 * to the seeded starter collection already in the store.
 */
import { useEffect, useRef } from 'react';
import { loadPlayer, savePlayer } from '../lib/persist';
import { useCollection } from './collection';
import { useDeck } from './deck';
import { useMatch } from './match';
import { useWallet } from './wallet';

export function usePlayerSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const loadedFor = useRef<string | null>(null);

  // Load on connect (once per address).
  useEffect(() => {
    if (!connected || !address || loadedFor.current === address) return;
    loadedFor.current = address;
    let cancelled = false;
    void loadPlayer(address).then((saved) => {
      if (cancelled || !saved) return;
      if (saved.cards?.length) {
        useCollection.setState({
          cards: saved.cards,
          nextId: saved.nextId || saved.cards.length + 1,
        });
      }
      if (saved.deck?.length) {
        useDeck.setState({ active: saved.deck.slice(0, 8), tier: saved.tier ?? 0 });
      }
      if (typeof saved.sol === 'number') useWallet.setState({ sol: saved.sol });
      if (saved.history?.length) useMatch.setState({ history: saved.history });
    });
    return () => { cancelled = true; };
  }, [connected, address]);

  // Save whenever anything meaningful changes (debounced inside savePlayer).
  useEffect(() => {
    if (!connected || !address) return;
    const push = () => {
      savePlayer(address, {
        cards: useCollection.getState().cards,
        deck: useDeck.getState().active,
        tier: useDeck.getState().tier,
        sol: useWallet.getState().sol,
        nextId: useCollection.getState().nextId,
        history: useMatch.getState().history,
      });
    };
    const unsubs = [
      useCollection.subscribe(push),
      useDeck.subscribe(push),
      useWallet.subscribe((s, p) => { if (s.sol !== p.sol) push(); }),
      useMatch.subscribe((s, p) => { if (s.history !== p.history) push(); }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [connected, address]);

  // Reset to a clean slate when the wallet disconnects.
  useEffect(() => {
    if (connected) return;
    loadedFor.current = null;
  }, [connected]);
}
