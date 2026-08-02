/**
 * Creates $MEMPIRE and opens its USDC pool.
 *
 * Resumable and idempotent: every step checks whether it already happened, so a
 * run that dies halfway on a rate limit can simply be run again. It writes
 * `app/src/lib/amm.json`, which is the single place the client learns the mint,
 * the pool and the vault addresses — so the UI and the chain can never disagree
 * about what is being traded.
 *
 * USDC is the **real** mint on each cluster, never one this script creates:
 *
 *   devnet   4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU  (Circle)
 *   mainnet  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (Circle)
 *
 * Devnet USDC comes from Circle's faucet at https://faucet.circle.com. This
 * script will not invent a substitute: a pool quoted in a token we minted
 * ourselves would price $MEMPIRE against nothing.
 *
 * Run: npx tsx scripts/setup-amm.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint,
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CLUSTER = /mainnet/.test(RPC) ? 'mainnet' : 'devnet';

/** Circle's real USDC. Not created here, on any cluster. */
const USDC = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}[CLUSTER]!;

/** $MEMPIRE. Six decimals to match USDC, so quotes need no rescaling. */
const MEMPIRE_DECIMALS = 6;
const MEMPIRE_SUPPLY = 1_000_000_000; // one billion, minted once

const OUT = join(__dirname, '../../app/src/lib/amm.json');
const KEY = join(__dirname, '../.mempire-mint.json');

function wallet(): Keypair {
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' })
      .match(/Keypair Path:\s*(.+)/)![1].trim();
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

async function main() {
  const conn = new Connection(RPC, { commitment: 'confirmed' });
  const payer = wallet();
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: 'confirmed',
  });
  const idl = JSON.parse(readFileSync(
    join(__dirname, '../target/idl/mempire_amm.json'), 'utf8',
  ));
  const program = new anchor.Program(idl, provider);
  const ammId = new PublicKey(idl.address);

  console.log(`cluster  ${CLUSTER}`);
  console.log(`payer    ${payer.publicKey.toBase58()}`);
  console.log(`balance  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`amm      ${ammId.toBase58()}`);
  console.log(`usdc     ${USDC}  (Circle, not created here)\n`);

  // ── 1. $MEMPIRE ───────────────────────────────────────────────────────────
  // The mint keypair is kept so a re-run reuses the same token rather than
  // minting a second $MEMPIRE and silently orphaning the first.
  let mintKp: Keypair;
  if (existsSync(KEY)) {
    mintKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
  } else {
    mintKp = Keypair.generate();
    writeFileSync(KEY, JSON.stringify(Array.from(mintKp.secretKey)));
  }
  const mempire = mintKp.publicKey;

  if (!(await conn.getAccountInfo(mempire))) {
    const lamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const ata = getAssociatedTokenAddressSync(mempire, payer.publicKey);
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mempire,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mempire, MEMPIRE_DECIMALS, payer.publicKey, payer.publicKey,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, ata, payer.publicKey, mempire,
      ),
      createMintToInstruction(
        mempire, ata, payer.publicKey,
        BigInt(MEMPIRE_SUPPLY) * BigInt(10 ** MEMPIRE_DECIMALS),
      ),
    );
    const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, [payer, mintKp], {
      commitment: 'confirmed',
    });
    console.log(`$MEMPIRE minted  ${mempire.toBase58()}`);
    console.log(`  supply ${MEMPIRE_SUPPLY.toLocaleString()}  tx ${sig}`);
  } else {
    const m = await getMint(conn, mempire);
    console.log(`$MEMPIRE exists  ${mempire.toBase58()}`);
    console.log(`  supply ${(Number(m.supply) / 10 ** m.decimals).toLocaleString()}`);
  }

  // ── 2. the pool ───────────────────────────────────────────────────────────
  const usdc = new PublicKey(USDC);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mempire.toBuffer(), usdc.toBuffer()], ammId,
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp'), pool.toBuffer()], ammId,
  );
  const baseVault = getAssociatedTokenAddressSync(mempire, pool, true);
  const quoteVault = getAssociatedTokenAddressSync(usdc, pool, true);

  if (!(await conn.getAccountInfo(pool))) {
    const sig = await program.methods.initPool(30)
      .accounts({
        pool,
        baseMint: mempire,
        quoteMint: usdc,
        lpMint,
        baseVault,
        quoteVault,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    console.log(`\npool opened      ${pool.toBase58()}`);
    console.log(`  fee 0.30%  tx ${sig}`);
  } else {
    console.log(`\npool exists      ${pool.toBase58()}`);
  }

  const p: any = await (program.account as any).pool.fetch(pool);
  console.log(`  reserves  ${Number(p.reserveBase) / 1e6} MEMPIRE / ${Number(p.reserveQuote) / 1e6} USDC`);
  console.log(`  lp supply ${Number(p.lpSupply) / 1e6}   swaps ${p.swaps}`);

  // ── 3. what the client needs ──────────────────────────────────────────────
  writeFileSync(OUT, `${JSON.stringify({
    cluster: CLUSTER,
    ammProgramId: ammId.toBase58(),
    mempireMint: mempire.toBase58(),
    mempireDecimals: MEMPIRE_DECIMALS,
    usdcMint: USDC,
    usdcDecimals: 6,
    pool: pool.toBase58(),
    lpMint: lpMint.toBase58(),
    baseVault: baseVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
    feeBps: 30,
  }, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);

  // ── 4. what is still needed to make the pool tradeable ────────────────────
  const usdcAta = getAssociatedTokenAddressSync(usdc, payer.publicKey);
  let usdcBal = 0;
  try { usdcBal = Number((await getAccount(conn, usdcAta)).amount) / 1e6; } catch { /* none */ }

  if (Number(p.lpSupply) === 0) {
    console.log('\n── the pool has no liquidity yet ──');
    console.log(`  USDC held by ${payer.publicKey.toBase58().slice(0, 8)}…: ${usdcBal}`);
    if (usdcBal === 0) {
      console.log('  Get devnet USDC from https://faucet.circle.com (Solana Devnet),');
      console.log(`  send it to ${payer.publicKey.toBase58()}, then run seed-liquidity.ts.`);
      console.log('  This script will not mint a stand-in: a pool quoted in a token we');
      console.log('  minted ourselves would price $MEMPIRE against nothing.');
    } else {
      console.log('  Run seed-liquidity.ts to open the market.');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
