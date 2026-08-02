import { create } from 'zustand';
import { play, startMusic, stopMusic } from '../lib/audio';
import { COINS } from '../lib/coins';
import { archetypeForMint } from '../sim/archetypes';
import { decideBot, type BotDifficulty } from '../sim/bot';
import { createMatch, hashState, stepSim } from '../sim/engine';
import {
  HASH_EVERY_TICKS, INPUT_DELAY_TICKS, type InputEvent, type MatchCard, type SimState,
} from '../sim/types';
import { useCollection, FEES } from './collection';
import { useEconomy, type ChestTier } from './economy';
import { useDeck, TIERS } from './deck';
import { useWallet } from './wallet';

export type MatchStatus = 'idle' | 'queuing' | 'found' | 'battle' | 'settled';

export interface MatchResult {
  won: boolean;
  draw: boolean;
  potSol: number;
  payoutSol: number; // what the player received (0 on loss)
  rakeSol: number;
  hashes: number; // checkpoints committed
  crowns: [number, number]; // towers felled, [you, them]
  chest: ChestTier | null; // won a chest, unless all four slots were full
}

/** Transient presentation signal — never read by the sim. */
export interface Shock {
  id: number;
  kind: 'tower' | 'deploy';
  forPlayer: 0 | 1;
}

interface MatchStore {
  status: MatchStatus;
  version: number; // bumped per sim tick — HUD subscribes to this
  sim: SimState | null;
  playerDeck: MatchCard[];
  botDeck: MatchCard[];
  stakeSol: number;
  result: MatchResult | null;
  history: MatchResult[];
  opponentName: string;
  crowns: [number, number]; // live tower count, [you, them]
  shock: Shock | null;
  /** No stake, no rake, no chest — a place to learn the controls. */
  practice: boolean;
  startQueue: (opts?: { practice?: boolean }) => string | null; // error string or null
  cancelQueue: () => void;
  playCard: (deckIndex: number, xFp: number, yFp: number) => void;
  forfeit: () => void;
  dismiss: () => void;
}

let loop: ReturnType<typeof setInterval> | null = null;
let queueTimers: ReturnType<typeof setTimeout>[] = [];
let pending = new Map<number, InputEvent[]>();
let hashes: number[] = [];

function clearTimers(): void {
  queueTimers.forEach(clearTimeout);
  queueTimers = [];
  if (loop) { clearInterval(loop); loop = null; }
}

const BOT_NAMES = ['xX_RugLord_Xx', 'ser_liquidator', 'wagmi_warlord', 'chad.sol'];

function buildDecks(): { player: MatchCard[]; bot: MatchCard[] } {
  const { cards } = useCollection.getState();
  const { active } = useDeck.getState();
  const player = active.map((id) => {
    const c = cards.find((x) => x.id === id)!;
    const coin = COINS.find((k) => k.mint === c.mint)!;
    return { coinId: c.mint, name: coin.ticker, archetype: c.archetype, level: c.level };
  });
  // bot mirrors the player's power so brackets feel honest
  const levels = player.map((p) => p.level);
  const bot = COINS.slice(0, 10).filter((c) => c.liquidityUsd >= 25000).slice(0, 8).map((c, i) => ({
    coinId: c.mint,
    name: c.ticker,
    archetype: archetypeForMint(c.mint),
    level: levels[(i * 3) % levels.length],
  }));
  return { player, bot };
}

export const useMatch = create<MatchStore>((set, get) => ({
  status: 'idle',
  version: 0,
  sim: null,
  playerDeck: [],
  botDeck: [],
  stakeSol: 0,
  result: null,
  history: [],
  opponentName: '',
  crowns: [0, 0],
  shock: null,
  practice: false,

  startQueue: (opts) => {
    const practice = opts?.practice ?? false;
    const deck = useDeck.getState();
    const wallet = useWallet.getState();
    if (!wallet.connected) return 'connect your wallet first';
    if (!deck.isComplete()) return 'deck needs 8 cards';
    const tier = TIERS[deck.tier];
    if (!practice && wallet.sol < tier.stakeSol) return `need ${tier.stakeSol} SOL to enter`;

    const { player, bot } = buildDecks();
    clearTimers();
    set({
      status: 'queuing',
      playerDeck: player,
      botDeck: bot,
      stakeSol: practice ? 0 : tier.stakeSol,
      practice,
      result: null,
      opponentName: practice ? 'Training Dummy' : BOT_NAMES[deck.tier],
    });

    // practice skips the search theatre — the point is to get to the arena
    const queueMs = practice ? 400 : 1200 + Math.random() * 1300;
    queueTimers.push(setTimeout(() => {
      if (get().status !== 'queuing') return;
      set({ status: 'found' });
      queueTimers.push(setTimeout(() => {
        if (get().status !== 'found') return;
        // Escrow happens here, not at queue time: a cancelled or abandoned
        // search must never cost the player anything. Practice never escrows.
        if (!practice) {
          if (!useWallet.getState().spend(tier.stakeSol)) {
            clearTimers();
            set({ status: 'idle' });
            return;
          }
          play('coin');
        }
        const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
        const sim = createMatch(seed, [player, bot]);
        pending = new Map();
        hashes = [];
        set({ status: 'battle', sim, version: 0, crowns: [0, 0], shock: null });
        startMusic();
        const difficulty: BotDifficulty = deck.tier <= 0 ? 'easy' : deck.tier === 1 ? 'normal' : 'hard';
        loop = setInterval(() => tickOnce(difficulty), 50);
      }, 900));
    }, queueMs));
    return null;
  },

  cancelQueue: () => {
    if (get().status !== 'queuing' && get().status !== 'found') return;
    clearTimers();
    set({ status: 'idle', sim: null, version: 0 });
  },

  playCard: (deckIndex, xFp, yFp) => {
    const { sim, status } = get();
    if (!sim || status !== 'battle' || sim.phase === 'ended') return;
    const ev: InputEvent = {
      tick: sim.tick + INPUT_DELAY_TICKS, player: 0, deckIndex, x: xFp, y: yFp,
    };
    const list = pending.get(ev.tick) ?? [];
    list.push(ev);
    pending.set(ev.tick, list);
  },

  forfeit: () => {
    if (get().status !== 'battle') return; // already settled or never started
    const { sim } = get();
    clearTimers();
    if (sim && sim.phase !== 'ended') {
      sim.phase = 'ended';
      sim.winner = 1;
    }
    settle();
  },

  dismiss: () => {
    clearTimers();
    stopMusic();
    set({ status: 'idle', sim: null, result: null, version: 0, crowns: [0, 0], shock: null, practice: false });
  },
}));

function tickOnce(difficulty: BotDifficulty): void {
  const store = useMatch.getState();
  const sim = store.sim;
  if (!sim) return;

  const botEv = decideBot(sim, 1, difficulty);
  if (botEv) {
    const list = pending.get(botEv.tick) ?? [];
    list.push(botEv);
    pending.set(botEv.tick, list);
  }

  // presentation-only snapshots taken around the step
  const towersBefore = sim.towers.map((t) => t.hp > 0);
  const unitsBefore = sim.units.length;

  stepSim(sim, pending.get(sim.tick) ?? []);
  pending.delete(sim.tick - 1);
  if (sim.tick % HASH_EVERY_TICKS === 0) hashes.push(hashState(sim));

  // a tower fell this tick → crown, sound, screen shock
  let felled: 0 | 1 | null = null;
  for (let i = 0; i < sim.towers.length; i++) {
    if (towersBefore[i] && sim.towers[i].hp <= 0) felled = sim.towers[i].owner;
  }
  if (felled !== null) play('tower');
  if (sim.units.length > unitsBefore) play('deploy');

  useMatch.setState((s) => {
    const next: Partial<MatchStore> = { version: s.version + 1 };
    if (felled !== null) {
      // derived, never accumulated — two towers can fall on the same tick
      next.crowns = countCrowns(sim);
      next.shock = { id: s.version + 1, kind: 'tower', forPlayer: felled };
    }
    return next;
  });

  if (sim.phase === 'ended') {
    clearTimers();
    settle();
  }
}

/** Crowns = enemy towers felled. Read from the sim, so it can never drift. */
function countCrowns(sim: SimState): [number, number] {
  let mine = 0;
  let theirs = 0;
  for (const t of sim.towers) {
    if (t.hp > 0) continue;
    if (t.owner === 1) mine += 1;
    else theirs += 1;
  }
  return [mine, theirs];
}

function settle(): void {
  const { sim, stakeSol, status, practice } = useMatch.getState();
  if (!sim || status === 'settled') return; // idempotent: never pay twice
  const crowns = countCrowns(sim);
  stopMusic();
  const wallet = useWallet.getState();
  const pot = stakeSol * 2;
  const draw = sim.winner === -2;
  const won = sim.winner === 0;
  const rakePct = draw ? FEES.tieRakePct : FEES.rakePct;
  const rakeSol = +(pot * (rakePct / 100)).toFixed(4);
  let payoutSol = 0;
  if (draw) {
    payoutSol = +((pot - rakeSol) / 2).toFixed(4);
    wallet.receive(payoutSol);
  } else if (won) {
    payoutSol = +(pot - rakeSol).toFixed(4);
    wallet.receive(payoutSol);
  }
  play(won || draw ? 'victory' : 'defeat');
  // A win earns a chest. Full slots deliberately award nothing — that pressure
  // is what makes the skip-timer purchase land. Practice earns nothing at all,
  // so it cannot be farmed for chests.
  const chest = won && !practice ? useEconomy.getState().awardChest(Math.random()) : null;
  const result: MatchResult = {
    won, draw, potSol: pot, payoutSol, rakeSol, hashes: hashes.length, crowns, chest,
  };
  useMatch.setState((s) => ({
    status: 'settled',
    result,
    // practice never enters the record — a padded W/L is worse than none
    history: practice ? s.history : [result, ...s.history],
  }));
}
