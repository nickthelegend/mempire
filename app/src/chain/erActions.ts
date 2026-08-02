import { BN } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { cardPda, configPda, matchPda, PROGRAM_ID } from './pdas';
import { canSign, getProgram } from './provider';
import { readableChainError } from './actions';
import {
  MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, confirmCommit, erProgram, resolveEr, waitUndelegated,
} from './magicblock';

/**
 * The battle loop on MagicBlock.
 *
 * Each function documents its destination, because the destination *is* the
 * contract here — the same instruction sent to the wrong layer fails in a way
 * that reads like a program bug:
 *
 *   initMatchLogTx      → base   (create the log)
 *   delegateMatchLogTx  → base   (hand it to the rollup)
 *   playCardEr          → ER     (one card play, ~10-50ms)
 *   checkpointEr        → ER     (state-hash checkpoint)
 *   endMatchEr          → ER     (seal + commit_and_undelegate)
 *   settleFromLogTx     → base   (pay the pot from the committed log)
 *
 * Only the log is delegated. The escrow never leaves base layer, so an ER outage
 * costs latency and falls back to `claim_timeout`, never the pot.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const LOG_SEED = 'log';

function u64le(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function matchLogPda(matchId: number | bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(LOG_SEED), u64le(matchId)],
    programId,
  )[0];
}

export class NoSignerError extends Error {
  constructor() { super('This wallet cannot sign — connect a real wallet to play onchain.'); }
}

function requireSigner(adapter: Adapter | null): Adapter {
  if (!canSign(adapter) || !adapter?.publicKey) throw new NoSignerError();
  return adapter;
}

export interface TxResult { signature: string }

/** Base layer. Creates the log for an already-active match. */
export async function initMatchLogTx(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult & { log: string }> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const log = matchLogPda(matchId);

  const signature = await program.methods
    .initMatchLog(new BN(matchId))
    .accounts({
      matchAccount: matchPda(matchId),
      matchLog: log,
      payer: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { signature, log: log.toBase58() };
}

/**
 * Base layer. Delegates the log to an ephemeral rollup.
 *
 * The `#[delegate]` macro injects the buffer, delegation record, and metadata
 * accounts, so Anchor resolves them from the seeds — they are deliberately not
 * passed by hand here.
 */
export async function delegateMatchLogTx(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);

  const signature = await program.methods
    .delegateMatchLog(new BN(matchId))
    .accounts({
      payer: wallet.publicKey!,
      matchLog: matchLogPda(matchId),
    } as any)
    .rpc();

  return { signature };
}

/**
 * ER. One card play.
 *
 * Resolves the rollup through the router each time rather than caching an
 * endpoint for the match: placement is the router's to decide, and a cached
 * FQDN is how an integration ends up talking to a validator that no longer
 * holds the account.
 */
export async function playCardEr(
  adapter: Adapter | null,
  matchId: number,
  tick: number,
  deckIndex: number,
  x: number,
  y: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const program = erProgram(wallet, er.conn);
  const signature = await program.methods
    .playCard(tick, deckIndex, x, y)
    .accounts({ matchLog: log, player: wallet.publicKey! } as any)
    .rpc();

  return { signature };
}

/** ER. Records a state-hash checkpoint. */
export async function checkpointEr(
  adapter: Adapter | null, matchId: number, tick: number, hash: bigint,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const program = erProgram(wallet, er.conn);
  const signature = await program.methods
    .checkpoint(tick, new BN(hash.toString()))
    .accounts({ matchLog: log, player: wallet.publicKey! } as any)
    .rpc();

  return { signature };
}

/**
 * ER. Seals the match and sends the log back to base layer.
 *
 * Returns the base-layer commit signature only once it has been confirmed there.
 * The ER signature alone proves the intent was accepted, not that the state
 * landed — and settlement reads base-layer state.
 */
export async function endMatchEr(
  adapter: Adapter | null, matchId: number, winner: number, finalHash: bigint,
): Promise<TxResult & { commitSignature: string | null; undelegated: boolean }> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const program = erProgram(wallet, er.conn);
  const signature = await program.methods
    .endMatchLog(winner, new BN(finalHash.toString()))
    .accounts({
      payer: wallet.publicKey!,
      matchLog: log,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    } as any)
    .rpc();

  const commitSignature = await confirmCommit(signature, er.conn);
  const undelegated = await waitUndelegated(log, PROGRAM_ID);
  return { signature, commitSignature, undelegated };
}

/**
 * Base layer. Pays the pot from the committed log — **one signature**.
 *
 * This is the concrete UX win of putting the log on a rollup: because the
 * result is onchain, a player whose opponent has closed their laptop can settle
 * honestly and immediately, instead of waiting out `claim_timeout`.
 */
export async function settleFromLogTx(
  adapter: Adapter | null, matchId: number, deckCardIds: number[],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);

  const m: any = await (program.account as any).matchAccount.fetch(matchPda(matchId));
  const cfg: any = await (program.account as any).config.fetch(configPda());

  const signature = await program.methods
    .settleFromLog()
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      matchLog: matchLogPda(matchId),
      settler: wallet.publicKey!,
      playerA: m.players[0],
      playerB: m.players[1],
      treasury: cfg.treasury,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();

  return { signature };
}

export { readableChainError };
