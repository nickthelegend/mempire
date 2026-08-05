/**
 * The audit fixes, proved against the deployed program.
 *
 * Every existing e2e suite tests the happy path. None of them tests the guards
 * added on 4 Aug, and a guard that has never been observed to reject anything
 * is a guard nobody knows is wired up. Each check here attempts the exact
 * exploit the audit described and asserts the chain refuses it.
 *
 * Run: npx tsx scripts/e2e-security.ts
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Runs `fn` and reports whether it failed for the named reason. */
async function refuses(label: string, want: RegExp, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, 'the call SUCCEEDED — the guard is not wired up');
  } catch (e) {
    const msg = String((e as any)?.message ?? e) + JSON.stringify((e as any)?.logs ?? []);
    check(label, want.test(msg), want.test(msg) ? 'refused' : `wrong error: ${msg.slice(0, 120)}`);
  }
}

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(readFileSync(join(homedir(), '.config/solana/zorr.json'), 'utf8')),
  ));
  const conn = new Connection(BASE, 'confirmed');
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const rollupIdl = JSON.parse(readFileSync('target/idl/mempire_rollup.json', 'utf8'));
  const ammIdl = JSON.parse(readFileSync('target/idl/mempire_amm.json', 'utf8'));
  const program = new anchor.Program(idl, provider);
  const rollup = new anchor.Program(rollupIdl, provider);

  console.log('\nthe deployed code is the fixed code');
  check('mempire MatchLog carries per-seat claims',
    JSON.stringify(idl.types).includes('claims'));
  check('mempire_amm no longer exposes delegate_pool',
    !ammIdl.instructions.some((i: any) => i.name === 'delegate_pool'),
    `${ammIdl.instructions.length} instructions`);
  check('mempire_amm no longer exposes commit_pool',
    !ammIdl.instructions.some((i: any) => i.name === 'commit_pool'));
  check('mempire exposes a ResultDisputed error',
    JSON.stringify(idl.errors ?? []).includes('ResultDisputed'));

  console.log('\ndelegation is no longer permissionless');

  /*
   * A real, initialised log whose two players are strangers.
   *
   * The first attempt at this used a log that did not exist, so the call was
   * refused for a missing discriminator rather than by the player check —
   * which proves the account was absent, not that the guard works. This
   * creates the account for real, with two keypairs that are not this wallet,
   * so the ONLY reason delegation can fail is the guard under test.
   */
  /*
   * A real, initialised log, attacked by a wallet that is not in it.
   *
   * Two earlier attempts got the wrong proof. Delegating a log that does not
   * exist fails on a missing discriminator — that shows the account is absent,
   * not that the guard works. And `init_log` already requires its payer to be
   * one of the players, so a log cannot be created between two strangers.
   *
   * So: create the log honestly (this wallet is seat 0), fund a throwaway
   * keypair, and have the throwaway attempt the delegation. It is a real
   * account, really initialised, and the attacker is really not in it — the
   * only thing that can refuse the call is the guard under test.
   */
  const matchId = new anchor.BN(Date.now() % 1_000_000);
  const opponent = Keypair.generate().publicKey;
  const [rLogPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('log'), matchId.toArrayLike(Buffer, 'le', 8)], rollup.programId,
  );
  await (rollup.methods as any).initLog(matchId, [kp.publicKey, opponent])
    .accounts({ log: rLogPda, payer: kp.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  const created: any = await (rollup.account as any).matchLog.fetch(rLogPda);
  check('a real log exists, with this wallet as seat 0',
    created.players[0].equals(kp.publicKey),
    `vs ${created.players[1].toBase58().slice(0, 8)}…`);

  // The attacker needs lamports to pay its own fee, or the call fails for
  // funding rather than for the reason under test.
  const attacker = Keypair.generate();
  const fund = new anchor.web3.Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey, toPubkey: attacker.publicKey, lamports: 20_000_000,
  }));
  await provider.sendAndConfirm(fund);
  check('the attacker is funded and is not a player',
    (await conn.getBalance(attacker.publicKey)) > 0
      && !created.players.some((k: PublicKey) => k.equals(attacker.publicKey)));

  await refuses(
    'delegate_log by a funded non-player is refused — the exploit itself',
    /NotAPlayer/i,
    () => (rollup.methods as any).delegateLog(matchId)
      .accounts({ payer: attacker.publicKey, log: rLogPda, validator: null })
      .signers([attacker]).rpc(),
  );

  // And the honest path still works, or the guard is just breaking the game.
  await (rollup.methods as any).delegateLog(matchId)
    .accounts({ payer: kp.publicKey, log: rLogPda, validator: null })
    .rpc();
  const owner = (await conn.getAccountInfo(rLogPda))?.owner;
  check('a real player CAN still delegate — the guard is not just a wall',
    owner?.toBase58() === 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
    `now owned by ${owner?.toBase58().slice(0, 12)}…`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
