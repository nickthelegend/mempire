/**
 * Which of each demo wallet's cards can the client actually field?
 *
 * `buildDecks()` resolves every deck card's mint against the client's bundled
 * coin registry and returns null on the first miss — which surfaces as "your
 * deck has retired cards". The chain registry has grown past the list the app
 * was built with, so a card minted from a coin the client has never heard of
 * is unfieldable, and a deck auto-filled with one is dead.
 *
 * Run: npx tsx scripts/check-demo-decks.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const OWNER_OFFSET = 16;

const conn = new Connection(BASE, { commitment: 'confirmed' });
const keypairPath = process.env.SOLANA_KEYPAIR
  ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim();
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' });
anchor.setProvider(provider);

const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
const program = new anchor.Program(idl, provider);
const accounts: any = program.account;

const client = JSON.parse(readFileSync('../app/src/lib/devnet-coins.json', 'utf8'));
const known = new Map<string, string>(client.coins.map((c: any) => [c.mint, c.ticker]));
console.log(`client registry: ${known.size} coins\n`);

const demo: Keypair[] = JSON.parse(readFileSync('../app/.demo-wallets.json', 'utf8'))
  .map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)));

// Wrapped rather than top level: tsx compiles these scripts as CJS, where a
// top-level await is a hard transform error.
async function main() {
  for (const [i, kp] of demo.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const mine: any[] = await accounts.card.all([
      { memcmp: { offset: OWNER_OFFSET, bytes: kp.publicKey.toBase58() } },
    ]);
    const unlocked = mine.filter((c) => c.account.lockedBy.equals(PublicKey.default));
    let ok = 0;
    console.log(`  ${label}  ${kp.publicKey.toBase58()}  ${unlocked.length} unlocked`);
    for (const c of unlocked) {
      const mint = c.account.coinMint.toBase58();
      const ticker = known.get(mint);
      if (ticker) ok += 1;
      console.log(`    card ${String(c.account.id).padStart(3)}  ${ticker ? `OK   ${ticker}` : `MISS ${mint}`}`);
    }
    console.log(`  ${ok >= 8 ? 'PASS' : 'FAIL'}  ${ok} of ${unlocked.length} are fieldable by the client\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
