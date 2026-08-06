import { BN } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { canSign, getProgram } from './provider';
import {
  PROGRAM_ID, cardPda, coinPda, configPda, matchPda, vaultAuthorityPda,
} from './pdas';
import { fetchConfig } from './read';

/**
 * Writes. Every one of these submits a real transaction and returns its
 * signature, so the UI can link to the explorer and the player can verify the
 * claim themselves.
 *
 * All of them refuse early when the wallet cannot sign. Guest mode has an
 * address but no keypair, and failing here with a sentence beats failing deep in
 * an adapter with a stack trace.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class NoSignerError extends Error {
  constructor() { super('This wallet cannot sign — connect a real wallet to go onchain.'); }
}

function requireSigner(adapter: Adapter | null): Adapter {
  if (!canSign(adapter) || !adapter?.publicKey) throw new NoSignerError();
  return adapter;
}

/**
 * Anchor error codes carry the program's own message, which is already written
 * for a human ("coin is younger than the minimum age"). Surface that rather than
 * a simulation dump; fall back to the raw text when it is something else.
 */
export function readableChainError(e: unknown): string {
  const anyErr = e as any;
  const fromAnchor = anyErr?.error?.errorMessage
    ?? anyErr?.error?.errorCode?.code
    ?? anyErr?.errorMessage;
  if (typeof fromAnchor === 'string' && fromAnchor) return fromAnchor;

  const msg = String(anyErr?.message ?? e ?? 'transaction failed');
  if (/user rejected|rejected the request|declined/i.test(msg)) return 'You rejected the transaction';
  if (/insufficient (lamports|funds)|0x1 /i.test(msg)) return 'Not enough SOL for this transaction';
  if (/blockhash|timed out|429|Too many requests/i.test(msg)) return 'Network is busy — try again';
  // Anchor writes the real cause into the simulation logs
  const logs: string[] = anyErr?.logs ?? [];
  const hit = logs.find((l) => l.includes('Error Message:'));
  if (hit) return hit.split('Error Message:')[1].trim();
  return msg.slice(0, 120);
}

export interface TxResult { signature: string }

/**
 * Mint a card from a coin the wallet holds.
 *
 * The program re-checks liquidity, age and a non-zero balance, so this cannot
 * be talked into minting an ineligible coin by a patched client.
 */
export async function mintCardTx(adapter: Adapter | null, mint: string): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const owner = wallet.publicKey!;
  const mintKey = new PublicKey(mint);

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .mintCard()
    .accounts({
      config: configPda(),
      coinInfo: coinPda(mintKey),
      card: cardPda(cfg.nextCardId),
      ownerTokens: getAssociatedTokenAddressSync(mintKey, owner),
      owner,
      treasury: new PublicKey(cfg.treasury),
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { signature };
}

/** Stake raw token units into a card's vault. Level snapshots at the oracle price. */
export async function stakeTx(
  adapter: Adapter | null, cardId: number, mint: string, rawAmount: bigint,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const owner = wallet.publicKey!;
  const mintKey = new PublicKey(mint);
  const vaultAuthority = vaultAuthorityPda(cardId);

  const signature = await program.methods
    .stake(new BN(rawAmount.toString()))
    .accounts({
      coinInfo: coinPda(mintKey),
      card: cardPda(cardId),
      vaultAuthority,
      // owned by the PDA, created on first stake by init_if_needed
      vault: getAssociatedTokenAddressSync(mintKey, vaultAuthority, true),
      mint: mintKey,
      ownerTokens: getAssociatedTokenAddressSync(mintKey, owner),
      owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { signature };
}

/** Step one of two. Starts the cooldown; nothing moves yet. */
export async function requestUnstakeTx(
  adapter: Adapter | null, cardId: number, rawAmount: bigint,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const signature = await program.methods
    .requestUnstake(new BN(rawAmount.toString()))
    .accounts({
      config: configPda(),
      card: cardPda(cardId),
      owner: wallet.publicKey!,
    } as any)
    .rpc();
  return { signature };
}

/** Step two. Only lands once the cooldown has elapsed; the fee goes to treasury. */
export async function claimUnstakeTx(
  adapter: Adapter | null, cardId: number, mint: string,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const owner = wallet.publicKey!;
  const mintKey = new PublicKey(mint);
  const vaultAuthority = vaultAuthorityPda(cardId);

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .claimUnstake()
    .accounts({
      config: configPda(),
      card: cardPda(cardId),
      vaultAuthority,
      vault: getAssociatedTokenAddressSync(mintKey, vaultAuthority, true),
      ownerTokens: getAssociatedTokenAddressSync(mintKey, owner),
      treasuryTokens: getAssociatedTokenAddressSync(mintKey, new PublicKey(cfg.treasury)),
      owner,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
  return { signature };
}

/**
 * Open a match and escrow the stake.
 *
 * The eight deck cards ride in `remaining_accounts`; the program validates
 * ownership, one-card-per-coin and the power band, then locks them. Order is the
 * deck order, which is what `deckHash` commits to.
 */
export async function createMatchTx(
  adapter: Adapter | null,
  tier: number,
  stakeSol: number,
  deckCardIds: number[],
  deckHash: Uint8Array,
): Promise<TxResult & { matchId: number; matchAddress: string }> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');
  const matchId = cfg.nextMatchId;
  const matchAccount = matchPda(matchId);

  const signature = await program.methods
    .createMatch(tier, new BN(Math.round(stakeSol * 1e9)), Array.from(deckHash))
    .accounts({
      config: configPda(),
      matchAccount,
      player: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();

  return { signature, matchId, matchAddress: matchAccount.toBase58() };
}

/** Join an open match at the same stake. Same deck validation, plus the bracket. */
export async function joinMatchTx(
  adapter: Adapter | null,
  matchId: number,
  deckCardIds: number[],
  deckHash: Uint8Array,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);

  const signature = await program.methods
    .joinMatch(Array.from(deckHash))
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      player: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/**
 * Settle with both signatures.
 *
 * This is the honest constraint in the current design: settlement needs *both*
 * players to sign the same final state hash, so it cannot be driven from one
 * client alone. `claimTimeoutTx` is the escape hatch when an opponent vanishes.
 */
export async function settleTx(
  adapter: Adapter | null,
  matchId: number,
  playerB: string,
  finalHash: bigint,
  winner: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .settle(new BN(finalHash.toString()), winner)
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      playerA: wallet.publicKey!,
      playerB: new PublicKey(playerB),
      treasury: new PublicKey(cfg.treasury),
    } as any)
    .rpc();
  return { signature };
}

/** Claim a stalled match's pot after the deadline. One signature, by design. */
export async function claimTimeoutTx(
  adapter: Adapter | null, matchId: number, winnerAccount: string,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .claimTimeout()
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      claimer: wallet.publicKey!,
      winnerAccount: new PublicKey(winnerAccount),
      treasury: new PublicKey(cfg.treasury),
    } as any)
    .rpc();
  return { signature };
}

/** The base program's own match-log PDA — the one `settle_from_log` reads. */
export function baseLogPda(matchId: number): PublicKey {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(matchId), true);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('log'), b], PROGRAM_ID,
  )[0];
}

/** Read a match account, or null if it does not exist yet. */
export async function readMatch(matchId: number): Promise<{
  id: number; state: number; players: string[]; stakeLamports: number;
  winner: number; deadline: number;
} | null> {
  const program = getProgram(null);
  try {
    const m = await (program.account as any).matchAccount.fetch(matchPda(matchId));
    return {
      id: Number(m.id),
      state: Number(m.state),
      players: (m.players as PublicKey[]).map((p) => p.toBase58()),
      stakeLamports: Number(m.stakeLamports),
      winner: Number(m.winner),
      deadline: Number(m.deadline),
    };
  } catch {
    return null;
  }
}

/**
 * Withdraw a match nobody joined. Refunds the stake and releases the deck.
 *
 * The counterpart to `createMatchTx`: if the opponent's join never lands —
 * they closed the tab, their wallet refused, their RPC was down — the creator
 * is otherwise left with a stake in a match that will never start and eight
 * cards locked behind it.
 */
export async function cancelMatchTx(
  adapter: Adapter | null, matchId: number, deckCardIds: number[],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const signature = await program.methods
    .cancelMatch()
    .accounts({
      matchAccount: matchPda(matchId),
      player: wallet.publicKey!,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/**
 * Pay the pot from the committed log. One signature, either player.
 *
 * This is what makes the stake real without needing both wallets awake at the
 * same instant: each seat records its own result with `endMatchLogEr`, and
 * whichever of them gets here first triggers the payout. The program refuses
 * unless both claims are present and agree, so calling it early is a no-op
 * rather than a way to take the pot.
 *
 * The eight-plus-eight deck accounts ride along so settlement releases both
 * decks in the same transaction that moves the money.
 */
export async function settleFromLogTx(
  adapter: Adapter | null,
  matchId: number,
  players: [string, string],
  deckCardIds: number[],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(wallet);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .settleFromLog()
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      matchLog: baseLogPda(matchId),
      settler: wallet.publicKey!,
      playerA: new PublicKey(players[0]),
      playerB: new PublicKey(players[1]),
      treasury: new PublicKey(cfg.treasury),
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}
