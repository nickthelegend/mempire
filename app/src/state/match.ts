import { create } from 'zustand';
import { play, startMusic, stopMusic } from '../lib/audio';
import { COINS } from '../lib/coins';
import { recordMatch } from '../lib/persist';
import {
  pvpCancel, pvpClose, pvpConnect, pvpQueue, pvpSendEnded, pvpSendHash, pvpSendInput,
  type MatchedPayload,
} from '../lib/pvp';
import { archetypeForMint } from '../sim/archetypes';
import { decideBot, type BotDifficulty } from '../sim/bot';
import { createMatch, hashState, stepSim } from '../sim/engine';
import {
  FORMATS, HASH_EVERY_TICKS, INPUT_DELAY_TICKS,
  type InputEvent, type MatchCard, type SimState,
} from '../sim/types';
import { useClan } from './clan';
import { useLadder } from './ladder';
import { useCollection, FEES } from './collection';
import { useEconomy, type ChestTier } from './economy';
import { useDeck, TIERS } from './deck';
import { deckCommitment } from '../chain/deckHash';
import { useChain } from './chain';
import { useErMatch } from './erMatch';
import {
  claimChestEr, ensureChestRail, readChestRail, requestChestEr,
} from '../chain/erActions';
import { signer, useWallet } from './wallet';

export type MatchStatus = 'idle' | 'queuing' | 'found' | 'battle' | 'settled';

/**
 * How a match is entered.
 *
 * `ranked` and `practice` are mutually exclusive by construction: practice has
 * no stake so it must not move trophies, and ranked must never be answered by a
 * bot. `rush` selects the 30-second format.
 */
export interface MatchOpts {
  practice?: boolean;
  ranked?: boolean;
  rush?: boolean;
}

export interface MatchResult {
  won: boolean;
  draw: boolean;
  potSol: number;
  payoutSol: number; // what the player received (0 on loss)
  rakeSol: number;
  hashes: number; // checkpoints committed
  crowns: [number, number]; // towers felled, [you, them]
  chest: ChestTier | null; // won a chest, unless all four slots were full
  /** Ranked only. Absent on practice and casual matches. */
  trophyDelta?: number;
  trophiesAfter?: number;
  promoted?: boolean;
  demoted?: boolean;
  leagueAfter?: string;
  /**
   * The sims diverged and the match was annulled: stakes returned, no rake,
   * nothing recorded. Divergence is detected by the hash checkpoints and
   * neutralised — never silently ignored, never paid out.
   */
  voided?: boolean;
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
  /**
   * Trophies are at stake, and the opponent is guaranteed human.
   *
   * Ranked never falls back to a bot. That is the whole promise — a ladder that
   * can be climbed against a bot is not a ladder, and "no bots" has to be true
   * where it is claimed or it is just copy.
   */
  ranked: boolean;
  /** 30-second format. */
  rush: boolean;
  /** Set while a ranked queue is waiting on a human, for honest queue copy. */
  waitingForHuman: boolean;
  /** 'human' when a real opponent is relaying inputs; 'bot' otherwise. */
  mode: 'bot' | 'human';
  /**
   * Which sim seat is *this* client. Both clients run one shared timeline where
   * seat 0 is the same physical player on both machines — determinism demands
   * it — so the UI renders from this seat's point of view instead of assuming
   * it is player 0.
   */
  perspective: 0 | 1;
  startQueue: (opts?: MatchOpts) => string | null; // error string or null
  cancelQueue: () => void;
  playCard: (deckIndex: number, xFp: number, yFp: number) => void;
  forfeit: () => void;
  dismiss: () => void;
}

let loop: ReturnType<typeof setInterval> | null = null;
let queueTimers: ReturnType<typeof setTimeout>[] = [];
let pending = new Map<number, InputEvent[]>();
let hashes: number[] = [];
/**
 * Puts the newest chest through the VRF oracle and reconciles its tier.
 *
 * Fire-and-forget by design. The request is accepted in one transaction and
 * fulfilled by the oracle in another, so this polls; the result screen is
 * already on screen and must never block on it. A session that cannot sign
 * keeps its local roll, honestly labelled.
 */
async function rollChestOnchain(): Promise<void> {
  const adapter = signer();
  if (!adapter || useChain.getState().mode !== 'onchain') return;
  try {
    await ensureChestRail(adapter);
    const rail = await readChestRail(adapter);
    if (!rail) return;
    const slot = rail.slots.findIndex((s) => s.state === 0);
    if (slot < 0 || rail.pendingSlot !== 255) return; // rail full or busy

    await requestChestEr(adapter, slot, Math.floor(Math.random() * 256));

    // Acceptance is not an outcome — wait for the separate callback.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1200));
      const now = await readChestRail(adapter);
      const filled = now?.slots[slot];
      if (filled?.state === 2) {
        const hex = Array.from(filled.randomness)
          .map((b) => b.toString(16).padStart(2, '0')).join('');
        useEconomy.getState().reconcileNewestChest(filled.tier, hex);
        void claimChestEr(adapter, slot).catch(() => { /* slot frees next run */ });
        return;
      }
    }
  } catch { /* the local roll stands, labelled as local */ }
}

/** Human matches step against the wall clock so two clients stay in lockstep. */
let humanStartAt = 0;
/**
 * SOL escrowed for a human match that has not settled yet. Every abnormal exit
 * between escrow and settlement — opponent vanishing before the start, the sim
 * failing to build, a desync — must pass through here exactly once, or the
 * stake either leaks (player loses money to a bug) or duplicates (free money).
 */
let humanEscrowSol = 0;
const TICK_MS = 50;
/** Opponent rating for the ranked match in flight, so settle can score it. */
let opponentTrophies = 0;
/**
 * Own inputs schedule this far ahead in a human match — 400ms of slack for the
 * relay round-trip. The bot keeps the tight 2-tick delay; a bot has no latency.
 */
const HUMAN_INPUT_DELAY_TICKS = 8;

function clearTimers(): void {
  queueTimers.forEach(clearTimeout);
  queueTimers = [];
  if (loop) { clearInterval(loop); loop = null; }
}

const BOT_NAMES = ['xX_RugLord_Xx', 'ser_liquidator', 'wagmi_warlord', 'chad.sol'];

/**
 * How long the queue waits for a human before the bot steps in.
 *
 * Overridable via sessionStorage because demoing PvP with two tabs on one
 * machine fights background-tab timer throttling — the hidden tab's clicks and
 * timers land seconds late, and an 8s window loses that race through no fault
 * of the player. `sessionStorage.setItem('pvpWaitMs','60000')` in both tabs
 * makes the pairing calm; real players on two devices never need it.
 */
function pvpWaitMs(): number {
  try {
    const v = Number(sessionStorage.getItem('pvpWaitMs'));
    if (Number.isFinite(v) && v >= 1000) return v;
  } catch { /* private mode */ }
  return 8000;
}

/**
 * Returns null when the deck references cards or coins that no longer exist —
 * stale ids after a migration, a coin retired from the registry. The old `!`
 * assertions here crashed the Battle button for exactly the returning players
 * a migration touches; a null is turned into a sentence by startQueue instead.
 */
function buildDecks(): { player: MatchCard[]; bot: MatchCard[] } | null {
  const { cards } = useCollection.getState();
  const { active } = useDeck.getState();
  const player: MatchCard[] = [];
  for (const id of active) {
    const c = cards.find((x) => x.id === id);
    const coin = c && COINS.find((k) => k.mint === c.mint);
    if (!c || !coin) return null;
    player.push({ coinId: c.mint, name: coin.ticker, archetype: c.archetype, level: c.level });
  }
  if (player.length !== 8) return null;
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
  ranked: false,
  rush: false,
  waitingForHuman: false,
  mode: 'bot',
  perspective: 0,

  startQueue: (opts) => {
    const practice = opts?.practice ?? false;
    const ranked = !practice && (opts?.ranked ?? false);
    const rush = opts?.rush ?? false;
    // A second tap while a match is forming would tear down a formed human
    // match — escrow and all — and start over. One match at a time.
    const current = get().status;
    if (current === 'queuing' || current === 'found' || current === 'battle') {
      return null; // already on the way to the arena; the tap is a no-op
    }
    const deck = useDeck.getState();
    const wallet = useWallet.getState();
    if (!wallet.connected) return 'connect your wallet first';
    if (!deck.isComplete()) return 'deck needs 8 cards';
    const tier = TIERS[deck.tier];
    if (!practice && wallet.sol < tier.stakeSol) return `need ${tier.stakeSol} SOL to enter`;

    const decks = buildDecks();
    if (!decks) return 'your deck has retired cards — rebuild it on the Deck tab';
    const { player, bot } = decks;
    clearTimers();
    pvpClose();
    useErMatch.getState().reset();

    /**
     * Put the match on Solana and its log on a MagicBlock rollup.
     *
     * Not awaited, and never blocking: a wallet that cannot sign, an
     * undeployed program, or a rollup that will not come up all leave the
     * simulated match running exactly as before. The rollup badge reports which
     * of those happened rather than the UI implying an onchain match that isn't.
     *
     * Practice is excluded on purpose — it stakes nothing, so there is nothing
     * to escrow and no reason to spend a commit quota on it.
     */
    if (!practice) {
      const onchainCards = useChain.getState().cards;
      if (onchainCards.length >= 8) {
        const ids = onchainCards.slice(0, 8).map((c) => c.id);
        void deckCommitment(ids, wallet.address).then((hash) => (
          useErMatch.getState().openOnchainMatch(deck.tier, tier.stakeSol, ids, hash)
        ));
      }
    }
    set({
      status: 'queuing',
      playerDeck: player,
      botDeck: bot,
      stakeSol: practice ? 0 : tier.stakeSol,
      practice,
      ranked,
      rush,
      waitingForHuman: ranked,
      mode: 'bot',
      perspective: 0,
      result: null,
      opponentName: practice ? 'Training Dummy' : 'searching…',
    });

    // Practice goes straight to the bot — its whole point is a private arena.
    if (practice) {
      beginBotFlow(true, deck.tier, player, bot);
      return null;
    }

    // Real stakes try a human first. The matchmaker pairs same-tier players;
    // if nobody shows inside the window (or the service is down), the bot
    // steps in — a solo judge still gets a battle every time.
    let fellBack = false;
    const fallBack = () => {
      if (fellBack || get().status === 'battle' || get().status === 'settled') return;
      // Ranked never answers with a bot. Trophies are the promise that the
      // opponent was real, so the queue keeps waiting instead — and the UI says
      // so rather than quietly seating a machine.
      if (ranked) return;
      fellBack = true;
      pvpClose();
      if (get().status === 'idle') return; // player cancelled while waiting
      set({ opponentName: BOT_NAMES[deck.tier], mode: 'bot', perspective: 0 });
      beginBotFlow(false, deck.tier, player, bot);
    };

    pvpConnect({
      onMatched: (m) => {
        if (fellBack) return;
        opponentTrophies = Number(m.opponent.trophies) || 0;
        set({ waitingForHuman: false });
        beginHumanBattle(m, player, tier.stakeSol, deck.tier, rush);
      },
      onUnavailable: fallBack,
      onInput: (ev) => queueRemoteInput(ev),
      onDesync: () => settleVoid('the two sims diverged'),
      onOpponentLeft: () => {
        const s = get();
        if (s.status === 'battle' && s.sim && s.sim.phase !== 'ended') {
          // A vanished opponent forfeits — the win is real and pays normally.
          s.sim.phase = 'ended';
          s.sim.winner = s.perspective;
          clearTimers();
          settle();
        } else if (s.status !== 'settled') {
          // Vanished between matched and the start: the stake was already
          // escrowed at matched, and the bot flow escrows again — refund
          // first or the fallback double-charges.
          refundEscrow();
          fallBack();
        }
      },
      onSocketLost: () => {
        // My own connection died mid-match. The server has already handed the
        // opponent a forfeit win, so pretending otherwise here would let one
        // pot pay out twice. Settle the mirror image: a loss.
        const s = get();
        if (s.status === 'battle' && s.sim && s.sim.phase !== 'ended') {
          s.sim.phase = 'ended';
          s.sim.winner = (1 - s.perspective) as 0 | 1;
          clearTimers();
          settle();
        } else if (s.status === 'queuing' || s.status === 'found') {
          refundEscrow();
          fallBack();
        }
      },
    });
    pvpQueue({
      address: wallet.address,
      name: wallet.walletName || 'anon',
      tier: deck.tier,
      power: deck.power(),
      deck: player,
      deckHash: player.map((c) => c.coinId).join(','),
      // The matchmaker pairs on rating within a widening band, and only pairs
      // players who asked for the same format — a 30-second Rush cannot be
      // seated against a 3-minute standard match.
      trophies: useLadder.getState().trophies,
      ranked,
      format: rush ? 'rush' : 'standard',
    });
    // Ranked has no bot timer at all: there is nothing to fall back to.
    if (!ranked) queueTimers.push(setTimeout(fallBack, pvpWaitMs()));
    return null;
  },

  cancelQueue: () => {
    const { status, mode } = get();
    if (status !== 'queuing' && status !== 'found') return;
    // Once a human match has formed the die is cast: the stake is escrowed and
    // a real opponent is committed. Backing out here is a forfeit, not a
    // cancel, and the UI stops offering Cancel at 'found' for the same reason.
    if (status === 'found' && mode === 'human') return;
    clearTimers();
    pvpCancel();
    pvpClose();
    set({ status: 'idle', sim: null, version: 0 });
  },

  playCard: (deckIndex, xFp, yFp) => {
    const { sim, status, mode, perspective } = get();
    if (!sim || status !== 'battle' || sim.phase === 'ended') return;
    const delay = mode === 'human' ? HUMAN_INPUT_DELAY_TICKS : INPUT_DELAY_TICKS;
    const ev: InputEvent = {
      tick: sim.tick + delay, player: perspective, deckIndex, x: xFp, y: yFp,
    };
    const list = pending.get(ev.tick) ?? [];
    list.push(ev);
    pending.set(ev.tick, list);
    // The opponent applies the identical event at the identical tick — that,
    // and nothing else, is what keeps the two sims one game.
    if (mode === 'human') pvpSendInput(ev);
    // Write the play to the ephemeral rollup. Deliberately not awaited: the
    // local sim is authoritative for what the player sees, and a battle must
    // never stall on a network round trip. The store counts failures instead of
    // hiding them.
    void useErMatch.getState().play(signer(), ev.tick, deckIndex, xFp, yFp);
  },

  forfeit: () => {
    if (get().status !== 'battle') return; // already settled or never started
    const { sim, mode, perspective } = get();
    clearTimers();
    // Closing the socket is the forfeit: the server tells the opponent, who
    // wins by opponent_left. No second message type to disagree with it.
    if (mode === 'human') pvpClose();
    if (sim && sim.phase !== 'ended') {
      sim.phase = 'ended';
      sim.winner = (1 - perspective) as 0 | 1;
    }
    settle();
  },

  dismiss: () => {
    clearTimers();
    pvpClose();
    stopMusic();
    set({
      status: 'idle', sim: null, result: null, version: 0, crowns: [0, 0],
      shock: null, practice: false, mode: 'bot', perspective: 0,
    });
  },
}));

/** One bot-match tick: the bot decides, then the sim advances. */
function tickOnce(difficulty: BotDifficulty): void {
  const sim = useMatch.getState().sim;
  if (!sim) return;

  const botEv = decideBot(sim, 1, difficulty);
  if (botEv) {
    const list = pending.get(botEv.tick) ?? [];
    list.push(botEv);
    pending.set(botEv.tick, list);
  }
  stepOne(sim);
}

/**
 * Bot matches pace against the wall clock exactly like human ones. A plain
 * per-interval step froze the whole match when the tab was hidden — browsers
 * throttle background timers — so switching apps mid-battle left a stake
 * suspended in a stopped clock forever. Now the match continues at real time
 * and a returning player fast-forwards to the present, same as PvP.
 */
let botStartAt = 0;

function tickBot(difficulty: BotDifficulty): void {
  const sim = useMatch.getState().sim;
  if (!sim || sim.phase === 'ended') return;
  const target = Math.floor((Date.now() - botStartAt) / TICK_MS);
  let steps = 0;
  while (sim.tick < target && steps < 6) {
    tickOnce(difficulty);
    steps += 1;
    if ((sim.phase as SimState['phase']) === 'ended') break;
  }
}

/**
 * One sim tick plus its presentation side-effects. Shared by the bot loop and
 * the human loop — the step itself must be byte-identical in both.
 */
function stepOne(sim: SimState): void {
  const { mode, perspective } = useMatch.getState();

  // presentation-only snapshots taken around the step
  const towersBefore = sim.towers.map((t) => t.hp > 0);
  const unitsBefore = sim.units.length;

  stepSim(sim, pending.get(sim.tick) ?? []);
  pending.delete(sim.tick - 1);
  if (sim.tick % HASH_EVERY_TICKS === 0) {
    const h = hashState(sim);
    hashes.push(h);
    // The server compares this against the opponent's hash for the same tick.
    // A mismatch voids the match.
    if (mode === 'human') pvpSendHash(sim.tick, h);
    // And the rollup keeps the checkpoint onchain, which is what makes the
    // anti-cheat story verifiable by anyone rather than by our own relay.
    // Every fourth checkpoint: the sponsored commit quota is finite, and one
    // hash per 8 seconds of play is enough to bound a divergence.
    if (sim.tick % (HASH_EVERY_TICKS * 4) === 0) {
      void useErMatch.getState().mark(signer(), sim.tick, BigInt(h >>> 0));
    }
  }

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
      next.crowns = countCrowns(sim, perspective);
      next.shock = { id: s.version + 1, kind: 'tower', forPlayer: felled };
    }
    return next;
  });

  if (sim.phase === 'ended') {
    clearTimers();
    if (mode === 'human') pvpSendEnded();
    settle();
  }
}

/**
 * Human matches step against the shared wall clock, not a free-running
 * interval: both clients target tick = (now − startAt) / 50ms, so they stay
 * within a tick of each other without any "are you ready" chatter. The catch-up
 * bound keeps a tab that was throttled in the background from spiralling.
 */
function tickHuman(): void {
  const sim = useMatch.getState().sim;
  if (!sim || sim.phase === 'ended') return;
  const target = Math.floor((Date.now() - humanStartAt) / TICK_MS);
  let steps = 0;
  while (sim.tick < target && steps < 6) {
    stepOne(sim);
    steps += 1;
    // stepOne mutates phase, which TS's narrowing can't see through
    if ((sim.phase as SimState['phase']) === 'ended') break;
  }
}

function beginBotFlow(
  practice: boolean, tierIdx: number, player: MatchCard[], bot: MatchCard[],
): void {
  const tier = TIERS[tierIdx];
  // practice skips the search theatre — the point is to get to the arena
  const queueMs = practice ? 400 : 1200 + Math.random() * 1300;
  queueTimers.push(setTimeout(() => {
    if (useMatch.getState().status !== 'queuing') return;
    useMatch.setState({ status: 'found' });
    queueTimers.push(setTimeout(() => {
      if (useMatch.getState().status !== 'found') return;
      // Escrow happens here, not at queue time: a cancelled or abandoned
      // search must never cost the player anything. Practice never escrows.
      if (!practice) {
        if (!useWallet.getState().spend(tier.stakeSol)) {
          clearTimers();
          useMatch.setState({ status: 'idle' });
          return;
        }
        play('coin');
      }
      const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      const sim = createMatch(seed, [player, bot], FORMATS[useMatch.getState().rush ? 'rush' : 'standard']);
      pending = new Map();
      hashes = [];
      useMatch.setState({ status: 'battle', sim, version: 0, crowns: [0, 0], shock: null });
      startMusic();
      const difficulty: BotDifficulty = tierIdx <= 0 ? 'easy' : tierIdx === 1 ? 'normal' : 'hard';
      botStartAt = Date.now();
      loop = setInterval(() => tickBot(difficulty), TICK_MS / 2);
    }, 900));
  }, queueMs));
}

/** Refund a tracked human-match escrow exactly once. */
function refundEscrow(): void {
  if (humanEscrowSol <= 0) return;
  useWallet.getState().receive(humanEscrowSol);
  humanEscrowSol = 0;
}

/**
 * A real opponent. Seat 0's deck is seat 0's deck on both machines — the sim
 * is one shared timeline and `perspective` only changes who the camera loves.
 */
function beginHumanBattle(
  m: MatchedPayload, myDeck: MatchCard[], stakeSol: number, tierIdx: number,
  rush = false,
): void {
  clearTimers(); // the bot fallback timer must not fire mid-handshake
  const store = useMatch.getState();
  if (store.status !== 'queuing' && store.status !== 'found') return;

  if (!useWallet.getState().spend(stakeSol)) {
    pvpClose();
    useMatch.setState({ status: 'idle' });
    return;
  }
  humanEscrowSol = stakeSol;
  play('coin');

  const decks: [MatchCard[], MatchCard[]] = m.role === 0
    ? [myDeck, m.opponent.deck]
    : [m.opponent.deck, myDeck];

  let sim: SimState;
  try {
    sim = createMatch(m.seed, decks, rush ? FORMATS.rush : FORMATS.standard);
  } catch {
    // A malformed opponent deck must not strand this player at 'found' with
    // their stake gone. Refund, drop the socket, and let the bot step in.
    refundEscrow();
    pvpClose();
    useMatch.setState({ mode: 'bot', perspective: 0, opponentName: BOT_NAMES[tierIdx] });
    const bot = buildDecks();
    if (bot) beginBotFlow(false, tierIdx, bot.player, bot.bot);
    else useMatch.setState({ status: 'idle' });
    return;
  }
  pending = new Map();
  hashes = [];
  humanStartAt = m.startAt;

  useMatch.setState({
    status: 'found',
    mode: 'human',
    perspective: m.role,
    opponentName: m.opponent.name ?? `${m.opponent.address.slice(0, 4)}…${m.opponent.address.slice(-4)}`,
  });

  // Both clients hold on 'found' until the shared start instant, then step
  // against the same clock. The interval runs at half a tick so a late timer
  // callback still lands inside the right tick window.
  const untilStart = Math.max(0, m.startAt - Date.now());
  queueTimers.push(setTimeout(() => {
    if (useMatch.getState().status !== 'found') return;
    useMatch.setState({ status: 'battle', sim, version: 0, crowns: [0, 0], shock: null });
    startMusic();
    loop = setInterval(tickHuman, TICK_MS / 2);
  }, untilStart));
}

/** Remote inputs join the same queue local ones do — the sim cannot tell. */
function queueRemoteInput(ev: InputEvent): void {
  const { sim, perspective, mode } = useMatch.getState();
  if (!sim || mode !== 'human') return;
  if (ev.player === perspective) return; // never accept our own seat from outside
  if (ev.tick <= sim.tick) {
    // Too late to apply at its stamped tick: the sender already applied it,
    // so the timelines have split. Void now rather than letting the next hash
    // checkpoint discover it.
    settleVoid('an input arrived too late to stay in lockstep');
    return;
  }
  const list = pending.get(ev.tick) ?? [];
  list.push(ev);
  pending.set(ev.tick, list);
}

/**
 * Annul the match: stakes come back, nothing is raked, nothing is recorded.
 * This is the designed response to divergence — the one unacceptable outcome
 * is two players seeing two different games and one of them paying for it.
 */
function settleVoid(reason: string): void {
  const { status, stakeSol, sim } = useMatch.getState();
  if (status !== 'battle' || !sim) return;
  clearTimers();
  pvpClose();
  stopMusic();
  useWallet.getState().receive(stakeSol); // the escrowed stake, returned whole
  humanEscrowSol = 0; // consumed by the refund above — never refund twice
  const result: MatchResult = {
    won: false,
    draw: true,
    voided: true,
    potSol: stakeSol * 2,
    payoutSol: stakeSol,
    rakeSol: 0,
    hashes: hashes.length,
    crowns: countCrowns(sim, useMatch.getState().perspective),
    chest: null,
  };
  console.warn(`match voided: ${reason}`);
  useMatch.setState({ status: 'settled', result });
}

/** Crowns = enemy towers felled, seen from `me`. Derived, so it cannot drift. */
function countCrowns(sim: SimState, me: 0 | 1): [number, number] {
  let mine = 0;
  let theirs = 0;
  for (const t of sim.towers) {
    if (t.hp > 0) continue;
    if (t.owner === me) theirs += 1;
    else mine += 1;
  }
  return [mine, theirs];
}

function settle(): void {
  const { sim, stakeSol, status, practice, perspective, mode, ranked } = useMatch.getState();
  if (!sim || status === 'settled') return; // idempotent: never pay twice
  if (mode === 'human') pvpClose();
  humanEscrowSol = 0; // consumed by the payout rules below
  const crowns = countCrowns(sim, perspective);

  // Seal the rollup log and bring it home. Not awaited: the result screen must
  // appear immediately, and the commit is observable through the rollup badge.
  // The final hash is the last checkpoint, which is what settlement records.
  if (sim.phase === 'ended') {
    const finalHash = hashes.length ? hashes[hashes.length - 1] : 0;
    const winner = sim.winner === null ? 2 : (sim.winner === perspective ? 0 : 1);
    void useErMatch.getState().finish(signer(), winner, BigInt(finalHash >>> 0));
  }
  stopMusic();
  const wallet = useWallet.getState();
  const pot = stakeSol * 2;
  const draw = sim.winner === -2;
  const won = sim.winner === perspective;
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
  // A chest tier is the one outcome the house picks, so it goes through the
  // MagicBlock VRF oracle whenever this session can sign. `Math.random()` here
  // is the Guest path only, and the chest records which it was — a UI that
  // showed the same badge either way would be lying about exactly the mechanic
  // players are right to distrust.
  //
  // Awarded optimistically with a local roll and reconciled when the oracle
  // answers: the result screen must not wait on an async callback, and a chest
  // that silently changes tier a second later is worse than one that arrives
  // already labelled as unverified.
  const chest = won && !practice ? useEconomy.getState().awardChest() : null;
  if (chest) void rollChestOnchain();
  /**
   * Trophies move only on ranked matches, and only against a real opponent's
   * rating. Practice and casual are excluded by construction — a ladder that
   * can be climbed against a bot is not a ladder.
   */
  const trophyChange = ranked && !practice
    ? useLadder.getState().record(
      wallet.address,
      opponentTrophies,
      draw ? 'draw' : won ? 'win' : 'loss',
    )
    : null;

  const result: MatchResult = {
    won, draw, potSol: pot, payoutSol, rakeSol, hashes: hashes.length, crowns, chest,
    trophyDelta: trophyChange?.delta,
    trophiesAfter: trophyChange?.after,
    promoted: trophyChange?.promoted,
    demoted: trophyChange?.demoted,
    leagueAfter: trophyChange?.leagueAfter.name,
  };
  useMatch.setState((s) => ({
    status: 'settled',
    result,
    // practice never enters the record — a padded W/L is worse than none
    history: practice ? s.history : [result, ...s.history],
  }));

  // Standing rolls up after settlement, fire-and-forget by design: the result
  // screen must never wait on, or fail because of, a service. Practice stays
  // out of all of it for the same reason it stays out of history — it cannot
  // be farmed.
  if (!practice) {
    recordMatch(wallet.address, result);
    if (crowns[0] > 0) {
      useClan.getState().reportCrowns(wallet.address, crowns[0], useDeck.getState().power());
    }
  }
}
