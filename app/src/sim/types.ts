export const TICKS_PER_SEC = 20;
export const REGULATION_TICKS = 180 * TICKS_PER_SEC; // 3 min
export const OVERTIME_TICKS = 60 * TICKS_PER_SEC; // +60 s
export const DOUBLE_ELIXIR_AT = 120 * TICKS_PER_SEC; // final 60 s of regulation
export const INPUT_DELAY_TICKS = 2; // 100 ms lockstep buffer
export const HASH_EVERY_TICKS = 40;
export const HAND_SIZE = 4;
export const DECK_SIZE = 8;
export const ELIXIR_CAP_FP = 10 * 1024;
// 1 elixir per 2.8 s → per-tick fp gain (floor keeps it integer-exact)
export const ELIXIR_PER_TICK_FP = Math.floor(1024 / (2.8 * TICKS_PER_SEC));

// erasable-syntax-safe "enum"
export const Archetype = {
  Tank: 0, Swarm: 1, Ranged: 2, Splash: 3, Support: 4, Spell: 5,
} as const;
export type Archetype = (typeof Archetype)[keyof typeof Archetype];

export const ARCHETYPE_NAMES = ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'] as const;

/** A deck card as it enters a match: identity + level resolved from staked USD. */
export interface MatchCard {
  coinId: string; // mint address (or seeded id on devnet)
  name: string; // coin ticker, e.g. DOGGO
  archetype: Archetype; // hash(mint) % 6, global and permanent
  level: number; // 1–10 from staked USD snapshot
}

export type UnitState = 'advance' | 'attack';

export interface Unit {
  id: number;
  owner: 0 | 1;
  archetype: Archetype;
  level: number;
  x: number; // fp tiles
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number; // ticks until next hit
  targetUnit: number; // unit id or -1
  targetTower: number; // tower index or -1
  state: UnitState;
  cardIndex: number; // which deck slot spawned it (render: coin skin)
}

export type TowerKind = 'princess' | 'king';

export interface Tower {
  owner: 0 | 1;
  kind: TowerKind;
  lane: 0 | 1 | -1; // princess: 0 left, 1 right; king: -1
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number;
  awake: boolean; // king sleeps until damaged or a princess falls
}

export interface PendingSpell {
  owner: 0 | 1;
  x: number;
  y: number;
  explodeTick: number;
  level: number;
  cardIndex: number;
}

export interface PlayerSim {
  elixirFP: number;
  deck: MatchCard[]; // 8, fixed order = deck slots
  cycle: number[]; // rotation of deck indices; first HAND_SIZE are the hand
}

export type Phase = 'regulation' | 'overtime' | 'ended';

export interface SimState {
  tick: number;
  phase: Phase;
  winner: 0 | 1 | -1 | -2; // -1 undecided, -2 draw
  units: Unit[];
  towers: Tower[]; // 6: [p0 L, p0 R, p0 king, p1 L, p1 R, p1 king]
  spells: PendingSpell[];
  players: [PlayerSim, PlayerSim];
  nextUnitId: number;
  rngState: number;
}

/**
 * One committed player action. This exact shape goes into the ER input log.
 *
 * `deckIndex` (not the hand slot) is what travels: the cycle rotates on every
 * play, so a hand position resolved at execution time can select a different
 * card than the one the player dragged when two plays land inside the same
 * input-delay window.
 */
export interface InputEvent {
  tick: number; // tick it executes on (sender adds INPUT_DELAY_TICKS)
  player: 0 | 1;
  deckIndex: number; // 0..7 slot in the player's deck
  x: number; // fp tiles
  y: number;
}
