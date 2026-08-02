/**
 * End-to-end: Private Ephemeral Rollup permissions and VRF chests, on devnet.
 *
 * These two features are the ones a compile cannot vouch for. A permission CPI
 * that names the wrong vault, a VRF request pointed at the base-layer queue from
 * inside a rollup, or a callback whose identity check is missing — every one of
 * those builds cleanly and then fails, silently, in front of a player.
 *
 * So this asserts against live infrastructure:
 *   - the delegation invariant (base owned by the delegation program, ER owned
 *     by us, router reporting delegated)
 *   - the permission account actually exists on the ER under the permission
 *     program, and is gone again after the log ends
 *   - a randomness request is accepted, and the *separate* oracle callback
 *     eventually fills the slot with a tier in range
 *   - a second concurrent request is refused
 *   - a request against the base-layer queue is refused from the rollup
 *
 * Run: BASE_RPC=https://api.devnet.solana.com npx tsx scripts/e2e-per-vrf.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const ROUTER = process.env.ROUTER_RPC ?? 'https://devnet-router.magicblock.app/';

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const EPHEMERAL_VAULT_ID = new PublicKey('MagicVau1t999999999999999999999999999999999');
/** Note the trailing colon — it is part of the seed, and omitting it derives a
 *  different PDA that the permission program will simply refuse. */
const PERMISSION_SEED = Buffer.from('permission:');

/** Delegated queue: the only one a transaction *running on the ER* can write. */
const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
/** Base-layer queue. Correct from Solana, wrong from inside a rollup. */
const BASE_QUEUE = new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function routerStatus(account: PublicKey): Promise<any | null> {
  try {
    const res = await fetch(ROUTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()],
      }),
    });
    const body: any = await res.json();
    return body?.error ? null : body?.result ?? null;
  } catch { return null; }
}

async function main() {
  const baseConn = new Connection(BASE, { commitment: 'confirmed' });
  // Read the keypair the Solana CLI is actually configured with rather than
  // assuming `id.json` — this machine uses a different name, and hardcoding the
  // default makes the suite unrunnable for no reason.
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? (execSync('solana config get', { encoding: 'utf8' })
      .match(/Keypair Path:\s*(.+)/)?.[1]?.trim())
    ?? join(homedir(), '.config/solana/id.json');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    readFileSync(keypairPath, 'utf8'),
  )));
  const wallet = new anchor.Wallet(kp);
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: 'confirmed' });

  const idl = JSON.parse(readFileSync(
    join(__dirname, '..', 'target/idl/mempire_rollup.json'), 'utf8',
  ));
  const programId = new PublicKey(idl.address);
  const baseProgram = new anchor.Program(idl, baseProvider);

  console.log(`\nprogram  ${programId.toBase58()}`);
  console.log(`wallet   ${kp.publicKey.toBase58()}`);
  console.log(`balance  ${(await baseConn.getBalance(kp.publicKey)) / 1e9} SOL`);

  // ── PER ───────────────────────────────────────────────────────────────────
  console.log('\nPER — the match log is sealed to its two seats');

  const matchId = BigInt(Date.now());
  const matchIdLe = Buffer.alloc(8);
  matchIdLe.writeBigUInt64LE(matchId);
  const [logPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('log'), matchIdLe], programId,
  );
  const [permissionPda] = PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, logPda.toBuffer()], PERMISSION_PROGRAM_ID,
  );
  const opponent = Keypair.generate();

  await baseProgram.methods
    .initLog(new anchor.BN(matchId.toString()), [kp.publicKey, opponent.publicKey])
    .accounts({ log: logPda, payer: kp.publicKey, systemProgram: SystemProgram.programId })
    .rpc();

  const funded = await baseConn.getBalance(logPda);
  const logSize = (await baseConn.getAccountInfo(logPda))!.data.length;
  const bareRent = await baseConn.getMinimumBalanceForRentExemption(logSize);
  check('log is pre-funded above its own rent for the permission',
    funded > bareRent, `${funded} lamports vs ${bareRent} bare rent`);

  await baseProgram.methods
    .delegateLog(new anchor.BN(matchId.toString()))
    .accounts({ payer: kp.publicKey, log: logPda, validator: null })
    .rpc();
  await sleep(3000);

  const baseInfo = await baseConn.getAccountInfo(logPda);
  check('base ownership flipped to the delegation program',
    baseInfo?.owner.equals(DELEGATION_PROGRAM_ID) ?? false,
    baseInfo?.owner.toBase58());

  const status = await routerStatus(logPda);
  check('router reports the log delegated', status?.isDelegated === true,
    status?.fqdn ?? 'no fqdn');
  const erUrl: string | null = status?.fqdn ?? null;
  if (!erUrl) {
    console.log('\n  router returned no ER endpoint — cannot continue');
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }

  const erConn = new Connection(erUrl, { commitment: 'confirmed' });
  const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' });
  const erProgram = new anchor.Program(idl, erProvider);

  const erInfo = await erConn.getAccountInfo(logPda);
  check('ER clone is owned by our program again',
    erInfo?.owner.equals(programId) ?? false, erInfo?.owner.toBase58());

  // Seal.
  try {
    await erProgram.methods.sealLog()
      .accounts({
        payer: kp.publicKey,
        log: logPda,
        permission: permissionPda,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    await sleep(1500);
    const perm = await erConn.getAccountInfo(permissionPda);
    check('permission account exists on the ER under the permission program',
      (perm?.owner.equals(PERMISSION_PROGRAM_ID) ?? false) && (perm?.data.length ?? 0) > 0,
      perm ? `${perm.data.length}B owned by ${perm.owner.toBase58().slice(0, 8)}…` : 'absent');
    // The permission is ER-local: it must NOT appear on the base layer.
    const permOnBase = await baseConn.getAccountInfo(permissionPda);
    check('no base-layer permission account was created', permOnBase === null,
      permOnBase ? 'unexpectedly present on base' : 'ER-local as designed');
  } catch (e: any) {
    check('seal_log succeeded', false, String(e?.message ?? e).slice(0, 140));
  }

  // Sealing twice must be a no-op, not a failure — clients retry ER transactions.
  try {
    await erProgram.methods.sealLog()
      .accounts({
        payer: kp.publicKey,
        log: logPda,
        permission: permissionPda,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    check('sealing an already-sealed log is idempotent', true);
  } catch (e: any) {
    check('sealing an already-sealed log is idempotent', false,
      String(e?.message ?? e).slice(0, 120));
  }

  // Unseal, then end. Two instructions on purpose — folding the close into
  // `end_log` as optional accounts broke every existing caller, because Anchor
  // substitutes the program id for an omitted optional and these were `mut`.
  try {
    await erProgram.methods.unsealLog()
      .accounts({
        payer: kp.publicKey,
        log: logPda,
        permission: permissionPda,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    await sleep(1200);
    const permMid = await erConn.getAccountInfo(permissionPda);
    check('unseal_log closes the permission and refunds the log',
      permMid === null || permMid.data.length === 0,
      permMid ? `${permMid.data.length}B left` : 'closed');

    // A second unseal is expected to fail at transaction verification — the
    // permission account is gone, so it cannot be loaded writable. What matters
    // is that this is harmless: settlement must still go through.
    let secondUnsealThrew = false;
    try {
      await erProgram.methods.unsealLog()
        .accounts({
          payer: kp.publicKey,
          log: logPda,
          permission: permissionPda,
          ephemeralVault: EPHEMERAL_VAULT_ID,
          permissionProgram: PERMISSION_PROGRAM_ID,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .rpc();
    } catch { secondUnsealThrew = true; }
    console.log(`        (second unseal ${secondUnsealThrew ? 'rejected, as expected' : 'succeeded'} — either way settlement must survive)`);

    // `end_log` keeps the four accounts it always had. This is the regression
    // guard: the app's settlement path sends exactly these.
    await erProgram.methods.endLog(0, new anchor.BN(1234))
      .accounts({
        payer: kp.publicKey,
        log: logPda,
        magicContext: MAGIC_CONTEXT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    check('end_log still takes only payer/log/magic — settlement unchanged', true);
    await sleep(9000);
    const backOnBase = await baseConn.getAccountInfo(logPda);
    check('log came back to base owned by our program',
      backOnBase?.owner.equals(programId) ?? false, backOnBase?.owner.toBase58());
  } catch (e: any) {
    check('unseal_log then end_log undelegated cleanly', false,
      String(e?.message ?? e).slice(0, 140));
  }

  // ── VRF ───────────────────────────────────────────────────────────────────
  console.log('\nVRF — chest tiers come from the oracle, not the client');

  const [chestsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('chests'), kp.publicKey.toBuffer()], programId,
  );

  const existing = await baseConn.getAccountInfo(chestsPda);
  if (!existing) {
    await baseProgram.methods.initChests()
      .accounts({ chests: chestsPda, owner: kp.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log('  (created chest rail)');
  } else if (existing.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log('  (rail already delegated from a previous run)');
  }

  const chestStatus0 = await routerStatus(chestsPda);
  if (chestStatus0?.isDelegated !== true) {
    await baseProgram.methods.delegateChests()
      .accounts({ owner: kp.publicKey, chests: chestsPda, validator: null })
      .rpc();
    await sleep(3000);
  }
  const chestStatus = await routerStatus(chestsPda);
  check('chest rail is delegated', chestStatus?.isDelegated === true,
    chestStatus?.fqdn ?? 'no fqdn');
  const chestErUrl: string = chestStatus?.fqdn ?? erUrl;
  const chestEr = new Connection(chestErUrl, { commitment: 'confirmed' });
  const chestProgram = new anchor.Program(
    idl, new anchor.AnchorProvider(chestEr, wallet, { commitment: 'confirmed' }),
  );

  // Reclaim any slot a previous run filled. This is also the assertion that
  // claim_chest works: without it the rail is write-once and this suite could
  // only ever run four times.
  {
    const rail: any = await chestProgram.account.playerChests.fetch(chestsPda);
    const filled = rail.slots
      .map((sl: any, i: number) => (sl.state === 2 ? i : -1))
      .filter((i: number) => i >= 0);
    let claimed = 0;
    for (const i of filled) {
      try {
        await chestProgram.methods.claimChest(i)
          .accounts({ chests: chestsPda, owner: kp.publicKey })
          .rpc();
        claimed += 1;
      } catch (e: any) {
        check(`claim_chest frees slot ${i}`, false, String(e?.msg ?? e?.message ?? e).slice(0, 110));
      }
    }
    if (filled.length) {
      const after: any = await chestProgram.account.playerChests.fetch(chestsPda);
      const stillFilled = after.slots.filter((sl: any) => sl.state === 2).length;
      check('claim_chest frees every filled slot', claimed === filled.length && stillFilled === 0,
        `claimed ${claimed}/${filled.length}, ${stillFilled} still filled`);
    }
  }

  // Find a free slot to roll into.
  const railBefore: any = await chestProgram.account.playerChests.fetch(chestsPda);
  const freeSlot = railBefore.slots.findIndex((s: any) => s.state === 0);
  check('a free chest slot is available', freeSlot >= 0, `slot ${freeSlot}`);
  const otherSlot = railBefore.slots.findIndex(
    (sl: any, i: number) => sl.state === 0 && i !== freeSlot,
  );

  if (freeSlot >= 0 && railBefore.pendingSlot === 255) {
    // The base-layer queue must be rejected from inside the rollup.
    try {
      await chestProgram.methods.requestChest(freeSlot, 7)
        .accounts({
          payer: kp.publicKey, chests: chestsPda, owner: kp.publicKey,
          oracleQueue: BASE_QUEUE,
        })
        .rpc();
      check('base-layer queue is refused from the rollup', false, 'it was accepted');
    } catch (e: any) {
      const text = `${e?.msg ?? ''} ${e?.message ?? ''} ${String(e)} ${(e?.logs ?? []).join(' ')}`;
      check('base-layer queue is refused from the rollup',
        /WrongQueue|not a delegated/i.test(text), 'rejected');
    }

    // Two requests in ONE transaction, both on the same slot.
    //
    // Not two transactions: ER VRF round-trips in under 50ms, which is faster
    // than a second RPC call from here. The first version of this test raced
    // the oracle, lost, and got `SlotNotEmpty` because the callback had already
    // filled the slot — proving the oracle is quick, and proving nothing at all
    // about the guard. Inside one transaction there is no window for a
    // callback, so `RequestInFlight` on instruction 1 is the only way out.
    //
    // Aiming both at the same slot also means this needs just one free slot,
    // and a reverted transaction leaves that slot untouched for the real
    // request below.
    try {
      const one = await chestProgram.methods.requestChest(freeSlot, 11)
        .accounts({
          payer: kp.publicKey, chests: chestsPda, owner: kp.publicKey,
          oracleQueue: EPHEMERAL_QUEUE,
        })
        .instruction();
      const two = await chestProgram.methods.requestChest(freeSlot, 12)
        .accounts({
          payer: kp.publicKey, chests: chestsPda, owner: kp.publicKey,
          oracleQueue: EPHEMERAL_QUEUE,
        })
        .instruction();
      await chestProgram.provider.sendAndConfirm!(new Transaction().add(one, two), []);
      check('two requests in one transaction are refused as RequestInFlight',
        false, 'both were accepted — the in-flight guard did not fire');
    } catch (e: any) {
      const text = `${e?.msg ?? ''} ${e?.message ?? ''} ${String(e)} ${(e?.logs ?? []).join(' ')}`;
      const inFlight = /RequestInFlight|already in flight|0x1775/i.test(text);
      check('two requests in one transaction are refused as RequestInFlight',
        inFlight,
        inFlight ? 'guard fired on instruction 1'
          : `wrong reason: ${text.replace(/\s+/g, ' ').slice(0, 150)}`);
    }

    // An empty slot has nothing to claim.
    try {
      await chestProgram.methods.claimChest(freeSlot)
        .accounts({ chests: chestsPda, owner: kp.publicKey })
        .rpc();
      check('claiming an empty slot is refused', false, 'it was accepted');
    } catch (e: any) {
      const text = `${e?.msg ?? ''} ${e?.message ?? ''} ${String(e)} ${(e?.logs ?? []).join(' ')}`;
      check('claiming an empty slot is refused',
        /SlotNotFilled|nothing to claim/i.test(text), 'rejected');
    }

    // The real request.
    let requested = false;
    try {
      const sig = await chestProgram.methods.requestChest(freeSlot, 42)
        .accounts({
          payer: kp.publicKey, chests: chestsPda, owner: kp.publicKey,
          oracleQueue: EPHEMERAL_QUEUE,
        })
        .rpc();
      requested = true;
      check('randomness request accepted by the oracle queue', true, sig.slice(0, 16) + '…');
    } catch (e: any) {
      check('randomness request accepted by the oracle queue', false,
        String(e?.msg ?? e?.message ?? e).slice(0, 160));
    }

    if (requested) {
      // Acceptance is not an outcome — poll for the separate callback.
      let filled: any = null;
      for (let i = 0; i < 40; i += 1) {
        await sleep(1500);
        const rail: any = await chestProgram.account.playerChests.fetch(chestsPda);
        if (rail.slots[freeSlot].state === 2) { filled = rail; break; }
      }
      if (filled) {
        const slot = filled.slots[freeSlot];
        check('the oracle callback filled the slot', true,
          `tier ${slot.tier}, nonce ${slot.nonce}`);
        check('tier is inside the published range', slot.tier >= 0 && slot.tier <= 3,
          `tier=${slot.tier}`);
        check('the randomness that produced it is stored for verification',
          (slot.randomness as number[]).some((b) => b !== 0),
          `${(slot.randomness as number[]).slice(0, 4).join(',')}…`);
        check('the request is no longer in flight', filled.pendingSlot === 255,
          `pendingSlot=${filled.pendingSlot}`);
      } else {
        const rail: any = await chestProgram.account.playerChests.fetch(chestsPda);
        check('the oracle callback filled the slot', false,
          `still state=${rail.slots[freeSlot].state} after 60s`);
      }
    }
  } else if (railBefore.pendingSlot !== 255) {
    console.log(`  (skipping: a request is already in flight on slot ${railBefore.pendingSlot})`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
