/**
 * Point the config at a dedicated treasury.
 *
 * On devnet the treasury was the admin wallet, which made every fee invisible:
 * rake and payout landed in the same account, so `e2e-staked-match` could only
 * assert that `rake + payout == pot` arithmetically and never that the rake
 * actually went anywhere. A separate address makes the split observable, which
 * is the difference between a checked invariant and a stated one.
 *
 * The address is derived from a fixed seed so it is stable across runs and
 * across machines — a treasury that moves is worse than one that is wrong.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';

/*
 * The seed below is IN THIS PUBLIC REPOSITORY, which means anyone on earth
 * can derive the treasury's secret key. On devnet that is a demo convenience.
 * On mainnet it is every fee the game ever earns, standing in the street.
 * This script refuses to run against anything that is not devnet; the
 * mainnet treasury is created by the launch runbook as a fresh keypair (or
 * better, a Squads multisig) and passed to init_config directly.
 */
if (/mainnet/i.test(BASE)) {
  throw new Error(
    'set-treasury derives its key from a public seed and must never run on mainnet — see MAINNET.md',
  );
}

/** Deterministic devnet treasury. Not a secret and not holding anything real. */
export function devnetTreasury(): Keypair {
  const seed = new Uint8Array(32);
  Buffer.from('mempire-devnet-treasury-v1').copy(Buffer.from(seed.buffer));
  return Keypair.fromSeed(seed);
}

async function main() {
  const conn = new Connection(BASE, 'confirmed');
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim();
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const program = new anchor.Program(idl, provider);
  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0];

  const treasury = devnetTreasury();
  const cfg: any = await (program.account as any).config.fetch(configPda);
  console.log('current treasury :', cfg.treasury.toBase58());
  console.log('target treasury  :', treasury.publicKey.toBase58());

  if (cfg.treasury.equals(treasury.publicKey)) {
    console.log('already set — nothing to do');
    return;
  }

  // Rent-exempt it first. A treasury that is a bare system account works, but
  // an unfunded one makes the first fee transfer look like it created the
  // account rather than paid into it, which muddies exactly the measurement
  // this change exists to enable.
  const bal = await conn.getBalance(treasury.publicKey);
  if (bal === 0) {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: treasury.publicKey,
      lamports: Math.round(0.01 * LAMPORTS_PER_SOL),
    })));
    console.log('funded the treasury for rent');
  }

  const sig = await (program.methods as any).setTreasury()
    .accounts({ config: configPda, admin: admin.publicKey, treasury: treasury.publicKey })
    .rpc();
  console.log('set_treasury', sig);

  const after: any = await (program.account as any).config.fetch(configPda);
  console.log('now           :', after.treasury.toBase58());
  if (!after.treasury.equals(treasury.publicKey)) throw new Error('treasury did not change');
}

main().catch((e) => { console.error(e); process.exit(1); });
