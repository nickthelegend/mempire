/**
 * Stock a dedicated faucet wallet with devnet SOL and starter coins.
 *
 * # Why a separate key at all
 *
 * The faucet has to sign, and it runs on a public web server. The admin key
 * cannot go there: it is the program's upgrade authority and the config admin,
 * so a compromised server would mean a compromised program. This key can do
 * exactly one thing — hand out devnet tokens it already holds — and losing it
 * costs a refill.
 *
 * # Why a faucet exists
 *
 * "Your bags are your army" is the whole premise, and a wallet that has just
 * arrived has no bags. Minting a card requires holding the coin, so a new
 * player could not mint a single fighter, could not field a legal deck, and
 * therefore could never reach a staked match. The game was unplayable for
 * exactly the person it was trying to impress.
 *
 * Run once, then top up when `--check` says it is running low.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import bs58 from 'bs58';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';

/** How many whole tokens of each coin the faucet stocks. */
const STOCK_PER_COIN = 5_000;
/** SOL the faucet holds to pay out drips and its own fees. */
const FAUCET_SOL = 4;

/**
 * The faucet keypair, from a fixed seed.
 *
 * Deterministic so this script, the server and any operator all derive the
 * same address without passing a file around. It is not a secret in the sense
 * that matters — it guards devnet play money — but the server still gets it
 * through an env var rather than reconstructing it, so rotating means changing
 * one config value.
 */
export function faucetKeypair(): Keypair {
  const seed = new Uint8Array(32);
  Buffer.from('mempire-devnet-faucet-v1').copy(Buffer.from(seed.buffer));
  return Keypair.fromSeed(seed);
}

async function main() {
  const check = process.argv.includes('--check');
  const conn = new Connection(BASE, 'confirmed');
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim();
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
  const faucet = faucetKeypair();

  const coins = (JSON.parse(readFileSync('../app/src/lib/devnet-coins.json', 'utf8')) as
    { coins: { ticker: string; mint: string; decimals: number }[] }).coins;

  console.log(`faucet ${faucet.publicKey.toBase58()}`);
  const sol = await conn.getBalance(faucet.publicKey);
  console.log(`  SOL ${(sol / LAMPORTS_PER_SOL).toFixed(3)}`);

  if (check) {
    let low = 0;
    for (const c of coins.slice(0, 12)) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(c.mint), faucet.publicKey);
      const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
      const whole = bal ? Number(bal.value.uiAmount ?? 0) : 0;
      if (whole < 100) { low += 1; console.log(`  LOW  ${c.ticker} ${whole}`); }
    }
    console.log(low ? `\n${low} coins need a top-up` : '\nstocked');
    return;
  }

  if (sol < FAUCET_SOL * LAMPORTS_PER_SOL * 0.5) {
    const need = Math.ceil(FAUCET_SOL * LAMPORTS_PER_SOL - sol);
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: faucet.publicKey, lamports: need,
    }));
    await conn.sendTransaction(tx, [admin]);
    console.log(`  funded with ${(need / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Mint straight into the faucet's accounts. The admin is the mint authority
  // for every seeded coin, so this creates supply rather than moving it —
  // which is the right shape for a devnet faucet: refilling it should never
  // require the admin to have hoarded enough in advance.
  let done = 0;
  for (let i = 0; i < coins.length; i += 4) {
    const chunk = coins.slice(i, i + 4);
    const tx = new Transaction();
    for (const c of chunk) {
      const mint = new PublicKey(c.mint);
      const ata = getAssociatedTokenAddressSync(mint, faucet.publicKey);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey, ata, faucet.publicKey, mint,
      ));
      tx.add(createMintToInstruction(
        mint, ata, admin.publicKey,
        BigInt(STOCK_PER_COIN) * BigInt(10) ** BigInt(c.decimals ?? 6),
      ));
    }
    try {
      await conn.sendTransaction(tx, [admin]);
      done += chunk.length;
      process.stdout.write(`  stocked ${done}/${coins.length}\r`);
      await new Promise((r) => setTimeout(r, 600));
    } catch (e) {
      console.log(`\n  skip ${chunk.map((c) => c.ticker).join(',')} — ${String(e).slice(0, 70)}`);
    }
  }
  console.log(`\n  stocked ${done} coins with ${STOCK_PER_COIN} each`);

  console.log('\nSet this on the server (never commit it):');
  console.log(`  FAUCET_SECRET=${bs58.encode(faucet.secretKey)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
