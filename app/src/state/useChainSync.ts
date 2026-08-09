import { useEffect } from 'react';
import { useChain } from './chain';
import { useCollection, type MintedCard } from './collection';
import { useDeck } from './deck';
import { useLadder } from './ladder';
import { signer, useWallet } from './wallet';
import { COINS } from '../lib/coins';
import { canSign } from '../chain/provider';
import { ensureChestRail } from '../chain/erActions';

/**
 * Keeps onchain state in step with the wallet.
 *
 * Boots the registry read once regardless of connection, because a visitor who
 * has connected nothing should still see the real coin registry — that read needs
 * no signer. Then loads wallet-scoped data whenever the address changes.
 *
 * Mounted once, in Shell.
 */
export function useChainSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const isGuest = useWallet((s) => s.isGuest);
  const init = useChain((s) => s.init);
  const loadWallet = useChain((s) => s.loadWallet);
  const clearWallet = useChain((s) => s.clearWallet);

  useEffect(() => { void init(); }, [init]);

  // Ladder standing is per-wallet and read-only here; the match store writes it.
  useEffect(() => {
    if (connected && address) {
      void useLadder.getState().load(address);
      void useLadder.getState().loadTop();
    } else {
      useLadder.getState().reset();
    }
  }, [connected, address]);

  useEffect(() => {
    if (!connected || !address) { clearWallet(); return; }
    // A guest signs through its own browser-held keypair, so it is passed the
    // same null adapter a wallet-less session has — `canSign` resolves the
    // difference downstream.
    void loadWallet(address, isGuest ? null : signer());
  }, [connected, address, isGuest, loadWallet, clearWallet]);

  useChestRail();

  useChainCollection();
}

/**
 * Have the chest rail ready before any match can end.
 *
 * `end_log` credits the winner's chest entitlement only when the winner's rail
 * is passed as an optional account, and `endLogEr` only passes it when that
 * rail is already delegated to the same rollup as the log. The rail was being
 * created in two places, both too late to be reliable:
 *
 *  - `openOnchainMatch`, which only the player who *creates* the match runs.
 *    The opponent who joins never sets one up, so whenever the joiner won, the
 *    entitlement had nowhere to go.
 *  - `rollChestOnchain`, which runs *after* the match has already settled —
 *    by then `end_log` has been and gone.
 *
 * The failure was silent all the way down: no rail meant no entitlement, no
 * entitlement meant `request_chest` was refused with `NoChestEarned`, and that
 * error was swallowed by a bare catch. Every chest quietly fell back to a local
 * roll and no surface anywhere said why — the 🎲 "rolled by MagicBlock VRF"
 * badge simply never appeared for anyone.
 *
 * Readiness of the rail is a property of the *player*, not of a match, so it
 * belongs here: once per connected wallet, idempotent, and long before any
 * match needs it. `ensureChestRail` no-ops when the rail already exists and is
 * delegated, so this costs one account read on a warm wallet.
 */
function useChestRail(): void {
  const connected = useWallet((s) => s.connected);
  const address = useWallet((s) => s.address);
  const isGuest = useWallet((s) => s.isGuest);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    // Guests sign locally and never reach the rollup; offline mode has no
    // chain to prepare anything on.
    if (!connected || !address || isGuest || mode !== 'onchain') return;
    let live = true;
    void (async () => {
      try {
        const adapter = signer();
        if (!canSign(adapter)) return;
        await ensureChestRail(adapter);
        if (live) console.info('chest rail ready — wins can be rolled by VRF');
      } catch (e) {
        // Non-fatal, and now audible. A wallet that cannot prepare its rail
        // still plays; it just keeps the honest local roll, and says so.
        console.warn('chest rail not ready — chests will use a local roll:', e);
      }
    })();
    return () => { live = false; };
  }, [connected, address, isGuest, mode]);
}

/**
 * Make the collection *be* the wallet's on-chain cards.
 *
 * Without this the two never met. The collection was seeded locally from the
 * coin registry and saved to the player row, while the actual minted `Card`
 * PDAs lived on chain — and the two sets had almost no mints in common. So a
 * player looked at eight fighters, picked eight for a deck, and the Arena
 * reported "8 of your cards are not minted onchain yet", because none of the
 * cards they were shown were the ones they owned.
 *
 * That is the premise of the game failing quietly: "your bags are your army"
 * only means something if the army on screen is the bags on chain.
 *
 * The local collection survives for exactly one case — a wallet with no minted
 * cards at all, where the seeded set is what lets someone see the game before
 * spending anything. The moment a real card exists, the chain wins.
 */
function useChainCollection(): void {
  const cards = useChain((s) => s.cards);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    if (mode === 'offline' || cards.length === 0) return;

    const mapped: MintedCard[] = cards.map((c) => ({
      // Keyed on the PDA id so the mapping is stable across reloads and two
      // cards for the same coin can never collide.
      id: `chain_${c.id}`,
      mint: c.mint,
      archetype: c.archetype as MintedCard['archetype'],
      stakedUsd: c.stakedUsd,
      stakedTokens: c.stakedTokens,
      level: c.level,
      pendingUnstakeUsd: 0,
      cooldownUntil: c.unstakeReadyAt > 0 ? c.unstakeReadyAt * 1000 : 0,
    }));

    const current = useCollection.getState().cards;
    const collectionMatches = current.length === mapped.length
      && current.every((c, i) => c.id === mapped[i].id && c.level === mapped[i].level);

    const fieldableMints = new Set(COINS.map((c) => c.mint));
    // Cards that exist *and* this build can field. A card whose coin was
    // registered after this client was built passes the first test and fails
    // the second, and a deck holding one is just as dead as a deck holding a
    // dangling id — so staleness has to mean both, or the re-point below never
    // runs for the case that needs it most.
    const valid0 = new Set(
      mapped.filter((c) => fieldableMints.has(c.mint)).map((c) => c.id),
    );
    const deckNow = useDeck.getState();
    // Checked separately from the collection because the two are restored by
    // different effects and either can land first — this way whichever runs
    // last still leaves both consistent.
    const deckStale = [deckNow.active, ...deckNow.slots]
      .some((slot) => slot.some((id) => !valid0.has(id)));

    if (collectionMatches && !deckStale) return;

    if (!collectionMatches) {
      useCollection.setState({ cards: mapped, nextId: mapped.length + 1 });
    }

    // Re-point the decks at the cards that now exist. A deck naming ids from
    // the old local set would be eight dangling references, which reads to the
    // player as their deck having been wiped.
    const deck = useDeck.getState();
    const valid = new Set(mapped.map((c) => c.id));

    /**
     * Only cards this build can actually field.
     *
     * The coin registry lives on chain and keeps growing; the client ships with
     * whatever list it was built against. A card minted from a coin registered
     * after that build is real, owned, and completely unusable here —
     * `buildDecks` resolves every deck card's mint against `COINS` and returns
     * null on the first miss, which surfaces as "your deck has retired cards"
     * with no way to fix it, because the offending card cannot be rendered on
     * the Deck tab either.
     *
     * Auto-filling a deck with one of those manufactured exactly that dead end.
     * The card stays in the collection — the player does own it — but it is
     * never chosen for them.
     */
    const usable = mapped.filter((c) => fieldableMints.has(c.mint));

    const repoint = (slot: string[]): string[] => {
      const kept = slot.filter((id) => valid.has(id) && usable.some((c) => c.id === id));
      if (kept.length >= 8) return kept.slice(0, 8);
      // Fill from what the wallet actually holds, one card per coin.
      const usedMints = new Set(kept.map((id) => mapped.find((c) => c.id === id)?.mint));
      for (const c of usable) {
        if (kept.length >= 8) break;
        if (!kept.includes(c.id) && !usedMints.has(c.mint)) {
          kept.push(c.id);
          usedMints.add(c.mint);
        }
      }
      return kept;
    };

    const slots = deck.slots.map(repoint);
    useDeck.setState({ slots, active: repoint(deck.active) });
  }, [cards, mode]);
}
