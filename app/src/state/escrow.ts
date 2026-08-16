import { create } from 'zustand';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  cancelMatchTx, claimTimeoutTx, createMatchTx, joinMatchTx, readMatch,
  settleFromLogTx,
} from '../chain/actions';
import {
  claimResultEr, delegateBaseLogTx, initBaseLogTx, logIsSettleable,
} from '../chain/escrow';
import { fetchCardsFor } from '../chain/read';
import { matchPda } from '../chain/pdas';
import { IS_LOCALNET, LOCALNET_VALIDATOR } from '../chain/magicblock';
import { readableChainError } from '../chain/actions';
import { pvpSendChain } from '../lib/pvp';
import { track } from '../lib/track';
import { useChain } from './chain';

/**
 * Where a ranked match's money is.
 *
 * `none` is not a failure state — practice matches, guests, and any wallet
 * that cannot sign live there permanently, and the Arena says so rather than
 * showing a stake it is not taking.
 */
export type EscrowPhase =
  | 'none'        // nothing staked; this match is for the ladder only
  | 'opening'     // create_match in flight
  | 'waiting'     // our stake is escrowed, waiting for the opponent's
  | 'joining'     // join_match in flight
  | 'live'        // both stakes escrowed, match Active
  | 'claiming'    // recording this seat's result on the rollup
  | 'claimed'     // our claim is in; the opponent's may not be
  | 'settled'     // the pot has been paid
  | 'refunded'    // cancelled or voided; stake came back
  | 'failed';     // could not stake — the match continues unstaked

interface EscrowStore {
  phase: EscrowPhase;
  /** The on-chain match id, once one exists. */
  matchId: number | null;
  /** Lamports each seat put in. */
  stakeLamports: number;
  /** Both seats, in program order, once the match is Active. */
  players: [string, string] | null;
  /** Our deck's card ids, needed to release the lock at settlement. */
  deckCardIds: number[];
  /** The opponent's, learned at settlement time from the match account. */
  opponentDeckCardIds: number[];
  seat: 0 | 1 | null;
  lastSignature: string | null;
  lastError: string | null;

  reset: () => void;

  /**
   * Seat 0: open the match and escrow. Returns the id, or null if nothing
   * could be staked — in which case the match plays on unstaked.
   */
  open: (
    adapter: Adapter | null, tier: number, stakeSol: number, deckCardIds: number[],
    deckHash: Uint8Array,
  ) => Promise<number | null>;

  /** Seat 1: verify the opponent's match, then match their stake. */
  join: (
    adapter: Adapter | null, matchId: number, expectedStakeSol: number,
    opponentAddress: string, deckCardIds: number[], deckHash: Uint8Array,
  ) => Promise<boolean>;

  /** Seat 0: put the log on a rollup so both seats can record a result. */
  prepareLog: (adapter: Adapter | null, matchId: number) => Promise<boolean>;

  /** Either seat, at the end: record our result and settle if we can. */
  finish: (adapter: Adapter | null, winnerSeat: number, finalHash: bigint) => Promise<void>;

  /** Seat 0, when nobody joined: take the stake back. */
  withdraw: (adapter: Adapter | null) => Promise<void>;

  /**
   * Last resort: claim a pot whose match never resolved.
   *
   * A voided match — desync, dropped relay, an opponent who never reported —
   * leaves both stakes escrowed in an `Active` match that no agreement will
   * ever settle. `claim_timeout` is the program's answer, and it only works
   * after the deadline, so this is a no-op until then. Without it a voided
   * staked match is a stranded pot, which is the failure this whole path
   * exists to avoid.
   */
  /**
   * Reclaim a stake from a match that never settled.
   *
   * Takes the id explicitly. It used to read `matchId` off this store, which
   * is wiped on reload — so the recovery button did nothing at all for anyone
   * who had closed the tab, which is everyone who needs it. The caller reads
   * the stranded match from the chain and passes its id.
   */
  recover: (adapter: Adapter | null, matchId?: number) => Promise<'paid' | 'too-early' | 'nothing'>;
}

export const useEscrow = create<EscrowStore>((set, get) => ({
  phase: 'none',
  matchId: null,
  stakeLamports: 0,
  players: null,
  deckCardIds: [],
  opponentDeckCardIds: [],
  seat: null,
  lastSignature: null,
  lastError: null,

  reset: () => set({
    phase: 'none', matchId: null, stakeLamports: 0, players: null,
    deckCardIds: [], opponentDeckCardIds: [], seat: null,
    lastSignature: null, lastError: null,
  }),

  open: async (adapter, tier, stakeSol, deckCardIds, deckHash) => {
    set({ phase: 'opening', seat: 0, deckCardIds, lastError: null });
    try {
      const { matchId, signature } = await createMatchTx(
        adapter, tier, stakeSol, deckCardIds, deckHash,
      );
      set({
        phase: 'waiting', matchId, lastSignature: signature,
        stakeLamports: Math.round(stakeSol * 1e9),
      });
      void useChain.getState().refresh();
      track('match.staked', { seat: 0, stakeSol, tier });
      pvpSendChain({ stage: 'opened', onchainMatchId: matchId });
      return matchId;
    } catch (e) {
      // A stake that could not be taken is reported, not hidden. The match
      // still plays — it just plays for the ladder instead of for the pot.
      const reason = readableChainError(e);
      set({ phase: 'failed', lastError: reason });
      pvpSendChain({ stage: 'failed', reason });
      return null;
    }
  },

  join: async (adapter, matchId, expectedStakeSol, opponentAddress, deckCardIds, deckHash) => {
    set({ phase: 'joining', seat: 1, deckCardIds, lastError: null });
    try {
      // Read the match before staking into it.
      //
      // The id arrived over the relay, which is not an authority on anything.
      // A peer that names someone else's match, or their own at a bigger
      // stake, gets refused here rather than after the lamports have moved.
      const m = await readMatch(matchId);
      if (!m) throw new Error('that match does not exist on chain');
      if (m.state !== 0) throw new Error('that match is not open');
      if (m.players[0] !== opponentAddress) {
        throw new Error('that match belongs to a different player');
      }
      const want = Math.round(expectedStakeSol * 1e9);
      if (m.stakeLamports !== want) {
        throw new Error(
          `stake mismatch: the match is for ${(m.stakeLamports / 1e9).toFixed(3)} SOL`,
        );
      }

      const { signature } = await joinMatchTx(adapter, matchId, deckCardIds, deckHash);
      set({
        phase: 'live', matchId, lastSignature: signature,
        stakeLamports: m.stakeLamports,
        players: [m.players[0], m.players[1]] as [string, string],
      });
      void useChain.getState().refresh();
      track('match.staked', { seat: 1, stakeSol: m.stakeLamports / 1e9 });
      pvpSendChain({ stage: 'joined', onchainMatchId: matchId });
      return true;
    } catch (e) {
      const reason = readableChainError(e);
      set({ phase: 'failed', lastError: reason });
      pvpSendChain({ stage: 'failed', reason });
      return false;
    }
  },

  prepareLog: async (adapter, matchId) => {
    try {
      // Confirm the opponent's stake landed before spending anything on a log.
      const m = await readMatch(matchId);
      if (!m || m.state !== 1) return false;
      set({ phase: 'live', players: [m.players[0], m.players[1]] as [string, string] });

      await initBaseLogTx(adapter, matchId);
      await delegateBaseLogTx(adapter, matchId, IS_LOCALNET ? LOCALNET_VALIDATOR : null);
      return true;
    } catch (e) {
      // Not fatal. Without the log the pot settles through `claim_timeout`
      // after the deadline instead — slower, but nobody's stake is stuck.
      set({ lastError: readableChainError(e) });
      return false;
    }
  },

  finish: async (adapter, winnerSeat, finalHash) => {
    const { matchId, phase } = get();
    if (matchId === null || phase === 'none' || phase === 'failed') return;
    set({ phase: 'claiming' });
    try {
      const { signature, committed } = await claimResultEr(
        adapter, matchId, winnerSeat, finalHash,
      );
      set({ phase: 'claimed', lastSignature: signature });

      /**
       * Wait for the agreement, then settle.
       *
       * Both seats reach this within a second of each other, so "whoever gets
       * here second settles" is not reliable on its own: seat A claims, waits,
       * and times out just as seat B is claiming — and seat B, having claimed
       * first from its own point of view, times out too. Neither settles, and
       * a perfectly agreed match falls through to `claim_timeout`, which costs
       * the winner their rake share and a wait.
       *
       * So poll instead of checking once. Whichever client sees the log come
       * home first calls settle; the other finds the match already `Settled`
       * and its call is a harmless no-op.
       */
      let ready = committed;
      for (let i = 0; !ready && i < 20; i += 1) {
        await new Promise((r) => { setTimeout(r, 3000); });
        ready = await logIsSettleable(matchId);
      }
      /**
       * The opponent never spoke. Fall back to the timeout rather than
       * leaving the pot in the match account indefinitely.
       *
       * A seat that closed its tab, crashed, or disagreed will never record a
       * claim, and settlement requires two. `claim_timeout` is the program's
       * answer and it only works after the deadline — so this waits it out in
       * the background instead of making the player find a button. The
       * program pays only the caller, and only a player, so this is safe to
       * run unattended.
       */
      if (!ready) {
        const m = await readMatch(matchId);
        if (!m || m.state !== 1) return;
        const waitMs = Math.max(0, (m.deadline * 1000) - Date.now()) + 5_000;
        // Cap the wait: a deadline hours away is not something to hold a timer
        // open for, and the Empire screen offers the same claim manually.
        if (waitMs > 15 * 60_000) return;
        setTimeout(() => { void get().recover(adapter); }, waitMs);
        return;
      }

      const m = await readMatch(matchId);
      if (!m || m.state !== 1) return;

      // Both decks must ride along so settlement releases both locks. Ours we
      // know; the opponent's we do not, and the program skips anything that is
      // not locked to this match — so sending only ours frees only ours, and
      // theirs is freed by their own settle call or by the timeout path.
      const { deckCardIds } = get();
      const { signature: settleSig } = await settleFromLogTx(
        adapter, matchId, [m.players[0], m.players[1]] as [string, string], deckCardIds,
      );
      set({ phase: 'settled', lastSignature: settleSig });
      track('match.settled', { matchId, winnerSeat: winnerSeat });
      void useChain.getState().refresh();
    } catch (e) {
      set({ lastError: readableChainError(e) });
    }
  },

  recover: async (adapter, explicitId) => {
    const matchId = explicitId ?? get().matchId;
    if (matchId === null || matchId === undefined) return 'nothing';
    const m = await readMatch(matchId);
    if (!m || m.state === 2) return 'nothing'; // already settled

    const me = adapter?.publicKey?.toBase58();
    if (!me || !m.players.includes(me)) return 'nothing';

    /*
     * The deck comes from the chain, not from this store.
     *
     * Both instructions take the locked deck as remaining accounts so the
     * cards come free again, and `deckCardIds` here is empty after a reload —
     * which is the only time anyone reaches this button. The cards this match
     * locked are a fact on chain: they are the ones naming it in `locked_by`.
     */
    const matchAddress = matchPda(matchId).toBase58();
    const locked = (await fetchCardsFor(me))
      .filter((c: { lockedBy: string | null }) => c.lockedBy === matchAddress)
      .map((c: { id: number }) => c.id);

    try {
      if (m.state === 0) {
        /*
         * Open — nobody ever joined, so there is no pot to award and no
         * deadline to wait for. The stake is simply still the player's, and
         * `cancel_match` gives it back. `claim_timeout` was the only path
         * offered before, and it refuses anything that is not Active, so a
         * match that never found an opponent could not be recovered at all.
         */
        const { signature } = await cancelMatchTx(adapter, matchId, locked);
        set({ phase: 'refunded', lastSignature: signature });
        void useChain.getState().refresh();
        return 'paid';
      }

      // Active: an opponent joined and it never settled. The program pays out
      // only after the deadline, and only to a player of this match.
      if (Date.now() / 1000 < m.deadline) return 'too-early';
      const { signature } = await claimTimeoutTx(
        adapter, matchId, me, m.players as [string, string], locked,
      );
      set({ phase: 'settled', lastSignature: signature });
      void useChain.getState().refresh();
      return 'paid';
    } catch (e) {
      set({ lastError: readableChainError(e) });
      return 'nothing';
    }
  },

  withdraw: async (adapter) => {
    const { matchId, deckCardIds, phase } = get();
    if (matchId === null || (phase !== 'waiting' && phase !== 'failed')) return;
    try {
      const { signature } = await cancelMatchTx(adapter, matchId, deckCardIds);
      set({ phase: 'refunded', lastSignature: signature });
      void useChain.getState().refresh();
    } catch (e) {
      set({ lastError: readableChainError(e) });
    }
  },
}));
