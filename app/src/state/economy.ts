import { create } from 'zustand';

/**
 * Gems and chests — the premium economy.
 *
 * Design rule that must not be broken: Gems buy *time, access and cosmetics*,
 * never stats. Card power comes only from staking real tokens, so a paying
 * player never out-stats a skilled one and matchmaking survives whales.
 */

export type ChestTier = 'silver' | 'golden' | 'magic' | 'legendary';

export interface ChestDef {
  tier: ChestTier;
  name: string;
  unlockMs: number;
  cards: number;
  gems: number;
  /** Relative weight when a win rolls a chest. */
  weight: number;
  colors: [string, string];
}

export const CHESTS: Record<ChestTier, ChestDef> = {
  silver: {
    tier: 'silver', name: 'Silver Chest', unlockMs: 15 * 60_000,
    cards: 1, gems: 2, weight: 62, colors: ['#dfe8f5', '#8b9dbb'],
  },
  golden: {
    tier: 'golden', name: 'Golden Chest', unlockMs: 3 * 3_600_000,
    cards: 2, gems: 8, weight: 26, colors: ['#ffd766', '#c8890b'],
  },
  magic: {
    tier: 'magic', name: 'Magic Chest', unlockMs: 8 * 3_600_000,
    cards: 3, gems: 20, weight: 9, colors: ['#c77dff', '#6a2fb5'],
  },
  legendary: {
    tier: 'legendary', name: 'Legendary Chest', unlockMs: 12 * 3_600_000,
    cards: 4, gems: 50, weight: 3, colors: ['#7cf6d8', '#12a88a'],
  },
};

export const CHEST_SLOTS = 4;

/** Devnet demo pacing: minutes, not hours, so a judge sees the whole loop. */
export const DEMO_TIME_SCALE = 1 / 60;

export interface ChestSlot {
  id: string;
  tier: ChestTier;
  /** 0 = not started, else the timestamp it finishes unlocking. */
  readyAt: number;
  unlocking: boolean;
}

export interface GemBundle {
  gems: number;
  sol: number;
  bonus?: string;
}

/** Published rate, with volume discount — the treasury keeps the spread. */
export const GEM_BUNDLES: GemBundle[] = [
  { gems: 80, sol: 0.05 },
  { gems: 500, sol: 0.25, bonus: 'Best value' },
  { gems: 1200, sol: 0.5, bonus: '+20% free' },
  { gems: 2500, sol: 1, bonus: '+25% free' },
];

/** Skipping the wait is the product. Price scales with time left. */
export function skipCost(remainingMs: number): number {
  const hours = remainingMs / 3_600_000;
  return Math.max(1, Math.ceil(hours * 18));
}

interface EconomyState {
  gems: number;
  chests: ChestSlot[];
  nextChestId: number;
  /** Lifetime spend, surfaced in Empire so the rake is never hidden. */
  gemsSpent: number;
  solSpentOnGems: number;

  buyGems: (bundle: GemBundle) => void;
  awardChest: (roll: number) => ChestTier | null;
  startUnlock: (id: string) => void;
  skipUnlock: (id: string) => boolean;
  collect: (id: string) => ChestDef | null;
  spendGems: (n: number) => boolean;
}

function rollTier(roll: number): ChestTier {
  const tiers = Object.values(CHESTS);
  const total = tiers.reduce((s, c) => s + c.weight, 0);
  let acc = 0;
  const target = roll * total;
  for (const c of tiers) {
    acc += c.weight;
    if (target <= acc) return c.tier;
  }
  return 'silver';
}

export const useEconomy = create<EconomyState>((set, get) => ({
  gems: 120, // starter grant so the loop is demonstrable immediately
  chests: [],
  nextChestId: 1,
  gemsSpent: 0,
  solSpentOnGems: 0,

  buyGems: (bundle) =>
    set((s) => ({
      gems: s.gems + bundle.gems,
      solSpentOnGems: +(s.solSpentOnGems + bundle.sol).toFixed(4),
    })),

  /** Called on a win. Returns null when every slot is full — that's the hook. */
  awardChest: (roll) => {
    if (get().chests.length >= CHEST_SLOTS) return null;
    const tier = rollTier(roll);
    set((s) => ({
      chests: [...s.chests, {
        id: `chest_${s.nextChestId}`, tier, readyAt: 0, unlocking: false,
      }],
      nextChestId: s.nextChestId + 1,
    }));
    return tier;
  },

  startUnlock: (id) =>
    set((s) => ({
      // one at a time, like the games this borrows from
      chests: s.chests.some((c) => c.unlocking && c.readyAt > Date.now())
        ? s.chests
        : s.chests.map((c) => (c.id === id
          ? {
            ...c,
            unlocking: true,
            readyAt: Date.now() + CHESTS[c.tier].unlockMs * DEMO_TIME_SCALE,
          }
          : c)),
    })),

  skipUnlock: (id) => {
    const chest = get().chests.find((c) => c.id === id);
    if (!chest) return false;
    const remaining = Math.max(0, chest.readyAt - Date.now());
    const cost = chest.unlocking ? skipCost(remaining) : skipCost(CHESTS[chest.tier].unlockMs);
    if (!get().spendGems(cost)) return false;
    set((s) => ({
      chests: s.chests.map((c) => (c.id === id ? { ...c, unlocking: true, readyAt: 0 } : c)),
    }));
    return true;
  },

  collect: (id) => {
    const chest = get().chests.find((c) => c.id === id);
    if (!chest) return null;
    const ready = chest.unlocking && chest.readyAt <= Date.now();
    if (!ready) return null;
    const def = CHESTS[chest.tier];
    set((s) => ({
      chests: s.chests.filter((c) => c.id !== id),
      gems: s.gems + def.gems,
    }));
    return def;
  },

  spendGems: (n) => {
    if (get().gems < n) return false;
    set((s) => ({ gems: s.gems - n, gemsSpent: s.gemsSpent + n }));
    return true;
  },
}));
