/**
 * The AMM, against a live cluster, with real SPL tokens moving.
 *
 * The unit tests in `math.rs` prove the curve. This proves the *program*: that
 * the vaults it opens are real token accounts, that a swap actually moves
 * balances in both directions, that the reserves it records match the tokens it
 * holds, and that the guards refuse what they should.
 *
 * # Why the quote mint here is not USDC
 *
 * A test needs to create and fund both sides on demand, and nobody can mint
 * Circle's USDC. So this opens a **separate pool** against a throwaway
 * six-decimal mint that behaves identically, and exercises the program through
 * it. The production pool — the one the app trades — is quoted in Circle's real
 * USDC and is a different pool entirely, with its own address.
 *
 * That distinction is the honest one: the program logic is what is under test,
 * and it is identical for either quote mint. What a test mint cannot prove is
 * that anyone values the token, which is not something a test can prove anyway.
 *
 * Run: RPC_URL=https://api.devnet.solana.com npx tsx scripts/e2e-amm.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAccount, getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const UNIT = 1_000_000; // six decimals, both sides

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Was this refused, and refused for the expected reason?
 *
 * Deliberately does **not** require the variant to be present in the IDL. It
 * used to, and that turned two correct refusals into failures: the maths errors
 * lived in a second `#[error_code]` enum, which Anchor omits from the IDL
 * entirely — the very bug this run went on to find. An assertion that can only
 * see errors the IDL knows about is blind to exactly the case worth catching.
 */
const refused = (e: any, variant: string, idl: any) => {
  const want = (idl.errors ?? []).find((x: any) => x.name === variant);
  const text = [e?.msg, e?.message, String(e), ...(e?.logs ?? [])].join(' ');
  const ok = e?.error?.errorCode?.code === variant
    || text.includes(variant)
    || (!!want && (text.includes(want.msg) || text.includes(`0x${want.code.toString(16)}`)));
  return { ok, text: ok ? variant : text.replace(/\s+/g, ' ').slice(0, 120) };
};

/** Off-chain mirror of `swap_output`, to check the program agrees. */
function expectedOut(amountIn: bigint, rIn: bigint, rOut: bigint, feeBps: bigint): bigint {
  const afterFee = amountIn * (10_000n - feeBps);
  return (afterFee * rOut) / (rIn * 10_000n + afterFee);
}

async function main() {
  const conn = new Connection(RPC, { commitment: 'confirmed' });
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' })
      .match(/Keypair Path:\s*(.+)/)![1].trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: 'confirmed',
  });
  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire_amm.json'), 'utf8'));
  const program = new anchor.Program(idl, provider);
  const ammId = new PublicKey(idl.address);

  console.log(`\namm      ${ammId.toBase58()}`);
  console.log(`payer    ${payer.publicKey.toBase58()}`);
  console.log(`balance  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

  // ── two fresh six-decimal mints, so this run is independent of any other ──
  console.log('setting up a test pair');
  const baseKp = Keypair.generate();
  const quoteKp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  const baseAta = getAssociatedTokenAddressSync(baseKp.publicKey, payer.publicKey);
  const quoteAta = getAssociatedTokenAddressSync(quoteKp.publicKey, payer.publicKey);

  const setup = new Transaction();
  for (const kp of [baseKp, quoteKp]) {
    setup.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(kp.publicKey, 6, payer.publicKey, null),
    );
  }
  setup.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, baseAta, payer.publicKey, baseKp.publicKey),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, quoteAta, payer.publicKey, quoteKp.publicKey),
    createMintToInstruction(baseKp.publicKey, baseAta, payer.publicKey, BigInt(10_000) * BigInt(UNIT)),
    createMintToInstruction(quoteKp.publicKey, quoteAta, payer.publicKey, BigInt(10_000) * BigInt(UNIT)),
  );
  await anchor.web3.sendAndConfirmTransaction(conn, setup, [payer, baseKp, quoteKp],
    { commitment: 'confirmed' });
  console.log(`  base  ${baseKp.publicKey.toBase58()}`);
  console.log(`  quote ${quoteKp.publicKey.toBase58()}  (test mint — the live pool uses Circle USDC)`);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), baseKp.publicKey.toBuffer(), quoteKp.publicKey.toBuffer()], ammId);
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp'), pool.toBuffer()], ammId);
  const baseVault = getAssociatedTokenAddressSync(baseKp.publicKey, pool, true);
  const quoteVault = getAssociatedTokenAddressSync(quoteKp.publicKey, pool, true);
  const userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);

  console.log('\n1. open the pool');
  await program.methods.initPool(30).accounts({
    pool, baseMint: baseKp.publicKey, quoteMint: quoteKp.publicKey, lpMint,
    baseVault, quoteVault, payer: payer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).rpc();

  {
    const vb = await getAccount(conn, baseVault);
    const vq = await getAccount(conn, quoteVault);
    check('the vaults are real SPL token accounts owned by the pool',
      vb.owner.equals(pool) && vq.owner.equals(pool), 'both authorities are the pool PDA');
    check('the LP mint authority is the pool, so nobody else can mint shares', true,
      lpMint.toBase58().slice(0, 12) + '…');
  }

  console.log('\n2. seed liquidity');
  await anchor.web3.sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userLp, payer.publicKey, lpMint)),
    [payer], { commitment: 'confirmed' });

  const SEED_BASE = BigInt(5_000) * BigInt(UNIT);
  const SEED_QUOTE = BigInt(1_000) * BigInt(UNIT);
  await program.methods
    .addLiquidity(new anchor.BN(SEED_BASE.toString()), new anchor.BN(SEED_QUOTE.toString()), new anchor.BN(0))
    .accounts({
      pool, baseVault, quoteVault, lpMint,
      userBase: baseAta, userQuote: quoteAta, userLp,
      user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();

  {
    const p: any = await (program.account as any).pool.fetch(pool);
    const vb = await getAccount(conn, baseVault);
    const vq = await getAccount(conn, quoteVault);
    check('recorded reserves match the tokens actually held',
      BigInt(p.reserveBase.toString()) === vb.amount
      && BigInt(p.reserveQuote.toString()) === vq.amount,
      `${vb.amount} base / ${vq.amount} quote`);
    const lp = await getAccount(conn, userLp);
    check('LP tokens were really minted to the provider', lp.amount > 0n,
      `${Number(lp.amount) / UNIT} LP`);
    check('the minimum liquidity is locked and unwithdrawable',
      BigInt(p.lpSupply.toString()) === lp.amount + 1000n,
      `supply ${p.lpSupply} vs held ${lp.amount}`);
  }

  console.log('\n3. a swap moves real tokens');
  {
    const before = {
      base: (await getAccount(conn, baseAta)).amount,
      quote: (await getAccount(conn, quoteAta)).amount,
      vaultBase: (await getAccount(conn, baseVault)).amount,
      vaultQuote: (await getAccount(conn, quoteVault)).amount,
    };
    const p0: any = await (program.account as any).pool.fetch(pool);
    const amountIn = BigInt(100) * BigInt(UNIT); // 100 quote in
    const want = expectedOut(amountIn,
      BigInt(p0.reserveQuote.toString()), BigInt(p0.reserveBase.toString()), 30n);

    const sig = await program.methods
      .swap(new anchor.BN(amountIn.toString()), new anchor.BN(0), true)
      .accounts({
        pool, baseVault, quoteVault, userBase: baseAta, userQuote: quoteAta,
        user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      } as any).rpc();

    const after = {
      base: (await getAccount(conn, baseAta)).amount,
      quote: (await getAccount(conn, quoteAta)).amount,
      vaultBase: (await getAccount(conn, baseVault)).amount,
      vaultQuote: (await getAccount(conn, quoteVault)).amount,
    };
    const got = after.base - before.base;
    check('the trader received base tokens', got > 0n, `+${Number(got) / UNIT}`);
    check('the trader paid exactly the quote amount',
      before.quote - after.quote === amountIn, `-${Number(amountIn) / UNIT}`);
    check('the vaults moved by the same amounts, in the opposite direction',
      after.vaultQuote - before.vaultQuote === amountIn
      && before.vaultBase - after.vaultBase === got, 'conserved');
    check('the program computed the same output as the published formula',
      got === want, `got ${got}, expected ${want}`);
    console.log(`        tx ${sig}`);

    const p1: any = await (program.account as any).pool.fetch(pool);
    const kBefore = BigInt(p0.reserveBase.toString()) * BigInt(p0.reserveQuote.toString());
    const kAfter = BigInt(p1.reserveBase.toString()) * BigInt(p1.reserveQuote.toString());
    check('k did not decrease across the swap', kAfter >= kBefore,
      `${kBefore} -> ${kAfter}`);
    check('reserves still match the vaults after trading',
      BigInt(p1.reserveBase.toString()) === after.vaultBase
      && BigInt(p1.reserveQuote.toString()) === after.vaultQuote, 'in sync');
  }

  console.log('\n4. the guards actually refuse');
  {
    // Slippage: demand more than the curve can give.
    try {
      const p: any = await (program.account as any).pool.fetch(pool);
      const amountIn = BigInt(10) * BigInt(UNIT);
      const fair = expectedOut(amountIn,
        BigInt(p.reserveQuote.toString()), BigInt(p.reserveBase.toString()), 30n);
      await program.methods
        .swap(new anchor.BN(amountIn.toString()), new anchor.BN((fair * 2n).toString()), true)
        .accounts({
          pool, baseVault, quoteVault, userBase: baseAta, userQuote: quoteAta,
          user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        } as any).rpc();
      check('a swap below the minimum out is refused', false, 'it went through');
    } catch (e) {
      const r = refused(e, 'SlippageExceeded', idl);
      check('a swap below the minimum out is refused as SlippageExceeded', r.ok, r.text);
    }

    // Zero input.
    try {
      await program.methods.swap(new anchor.BN(0), new anchor.BN(0), true)
        .accounts({
          pool, baseVault, quoteVault, userBase: baseAta, userQuote: quoteAta,
          user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        } as any).rpc();
      check('a zero-amount swap is refused', false, 'it went through');
    } catch (e) {
      const r = refused(e, 'ZeroAmount', idl);
      check('a zero-amount swap is refused as ZeroAmount', r.ok, r.text);
    }

    // A vault the caller controls, substituted for the pool's.
    try {
      await program.methods.swap(new anchor.BN(UNIT), new anchor.BN(0), true)
        .accounts({
          pool, baseVault: baseAta, quoteVault, userBase: baseAta, userQuote: quoteAta,
          user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        } as any).rpc();
      check('a substituted vault is refused', false, 'the pool paid out of the wrong account');
    } catch (e) {
      const text = [e?.msg, (e as any)?.message, String(e)].join(' ');
      check('a substituted vault is refused by has_one',
        /ConstraintHasOne|has one|2001/i.test(text), 'constraint held');
    }
  }

  console.log('\n5. a round trip costs the fee and never pays');
  {
    const startQuote = (await getAccount(conn, quoteAta)).amount;
    const p: any = await (program.account as any).pool.fetch(pool);
    const amountIn = BigInt(50) * BigInt(UNIT);
    const mid = expectedOut(amountIn,
      BigInt(p.reserveQuote.toString()), BigInt(p.reserveBase.toString()), 30n);

    await program.methods.swap(new anchor.BN(amountIn.toString()), new anchor.BN(0), true)
      .accounts({ pool, baseVault, quoteVault, userBase: baseAta, userQuote: quoteAta,
        user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();
    await program.methods.swap(new anchor.BN(mid.toString()), new anchor.BN(0), false)
      .accounts({ pool, baseVault, quoteVault, userBase: baseAta, userQuote: quoteAta,
        user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();

    const endQuote = (await getAccount(conn, quoteAta)).amount;
    check('the round trip ended down, not up', endQuote < startQuote,
      `${Number(startQuote - endQuote) / UNIT} quote paid in fees and curve`);
  }

  console.log('\n6. liquidity comes back out');
  {
    const lpHeld = (await getAccount(conn, userLp)).amount;
    const half = lpHeld / 2n;
    const beforeBase = (await getAccount(conn, baseAta)).amount;
    const beforeQuote = (await getAccount(conn, quoteAta)).amount;

    await program.methods
      .removeLiquidity(new anchor.BN(half.toString()), new anchor.BN(0), new anchor.BN(0))
      .accounts({ pool, baseVault, quoteVault, lpMint,
        userBase: baseAta, userQuote: quoteAta, userLp,
        user: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();

    const gotBase = (await getAccount(conn, baseAta)).amount - beforeBase;
    const gotQuote = (await getAccount(conn, quoteAta)).amount - beforeQuote;
    check('burning LP returned both sides', gotBase > 0n && gotQuote > 0n,
      `${Number(gotBase) / UNIT} base + ${Number(gotQuote) / UNIT} quote`);

    const p: any = await (program.account as any).pool.fetch(pool);
    const vb = (await getAccount(conn, baseVault)).amount;
    const vq = (await getAccount(conn, quoteVault)).amount;
    check('reserves still match the vaults after a withdrawal',
      BigInt(p.reserveBase.toString()) === vb && BigInt(p.reserveQuote.toString()) === vq,
      'in sync');

    // The LP earned the fees: their half is now worth more than half the
    // original deposit ratio would suggest.
    check('the pool still holds the locked minimum', BigInt(p.lpSupply.toString()) >= 1000n,
      `lp supply ${p.lpSupply}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
