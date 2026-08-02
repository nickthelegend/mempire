import { create } from 'zustand';
import { COINS, isEligible } from '../lib/coins';
import {
  bytesToHex, deriveDrops, hexToBytes, localSeed, tierFromSeed,
} from '../lib/chestDrop';
import { useCollection } from './collection';

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

/** What actually came out — the def plus the cards it minted, by ticker. */
export interface OpenedChest extends ChestDef {
  droppedTickers: string[];
  /** The seed these drops came from, so the reward screen can show it. */
  seed: string;
  source: 'vrf' | 'local';
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

/** Tier index → name, matching `TIER_WEIGHTS` in the program. */
export const TIER_ORDER: ChestTier[] = ['silver', 'golden', 'magic', 'legendary'];

/** Devnet demo pacing: minutes, not hours, so a judge sees the whole loop. */
export const DEMO_TIME_SCALE = 1 / 60;

export interface ChestSlot {
  id: string;
  tier: ChestTier;
  /** 0 = not started, else the timestamp it finishes unlocking. */
  readyAt: number;
  unlocking: boolean;
  /**
   * Where this chest's tier came from.
   *
   * `vrf` means a MagicBlock oracle rolled it and `randomness` holds the bytes
   * that produced it, so anyone can re-derive the result. `local` means this
   * session cannot sign — Guest play — and the roll was made in the browser.
   *
   * Recorded rather than assumed because the difference is the whole claim: a
   * chest is only "provably fair" if it actually went through the oracle, and
   * a UI that shows the same badge either way is lying about the one mechanic
   * where the house picks the outcome.
   */
  source: 'vrf' | 'local';
  /**
   * The 32 bytes this chest's contents are derived from, hex-encoded.
   *
   * Always present, whatever the provenance. A local seed is still a *recorded*
   * seed, which means the drop is a published function of something written down
   * rather than of an unrecorded `Math.random()` — the difference between "we
   * picked fairly, trust us" and "here is the input, check it yourself".
   *
   * `source` says who produced it. Only `vrf` was attested by the oracle, and
   * only `vrf` earns the fairness claim in the UI.
   */
  seed: string;
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
  /**
   * Awards a chest, seeded locally.
   *
   * No `roll` parameter: the seed decides both tier and contents by the same
   * rule the program uses, so one recorded input explains the whole chest.
   */
  awardChest: () => ChestTier | null;
  startUnlock: (id: string) => void;
  skipUnlock: (id: string) => boolean;
  collect: (id: string) => OpenedChest | null;
  /**
   * Upgrades the newest chest from a local roll to the oracle's answer.
   *
   * The result screen awards optimistically so it never waits on an async
   * callback; this is what makes that honest. If the tier changed, the oracle
   * wins — it is the authority — and the chest stops claiming to be local.
   */
  reconcileNewestChest: (tier: number, randomness: string) => void;
  spendGems: (n: number) => boolean;
  addGems: (n: number) => void;
}

/**
 * Mint the cards a chest contains, derived from its recorded seed.
 *
 * Not a roll. `deriveDrops` is a pure function of (seed, eligible list in
 * registry order, owned set), so the contents of any chest can be re-derived
 * and checked afterwards — which is the whole reason the oracle's bytes are
 * stored on the chest rather than consumed and thrown away.
 *
 * Unowned coins are drawn first and without replacement: a drop that teaches a
 * new card beats a duplicate. That preference is part of the published rule, not
 * a thumb on the scale, and duplicates become possible again once the collection
 * fills out (Clash's dupes feed upgrades; ours feed extra stake vessels for the
 * same coin).
 */
function dropCards(n: number, seed: Uint8Array): string[] {
  const { cards, mintCard } = useCollection.getState();
  const eligible = COINS.filter((c) => isEligible(c));
  if (!eligible.length) return [];
  const owned = new Set(cards.map((c) => c.mint));
  const picks = deriveDrops(seed, eligible, owned, n);
  const out: string[] = [];
  for (const pick of picks) {
    if (mintCard(pick.mint)) out.push(pick.ticker);
  }
  return out;
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
  awardChest: () => {
    if (get().chests.length >= CHEST_SLOTS) return null;
    const seed = localSeed();
    // Same weighting the on-chain callback applies, so a locally-seeded chest
    // has the published odds rather than merely similar ones.
    const tier = TIER_ORDER[tierFromSeed(seed)] ?? 'silver';
    // Seeded at birth, locally, so the contents are already fixed and recorded
    // before the oracle has answered. If the oracle does answer, `reconcile`
    // replaces both the tier and the seed with its attested pair — a chest is
    // never left with a tier from one source and contents from another.
    set((s) => ({
      chests: [...s.chests, {
        id: `chest_${s.nextChestId}`, tier, readyAt: 0, unlocking: false,
        source: 'local', seed: bytesToHex(seed),
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
    // The chest's card count mints real cards, not a number on a toast — and
    // which ones is derived from the seed the chest has been carrying since it
    // was awarded, so the contents were fixed before the player pressed OPEN.
    const dropped = dropCards(def.cards, hexToBytes(chest.seed));
    return { ...def, droppedTickers: dropped, seed: chest.seed, source: chest.source };
  },

  reconcileNewestChest: (tier, randomness) => {
    const resolved = TIER_ORDER[tier] ?? 'silver';
    // Check the oracle rather than trusting it. The tier the program wrote must
    // be the tier its own randomness produces under the published weights; if it
    // is not, something between the oracle and the account is wrong and this
    // chest should keep the local roll it already has rather than adopt a number
    // that does not follow from its bytes.
    try {
      const expected = tierFromSeed(hexToBytes(randomness));
      if (expected !== tier) {
        console.warn(
          `chest: oracle reported tier ${tier} but its randomness derives ${expected} — keeping the local roll`,
        );
        return;
      }
    } catch {
      return;
    }
    set((s) => {
      if (!s.chests.length) return s;
      const chests = [...s.chests];
      const last = chests.length - 1;
      // Only a chest still waiting to be opened can change tier. One already
      // unlocking has been shown to the player as a specific thing.
      if (chests[last].unlocking || chests[last].readyAt) return s;
      chests[last] = { ...chests[last], tier: resolved, source: 'vrf', seed: randomness };
      return { chests };
    });
  },

  spendGems: (n) => {
    if (get().gems < n) return false;
    set((s) => ({ gems: s.gems - n, gemsSpent: s.gemsSpent + n }));
    return true;
  },

  /**
   * Gems granted for something earned — currently answering a clanmate's lend
   * request. Deliberately not counted in `gemsSpent`, which tracks what the
   * treasury took, not what it gave back.
   */
  addGems: (n) => set((s) => ({ gems: s.gems + Math.max(0, Math.floor(n)) })),
}));
