import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import rollupIdl from './mempire_rollup.idl.json';
import { canSign, getConnection, getProvider } from './provider';
import { readableChainError } from './actions';
import {
  closeSession, forgetSession, openSession, sessionFor, sessionProvider,
} from './session';
import {
  IS_LOCALNET, LOCALNET_VALIDATOR, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
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

/**
 * MagicBlock's permission program, and the seed it derives from.
 *
 * The trailing colon is part of the seed. Dropping it derives a different PDA
 * that the permission program simply refuses, with an error that points nowhere
 * near the cause.
 */
export const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
export const EPHEMERAL_VAULT_ID = new PublicKey('MagicVau1t999999999999999999999999999999999');
const PERMISSION_SEED = enc.encode('permission:');

/** The ER-local permission guarding a delegated log. */
export function permissionPda(log: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, log.toBytes()],
    PERMISSION_PROGRAM_ID,
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

  // Sign with the match's session key when it has one. The rollup accepts
  // either the seat's wallet or the temporary key that seat authorised, and
  // the account list is identical — so this is purely a question of who holds
  // the pen, never of what gets passed.
  const kp = sessionFor(matchId);
  const prog = kp
    ? new Program(rollupIdl as Idl, sessionProvider(er.conn, kp))
    : erProgram(wallet, er.conn);

  const signature = await prog.methods
    .playCard(tick, deckIndex, x, y)
    .accounts({ log, player: (kp?.publicKey ?? wallet.publicKey)! } as any)
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

  const kp = sessionFor(matchId);
  const prog = kp
    ? new Program(rollupIdl as Idl, sessionProvider(er.conn, kp))
    : erProgram(wallet, er.conn);

  const signature = await prog.methods
    .checkpoint(tick, new BN(hash.toString()))
    .accounts({ log, player: (kp?.publicKey ?? wallet.publicKey)! } as any)
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
/**
 * Rollup. Seals the log so only the two seats can read it (PER).
 *
 * The simulation runs two ticks behind the input a player submits. That delay
 * is only safe while nobody can read the log faster than the sim consumes it —
 * otherwise an observer polling the rollup sees the opponent's card and
 * placement *before* it resolves on screen. With real SOL on the match that is
 * a cheat, not a leak.
 *
 * Idempotent onchain: sealing an already-sealed log returns success.
 */
export async function sealLogEr(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const signature = await erProgram(wallet, er.conn).methods
    .sealLog()
    .accounts({
      payer: wallet.publicKey!,
      log,
      permission: permissionPda(log),
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any)
    .rpc();
  return { signature };
}

/**
 * Rollup. Closes the seal, refunding its rent to the log.
 *
 * Must run before `endLogEr`: the permission is ER-local, so once the log is
 * undelegated nothing can reach it to close it and its rent stays behind.
 *
 * Not idempotent — once the permission is closed the account is gone and
 * transaction verification rejects it before the instruction runs. Callers
 * treat a failure here as non-fatal and continue to end the match; `end_log`
 * deliberately does not depend on the permission, so the worst case is a few
 * lamports stranded on a rollup that is about to forget them anyway.
 */
export async function unsealLogEr(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const signature = await erProgram(wallet, er.conn).methods
    .unsealLog()
    .accounts({
      payer: wallet.publicKey!,
      log,
      permission: permissionPda(log),
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any)
    .rpc();
  return { signature };
}

/* ── VRF chests ────────────────────────────────────────────────────────────
 *
 * The rail is a delegated account, so a roll costs nothing: MagicBlock prices
 * ER randomness at zero and base-layer randomness at 0.0008 SOL per request.
 * Everything below routes to the rollup for that reason.
 */

/** Delegated VRF queue. Only a queue that lives on the ER is writable from it. */
export const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');

export function chestsPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('chests'), owner.toBytes()],
    ROLLUP_PROGRAM_ID,
  )[0];
}

/** Base layer. Creates the rail, then hands it to a rollup. Idempotent. */
export async function ensureChestRail(adapter: Adapter | null): Promise<PublicKey> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const conn = getConnection();

  const existing = await conn.getAccountInfo(rail);
  if (!existing) {
    await baseProgram(wallet).methods
      .initChests()
      .accounts({ chests: rail, owner, systemProgram: SystemProgram.programId } as any)
      .rpc();
  }
  const status = await resolveEr(rail);
  if (!status) {
    await baseProgram(wallet).methods
      .delegateChests()
      .accounts({ owner, chests: rail, validator: IS_LOCALNET ? LOCALNET_VALIDATOR : null } as any)
      .rpc();
  }
  return rail;
}

/**
 * Rollup. Asks the oracle to roll one chest.
 *
 * Returns when the request is *accepted*, which is not an outcome — the oracle
 * fulfils it in a separate transaction. Callers must poll `readChestRail` and
 * show "opening" until the slot reports filled.
 */
export async function requestChestEr(
  adapter: Adapter | null, slotIndex: number, clientSeed: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const er = await resolveEr(rail);
  if (!er) throw new Error('chest rail is not delegated to a rollup');

  const signature = await erProgram(wallet, er.conn).methods
    .requestChest(slotIndex, clientSeed & 0xff)
    .accounts({
      payer: owner, chests: rail, owner, oracleQueue: EPHEMERAL_QUEUE,
    } as any)
    .rpc();
  return { signature };
}

/** Rollup. Takes a filled chest and frees its slot. */
export async function claimChestEr(
  adapter: Adapter | null, slotIndex: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const er = await resolveEr(rail);
  if (!er) throw new Error('chest rail is not delegated to a rollup');

  const signature = await erProgram(wallet, er.conn).methods
    .claimChest(slotIndex)
    .accounts({ chests: rail, owner } as any)
    .rpc();
  return { signature };
}

export interface ChestSlotChain {
  state: number; // 0 empty, 1 pending, 2 filled
  tier: number;
  nonce: bigint;
  randomness: Uint8Array;
}

/** Reads the rail from wherever it currently lives. */
export async function readChestRail(
  adapter: Adapter | null,
): Promise<{ slots: ChestSlotChain[]; pendingSlot: number } | null> {
  const wallet = requireSigner(adapter);
  const rail = chestsPda(wallet.publicKey!);
  const er = await resolveEr(rail);
  const conn = er ? er.conn : getConnection();
  try {
    const acc: any = await (erProgram(wallet, conn).account as any)
      .playerChests.fetch(rail);
    return {
      slots: acc.slots.map((s: any) => ({
        state: Number(s.state),
        tier: Number(s.tier),
        nonce: BigInt(s.nonce.toString()),
        randomness: Uint8Array.from(s.randomness),
      })),
      pendingSlot: Number(acc.pendingSlot),
    };
  } catch {
    return null;
  }
}

/**
 * Authorises a temporary signer for this match. One wallet popup, then none.
 *
 * Runs on the rollup, where the log lives — a session recorded on base layer
 * would not be readable by the validator that has to check it.
 */
export async function openSessionEr(
  adapter: Adapter | null, matchId: number,
): Promise<boolean> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) return false;
  return openSession(wallet, matchId, erProgram(wallet, er.conn), log);
}

/** Revokes it. Never throws — expiry is the backstop. */
export async function closeSessionEr(
  adapter: Adapter | null, matchId: number,
): Promise<void> {
  if (!canSign(adapter)) { forgetSession(); return; }
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) { forgetSession(); return; }
  await closeSession(adapter, erProgram(adapter, er.conn), log);
}

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
