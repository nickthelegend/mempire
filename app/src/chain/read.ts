import type { Idl, Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getConnection, getProgram } from './provider';
import { configPda } from './pdas';

/**
 * Reads. Everything here works without a wallet, because a visitor who has
 * connected nothing should still see the real registry rather than a mock.
 *
 * Anchor's generated account namespace is untyped without a codegen step, so
 * each fetch is narrowed into an explicit shape at this boundary. Nothing
 * downstream sees `any`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const accounts = (p: Program<Idl>) => p.account as any;

const num = (v: unknown): number => Number(v ?? 0);

export interface ChainConfig {
  address: string;
  admin: string;
  treasury: string;
  mintFeeSol: number;
  rakePct: number;
  tieRakePct: number;
  unstakeFeePct: number;
  unstakeCooldownSecs: number;
  matchTimeoutSecs: number;
  minAgeSecs: number;
  powerBand: number;
  nextCardId: number;
  nextMatchId: number;
}

export async function fetchConfig(): Promise<ChainConfig | null> {
  const program = getProgram();
  const pda = configPda();
  const raw = await accounts(program).config.fetchNullable(pda);
  if (!raw) return null;
  return {
    address: pda.toBase58(),
    admin: raw.admin.toBase58(),
    treasury: raw.treasury.toBase58(),
    mintFeeSol: num(raw.mintFeeLamports) / 1e9,
    rakePct: num(raw.rakeBps) / 100,
    tieRakePct: num(raw.tieRakeBps) / 100,
    unstakeFeePct: num(raw.unstakeFeeBps) / 100,
    unstakeCooldownSecs: num(raw.unstakeCooldownSecs),
    matchTimeoutSecs: num(raw.matchTimeoutSecs),
    minAgeSecs: num(raw.minAgeSecs),
    powerBand: num(raw.powerBand),
    nextCardId: num(raw.nextCardId),
    nextMatchId: num(raw.nextMatchId),
  };
}

export interface ChainCoin {
  mint: string;
  liquidityUsd: number;
  priceUsd: number;
  firstSeenTs: number;
  decimals: number;
}

export async function fetchRegisteredCoins(): Promise<ChainCoin[]> {
  const program = getProgram();
  const all = await accounts(program).coinInfo.all();
  return all.map((c: any) => ({
    mint: c.account.mint.toBase58(),
    liquidityUsd: num(c.account.liquidityUsd),
    priceUsd: num(c.account.priceMicroUsd) / 1e6,
    firstSeenTs: num(c.account.firstSeenTs),
    decimals: num(c.account.decimals),
  }));
}

export interface ChainCard {
  address: string;
  id: number;
  owner: string;
  mint: string;
  archetype: number;
  stakedTokens: number;
  stakedUsd: number;
  level: number;
  pendingUnstakeTokens: number;
  unstakeReadyAt: number;
  /** True while the card is locked into a match. */
  inMatch: boolean;
  /** The match holding the lock, or null when free. */
  lockedBy: string | null;
}

function toCard(address: PublicKey, a: any): ChainCard {
  return {
    address: address.toBase58(),
    id: num(a.id),
    owner: a.owner.toBase58(),
    mint: a.coinMint.toBase58(),
    archetype: num(a.archetype),
    stakedTokens: num(a.stakedTokens),
    stakedUsd: num(a.stakedMicroUsd) / 1e6,
    level: num(a.level),
    pendingUnstakeTokens: num(a.pendingUnstakeTokens),
    unstakeReadyAt: num(a.unstakeReadyAt),
    // The chain replaced the `in_match` flag with the key of the match that
    // holds the lock, so settlement can refuse to free a card belonging to
    // some other, still-running match. `inMatch` stays in this shape because
    // every screen only ever asked the yes/no question.
    inMatch: !!a.lockedBy && !a.lockedBy.equals(PublicKey.default),
    lockedBy:
      a.lockedBy && !a.lockedBy.equals(PublicKey.default)
        ? a.lockedBy.toBase58()
        : null,
  };
}

/**
 * Cards owned by one wallet.
 *
 * Filtered server-side by a memcmp on the `owner` field rather than fetching
 * every card and filtering locally — the discriminator is 8 bytes and `id` is a
 * u64, so `owner` starts at byte 16.
 */
const CARD_OWNER_OFFSET = 8 + 8;

export async function fetchCardsFor(owner: string): Promise<ChainCard[]> {
  const program = getProgram();
  const all = await accounts(program).card.all([
    { memcmp: { offset: CARD_OWNER_OFFSET, bytes: owner } },
  ]);
  return all
    .map((c: any) => toCard(c.publicKey, c.account))
    .sort((a: ChainCard, b: ChainCard) => a.id - b.id);
}

export interface ChainMatch {
  address: string;
  id: number;
  tier: number;
  stakeSol: number;
  players: [string, string];
  state: number;
  createdAt: number;
  deadline: number;
  winner: number;
  finalHash: string;
}

function toMatch(address: PublicKey, a: any): ChainMatch {
  return {
    address: address.toBase58(),
    id: num(a.id),
    tier: num(a.tier),
    stakeSol: num(a.stakeLamports) / 1e9,
    players: [a.players[0].toBase58(), a.players[1].toBase58()],
    state: num(a.state),
    createdAt: num(a.createdAt),
    deadline: num(a.deadline),
    winner: num(a.winner),
    finalHash: String(a.finalHash ?? '0'),
  };
}

export async function fetchMatch(address: string): Promise<ChainMatch | null> {
  const program = getProgram();
  const pk = new PublicKey(address);
  const raw = await accounts(program).matchAccount.fetchNullable(pk);
  return raw ? toMatch(pk, raw) : null;
}

/** Matches awaiting a second player — the real matchmaking pool. */
const MATCH_STATE_OPEN = 0;

export async function fetchOpenMatches(): Promise<ChainMatch[]> {
  const program = getProgram();
  const all = await accounts(program).matchAccount.all();
  return all
    .map((m: any) => toMatch(m.publicKey, m.account))
    .filter((m: ChainMatch) => m.state === MATCH_STATE_OPEN)
    .sort((a: ChainMatch, b: ChainMatch) => b.createdAt - a.createdAt);
}

export async function fetchSolBalance(owner: string): Promise<number> {
  const lamports = await getConnection().getBalance(new PublicKey(owner));
  return lamports / 1e9;
}

/**
 * Real SPL balances for one wallet, keyed by mint.
 *
 * This is what makes "your bags are your army" literal: the coins a player can
 * mint cards from are the coins this call reports, not a fixture.
 */
export async function fetchTokenBalances(owner: string): Promise<Map<string, number>> {
  const res = await getConnection().getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { programId: TOKEN_PROGRAM_ID },
  );
  const out = new Map<string, number>();
  for (const { account } of res.value) {
    const info = (account.data as any).parsed?.info;
    if (!info) continue;
    const amount = Number(info.tokenAmount?.uiAmount ?? 0);
    if (amount > 0) out.set(info.mint as string, amount);
  }
  return out;
}
