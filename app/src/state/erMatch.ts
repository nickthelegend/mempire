import { create } from 'zustand';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  checkpointEr, delegateMatchLogTx, endMatchEr, initMatchLogTx, matchLogPda,
  playCardEr, readableChainError, settleFromLogTx,
} from '../chain/erActions';
import { createMatchTx } from '../chain/actions';
import { resolveEr } from '../chain/magicblock';
import { useChain } from './chain';
import { signer } from './wallet';

/**
 * The rollup side of a match.
 *
 * Wraps the ER lifecycle in a store so the battle screen can show what layer it
 * is on and the match store can fire plays without knowing about routers.
 *
 * Two properties matter more than throughput here:
 *
 * 1. **A rollup failure never blocks play.** Every ER write is fire-and-forget
 *    against the local simulation, which stays authoritative for what the player
 *    sees. The log is the onchain record; if a write fails the match continues
 *    and `pendingWrites` reports the gap honestly rather than freezing a battle
 *    over a network hiccup.
 * 2. **Nothing here moves money.** Settlement is a separate base-layer call that
 *    reads the committed log, so a stalled rollup degrades to `claim_timeout`.
 */

export type ErPhase =
  | 'off' // no wallet that can sign, or ER disabled
  | 'preparing' // creating + delegating the log
  | 'live' // delegated; plays are landing on the rollup
  | 'committing' // sealing and undelegating
  | 'committed' // log is home on base layer
  | 'degraded'; // rollup unreachable — sim continues, log is incomplete

interface ErMatchState {
  phase: ErPhase;
  matchId: number | null;
  logAddress: string | null;
  fqdn: string | null;
  /** Plays accepted by the rollup this match. */
  writes: number;
  /** Plays the rollup refused or dropped. Surfaced, never hidden. */
  failed: number;
  lastError: string | null;
  lastSignature: string | null;
  commitSignature: string | null;

  /** Base layer: create + delegate. Safe to call once per match. */
  begin: (adapter: Adapter | null, matchId: number) => Promise<void>;
  /**
   * The whole onchain opening: escrow the stake in a real match, then put its
   * log on a rollup. Returns the onchain match id, or null when this session
   * cannot go onchain (guest wallet, program unreachable, deck not minted).
   */
  openOnchainMatch: (
    tier: number, stakeSol: number, deckCardIds: number[], deckHash: Uint8Array,
  ) => Promise<number | null>;
  /** ER: record one play. Never throws — a battle must not stall on a rollup. */
  play: (
    adapter: Adapter | null, tick: number, deckIndex: number, x: number, y: number,
  ) => Promise<void>;
  /** ER: record a state-hash checkpoint. Never throws. */
  mark: (adapter: Adapter | null, tick: number, hash: bigint) => Promise<void>;
  /** ER: seal and undelegate, then report whether the log made it home. */
  finish: (adapter: Adapter | null, winner: number, finalHash: bigint) => Promise<boolean>;
  /** Base layer: pay the pot from the committed log, with one signature. */
  settle: (adapter: Adapter | null, deckCardIds: number[]) => Promise<string | null>;
  reset: () => void;
}

export const useErMatch = create<ErMatchState>((set, get) => ({
  phase: 'off',
  matchId: null,
  logAddress: null,
  fqdn: null,
  writes: 0,
  failed: 0,
  lastError: null,
  lastSignature: null,
  commitSignature: null,

  begin: async (adapter, matchId) => {
    if (!adapter) { set({ phase: 'off' }); return; }
    set({
      phase: 'preparing', matchId, writes: 0, failed: 0,
      lastError: null, commitSignature: null,
      logAddress: matchLogPda(matchId).toBase58(),
    });
    try {
      await initMatchLogTx(adapter, matchId);
      await delegateMatchLogTx(adapter, matchId);
      // Placement is the router's call — confirm it before claiming 'live'.
      const er = await resolveEr(matchLogPda(matchId));
      if (!er) throw new Error('router did not place the log on a rollup');
      set({ phase: 'live', fqdn: er.fqdn });
    } catch (e) {
      // The match is already playable; the rollup is the optional half.
      set({ phase: 'degraded', lastError: readableChainError(e) });
    }
  },

  /**
   * Escrow onchain, then delegate the log.
   *
   * Ordered deliberately: the stake must be committed on base layer *before* the
   * rollup is involved, so a rollup that never comes up leaves a normal onchain
   * match that `claim_timeout` can resolve — never a delegated log guarding a
   * pot nobody can reach.
   */
  openOnchainMatch: async (tier, stakeSol, deckCardIds, deckHash) => {
    const adapter = signer();
    // Guest has an address but no keypair; simulated play is the honest fallback.
    if (!adapter || useChain.getState().mode !== 'onchain') { set({ phase: 'off' }); return null; }
    if (deckCardIds.length !== 8) { set({ phase: 'off' }); return null; }

    try {
      const { matchId } = await createMatchTx(adapter, tier, stakeSol, deckCardIds, deckHash);
      await get().begin(adapter, matchId);
      void useChain.getState().refresh();
      return matchId;
    } catch (e) {
      // Escrow failed, so there is nothing onchain to clean up. Play locally.
      set({ phase: 'off', lastError: readableChainError(e) });
      return null;
    }
  },

  play: async (adapter, tick, deckIndex, x, y) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !adapter) return;
    try {
      const { signature } = await playCardEr(adapter, matchId, tick, deckIndex, x, y);
      set((s) => ({ writes: s.writes + 1, lastSignature: signature }));
    } catch (e) {
      set((s) => ({ failed: s.failed + 1, lastError: readableChainError(e) }));
    }
  },

  mark: async (adapter, tick, hash) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !adapter) return;
    try {
      const { signature } = await checkpointEr(adapter, matchId, tick, hash);
      set({ lastSignature: signature });
    } catch (e) {
      set((s) => ({ failed: s.failed + 1, lastError: readableChainError(e) }));
    }
  },

  finish: async (adapter, winner, finalHash) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !adapter) return false;
    set({ phase: 'committing' });
    try {
      const r = await endMatchEr(adapter, matchId, winner, finalHash);
      // 'committed' means the log is readable on base layer — the only state in
      // which settle_from_log can succeed.
      set({
        phase: r.undelegated ? 'committed' : 'degraded',
        commitSignature: r.commitSignature,
        lastSignature: r.signature,
      });
      return r.undelegated;
    } catch (e) {
      set({ phase: 'degraded', lastError: readableChainError(e) });
      return false;
    }
  },

  settle: async (adapter, deckCardIds) => {
    const { phase, matchId } = get();
    if (phase !== 'committed' || matchId === null || !adapter) return null;
    try {
      const { signature } = await settleFromLogTx(adapter, matchId, deckCardIds);
      set({ lastSignature: signature });
      return signature;
    } catch (e) {
      set({ lastError: readableChainError(e) });
      return null;
    }
  },

  reset: () => set({
    phase: 'off', matchId: null, logAddress: null, fqdn: null,
    writes: 0, failed: 0, lastError: null, lastSignature: null, commitSignature: null,
  }),
}));
