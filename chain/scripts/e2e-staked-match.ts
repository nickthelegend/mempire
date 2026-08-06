/**
 * A staked match, settled from the log, with two real wallets and a real pot.
 *
 * This is the test the suite was missing. `e2e-magicblock.ts` creates a match
 * but never joins it — the second wallet has no cards — so it exercises the
 * rollup against an `Open` match and never once moves a pot. Everything about
 * the money path was therefore unproven: whether two stakes actually escrow,
 * whether both seats can record a claim, whether `settle_from_log` pays, and
 * whether the winner ends up richer than they started.
 *
 * It also catches the defect that made all of that impossible: `end_match_log`
 * used to commit-and-undelegate on the *first* claim, so the log left the
 * rollup before the second seat could speak and the agreement `settle_from_log`
 * requires could never be assembled.
 *
 * Run: npx tsx scripts/e2e-staked-match.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const ROUTER = process.env.ROUTER_RPC ?? 'https://devnet-router.magicblock.app/';
const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number | bigint) => new anchor.BN(n.toString()).toArrayLike(Buffer, 'le', 8);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function routerStatus(account: PublicKey): Promise<any | null> {
  try {
    const res = await fetch(ROUTER, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()],
      }),
    });
    const body: any = await res.json();
    return body?.error ? null : body?.result ?? null;
  } catch { return null; }
}

async function main() {
  const conn = new Connection(BASE, { commitment: 'confirmed' });
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim()
    ?? join(homedir(), '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const program = new anchor.Program(idl, provider);
  const pid = program.programId;
  const accounts: any = program.account;

  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
  const matchPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('match'), u64le(id)], pid)[0];
  const logPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('log'), u64le(id)], pid)[0];
  const cardPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('card'), u64le(id)], pid)[0];

  console.log('a staked match, end to end, with a pot that actually moves\n');

  // ── 0. two funded wallets ────────────────────────────────────────────────
  // A persistent second wallet: minting eight cards costs SOL and rent, and
  // burning that on a fresh keypair every run would drain the faucet for no
  // reason. Derived from the admin key so it is stable across runs.
  const seed = new Uint8Array(32);
  Buffer.from('mempire-e2e-opponent-v1').copy(Buffer.from(seed.buffer));
  const bob = Keypair.fromSeed(seed);
  console.log(`  seat A ${admin.publicKey.toBase58().slice(0, 8)}…  seat B ${bob.publicKey.toBase58().slice(0, 8)}…`);

  const bobBal = await conn.getBalance(bob.publicKey);
  if (bobBal < 0.35 * LAMPORTS_PER_SOL) {
    const need = Math.ceil(0.5 * LAMPORTS_PER_SOL - bobBal);
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: bob.publicKey, lamports: need,
    })));
    console.log(`  funded seat B with ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  }
  const bobProvider = new anchor.AnchorProvider(conn, new anchor.Wallet(bob), { commitment: 'confirmed' });
  const bobProgram = new anchor.Program(idl, bobProvider);

  const cfg: any = await accounts.config.fetch(configPda);

  // ── 1. eight cards each ──────────────────────────────────────────────────
  console.log('\n1. both seats hold eight unlocked cards, one coin each');

  // Release anything an interrupted earlier run left locked. A match that got
  // as far as `create_match` and then died holds eight cards until it settles,
  // and this suite would otherwise slowly starve itself of decks.
  {
    const matches: any[] = await accounts.matchAccount.all();
    const mine = matches.filter((x) => x.account.state === 0
      && x.account.players[0].equals(admin.publicKey));
    for (const stale of mine) {
      const held: any[] = (await accounts.card.all())
        .filter((c: any) => c.account.lockedBy.equals(stale.publicKey));
      try {
        await (program.methods as any).cancelMatch()
          .accounts({ matchAccount: stale.publicKey, player: admin.publicKey })
          .remainingAccounts(held.map((c) => ({
            pubkey: c.publicKey, isWritable: true, isSigner: false,
          }))).rpc();
        console.log(`  released a stranded Open match (#${stale.account.id})`);
      } catch { /* not ours to cancel */ }
    }
  }

  async function deckFor(owner: PublicKey): Promise<number[]> {
    const all: any[] = await accounts.card.all();
    const seenMint = new Set<string>();
    const owned = all
      .filter((c) => c.account.owner.equals(owner)
        && c.account.lockedBy.equals(PublicKey.default))
      .filter((c) => {
        const m = c.account.coinMint.toBase58();
        if (seenMint.has(m)) return false;
        seenMint.add(m);
        return true;
      });
    return owned.slice(0, 8).map((c) => Number(c.account.id));
  }

  /**
   * Mint cards for `who` until they hold eight *distinct, unlocked* coins.
   *
   * Skips any coin they already have a card for, locked or not: a second card
   * for the same mint does not help, because the program refuses a deck with a
   * repeated coin and `deckFor` dedupes accordingly. Runs against whichever of
   * the 80-odd registered coins the wallet can be given a token of.
   */
  async function ensureDeck(
    who: Keypair, prog: anchor.Program, label: string,
  ): Promise<number[]> {
    let ids = await deckFor(who.publicKey);
    if (ids.length >= 8) { console.log(`  ${label} already has ${ids.length}`); return ids.slice(0, 8); }

    const all: any[] = await accounts.card.all();
    const carded = new Set(
      all.filter((c) => c.account.owner.equals(who.publicKey))
        .map((c) => c.account.coinMint.toBase58()),
    );

    const coins: any[] = await accounts.coinInfo.all();
    let minted = 0;
    for (const ci of coins) {
      if (ids.length + minted >= 8) break;
      const mint: PublicKey = ci.account.mint;
      if (carded.has(mint.toBase58())) continue;

      // The wallet must hold the coin to mint its card. Seat B holds nothing,
      // so seat A — which seeded every coin — sends it one token.
      const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey);
      const theirAta = getAssociatedTokenAddressSync(mint, who.publicKey);
      const adminBal = await conn.getTokenAccountBalance(adminAta).catch(() => null);
      if (!adminBal || Number(adminBal.value.amount) < 2) continue;

      if (!who.publicKey.equals(admin.publicKey)) {
        const theirBal = await conn.getTokenAccountBalance(theirAta).catch(() => null);
        if (!theirBal || Number(theirBal.value.amount) === 0) {
          try {
            await provider.sendAndConfirm(new Transaction()
              .add(createAssociatedTokenAccountIdempotentInstruction(
                admin.publicKey, theirAta, who.publicKey, mint))
              .add(createTransferInstruction(adminAta, theirAta, admin.publicKey, 1)));
          } catch { continue; }
        }
      }

      try {
        const cfgNow: any = await accounts.config.fetch(configPda);
        const id = Number(cfgNow.nextCardId);
        await (prog.methods as any).mintCard().accounts({
          config: configPda,
          coinInfo: ci.publicKey,
          card: cardPda(id),
          ownerTokens: theirAta,
          owner: who.publicKey,
          treasury: cfgNow.treasury,
          systemProgram: SystemProgram.programId,
        }).rpc();
        carded.add(mint.toBase58());
        minted += 1;
      } catch { /* coin too young or too illiquid — next */ }
    }
    if (minted) console.log(`  ${label}: minted ${minted} more`);
    ids = await deckFor(who.publicKey);
    return ids.slice(0, 8);
  }

  /**
   * `ensureDeck` mints against a snapshot, and individual mints fail for
   * reasons only the chain knows (a coin below the liquidity floor, a token
   * account that turned out empty). Re-running it converges rather than
   * assuming one pass is enough.
   */
  async function ensureDeckRetrying(
    who: Keypair, prog: anchor.Program, label: string,
  ): Promise<number[]> {
    let ids: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ids = await ensureDeck(who, prog, label);
      if (ids.length >= 8) break;
    }
    return ids;
  }

  const deckA = await ensureDeckRetrying(admin, program, 'seat A');
  const deckB = await ensureDeckRetrying(bob, bobProgram, 'seat B');
  check('seat A has a legal deck', deckA.length === 8, `${deckA.length} cards`);
  check('seat B has a legal deck', deckB.length === 8, `${deckB.length} cards`);
  if (deckA.length < 8 || deckB.length < 8) {
    console.log('\ncannot run a staked match without two decks');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }

  const metasA = deckA.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false }));
  const metasB = deckB.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false }));

  // ── 2. create + join: two stakes escrow ──────────────────────────────────
  console.log('\n2. create_match + join_match — both stakes escrow into the match account');
  const cfgNow: any = await accounts.config.fetch(configPda);
  const matchId = Number(cfgNow.nextMatchId);
  const match = matchPda(matchId);
  const stake = Math.round(0.02 * LAMPORTS_PER_SOL);
  const zeroHash = Array(32).fill(0);

  const aBefore = await conn.getBalance(admin.publicKey);
  const bBefore = await conn.getBalance(bob.publicKey);

  await (program.methods as any).createMatch(0, new anchor.BN(stake), zeroHash)
    .accounts({
      config: configPda, matchAccount: match,
      player: admin.publicKey, systemProgram: SystemProgram.programId,
    }).remainingAccounts(metasA).rpc();

  const lockedA: any = await accounts.card.fetch(cardPda(deckA[0]));
  check('seat A\'s deck is locked to this match', lockedA.lockedBy.equals(match));

  await (bobProgram.methods as any).joinMatch(zeroHash)
    .accounts({
      config: configPda, matchAccount: match,
      player: bob.publicKey, systemProgram: SystemProgram.programId,
    }).remainingAccounts(metasB).rpc();

  const m: any = await accounts.matchAccount.fetch(match);
  check('match is Active with two players', m.state === 1,
    `state=${m.state} players=${m.players.length}`);

  const potHeld = await conn.getBalance(match);
  const rent = await conn.getMinimumBalanceForRentExemption(m ? 8 + 8 + 1 + 8 + 64 + 64 + 8 + 1 + 8 + 8 + 1 + 8 + 1 : 0);
  check('the match account holds both stakes', potHeld >= stake * 2,
    `${(potHeld / LAMPORTS_PER_SOL).toFixed(4)} SOL held (2 × ${(stake / LAMPORTS_PER_SOL).toFixed(3)} + rent ${(rent / LAMPORTS_PER_SOL).toFixed(4)})`);

  const aAfterEscrow = await conn.getBalance(admin.publicKey);
  const bAfterEscrow = await conn.getBalance(bob.publicKey);
  check('seat A actually paid the stake', aBefore - aAfterEscrow >= stake,
    `-${((aBefore - aAfterEscrow) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  check('seat B actually paid the stake', bBefore - bAfterEscrow >= stake,
    `-${((bBefore - bAfterEscrow) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // ── 3. the log, on a rollup ──────────────────────────────────────────────
  console.log('\n3. init + delegate the match log');
  const log = logPda(matchId);
  await (program.methods as any).initMatchLog(new anchor.BN(matchId))
    .accounts({
      matchAccount: match, matchLog: log,
      payer: admin.publicKey, systemProgram: SystemProgram.programId,
    }).rpc();
  await (program.methods as any).delegateMatchLog(new anchor.BN(matchId))
    .accounts({ payer: admin.publicKey, matchLog: log, validator: null }).rpc();
  await sleep(3500);

  const st = await routerStatus(log);
  check('the log is delegated to a rollup', st?.isDelegated === true, st?.fqdn ?? 'no fqdn');
  const erUrl: string = st?.fqdn ?? 'https://devnet-as.magicblock.app/';
  const erConn = new Connection(erUrl, { commitment: 'confirmed' });
  const erA = new anchor.Program(idl,
    new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' }));
  const erB = new anchor.Program(idl,
    new anchor.AnchorProvider(erConn, new anchor.Wallet(bob), { commitment: 'confirmed' }));

  // ── 4. both seats play ───────────────────────────────────────────────────
  console.log('\n4. both seats write plays to the rollup');
  await (erA.methods as any).playCard(10, 0, 512, 1024)
    .accounts({ payer: admin.publicKey, matchLog: log }).rpc();
  await (erB.methods as any).playCard(14, 3, -512, -1024)
    .accounts({ payer: bob.publicKey, matchLog: log }).rpc();
  const played: any = await (erA.account as any).matchLog.fetch(log);
  check('both plays are in the log', played.plays.length >= 2, `${played.plays.length} plays`);

  // ── 5. each seat records its claim ───────────────────────────────────────
  console.log('\n5. each seat records the same result — the log must survive the first claim');
  const finalHash = new anchor.BN('123456789');

  await (erA.methods as any).endMatchLog(0, finalHash)
    .accounts({
      payer: admin.publicKey, matchLog: log,
      magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    }).rpc();

  // The regression this suite exists for: one claim used to undelegate the
  // log, which stranded the second seat and made settlement unreachable.
  const afterFirst = await conn.getAccountInfo(log);
  const stillDelegated = afterFirst?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
  check('the log stays on the rollup after ONE claim',
    stillDelegated,
    stillDelegated ? 'seat B can still speak' : 'undelegated early — seat B is locked out');

  let bothClaimed = false;
  try {
    await (erB.methods as any).endMatchLog(0, finalHash)
      .accounts({
        payer: bob.publicKey, matchLog: log,
        magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      }).rpc();
    bothClaimed = true;
  } catch (e: any) {
    check('seat B can record its claim', false, String(e?.message ?? e).slice(0, 120));
  }
  if (bothClaimed) check('seat B can record its claim', true, 'both seats agree seat A won');

  // ── 6. the log comes home ────────────────────────────────────────────────
  console.log('\n6. agreement commits the log back to base layer');
  let home = false;
  for (let i = 0; i < 45; i += 1) {
    await sleep(1500);
    const info = await conn.getAccountInfo(log);
    if (info && info.owner.equals(pid)) { home = true; break; }
  }
  check('the log is back on base layer, owned by the program', home);

  if (home) {
    const committed: any = await accounts.matchLog.fetch(log);
    check('both claims committed and agree',
      committed.claims[0] === 0 && committed.claims[1] === 0,
      `claims=[${committed.claims[0]}, ${committed.claims[1]}]`);
  }

  // ── 7. settle from the log: the pot moves ────────────────────────────────
  console.log('\n7. settle_from_log — one signature, and the pot actually moves');
  const aPre = await conn.getBalance(admin.publicKey);
  const treasuryPre = await conn.getBalance(new PublicKey(cfg.treasury));

  let settled = false;
  try {
    await (bobProgram.methods as any).settleFromLog()
      .accounts({
        config: configPda, matchAccount: match, matchLog: log,
        settler: bob.publicKey,
        playerA: admin.publicKey, playerB: bob.publicKey,
        treasury: cfg.treasury,
      }).remainingAccounts([...metasA, ...metasB]).rpc();
    settled = true;
  } catch (e: any) {
    check('settle_from_log paid out', false, String(e?.message ?? e).slice(0, 160));
  }

  if (settled) {
    const aPost = await conn.getBalance(admin.publicKey);
    const treasuryPost = await conn.getBalance(new PublicKey(cfg.treasury));
    const pot = stake * 2;
    const rakeBps = Number(cfg.rakeBps);
    const expectedRake = Math.floor((pot * rakeBps) / 10_000);
    const expectedPayout = pot - expectedRake;

    // The treasury is a dedicated address now, so the split is observable
    // rather than asserted. It used to be the admin wallet — the same account
    // as the winner — which meant rake and payout landed together and no test
    // could tell whether the rake had been taken at all.
    const credited = aPost - aPre;
    const rakeTaken = treasuryPost - treasuryPre;

    // Settled by seat B, so seat A paid no transaction fee — its whole delta
    // is what the program sent it.
    check('the winner received pot minus rake, exactly',
      credited === expectedPayout,
      `+${(credited / LAMPORTS_PER_SOL).toFixed(6)} SOL, expected ${(expectedPayout / LAMPORTS_PER_SOL).toFixed(6)}`);

    check('the treasury received the rake, exactly',
      rakeTaken === expectedRake,
      `+${(rakeTaken / LAMPORTS_PER_SOL).toFixed(6)} SOL at ${rakeBps}bps, expected ${(expectedRake / LAMPORTS_PER_SOL).toFixed(6)}`);

    check('rake + payout is the whole pot — nothing minted, nothing lost',
      rakeTaken + credited === pot,
      `${(rakeTaken / LAMPORTS_PER_SOL).toFixed(6)} + ${(credited / LAMPORTS_PER_SOL).toFixed(6)} = ${(pot / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

    check('the treasury is not the winner — the split is measurable',
      !new PublicKey(cfg.treasury).equals(admin.publicKey),
      new PublicKey(cfg.treasury).toBase58().slice(0, 12) + '…');

    const settledMatch: any = await accounts.matchAccount.fetch(match);
    check('the match is marked Settled', settledMatch.state === 2, `state=${settledMatch.state}`);
    check('the winner is recorded', settledMatch.winner === 0, `winner=${settledMatch.winner}`);

    const freedA: any = await accounts.card.fetch(cardPda(deckA[0]));
    const freedB: any = await accounts.card.fetch(cardPda(deckB[0]));
    check('settlement released BOTH decks',
      freedA.lockedBy.equals(PublicKey.default) && freedB.lockedBy.equals(PublicKey.default));

    const potLeft = await conn.getBalance(match);
    check('the match account no longer holds the pot', potLeft < stake,
      `${(potLeft / LAMPORTS_PER_SOL).toFixed(6)} SOL left (rent)`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
