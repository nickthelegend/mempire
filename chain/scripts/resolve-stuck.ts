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
  const stuck = all.filter((m) => m.account.state === 1);
  if (!stuck.length) { console.log('no unsettled matches'); return; }

  const cards: any[] = await (read.account as any).card.all();

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
      const sig = await (prog.methods as any).claimTimeout()
        .accounts({
          config: configPda,
          matchAccount: m.publicKey,
          claimer: kp.publicKey,
          winnerAccount: kp.publicKey,
          treasury: cfg.treasury,
        })
        .remainingAccounts(locked)
        .rpc();
      console.log(`     claimed → ${sig.slice(0, 20)}…  freed ${locked.length} cards`);
    } catch (e: any) {
      console.log(`     could not claim: ${String(e?.message ?? e).slice(0, 110)}`);
    }
  }

  if (!act) console.log('\nrun with --claim to act on the ones past their deadline');
}

main().catch((e) => { console.error(e); process.exit(1); });
