import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import rollupIdl from './mempire_rollup.idl.json';
import { canSign, getProvider } from './provider';
import { readableChainError } from './actions';
import {
  LOCALNET_VALIDATOR, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
  confirmCommit, resolveEr, waitUndelegated,
} from './magicblock';

/**
 * The battle loop on MagicBlock.
 *
 * # Two programs, on purpose
 *
 * The rollup state lives in a **separate program** (`mempire_rollup`) from the
 * money (`mempire`). Two reasons, and the second matters more:
 *
 * 1. Adding the ER SDK to `mempire` — which already carries `anchor-spl` for the
 *    staking vaults — pushed that binary past what its deploy buffer could be
 *    funded for. The rollup program needs no token CPI and is a third the size.
 * 2. The rollup program **cannot move money**. It owns no lamports beyond its own
 *    rent and has no transfer path, so a delegated log can never guard a pot.
 *    Escrow, deck locks and payout stay in `mempire` on base layer, settled by
 *    its existing signature-verified `settle` using the hash this program
 *    commits. A stalled rollup costs latency and falls back to `claim_timeout`.
 *
 * # Routing — the destination is the contract
 *
 *   initLogTx       → base   (create the log)
 *   delegateLogTx   → base   (hand it to a rollup)
 *   playCardEr      → ER     (one card play)
 *   checkpointEr    → ER     (state-hash checkpoint)
 *   endLogEr        → ER     (seal + commit_and_undelegate)
 *   closeLogTx      → base   (reclaim rent once sealed)
 *
 * The same instruction sent to the wrong layer fails in a way that reads like a
 * program bug, so each function names its layer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ROLLUP_PROGRAM_ID = new PublicKey((rollupIdl as { address: string }).address);

const enc = new TextEncoder();

function u64le(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function matchLogPda(matchId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('log'), u64le(matchId)],
    ROLLUP_PROGRAM_ID,
  )[0];
}

export class NoSignerError extends Error {
  constructor() { super('This wallet cannot sign — connect a real wallet to play onchain.'); }
}

function requireSigner(adapter: Adapter | null): Adapter {
  if (!canSign(adapter) || !adapter?.publicKey) throw new NoSignerError();
  return adapter;
}

/** The rollup program on base layer. */
function baseProgram(adapter: Adapter | null): Program<Idl> {
  return new Program(rollupIdl as Idl, getProvider(adapter));
}

/** The rollup program bound to a specific ER endpoint. */
function erProgram(adapter: Adapter | null, conn: Connection): Program<Idl> {
  const base = getProvider(adapter);
  return new Program(rollupIdl as Idl, new AnchorProvider(conn, base.wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  }));
}

export interface TxResult { signature: string }

/** Base layer. Creates the log and records both seats. */
export async function initLogTx(
  adapter: Adapter | null, matchId: number, players: [string, string],
): Promise<TxResult & { log: string }> {
  const wallet = requireSigner(adapter);
  const program = baseProgram(wallet);
  const log = matchLogPda(matchId);

  const signature = await program.methods
    .initLog(new BN(matchId), [new PublicKey(players[0]), new PublicKey(players[1])])
    .accounts({
      log,
      payer: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { signature, log: log.toBase58() };
}

/**
 * Base layer. Delegates the log to an ephemeral rollup.
 *
 * `validator` is only supplied on localnet. Naming a specific validator is
 * *required* there — an unassigned delegation is refused by a specific ER even
 * though base ownership and the ER clone both look correct, which is a
 * genuinely confusing failure. On devnet the router assigns placement, so the
 * account is left off.
 */
export async function delegateLogTx(
  adapter: Adapter | null, matchId: number, localnet = false,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = baseProgram(wallet);

  const signature = await program.methods
    .delegateLog(new BN(matchId))
    .accounts({
      payer: wallet.publicKey!,
      log: matchLogPda(matchId),
      validator: localnet ? LOCALNET_VALIDATOR : null,
    } as any)
    .rpc();

  return { signature };
}

/**
 * ER. One card play.
 *
 * Resolves the rollup through the router on each call rather than caching an
 * endpoint for the match: placement is the router's to decide, and a cached FQDN
 * is how an integration ends up talking to a validator that no longer holds the
 * account.
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

  const signature = await erProgram(wallet, er.conn).methods
    .playCard(tick, deckIndex, x, y)
    .accounts({ log, player: wallet.publicKey! } as any)
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

  const signature = await erProgram(wallet, er.conn).methods
    .checkpoint(tick, new BN(hash.toString()))
    .accounts({ log, player: wallet.publicKey! } as any)
    .rpc();

  return { signature };
}

/**
 * ER. Seals the log and commits it back to base layer.
 *
 * Reports the base-layer commit signature only after confirming it there. The ER
 * signature alone proves the intent was accepted, not that the state landed —
 * and settlement reads base-layer state.
 */
export async function endLogEr(
  adapter: Adapter | null, matchId: number, winner: number, finalHash: bigint,
): Promise<TxResult & { commitSignature: string | null; undelegated: boolean }> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const signature = await erProgram(wallet, er.conn).methods
    .endLog(winner, new BN(finalHash.toString()))
    .accounts({
      payer: wallet.publicKey!,
      log,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    } as any)
    .rpc();

  const commitSignature = await confirmCommit(signature, er.conn);
  const undelegated = await waitUndelegated(log, ROLLUP_PROGRAM_ID);
  return { signature, commitSignature, undelegated };
}

/** Base layer. Reclaims the log's rent once the match is sealed. */
export async function closeLogTx(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const signature = await baseProgram(wallet).methods
    .closeLog()
    .accounts({ log: matchLogPda(matchId), payer: wallet.publicKey! } as any)
    .rpc();
  return { signature };
}

/** Reads the committed log off base layer — the onchain record of the match. */
export async function fetchLog(matchId: number): Promise<{
  plays: number; lastTick: number; lastHash: string; checkpoints: number;
  ended: boolean; winner: number;
} | null> {
  try {
    const program = baseProgram(null);
    const raw: any = await (program.account as any).matchLog.fetchNullable(matchLogPda(matchId));
    if (!raw) return null;
    return {
      plays: raw.plays?.length ?? 0,
      lastTick: Number(raw.lastTick ?? 0),
      lastHash: String(raw.lastHash ?? '0'),
      checkpoints: Number(raw.checkpoints ?? 0),
      ended: Boolean(raw.ended),
      winner: Number(raw.winner ?? 255),
    };
  } catch {
    return null;
  }
}

export { readableChainError };
