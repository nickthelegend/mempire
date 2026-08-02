/**
 * Puts the first liquidity into the live $MEMPIRE / USDC pool.
 *
 * The opening ratio *is* the opening price — there is nothing else for the
 * market to reference — so it is stated here explicitly rather than falling out
 * of whatever amounts happened to be to hand.
 *
 * Idempotent: a pool that already has liquidity is left alone. Re-running to
 * "top up" would move the price if the amounts were not exactly proportional,
 * which is a thing to do deliberately through `add_liquidity`, not by accident
 * through a setup script.
 *
 * Run: npx tsx scripts/seed-liquidity.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, getAccount,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const UNIT = 1_000_000;

/**
 * The opening market.
 *
 * 1.8M $MEMPIRE against 18 USDC is $0.00001 a token, which on a one-billion
 * supply is a $10,000 fully-diluted valuation. Small on purpose: this is a
 * devnet pool whose job is to prove the mechanism works, and a thin pool makes
 * price impact visible in the UI at trade sizes a tester will actually use.
 *
 * Two USDC are deliberately left in the wallet so the pool can be traded
 * against immediately after seeding.
 */
const SEED_MEMPIRE = 1_800_000;
const SEED_USDC = 18;

async function main() {
  const conn = new Connection(RPC, { commitment: 'confirmed' });
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' })
      .match(/Keypair Path:\s*(.+)/)![1].trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: 'confirmed',
  });

  const cfg = JSON.parse(readFileSync(join(__dirname, '../../app/src/lib/amm.json'), 'utf8'));
  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire_amm.json'), 'utf8'));
  const program = new anchor.Program(idl, provider);

  const pool = new PublicKey(cfg.pool);
  const base = new PublicKey(cfg.mempireMint);
  const quote = new PublicKey(cfg.usdcMint);
  const lpMint = new PublicKey(cfg.lpMint);
  const baseVault = new PublicKey(cfg.baseVault);
  const quoteVault = new PublicKey(cfg.quoteVault);
  const userBase = getAssociatedTokenAddressSync(base, payer.publicKey);
  const userQuote = getAssociatedTokenAddressSync(quote, payer.publicKey);
  const userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);

  const p0: any = await (program.account as any).pool.fetch(pool);
  console.log(`pool     ${pool.toBase58()}`);
  console.log(`balance  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  if (Number(p0.lpSupply) > 0) {
    console.log(`\nalready seeded — ${Number(p0.reserveBase) / UNIT} MEMPIRE / ${Number(p0.reserveQuote) / UNIT} USDC`);
    console.log('Leaving it alone: topping up at the wrong ratio moves the price.');
    return;
  }

  const usdcHeld = Number((await getAccount(conn, userQuote)).amount) / UNIT;
  if (usdcHeld < SEED_USDC) {
    console.log(`\nneed ${SEED_USDC} USDC, wallet holds ${usdcHeld}.`);
    console.log('Get devnet USDC from https://faucet.circle.com (Solana Devnet).');
    process.exit(1);
  }

  // The LP account has to exist before the pool can mint into it.
  await anchor.web3.sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userLp, payer.publicKey, lpMint)),
    [payer], { commitment: 'confirmed' });

  const baseIn = BigInt(SEED_MEMPIRE) * BigInt(UNIT);
  const quoteIn = BigInt(SEED_USDC) * BigInt(UNIT);

  const sig = await program.methods
    .addLiquidity(
      new anchor.BN(baseIn.toString()),
      new anchor.BN(quoteIn.toString()),
      new anchor.BN(0), // first deposit sets the price; there is nothing to slip against
    )
    .accounts({
      pool, baseVault, quoteVault, lpMint,
      userBase, userQuote, userLp,
      user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();

  const p1: any = await (program.account as any).pool.fetch(pool);
  const vb = await getAccount(conn, baseVault);
  const vq = await getAccount(conn, quoteVault);
  const price = Number(p1.reserveQuote) / Number(p1.reserveBase);

  console.log(`\nmarket open   tx ${sig}`);
  console.log(`  reserves    ${Number(p1.reserveBase) / UNIT} MEMPIRE / ${Number(p1.reserveQuote) / UNIT} USDC`);
  console.log(`  vaults hold ${Number(vb.amount) / UNIT} / ${Number(vq.amount) / UNIT}  (must match above)`);
  console.log(`  price       $${price.toFixed(8)} per $MEMPIRE`);
  console.log(`  FDV         $${(price * 1_000_000_000).toLocaleString()} on a 1B supply`);
  console.log(`  LP held     ${Number((await getAccount(conn, userLp)).amount) / UNIT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
