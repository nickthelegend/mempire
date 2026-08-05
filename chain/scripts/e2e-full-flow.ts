/**
 * The whole MagicBlock flow, exactly as a real match runs it.
 *
 * The other suites test pieces. This one walks the lifecycle end to end in
 * order, with two distinct funded players, and records the real transaction
 * signature for every step — so "it works" means a signature you can open in an
 * explorer, not a green line.
 *
 *   base    init_log            create the log, pre-funded for its permission
 *   base    delegate_log        hand it to a rollup
 *   ER      seal_log            PER: seal it to the two seats
 *   ER      play_card ×3        both players, alternating
 *   ER      checkpoint          state hash committed mid-match
 *   ER      unseal_log          PER: close the seal, refund the log
 *   ER      end_log             commit + undelegate
 *   base    close_log           reclaim rent
 *
 *   base    init_chests         create the chest rail
 *   base    delegate_chests     hand it to a rollup
 *   ER      request_chest       VRF: ask the oracle
 *   ER      (oracle callback)   VRF: the separate fulfilment
 *   ER      claim_chest         take the chest, free the slot
 *   ER      commit_chests       commit + undelegate the rail
 *
 * Negative cases are interleaved where they belong, because a flow that only
 * proves the happy path proves very little about a program holding money.
 *
 * Run: BASE_RPC=https://api.devnet.solana.com npx tsx scripts/e2e-full-flow.ts
 */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
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
const PERMISSION_SEED = Buffer.from('permission:');
const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const sigs: { step: string; sig: string }[] = [];

const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};
const record = (step: string, sig: string) => {
  sigs.push({ step, sig });
  console.log(`        tx ${sig}`);
};

/**
 * Asserts a transaction was refused, and refused for the *expected* reason.
 *
 * Resolves the variant's code and message from the IDL rather than guessing at
 * wording. Anchor surfaces an ER rejection in several shapes — sometimes a
 * numeric code, sometimes only the `#[msg]` text, sometimes inside logs — and
 * matching on a hand-written regex means a correct refusal reads as a failure
 * the moment a message is reworded. Refused-for-the-wrong-reason still fails,
 * which is the point: `SlotNotEmpty` where `RequestInFlight` was expected would
 * mean a guard never ran.
 */
function refusedAs(
  e: any, variant: string, idl: any,
): { ok: boolean; text: string } {
  const want = (idl.errors ?? []).find((x: any) => x.name === variant);
  const text = [
    e?.msg, e?.message, String(e), ...(Array.isArray(e?.logs) ? e.logs : []),
  ].join(' ').replace(/\s+/g, ' ');
  if (!want) return { ok: false, text: `unknown error variant ${variant}` };
  const ok = e?.code === want.code
    || text.includes(want.msg)
    || text.includes(`0x${want.code.toString(16)}`)
    || text.includes(variant);
  return { ok, text: ok ? `${variant} (${want.code})` : text.slice(0, 130) };
}

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
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? (execSync('solana config get', { encoding: 'utf8' })
      .match(/Keypair Path:\s*(.+)/)?.[1]?.trim())
    ?? join(homedir(), '.config/solana/id.json');
  const playerA = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    readFileSync(keypairPath, 'utf8'),
  )));
  // A second *real* signer. The seat check is the thing most likely to be
  // wrong, and it cannot be exercised with one keypair playing both sides.
  const playerB = Keypair.generate();
  const stranger = Keypair.generate();

  const idl = JSON.parse(readFileSync(
    join(__dirname, '..', 'target/idl/mempire_rollup.json'), 'utf8',
  ));
  const programId = new PublicKey(idl.address);
  const progFor = (kp: Keypair, conn: Connection) => new anchor.Program(
    idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }),
  );
  const baseA = progFor(playerA, baseConn);

  console.log(`\nprogram   ${programId.toBase58()}`);
  console.log(`player A  ${playerA.publicKey.toBase58()}`);
  console.log(`player B  ${playerB.publicKey.toBase58()}  (funded below)`);
  console.log(`balance   ${(await baseConn.getBalance(playerA.publicKey)) / 1e9} SOL\n`);

  // Fund B and the stranger enough to sign on both layers.
  for (const [who, kp] of [['B', playerB], ['stranger', stranger]] as const) {
    const sig = await baseConn.requestAirdrop(kp.publicKey, 0).catch(() => null);
    void sig;
    const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({
      fromPubkey: playerA.publicKey,
      toPubkey: kp.publicKey,
      lamports: 0.03 * LAMPORTS_PER_SOL,
    }));
    await anchor.web3.sendAndConfirmTransaction(baseConn, tx, [playerA], {
      commitment: 'confirmed',
    });
    console.log(`  funded ${who} with 0.03 SOL`);
  }

  // ═══ MATCH LIFECYCLE ═══════════════════════════════════════════════════════
  console.log('\n═══ 1. base layer: create the log ═══');
  const matchId = BigInt(Date.now());
  const matchIdLe = Buffer.alloc(8);
  matchIdLe.writeBigUInt64LE(matchId);
  const [log] = PublicKey.findProgramAddressSync([Buffer.from('log'), matchIdLe], programId);
  const [permission] = PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, log.toBuffer()], PERMISSION_PROGRAM_ID,
  );

  {
    const sig = await baseA.methods
      .initLog(new anchor.BN(matchId.toString()), [playerA.publicKey, playerB.publicKey])
      .accounts({ log, payer: playerA.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    record('init_log', sig);
    const acc: any = await (baseA.account as any).matchLog.fetch(log);
    check('both seats recorded on base layer',
      acc.players[0].equals(playerA.publicKey) && acc.players[1].equals(playerB.publicKey));
    const bal = await baseConn.getBalance(log);
    const rent = await baseConn.getMinimumBalanceForRentExemption(
      (await baseConn.getAccountInfo(log))!.data.length,
    );
    check('log pre-funded for its ephemeral permission', bal > rent,
      `+${bal - rent} lamports over bare rent`);
  }

  console.log('\n═══ 2. base layer: delegate to a rollup ═══');
  let erUrl = '';
  {
    const sig = await baseA.methods
      .delegateLog(new anchor.BN(matchId.toString()))
      .accounts({ payer: playerA.publicKey, log, validator: null })
      .rpc();
    record('delegate_log', sig);
    await sleep(3500);
    const info = await baseConn.getAccountInfo(log);
    check('base ownership is now the delegation program',
      info?.owner.equals(DELEGATION_PROGRAM_ID) ?? false, info?.owner.toBase58());
    const st = await routerStatus(log);
    check('router placed it and reports delegated', st?.isDelegated === true, st?.fqdn);
    erUrl = st?.fqdn ?? '';
    if (!erUrl) { console.log('\n  no ER endpoint — stopping'); process.exit(1); }
  }

  const erConn = new Connection(erUrl, { commitment: 'confirmed' });
  const erA = progFor(playerA, erConn);
  const erB = progFor(playerB, erConn);
  const erStranger = progFor(stranger, erConn);

  {
    const info = await erConn.getAccountInfo(log);
    check('the ER clone is owned by our program again',
      info?.owner.equals(programId) ?? false, info?.owner.toBase58());
  }

  console.log('\n═══ 3. rollup: seal the log (PER) ═══');
  {
    const sig = await erA.methods.sealLog()
      .accounts({
        payer: playerA.publicKey, log, permission,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    record('seal_log', sig);
    await sleep(1500);
    const perm = await erConn.getAccountInfo(permission);
    check('permission lives on the ER under the permission program',
      (perm?.owner.equals(PERMISSION_PROGRAM_ID) ?? false) && (perm?.data.length ?? 0) > 0,
      perm ? `${perm.data.length} bytes` : 'absent');
    check('and does NOT exist on the base layer',
      (await baseConn.getAccountInfo(permission)) === null, 'ER-local, as the model requires');
  }

  console.log('\n═══ 3b. rollup: session keys (zero wallet popups) ═══');
  const sessionA = Keypair.generate();
  {
    // Seat A authorises a throwaway key. This is the one wallet signature a
    // match needs; everything after it is signed by the session.
    const sig = await erA.methods.openSession(sessionA.publicKey, new anchor.BN(900))
      .accounts({ log, player: playerA.publicKey })
      .rpc();
    record('open_session', sig);
    const acc: any = await (erA.account as any).matchLog.fetch(log);
    check('the session is recorded against the right seat',
      acc.sessionSigners[0].equals(sessionA.publicKey)
      && acc.sessionSigners[1].equals(PublicKey.default),
      'seat 0 only');
    check('it carries an on-chain expiry, not a UI timer',
      Number(acc.sessionExpires[0]) > Math.floor(Date.now() / 1000),
      `expires ${acc.sessionExpires[0]}`);

    // A session key needs no funding: rollup fees are zero.
    const erSession = progFor(sessionA, erConn);
    const playSig = await erSession.methods.playCard(100, 1, 5120, 13312)
      .accounts({ log, player: sessionA.publicKey })
      .rpc();
    record('play_card (session key, unfunded)', playSig);
    const after: any = await (erA.account as any).matchLog.fetch(log);
    const last = after.plays[after.plays.length - 1];
    check('the session play was attributed to the seat, not to the key',
      last.player === 0 && last.tick === 100, `seat ${last.player} tick ${last.tick}`);

    // A key nobody authorised must still be refused.
    try {
      await progFor(stranger, erConn).methods.playCard(110, 0, 4096, 12288)
        .accounts({ log, player: stranger.publicKey })
        .rpc();
      check('an unauthorised key is still refused', false, 'it was accepted');
    } catch (e) {
      const r = refusedAs(e, 'NotAPlayer', idl);
      check('an unauthorised key is still refused', r.ok, r.text);
    }

    // Revoke, then prove the key is dead.
    const revoke = await erA.methods.closeSession()
      .accounts({ log, player: playerA.publicKey })
      .rpc();
    record('close_session', revoke);
    try {
      await erSession.methods.playCard(120, 0, 4096, 12288)
        .accounts({ log, player: sessionA.publicKey })
        .rpc();
      check('a revoked session cannot write', false, 'the revoked key still wrote');
    } catch (e) {
      const r = refusedAs(e, 'NotAPlayer', idl);
      check('a revoked session cannot write', r.ok, r.text);
    }
  }

  console.log('\n═══ 4. rollup: both players actually play ═══');
  {
    const plays: [anchor.Program, Keypair, string, number][] = [
      [erA, playerA, 'A', 200], [erB, playerB, 'B', 240], [erA, playerA, 'A', 280],
    ];
    for (const [prog, kp, who, tick] of plays) {
      const sig = await prog.methods.playCard(tick, 0, 4096, 12288)
        .accounts({ log, player: kp.publicKey })
        .rpc();
      record(`play_card (${who}, tick ${tick})`, sig);
    }
    const acc: any = await (erA.account as any).matchLog.fetch(log);
    // Four now: the session play from 3b, then these three.
    check('all plays are on the rollup', acc.plays.length === 4,
      `${acc.plays.length} entries`);
    check('seats were attributed correctly',
      acc.plays.map((p: any) => p.player).join(',') === '0,0,1,0',
      acc.plays.map((p: any) => p.player).join(','));
  }

  console.log('\n═══ 5. rollup: a stranger cannot write ═══');
  {
    try {
      await erStranger.methods.playCard(80, 0, 4096, 12288)
        .accounts({ log, player: stranger.publicKey })
        .rpc();
      check('non-player rejected', false, 'the write was accepted');
    } catch (e) {
      const r = refusedAs(e, 'NotAPlayer', idl);
      check('non-player rejected as NotAPlayer', r.ok, r.text);
    }
    try {
      await erA.methods.playCard(5, 0, 4096, 12288)
        .accounts({ log, player: playerA.publicKey })
        .rpc();
      check('a play in the past is rejected', false, 'it was accepted');
    } catch (e) {
      const r = refusedAs(e, 'StaleTick', idl);
      check('a play in the past is rejected as StaleTick', r.ok, r.text);
    }
  }

  console.log('\n═══ 6. rollup: checkpoint the state hash ═══');
  {
    const sig = await erA.methods.checkpoint(300, new anchor.BN('123456789'))
      .accounts({ log, player: playerA.publicKey })
      .rpc();
    record('checkpoint', sig);
    const acc: any = await (erA.account as any).matchLog.fetch(log);
    check('checkpoint recorded', acc.checkpoints === 1 && acc.lastHash.toString() === '123456789',
      `n=${acc.checkpoints} hash=${acc.lastHash}`);
  }

  // The chest rail, created and delegated *before* the match ends.
  //
  // `end_log` credits the win's entitlement on the rollup — the one place it
  // can see both the log and the rail at once — and afterwards the log is back
  // on base layer. A rail created later has missed its moment, which is why
  // the app calls `ensureChestRail` at match start, not at reward time.
  const [rail] = PublicKey.findProgramAddressSync(
    [Buffer.from('chests'), playerA.publicKey.toBuffer()], programId,
  );
  {
    if (!(await baseConn.getAccountInfo(rail))) {
      const sig = await baseA.methods.initChests()
        .accounts({ chests: rail, owner: playerA.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      record('init_chests', sig);
    }
    let st = await routerStatus(rail);
    if (st?.isDelegated !== true) {
      const sig = await baseA.methods.delegateChests()
        .accounts({ owner: playerA.publicKey, chests: rail, validator: null })
        .rpc();
      record('delegate_chests', sig);
      await sleep(3500);
      st = await routerStatus(rail);
    }
    check('chest rail is delegated before the match ends', st?.isDelegated === true, st?.fqdn);
  }

  console.log('\n═══ 7. rollup: unseal, then commit + undelegate ═══');
  {
    const sig = await erA.methods.unsealLog()
      .accounts({
        payer: playerA.publicKey, log, permission,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    record('unseal_log', sig);
    await sleep(1200);
    const perm = await erConn.getAccountInfo(permission);
    check('the seal is closed', perm === null || perm.data.length === 0,
      perm ? `${perm.data.length} bytes left` : 'closed, rent refunded to the log');

    // Naming the winner's rail is what turns the win into a chest. It is
    // optional in the program so a first-ever match still settles without one,
    // but Anchor cannot infer an omitted optional — present or null, it is
    // named explicitly.
    const endSig = await erA.methods.endLog(0, new anchor.BN('987654321'))
      .accounts({
        payer: playerA.publicKey, log, winnerChests: rail,
        magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .rpc();
    record('end_log', endSig);

    let home: PublicKey | null = null;
    for (let i = 0; i < 45; i += 1) {
      await sleep(1500);
      const info = await baseConn.getAccountInfo(log);
      if (info?.owner.equals(programId)) { home = info.owner; break; }
    }
    check('the log came home to Solana', home !== null, home?.toBase58() ?? 'still delegated');
    if (home) {
      const acc: any = await (baseA.account as any).matchLog.fetch(log);
      check('rollup state survived the commit',
        acc.plays.length === 4 && acc.ended === true
          && acc.lastHash.toString() === '987654321' && acc.winner === 0,
        `${acc.plays.length} plays, winner ${acc.winner}, hash ${acc.lastHash}`);
      check('a play kept its exact contents',
        acc.plays[2].tick === 240 && acc.plays[2].player === 1 && acc.plays[2].x === 4096,
        `tick ${acc.plays[2].tick} seat ${acc.plays[2].player} x ${acc.plays[2].x}`);
    }
  }

  console.log('\n═══ 8. base layer: reclaim the rent ═══');
  {
    const before = await baseConn.getBalance(playerA.publicKey);
    const sig = await baseA.methods.closeLog()
      .accounts({ log, payer: playerA.publicKey })
      .rpc();
    record('close_log', sig);
    const after = await baseConn.getBalance(playerA.publicKey);
    check('the log is gone', (await baseConn.getAccountInfo(log)) === null);
    check('rent came back to the player', after > before,
      `+${((after - before) / LAMPORTS_PER_SOL).toFixed(5)} SOL`);
  }

  // ═══ CHESTS ════════════════════════════════════════════════════════════════
  console.log('\n═══ 9. the VRF chest lifecycle ═══');
  {
    const st = await routerStatus(rail);

    const chestEr = new Connection(st?.fqdn ?? erUrl, { commitment: 'confirmed' });
    const chestProg = progFor(playerA, chestEr);

    // Reclaim whatever a previous run left, so the rail is not write-once.
    const before: any = await (chestProg.account as any).playerChests.fetch(rail);
    for (let i = 0; i < before.slots.length; i += 1) {
      if (before.slots[i].state === 2) {
        await chestProg.methods.claimChest(i)
          .accounts({ chests: rail, owner: playerA.publicKey }).rpc();
      }
    }
    const rolled: any = await (chestProg.account as any).playerChests.fetch(rail);
    const slot = rolled.slots.findIndex((s: any) => s.state === 0);
    check('a slot is free to roll into', slot >= 0, `slot ${slot}`);

    if (slot >= 0 && rolled.pendingSlot === 255) {
      // Only the owner may roll their own rail.
      try {
        await progFor(stranger, chestEr).methods.requestChest(slot, 5)
          .accounts({
            payer: stranger.publicKey, chests: rail, owner: stranger.publicKey,
            oracleQueue: EPHEMERAL_QUEUE,
          })
          .rpc();
        check("a stranger cannot roll someone else's rail", false, 'it was accepted');
      } catch (e) {
        // Anchor's own constraint failure, not one of ours — matched on text
        // because it never reaches our error enum.
        const text = [e?.msg, e?.message, String(e), ...(e?.logs ?? [])].join(' ');
        const ok = /ConstraintHasOne|has one|2001|ConstraintSeeds|2006|A seeds constraint/i.test(text);
        check("a stranger cannot roll someone else's rail", ok,
          ok ? 'refused by the has_one constraint' : text.replace(/\s+/g, ' ').slice(0, 130));
      }

      const sig = await chestProg.methods.requestChest(slot, 99)
        .accounts({
          payer: playerA.publicKey, chests: rail, owner: playerA.publicKey,
          oracleQueue: EPHEMERAL_QUEUE,
        })
        .rpc();
      record('request_chest', sig);

      let filled: any = null;
      for (let i = 0; i < 40; i += 1) {
        await sleep(1500);
        const now: any = await (chestProg.account as any).playerChests.fetch(rail);
        if (now.slots[slot].state === 2) { filled = now; break; }
      }
      check('the oracle called back and filled the slot', filled !== null,
        filled ? `tier ${filled.slots[slot].tier}` : 'no callback within 60s');

      if (filled) {
        const c = filled.slots[slot];
        check('the tier is inside the published 0–3 range', c.tier >= 0 && c.tier <= 3, `tier ${c.tier}`);
        check('the randomness that produced it is stored',
          (c.randomness as number[]).some((b) => b !== 0),
          `0x${(c.randomness as number[]).slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')}…`);
        check('the request is settled, not still pending', filled.pendingSlot === 255);

        const claimSig = await chestProg.methods.claimChest(slot)
          .accounts({ chests: rail, owner: playerA.publicKey })
          .rpc();
        record('claim_chest', claimSig);
        const after: any = await (chestProg.account as any).playerChests.fetch(rail);
        check('claiming freed the slot', after.slots[slot].state === 0);
      }
    }

    // Commit the rail home so the run leaves nothing delegated.
    try {
      const sig = await chestProg.methods.commitChests()
        .accounts({ owner: playerA.publicKey, chests: rail,
          magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID })
        .rpc();
      record('commit_chests', sig);
      let home = false;
      for (let i = 0; i < 40; i += 1) {
        await sleep(1500);
        const info = await baseConn.getAccountInfo(rail);
        if (info?.owner.equals(programId)) { home = true; break; }
      }
      check('the chest rail committed back to Solana', home);
    } catch (e: any) {
      check('the chest rail committed back to Solana', false,
        String(e?.msg ?? e?.message ?? e).slice(0, 120));
    }
  }

  console.log('\n═══ transactions this run ═══');
  for (const { step, sig } of sigs) console.log(`  ${step.padEnd(26)} ${sig}`);
  console.log(`\n${pass} passed, ${fail} failed  ·  ${sigs.length} real transactions\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
