import { create } from 'zustand';
import { useCollection } from './collection';

export const TIERS = [
  { crowns: 1, stakeSol: 0.05, name: 'Pauper' },
  { crowns: 2, stakeSol: 0.25, name: 'Knight' },
  { crowns: 3, stakeSol: 1, name: 'Duke' },
  { crowns: 4, stakeSol: 5, name: 'Emperor' },
] as const;

interface DeckState {
  active: string[]; // card ids, max 8
  tier: number; // index into TIERS
  toggleCard: (cardId: string) => void;
  setTier: (i: number) => void;
  isComplete: () => boolean;
  power: () => number;
}

export const useDeck = create<DeckState>((set, get) => ({
  // pre-filled with the seeded cards: judges can hit BATTLE immediately
  active: Array.from({ length: 8 }, (_, i) => `card_${i + 1}`),
  tier: 0,
  toggleCard: (cardId) =>
    set((s) => {
      if (s.active.includes(cardId)) return { active: s.active.filter((id) => id !== cardId) };
      if (s.active.length >= 8) return s;
      // one card per coin per deck
      const cards = useCollection.getState().cards;
      const mint = cards.find((c) => c.id === cardId)?.mint;
      const dupe = s.active.some((id) => cards.find((c) => c.id === id)?.mint === mint);
      return dupe ? s : { active: [...s.active, cardId] };
    }),
  setTier: (i) => set({ tier: i }),
  isComplete: () => get().active.length === 8,
  power: () => {
    const cards = useCollection.getState().cards;
    return get().active.reduce((sum, id) => sum + (cards.find((c) => c.id === id)?.level ?? 0), 0);
  },
}));
