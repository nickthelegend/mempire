import { create } from 'zustand';
import { COINS, coinByMint } from '../lib/coins';
import { levelForUsd } from '../lib/leveling';
import { archetypeForMint } from '../sim/archetypes';
import type { Archetype } from '../sim/types';

export const FEES = {
  mintSol: 0.02,
  unstakePct: 2,
  rakePct: 10,
  tieRakePct: 5,
};

// Devnet demo cooldown — mainnet is 72h; 60s here so judges can see the flow.
export const UNSTAKE_COOLDOWN_MS = 60_000;

export interface MintedCard {
  id: string;
  mint: string; // coin mint
  archetype: Archetype;
  stakedUsd: number;
  stakedTokens: number;
  level: number;
  pendingUnstakeUsd: number; // locked in cooldown, still counts against holdings
  cooldownUntil: number; // 0 = none; else timestamp while unstake pends
}

interface CollectionState {
  cards: MintedCard[];
  nextId: number;
  mintCard: (mint: string) => MintedCard | null;
  /** Returns an error string, or null on success. */
  stake: (cardId: string, usd: number) => string | null;
  requestUnstake: (cardId: string, usd: number) => void;
  claimUnstake: (cardId: string) => void;
  card: (id: string) => MintedCard | undefined;
  /** USD of a coin already locked across every card the player owns. */
  stakedUsdFor: (mint: string) => number;
  /** USD of a coin still free to stake. */
  availableUsdFor: (mint: string) => number;
}

// Pre-seeded so the first run demos instantly (8 cards ≈ one full deck).
const SEED_LEVEL_USD = [100, 25, 50, 10, 200, 30, 12, 60];

const seedCards = (): MintedCard[] =>
  COINS.slice(0, 8).map((c, i) => {
    const usd = SEED_LEVEL_USD[i];
    return {
      id: `card_${i + 1}`,
      mint: c.mint,
      archetype: archetypeForMint(c.mint),
      stakedUsd: usd,
      stakedTokens: Math.round(usd / c.priceUsd),
      level: levelForUsd(usd),
      pendingUnstakeUsd: 0,
      cooldownUntil: 0,
    };
  });

export const useCollection = create<CollectionState>((set, get) => ({
  cards: seedCards(),
  nextId: 9,
  mintCard: (mint) => {
    const coin = coinByMint(mint);
    if (!coin) return null;
    const card: MintedCard = {
      id: `card_${get().nextId}`,
      mint,
      archetype: archetypeForMint(mint),
      stakedUsd: 0,
      stakedTokens: 0,
      level: 1,
      pendingUnstakeUsd: 0,
      cooldownUntil: 0,
    };
    set((s) => ({ cards: [...s.cards, card], nextId: s.nextId + 1 }));
    return card;
  },
  stakedUsdFor: (mint) =>
    get().cards.filter((c) => c.mint === mint)
      .reduce((sum, c) => sum + c.stakedUsd + (c.pendingUnstakeUsd ?? 0), 0),

  availableUsdFor: (mint) => {
    const coin = coinByMint(mint);
    if (!coin) return 0;
    return Math.max(0, coin.balance * coin.priceUsd - get().stakedUsdFor(mint));
  },

  stake: (cardId, usd) => {
    const card = get().cards.find((c) => c.id === cardId);
    if (!card) return 'card not found';
    if (card.cooldownUntil > Date.now()) return 'unstake pending';
    // You can only ever stake tokens you actually hold — this is the whole
    // premise of the game, so it is enforced here rather than in the UI.
    const available = get().availableUsdFor(card.mint);
    if (usd > available) {
      const coin = coinByMint(card.mint);
      return `only $${Math.floor(available)} of ${coin?.ticker ?? 'that coin'} left to stake`;
    }
    set((s) => ({
      cards: s.cards.map((c) => {
        if (c.id !== cardId) return c;
        const coin = coinByMint(c.mint);
        const stakedUsd = c.stakedUsd + usd;
        return {
          ...c,
          stakedUsd,
          stakedTokens: c.stakedTokens + (coin ? Math.round(usd / coin.priceUsd) : 0),
          level: levelForUsd(stakedUsd),
        };
      }),
    }));
    return null;
  },

  requestUnstake: (cardId, usd) =>
    set((s) => ({
      cards: s.cards.map((c) => {
        if (c.id !== cardId) return c;
        const coin = coinByMint(c.mint);
        const amount = Math.min(usd, c.stakedUsd);
        const stakedUsd = c.stakedUsd - amount;
        return {
          ...c,
          stakedUsd,
          stakedTokens: Math.max(0, c.stakedTokens - (coin ? Math.round(amount / coin.priceUsd) : 0)),
          level: levelForUsd(stakedUsd),
          pendingUnstakeUsd: amount,
          cooldownUntil: Date.now() + UNSTAKE_COOLDOWN_MS,
        };
      }),
    })),

  /** Cooldown elapsed: tokens return to the wallet minus the unstake fee. */
  claimUnstake: (cardId) =>
    set((s) => ({
      cards: s.cards.map((c) => {
        if (c.id !== cardId || c.cooldownUntil > Date.now()) return c;
        return { ...c, pendingUnstakeUsd: 0, cooldownUntil: 0 };
      }),
    })),

  card: (id) => get().cards.find((c) => c.id === id),
}));
