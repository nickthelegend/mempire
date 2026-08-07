/**
 * Game integrity: what a cheating client can actually take.
 *
 * The other suites ask whether an honest match works. This one asks what
 * happens when a seat lies — which is the only question that matters once
 * there is money in the pot.
 *
 * The scenario is the one a modified client would run: play the match, then
 * report the opposite winner. Both seats claim, the claims disagree, and the
 * program cannot tell which is lying. What it does next is the whole test.
 *
 * Run against devnet. Costs about 0.05 SOL per run, most of it returned by
 * whichever settlement path fires.
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const ROUTER = 'https://devnet-router.magicblock.app/';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

async function routerStatus(account: PublicKey): Promise<any | null> {
  try {
    const r = await fetch(ROUTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()],
      }),
    });
    return (await r.json())?.result ?? null;
  } catch { return null; }
}

async function main() {
  const conn = new Connection(BASE, { commitment: 'confirmed' });
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim()
    ?? join(homedir(), '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const program = new anchor.Program(idl, provider);
  const pid = program.programId;
  const accounts: any = program.account;

  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
  const matchPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('match'), u64le(id)], pid)[0];
  const logPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('log'), u64le(id)], pid)[0];
  const cardPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('card'), u64le(id)], pid)[0];

  console.log('game integrity — what a lying client can take\n');

  // Same persistent opponent the staked-match suite uses, so the two share a
  // deck rather than each minting sixteen cards' worth of rent.
  const seed = new Uint8Array(32);
  Buffer.from('mempire-e2e-opponent-v1').copy(Buffer.from(seed.buffer));
  const bob = Keypair.fromSeed(seed);
  const bobProvider = new anchor.AnchorProvider(conn, new anchor.Wallet(bob), { commitment: 'confirmed' });
  const bobProgram = new anchor.Program(idl, bobProvider);
  console.log(`  seat A ${admin.publicKey.toBase58().slice(0, 8)}…  seat B ${bob.publicKey.toBase58().slice(0, 8)}…`);

  const bobBal = await conn.getBalance(bob.publicKey);
  if (bobBal < 0.1 * LAMPORTS_PER_SOL) {
    const need = Math.ceil(0.15 * LAMPORTS_PER_SOL - bobBal);
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: bob.publicKey, lamports: need,
    })));
    console.log(`  funded seat B with ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  }

  const cfg: any = await accounts.config.fetch(configPda);

  // ── decks ────────────────────────────────────────────────────────────────
  // Anything an interrupted run left Open still holds eight cards. Release it
  // or this suite slowly starves itself of legal decks.
  {
    const matches: any[] = await accounts.matchAccount.all();
    for (const stale of matches.filter((x) => x.account.state === 0
      && x.account.players[0].equals(admin.publicKey))) {
      const held: any[] = (await accounts.card.all())
        .filter((c: any) => c.account.lockedBy.equals(stale.publicKey));
      try {
        await (program.methods as any).cancelMatch()
          .accounts({ matchAccount: stale.publicKey, player: admin.publicKey })
          .remainingAccounts(held.map((c) => ({ pubkey: c.publicKey, isWritable: true, isSigner: false })))
          .rpc();
        console.log(`  released a stranded Open match (#${stale.account.id})`);
      } catch { /* not ours */ }
    }
  }

  async function deckFor(owner: PublicKey): Promise<number[]> {
    const all: any[] = await accounts.card.all();
    const seen = new Set<string>();
    return all
      .filter((c) => c.account.owner.equals(owner) && c.account.lockedBy.equals(PublicKey.default))
      .filter((c) => {
        const m = c.account.coinMint.toBase58();
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      })
      .slice(0, 8)
      .map((c) => Number(c.account.id));
  }

  async function ensureDeck(who: Keypair, prog: anchor.Program, label: string): Promise<number[]> {
    let ids = await deckFor(who.publicKey);
    if (ids.length >= 8) return ids.slice(0, 8);

    const all: any[] = await accounts.card.all();
    const carded = new Set(all.filter((c) => c.account.owner.equals(who.publicKey))
      .map((c) => c.account.coinMint.toBase58()));
    const coins: any[] = await accounts.coinInfo.all();
    let minted = 0;
    for (const ci of coins) {
      if (ids.length + minted >= 8) break;
      const mint: PublicKey = ci.account.mint;
      if (carded.has(mint.toBase58())) continue;
      const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey);
      const theirAta = getAssociatedTokenAddressSync(mint, who.publicKey);
      const adminBal = await conn.getTokenAccountBalance(adminAta).catch(() => null);
      if (!adminBal || Number(adminBal.value.amount) < 2) continue;
      if (!who.publicKey.equals(admin.publicKey)) {
        const theirBal = await conn.getTokenAccountBalance(theirAta).catch(() => null);
        if (!theirBal || Number(theirBal.value.amount) === 0) {
          try {
            await provider.sendAndConfirm(new Transaction()
              .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, theirAta, who.publicKey, mint))
              .add(createTransferInstruction(adminAta, theirAta, admin.publicKey, 1)));
          } catch { continue; }
        }
      }
      try {
        const cfgNow: any = await accounts.config.fetch(configPda);
        await (prog.methods as any).mintCard().accounts({
          config: configPda, coinInfo: ci.publicKey, card: cardPda(Number(cfgNow.nextCardId)),
          ownerTokens: theirAta, owner: who.publicKey, treasury: cfgNow.treasury,
          systemProgram: SystemProgram.programId,
        }).rpc();
        carded.add(mint.toBase58());
        minted += 1;
      } catch { /* coin too young or too illiquid */ }
    }
    if (minted) console.log(`  ${label}: minted ${minted} more`);
    return (await deckFor(who.publicKey)).slice(0, 8);
  }

  let deckA: number[] = [];
  let deckB: number[] = [];
  for (let i = 0; i < 3 && (deckA.length < 8 || deckB.length < 8); i += 1) {
    deckA = await ensureDeck(admin, program, 'seat A');
    deckB = await ensureDeck(bob, bobProgram, 'seat B');
  }
  if (!check('both seats hold a legal deck', deckA.length === 8 && deckB.length === 8,
    `A=${deckA.length} B=${deckB.length}`)) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }
  const metasA = deckA.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false }));
  const metasB = deckB.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false }));

  // ── a staked match, played to the end ────────────────────────────────────
  console.log('\n1. a real staked match, both seats in');
  const cfgNow: any = await accounts.config.fetch(configPda);
  const matchId = Number(cfgNow.nextMatchId);
  const match = matchPda(matchId);
  const log = logPda(matchId);
  const stake = Math.round(0.01 * LAMPORTS_PER_SOL);
  const zero = Array(32).fill(0);

  const aStart = await conn.getBalance(admin.publicKey);
  const bStart = await conn.getBalance(bob.publicKey);

  await (program.methods as any).createMatch(0, new anchor.BN(stake), zero)
    .accounts({
      config: configPda, matchAccount: match, player: admin.publicKey,
      systemProgram: SystemProgram.programId,
    }).remainingAccounts(metasA).rpc();
  await (bobProgram.methods as any).joinMatch(zero)
    .accounts({
      config: configPda, matchAccount: match, player: bob.publicKey,
      systemProgram: SystemProgram.programId,
    }).remainingAccounts(metasB).rpc();

  const m0: any = await accounts.matchAccount.fetch(match);
  check('the match is Active with both stakes escrowed', m0.state === 1,
    `#${matchId} · ${((await conn.getBalance(match)) / LAMPORTS_PER_SOL).toFixed(4)} SOL held`);

  // ── the log, on the rollup ───────────────────────────────────────────────
  console.log('\n2. the match log, delegated to the rollup');
  await (program.methods as any).initMatchLog(new anchor.BN(matchId))
    .accounts({
      matchAccount: match, matchLog: log, payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    }).rpc();
  await (program.methods as any).delegateMatchLog(new anchor.BN(matchId))
    .accounts({ payer: admin.publicKey, matchLog: log, validator: null }).rpc();
  await sleep(3500);
  const st = await routerStatus(log);
  check('the log is delegated', st?.isDelegated === true, st?.fqdn ?? 'no fqdn');
  const erUrl: string = st?.fqdn ?? 'https://devnet-as.magicblock.app/';
  const erConn = new Connection(erUrl, { commitment: 'confirmed' });
  const erA = new anchor.Program(idl,
    new anchor.AnchorProvider(erConn, new anchor.Wallet(admin), { commitment: 'confirmed' }));
  const erB = new anchor.Program(idl,
    new anchor.AnchorProvider(erConn, new anchor.Wallet(bob), { commitment: 'confirmed' }));

  await (erA.methods as any).playCard(10, 0, 512, 1024)
    .accounts({ matchLog: log, player: admin.publicKey }).rpc().catch(() => {});
  await (erB.methods as any).playCard(14, 3, -512, -1024)
    .accounts({ matchLog: log, player: bob.publicKey }).rpc().catch(() => {});

  // ── the lie ──────────────────────────────────────────────────────────────
  console.log('\n3. both seats claim the win — the modified client\'s move');
  const finalHash = new anchor.BN(0x1234abcd);
  await (erA.methods as any).endMatchLog(0, finalHash)
    .accounts({ matchLog: log, player: admin.publicKey }).rpc();
  // Seat B reports the opposite result. Nothing about this transaction is
  // malformed — it is exactly what an honest client sends, with one byte
  // changed, which is the point.
  await (erB.methods as any).endMatchLog(1, finalHash)
    .accounts({ matchLog: log, player: bob.publicKey }).rpc();
  console.log('  seat A claims winner 0, seat B claims winner 1');
  await sleep(9000);

  let disputed = false;
  try {
    await (bobProgram.methods as any).settleFromLog()
      .accounts({
        config: configPda, matchAccount: match, matchLog: log, settler: bob.publicKey,
        playerA: admin.publicKey, playerB: bob.publicKey, treasury: cfg.treasury,
      }).remainingAccounts([...metasA, ...metasB]).rpc();
  } catch (e: any) {
    disputed = /ResultDisputed|6\d\d\d/.test(String(e?.message ?? e));
  }
  check('settle_from_log refuses to pay a disputed result', disputed,
    'neither seat can be paid from a contradiction');

  // ── the deadline, and what happens at it ─────────────────────────────────
  const mNow: any = await accounts.matchAccount.fetch(match);
  const waitSec = Math.max(0, Number(mNow.deadline) - Math.floor(Date.now() / 1000)) + 5;
  console.log(`\n4. the match is still Active. waiting out its ${Number(cfg.matchTimeoutSecs)}s deadline (${waitSec}s)`);
  await sleep(waitSec * 1000);

  const aPre = await conn.getBalance(admin.publicKey);
  const bPre = await conn.getBalance(bob.publicKey);

  /**
   * The exploit, if it is one.
   *
   * `claim_timeout` exists for an opponent who walked away, and pays the
   * claimer. After a dispute *both* seats are still here and both are eligible
   * — so whichever calls first takes the whole pot. Seat B, which lied, calls
   * first. If this succeeds the lie was profitable, and disagreement is theft
   * rather than the void the design intends.
   */
  let liarTookPot = false;
  let timeoutErr = '';
  try {
    await (bobProgram.methods as any).claimTimeout()
      .accounts({
        config: configPda, matchAccount: match, claimer: bob.publicKey,
        winnerAccount: bob.publicKey, treasury: cfg.treasury,
        // Passed in full, exactly as an honest client would. A refusal caused
        // by a missing account proves nothing about the dispute rule — the
        // first run of this "passed" on `Account playerA not provided`, which
        // is a test checking its own typo.
        playerA: admin.publicKey, playerB: bob.publicKey, matchLog: log,
      }).remainingAccounts([...metasA, ...metasB]).rpc();
    liarTookPot = true;
  } catch (e: any) {
    timeoutErr = String(e?.message ?? e).slice(0, 140);
  }

  const aPost = await conn.getBalance(admin.publicKey);
  const bPost = await conn.getBalance(bob.publicKey);
  const bGain = (bPost - bPre) / LAMPORTS_PER_SOL;
  const aGain = (aPost - aPre) / LAMPORTS_PER_SOL;

  /*
   * The exploit is taking the pot, not the instruction succeeding.
   *
   * The first version asserted `!liarTookPot` — that `claim_timeout` threw. It
   * does not throw any more: it succeeds and refunds both seats, which is the
   * fix. Asserting on whether a call errored rather than on where the money
   * went would have failed a working program and passed a broken one that
   * reverted for an unrelated reason.
   *
   * A pot grab pays roughly 2 × stake less rake. A refund pays exactly the
   * stake back. Those are far enough apart that a threshold cannot confuse
   * them.
   */
  const stakeSol = stake / LAMPORTS_PER_SOL;
  check('the seat that lied got at most its own stake back, never the pot',
    bGain <= stakeSol * 1.05,
    liarTookPot
      ? `claim_timeout ran and paid seat B ${bGain.toFixed(4)} SOL against a ${stakeSol.toFixed(3)} stake`
      : timeoutErr || 'refused outright');
  check('the honest seat was made whole too', aGain >= stakeSol * 0.95,
    `seat A +${aGain.toFixed(4)} SOL`);

  const mEnd: any = await accounts.matchAccount.fetch(match);
  check('the disputed match is settled as void, not paid to a seat',
    mEnd.state === 2 && mEnd.winner === 2,
    `state=${mEnd.state} winner=${mEnd.winner}`);
  check('both decks came back unlocked',
    (await accounts.card.fetch(cardPda(deckA[0]))).lockedBy.equals(PublicKey.default)
    && (await accounts.card.fetch(cardPda(deckB[0]))).lockedBy.equals(PublicKey.default));

  // Whatever happened, both seats should be roughly whole across the match:
  // a refund returns both stakes, and only fees should be missing.
  const aNet = (aPost - aStart) / LAMPORTS_PER_SOL;
  const bNet = (bPost - bStart) / LAMPORTS_PER_SOL;
  check('neither seat profited from the disagreement', Math.abs(aNet) < 0.02 && Math.abs(bNet) < 0.02,
    `A ${aNet.toFixed(4)} SOL · B ${bNet.toFixed(4)} SOL`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
