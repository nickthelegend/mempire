/**
 * MagicBlock Ephemeral Rollup end-to-end proof, against the local `mb-stack`.
 *
 * Localnet is the right environment for this claim: it exercises real
 * delegation, a real ephemeral validator, and a real commit path, and it costs
 * no devnet SOL. What it does *not* prove is hosted router placement across
 * regions — that needs devnet, and is the one gap this run leaves open.
 *
 * Proves, in order:
 *   1. the log delegates and base-layer ownership flips to the delegation program
 *   2. the same account is owned by OUR program on the ER (the delegation invariant)
 *   3. card plays and checkpoints actually land on the ER
 *   4. the ER enforces authorization, not just routing (a stranger is rejected)
 *   5. monotonic ticks — history already simulated cannot be rewritten
 *   6. commit_and_undelegate returns the log with its ER state intact
 *
 * Prereq: `npx mb-stack` running.
 * Run: npx tsx scripts/e2e-rollup-local.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.BASE_RPC ?? 'http://127.0.0.1:8899';
const ER = process.env.ER_RPC ?? 'http://127.0.0.1:7799';

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
/** Localnet delegation must name the local validator's identity explicitly. */
const LOCALNET_VALIDATOR = new PublicKey('mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b;
};

/**
 * Finds an Anchor error name in a thrown ER error.
 *
 * `e.error.errorCode.code` is only populated when the client could parse a
 * program-error return. A simulation rejection on the ER surfaces the failure in
 * the message or logs instead, so asserting solely on `errorCode` reports a
 * correct rejection as a failure — which it did, three times, before this.
 */
function anchorErr(
  e: unknown, expected: string, idl?: { errors?: { code: number; name: string; msg?: string }[] },
): { matched: boolean; detail: string } {
  const any = e as any;

  // Anchor 0.32 surfaces an ER rejection as a bare `ProgramError` carrying only
  // { code, msg, logs } — no `error.errorCode`, and an empty `.message`. The
  // numeric code is the reliable signal, so resolve the expected variant's code
  // from the IDL rather than string-matching a human-facing sentence.
  const want = idl?.errors?.find((x) => x.name === expected);
  const gotCode = typeof any?.code === 'number' ? any.code : undefined;
  if (want && gotCode !== undefined) {
    return {
      matched: gotCode === want.code,
      detail: `${expected}=${want.code} got ${gotCode}`,
    };
  }

  // Fall back to whatever text is available, including String(e) — which is
  // where the `#[msg]` ends up on this error shape.
  const haystack = [
    String(any?.msg ?? ''),
    String(any?.message ?? ''),
    String(any?.transactionMessage ?? ''),
    String(e),
    ...(Array.isArray(any?.logs) ? any.logs : []),
  ].join(' | ');
  if (want?.msg && haystack.includes(want.msg)) return { matched: true, detail: want.msg };
  if (haystack.includes(expected)) return { matched: true, detail: expected };
  return { matched: false, detail: haystack.slice(0, 110) || 'no detail' };
}

async function main() {
  const baseConn = new Connection(BASE, { commitment: 'confirmed' });
  const erConn = new Connection(ER, { commitment: 'confirmed' });
  process.on('unhandledRejection', () => { /* validator websocket noise */ });

  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  const stranger = Keypair.generate();
  for (const kp of [playerA, playerB, stranger]) {
    const sig = await baseConn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await baseConn.confirmTransaction(sig, 'confirmed');
  }

  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire_rollup.json'), 'utf8'));
  const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(playerA), { commitment: 'confirmed' });
  const baseProgram = new anchor.Program(idl, baseProvider);
  const erProvider = new anchor.AnchorProvider(erConn, new anchor.Wallet(playerA), { commitment: 'confirmed' });
  const erProgram = new anchor.Program(idl, erProvider);
  const pid = baseProgram.programId;

  const matchId = Math.floor(Number(process.env.MATCH_ID ?? `${Date.now() % 1_000_000}`));
  const [log] = PublicKey.findProgramAddressSync([Buffer.from('log'), u64le(matchId)], pid);

  console.log(`program  ${pid.toBase58()}`);
  console.log(`base     ${BASE}`);
  console.log(`rollup   ${ER}`);
  console.log(`match    #${matchId}`);
  console.log(`log      ${log.toBase58()}\n`);

  // ── 1. init + delegate ───────────────────────────────────────────────────
  console.log('1. init_log + delegate_log (base layer)');
  await baseProgram.methods
    .initLog(new anchor.BN(matchId), [playerA.publicKey, playerB.publicKey])
    .accounts({ log, payer: playerA.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  const before = await baseConn.getAccountInfo(log);
  check('log created, owned by our program', Boolean(before?.owner.equals(pid)));

  const created: any = await (baseProgram.account as any).matchLog.fetch(log);
  check('both seats recorded', created.players[0].equals(playerA.publicKey)
    && created.players[1].equals(playerB.publicKey));

  // The validator must be named explicitly on localnet: an unassigned delegation
  // is refused by a specific ER even though base ownership looks correct.
  await baseProgram.methods
    .delegateLog(new anchor.BN(matchId))
    .accounts({ payer: playerA.publicKey, log, validator: LOCALNET_VALIDATOR })
    .rpc();

  let baseOwner: PublicKey | null = null;
  for (let i = 0; i < 25; i += 1) {
    baseOwner = (await baseConn.getAccountInfo(log))?.owner ?? null;
    if (baseOwner?.equals(DELEGATION_PROGRAM_ID)) break;
    await sleep(600);
  }
  check('base ownership flipped to the delegation program',
    Boolean(baseOwner?.equals(DELEGATION_PROGRAM_ID)), baseOwner?.toBase58());

  // ── 2. the delegation invariant ───────────────────────────────────────────
  console.log('\n2. the delegation invariant (base=delegation program, ER=us)');
  let erOwner: PublicKey | null = null;
  for (let i = 0; i < 25; i += 1) {
    erOwner = (await erConn.getAccountInfo(log))?.owner ?? null;
    if (erOwner?.equals(pid)) break;
    await sleep(600);
  }
  check('log owned by our program ON the rollup', Boolean(erOwner?.equals(pid)), erOwner?.toBase58());

  // ── 3. plays + checkpoints on the rollup ─────────────────────────────────
  console.log('\n3. card plays + checkpoints (ephemeral rollup)');

  /**
   * The first write is retried.
   *
   * An ER clone can arrive read-only and become writable a moment later: router
   * and ownership can both report "delegated" while the ER bank has not yet
   * synchronized mutability for the account, which surfaces as
   * `InvalidWritableAccount` / "loads a writable account that cannot be written".
   * Propagation is asynchronous, so this polls rather than assuming — the same
   * rule the delegation checklist applies to ownership.
   */
  const t0 = Date.now();
  let firstPlayErr = '';
  let landed = false;
  for (let i = 0; i < 20; i += 1) {
    try {
      await erProgram.methods.playCard(20, 0, 1024, 2048)
        .accounts({ log, player: playerA.publicKey }).rpc();
      landed = true;
      break;
    } catch (e: any) {
      firstPlayErr = String(e?.transactionMessage ?? e?.message ?? e).slice(0, 90);
      await sleep(1500);
    }
  }
  const oneWay = Date.now() - t0;
  check('play landed on the rollup', landed, landed ? `${oneWay}ms incl. mutability sync` : firstPlayErr);
  if (!landed) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  // Seat 1 plays too — both players write to the same delegated log.
  const erProviderB = new anchor.AnchorProvider(erConn, new anchor.Wallet(playerB), { commitment: 'confirmed' });
  const erProgramB = new anchor.Program(idl, erProviderB);
  await erProgramB.methods.playCard(24, 3, -512, 4096)
    .accounts({ log, player: playerB.publicKey }).rpc();

  await erProgram.methods.checkpoint(40, new anchor.BN('1234567890'))
    .accounts({ log, player: playerA.publicKey }).rpc();

  const live: any = await (erProgram.account as any).matchLog.fetch(log);
  check('both plays recorded', live.plays.length === 2, `${live.plays.length} plays`);
  check('seats attributed correctly',
    live.plays[0].player === 0 && live.plays[1].player === 1);
  check('coordinates survived round trip',
    live.plays[0].x === 1024 && live.plays[1].y === 4096);
  check('checkpoint hash recorded', live.lastHash.toString() === '1234567890');
  check('checkpoint counted', live.checkpoints === 1);

  // ── 4. authorization is enforced on the rollup ───────────────────────────
  console.log('\n4. the rollup enforces authorization, not just routing');
  const erStranger = new anchor.Program(
    idl, new anchor.AnchorProvider(erConn, new anchor.Wallet(stranger), { commitment: 'confirmed' }),
  );
  try {
    await erStranger.methods.playCard(60, 1, 0, 0)
      .accounts({ log, player: stranger.publicKey }).rpc();
    check('non-player rejected', false, 'a stranger played a card');
  } catch (e) {
    const r = anchorErr(e, 'NotAPlayer', idl);
    check('non-player rejected', r.matched, r.detail);
  }

  // ── 5. monotonic ticks ───────────────────────────────────────────────────
  console.log('\n5. history cannot be rewritten');
  try {
    await erProgram.methods.playCard(10, 0, 0, 0)
      .accounts({ log, player: playerA.publicKey }).rpc();
    check('stale tick rejected', false, 'a play rewrote simulated history');
  } catch (e) {
    const r = anchorErr(e, 'StaleTick', idl);
    check('stale tick rejected', r.matched, r.detail);
  }
  try {
    await erProgram.methods.playCard(80, 99, 0, 0)
      .accounts({ log, player: playerA.publicKey }).rpc();
    check('out-of-range deck index rejected', false, 'index 99 was accepted');
  } catch (e) {
    const r = anchorErr(e, 'BadDeckIndex', idl);
    check('out-of-range deck index rejected', r.matched, r.detail);
  }

  // ── 6. commit + undelegate ───────────────────────────────────────────────
  console.log('\n6. end_log → commit_and_undelegate');
  await erProgram.methods.endLog(0, new anchor.BN('999999'))
    .accounts({
      payer: playerA.publicKey, log,
      magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID,
    })
    .rpc();

  let homeOwner: PublicKey | null = null;
  for (let i = 0; i < 40; i += 1) {
    homeOwner = (await baseConn.getAccountInfo(log))?.owner ?? null;
    if (homeOwner?.equals(pid)) break;
    await sleep(750);
  }
  check('log undelegated back to our program', Boolean(homeOwner?.equals(pid)), homeOwner?.toBase58());

  if (homeOwner?.equals(pid)) {
    const settled: any = await (baseProgram.account as any).matchLog.fetch(log);
    check('rollup state survived the commit', settled.plays.length === 2,
      `${settled.plays.length} plays on base layer`);
    check('final hash committed', settled.lastHash.toString() === '999999');
    check('winner committed', settled.winner === 0);
    check('ended flag committed', settled.ended === true);
    check('play detail intact after commit',
      settled.plays[1].player === 1 && settled.plays[1].y === 4096);

    // A sealed log can be closed by a player to reclaim its rent.
    console.log('\n7. close_log reclaims rent (base layer)');
    const balBefore = await baseConn.getBalance(playerA.publicKey);
    await baseProgram.methods.closeLog()
      .accounts({ log, payer: playerA.publicKey }).rpc();
    const balAfter = await baseConn.getBalance(playerA.publicKey);
    const gone = await baseConn.getAccountInfo(log);
    check('log closed', gone === null);
    check('rent returned to the player', balAfter > balBefore,
      `+${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(5)} SOL`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('MAGICBLOCK OK: the battle loop runs on an ephemeral rollup.');
  console.log('Not proven here: hosted router placement across regions (needs devnet).');
}

main().catch((e) => { console.error(e); process.exit(1); });
