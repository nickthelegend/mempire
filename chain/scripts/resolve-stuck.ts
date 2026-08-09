/**
 * Resolve matches that escrowed and never settled.
 *
 * A match that reached `Active` and then lost a client — a crashed tab, a
 * killed test run, an opponent who closed the laptop — holds both stakes and
 * sixteen locked cards until somebody acts. The program's answer is
 * `claim_timeout` after the deadline; this is the operator's hand on that
 * lever, and it also frees the decks so the wallets can play again.
 *
 * Runs for whichever seat keys it can find: the admin wallet and the two
 * browser-test seats. It only ever claims *for* a seat, which is all the
 * program permits anyway.
 *
 *   npx tsx scripts/resolve-stuck.ts          # report
 *   npx tsx scripts/resolve-stuck.ts --claim  # act
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import nacl from 'tweetnacl';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';

/** The browser-test seats, derived the same way `e2e-two-browsers.mjs` does. */
function seatKeypair(label: string): Keypair {
  const seed = new Uint8Array(32);
  Buffer.from(`mempire-browser-e2e-${label}-v1`).copy(Buffer.from(seed.buffer));
  return Keypair.fromSecretKey(nacl.sign.keyPair.fromSeed(seed).secretKey);
}

async function main() {
  const act = process.argv.includes('--claim');
  const conn = new Connection(BASE, 'confirmed');
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim();
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));

  const known = new Map<string, Keypair>();
  for (const kp of [admin, seatKeypair('a'), seatKeypair('b')]) {
    known.set(kp.publicKey.toBase58(), kp);
  }

  /**
   * The demo-recording seats, when they exist.
   *
   * A recording take that ends before its match does strands exactly the same
   * way a crashed test does — sixteen locked cards and two stakes — and the
   * next take then reports "ladder only" because `onchainDeckIds` cannot find
   * eight *unlocked* cards. Without these keys here that state is unclearable
   * by this script, which is the one tool for it.
   */
  try {
    const demo: Keypair[] = JSON.parse(readFileSync('../app/.demo-wallets.json', 'utf8'))
      .map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)));
    for (const kp of demo) known.set(kp.publicKey.toBase58(), kp);
  } catch { /* no demo wallets on this machine — the rest still works */ }

  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const read = new anchor.Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' }),
  );
  const pid = read.programId;
  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
  const cfg: any = await (read.account as any).config.fetch(configPda);
  const now = Math.floor(Date.now() / 1000);

  const all: any[] = await (read.account as any).matchAccount.all();
  const cards: any[] = await (read.account as any).card.all();

  /**
   * `Open` first — a match nobody joined.
   *
   * This used to look only at `Active` matches, which missed the more common
   * stranding by far: a run that created a match and died before the opponent
   * joined leaves it `Open` with eight cards locked and no deadline to wait
   * for. The wallet then cannot field a legal deck ever again, and every
   * later run reports "8 of your cards are not minted onchain yet" — which is
   * true, in the sense that they are locked, and says nothing about why.
   */
  const open = all.filter((m) => m.account.state === 0
    && known.has(m.account.players[0].toBase58()));
  for (const m of open) {
    const id = Number(m.account.id);
    const held = cards
      .filter((c: any) => c.account.lockedBy.equals(m.publicKey))
      .map((c: any) => ({ pubkey: c.publicKey, isWritable: true, isSigner: false }));
    const owner = m.account.players[0].toBase58();
    console.log(`#${id}  Open, never joined — ${held.length} cards locked, creator ${owner.slice(0, 8)}…`);
    if (!act) continue;
    const kp = known.get(owner)!;
    const prog = new anchor.Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }),
    );
    try {
      const sig = await (prog.methods as any).cancelMatch()
        .accounts({ matchAccount: m.publicKey, player: kp.publicKey })
        .remainingAccounts(held).rpc();
      console.log(`     cancelled → ${sig.slice(0, 20)}…  freed ${held.length} cards`);
    } catch (e: any) {
      console.log(`     could not cancel: ${String(e?.message ?? e).slice(0, 110)}`);
    }
  }

  // No early return here: cards can be stranded on a *settled* match, which
  // is neither Open nor Active, and returning before that sweep is how those
  // stayed locked through several runs of this very script.
  const stuck = all.filter((m) => m.account.state === 1);

  for (const m of stuck) {
    const id = Number(m.account.id);
    const deadline = Number(m.account.deadline);
    const held = await conn.getBalance(m.publicKey);
    const seats: string[] = m.account.players.map((p: PublicKey) => p.toBase58());
    const mine = seats.find((s) => known.has(s));
    const past = now >= deadline;

    console.log(
      `#${id}  ${(held / LAMPORTS_PER_SOL).toFixed(4)} SOL held  `
      + `deadline ${past ? 'passed' : `in ${deadline - now}s`}  `
      + `${mine ? `claimable by ${mine.slice(0, 8)}…` : 'no key for either seat'}`,
    );

    if (!act || !mine || !past) continue;

    // Both decks ride along so the claim frees the sixteen locked cards in the
    // same transaction that moves the pot. `unlock_deck` skips anything not
    // locked to this match, so passing every card the wallet owns is safe.
    const locked = cards
      .filter((c: any) => c.account.lockedBy.equals(m.publicKey))
      .map((c: any) => ({ pubkey: c.publicKey, isWritable: true, isSigner: false }));

    const kp = known.get(mine)!;
    const prog = new anchor.Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }),
    );
    try {
      /**
       * Both seats and the log, which this script used to omit.
       *
       * `claim_timeout` grew three accounts when the disputed-result race was
       * fixed: a contradiction between the two seats now settles the match as
       * *void* and refunds both stakes, so both player accounts have to be
       * writable, and the log is what the instruction reads to discover whether
       * the seats disagreed. Passing the old five failed with "Account
       * `playerA` not provided" — the resolver had quietly stopped being able
       * to resolve anything.
       */
      const logPda = PublicKey.findProgramAddressSync(
        [Buffer.from('log'), new anchor.BN(id).toArrayLike(Buffer, 'le', 8)],
        pid,
      )[0];
      const sig = await (prog.methods as any).claimTimeout()
        .accounts({
          config: configPda,
          matchAccount: m.publicKey,
          claimer: kp.publicKey,
          winnerAccount: kp.publicKey,
          treasury: cfg.treasury,
          playerA: m.account.players[0],
          playerB: m.account.players[1],
          matchLog: logPda,
        })
        .remainingAccounts(locked)
        .rpc();
      console.log(`     claimed → ${sig.slice(0, 20)}…  freed ${locked.length} cards`);
    } catch (e: any) {
      console.log(`     could not claim: ${String(e?.message ?? e).slice(0, 110)}`);
    }
  }

  /**
   * Cards still pinned to a match that is already over.
   *
   * Settlement only frees the decks it is handed, and a client reliably knows
   * just its own eight — so the other seat's deck routinely survived the match
   * that locked it. The lock protects nothing once the match is `Settled`, and
   * `release_cards` is permissionless for exactly that reason.
   */
  const settled = all.filter((m) => m.account.state === 2);
  const byMatch = new Map<string, any[]>();
  for (const c of cards) {
    const lock = c.account.lockedBy.toBase58();
    if (lock === PublicKey.default.toBase58()) continue;
    if (!byMatch.has(lock)) byMatch.set(lock, []);
    byMatch.get(lock)!.push(c);
  }

  for (const m of settled) {
    const held = byMatch.get(m.publicKey.toBase58());
    if (!held?.length) continue;
    console.log(`#${m.account.id}  Settled, but ${held.length} cards are still locked to it`);
    if (!act) continue;
    try {
      const sig = await (read.methods as any).releaseCards()
        .accounts({ matchAccount: m.publicKey, payer: admin.publicKey })
        .remainingAccounts(held.map((c: any) => ({
          pubkey: c.publicKey, isWritable: true, isSigner: false,
        })))
        .rpc();
      console.log(`     released → ${sig.slice(0, 20)}…  freed ${held.length} cards`);
    } catch (e: any) {
      console.log(`     could not release: ${String(e?.message ?? e).slice(0, 110)}`);
    }
  }

  if (!act) console.log('\nrun with --claim to act on the ones past their deadline');
}

main().catch((e) => { console.error(e); process.exit(1); });
