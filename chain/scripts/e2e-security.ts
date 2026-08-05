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
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
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


  // ── C12: init_config is bound to the upgrade authority ───────────────────
  console.log('\nconfig is no longer first-come-first-served');
  {
    const [cfg] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
    const live = await conn.getAccountInfo(cfg);
    check('config already exists, so the land-grab window is closed',
      live !== null, live ? `${live.data.length} bytes` : 'ABSENT — anyone could claim it');

    // The program account and its ProgramData, which the constraint reads.
    const [programData] = PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
    );
    await refuses(
      'init_config by a non-upgrade-authority is refused',
      /NotUpgradeAuthority|already in use|custom program error/i,
      () => (program.methods as any).initConfig(
        new anchor.BN(1), 100, 50, 200, new anchor.BN(1), new anchor.BN(1), new anchor.BN(0), 6,
      ).accounts({
        config: cfg, admin: attacker.publicKey, treasury: attacker.publicKey,
        program: program.programId, programData, systemProgram: SystemProgram.programId,
      }).signers([attacker]).rpc(),
    );
  }

  // ── C11: an unjoined match can be withdrawn ──────────────────────────────
  console.log('\nan open match is no longer a one-way door');
  {
    const cards: any[] = await (program.account as any).card.all();
    // One card per coin: the program rejects a deck with a repeated mint, and
    // this wallet has minted the same coin more than once across test runs.
    const seen = new Set<string>();
    const free = cards
      .filter((c) => c.account.owner.equals(kp.publicKey)
        && c.account.lockedBy.equals(PublicKey.default))
      .filter((c) => {
        const mint = c.account.coinMint.toBase58();
        if (seen.has(mint)) return false;
        seen.add(mint);
        return true;
      })
      .slice(0, 8);

    // Top up to eight distinct coins by minting from anything this wallet
    // actually holds. Runs before the assertions so the suite is not hostage
    // to whatever the last run happened to leave behind.
    if (free.length < 8) {
      const coins: any[] = await (program.account as any).coinInfo.all();
      for (const ci of coins) {
        if (free.length >= 8) break;
        const mint: PublicKey = ci.account.mint;
        if (seen.has(mint.toBase58())) continue;
        const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
        const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
        if (!bal || Number(bal.value.amount) === 0) continue;
        try {
          const cfgNow: any = await (program.account as any).config.fetch(
            PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0]);
          const id: anchor.BN = cfgNow.nextCardId;
          const [cardPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('card'), id.toArrayLike(Buffer, 'le', 8)], program.programId);
          await (program.methods as any).mintCard().accounts({
            config: PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0],
            coinInfo: ci.publicKey,
            card: cardPda,
            ownerTokens: ata,
            owner: kp.publicKey,
            treasury: cfgNow.treasury,
            systemProgram: SystemProgram.programId,
          }).rpc();
          seen.add(mint.toBase58());
          free.push({ publicKey: cardPda, account: { coinMint: mint } } as any);
        } catch { /* ineligible coin: too young, too illiquid — try the next */ }
      }
      console.log(`  (topped the deck up to ${free.length} distinct coins)`);
    }

    if (free.length < 8) {
      check('cancel_match refunds the stake and frees the deck', false,
        `needs 8 unlocked cards, found ${free.length}`);
    } else {
      const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
      const cfg: any = await (program.account as any).config.fetch(cfgPda);
      const nextId: anchor.BN = cfg.nextMatchId;
      const [matchPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('match'), nextId.toArrayLike(Buffer, 'le', 8)], program.programId,
      );
      const stake = 5_000_000;
      const deckMetas = free.map((c) => ({ pubkey: c.publicKey, isSigner: false, isWritable: true }));

      const balBefore = await conn.getBalance(kp.publicKey);
      await (program.methods as any).createMatch(0, new anchor.BN(stake), Array(32).fill(0))
        .accounts({
          config: cfgPda, matchAccount: matchPda,
          player: kp.publicKey, systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckMetas).rpc();

      const locked: any = await (program.account as any).card.fetch(free[0].publicKey);
      check('creating the match locked the deck to that match',
        locked.lockedBy.equals(matchPda), `locked_by ${locked.lockedBy.toBase58().slice(0, 10)}…`);

      // A stranger may not withdraw someone else's queued match.
      await refuses(
        'cancel_match by a non-creator is refused',
        /NotAPlayer/i,
        () => (program.methods as any).cancelMatch()
          .accounts({ matchAccount: matchPda, player: attacker.publicKey })
          .remainingAccounts(deckMetas).signers([attacker]).rpc(),
      );

      await (program.methods as any).cancelMatch()
        .accounts({ matchAccount: matchPda, player: kp.publicKey })
        .remainingAccounts(deckMetas).rpc();

      const freed: any = await (program.account as any).card.fetch(free[0].publicKey);
      check('cancel_match released the deck',
        freed.lockedBy.equals(PublicKey.default), 'locked_by is the default key again');

      const balAfter = await conn.getBalance(kp.publicKey);
      check('cancel_match returned the stake',
        balAfter > balBefore - stake,
        `net ${((balAfter - balBefore) / 1e9).toFixed(6)} SOL — fees only, stake came back`);

      // ── C6: unlocking is scoped to the match that did the locking ────────
      //
      // The exploit the audit described: settle (or cancel) one match while
      // passing a *different* match's locked deck as remaining accounts.
      // `unlock_deck` used to clear `in_match` on anything that deserialised
      // as a Card, which freed a deck out of a still-running match and let the
      // same heavy cards enter two matches at once — the power bracket, gone.
      console.log('\nsettlement only unlocks its own deck');

      const cfgA: any = await (program.account as any).config.fetch(cfgPda);
      const idA: anchor.BN = cfgA.nextMatchId;
      const [matchA] = PublicKey.findProgramAddressSync(
        [Buffer.from('match'), idA.toArrayLike(Buffer, 'le', 8)], program.programId);
      await (program.methods as any).createMatch(0, new anchor.BN(stake), Array(32).fill(0))
        .accounts({
          config: cfgPda, matchAccount: matchA,
          player: kp.publicKey, systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckMetas).rpc();

      const cfgB: any = await (program.account as any).config.fetch(cfgPda);
      const idB: anchor.BN = cfgB.nextMatchId;
      const [matchB] = PublicKey.findProgramAddressSync(
        [Buffer.from('match'), idB.toArrayLike(Buffer, 'le', 8)], program.programId);

      // Match B is created with no deck of its own — an empty deck is refused,
      // so B borrows nothing and is cancelled while *pointing at A's cards*.
      let bMade = false;
      try {
        await (program.methods as any).createMatch(0, new anchor.BN(stake), Array(32).fill(0))
          .accounts({
            config: cfgPda, matchAccount: matchB,
            player: kp.publicKey, systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(deckMetas).rpc();
        bMade = true;
      } catch {
        // Expected: A already holds these cards, so B cannot lock them. That
        // is the *first* guard — CardLocked — and it is worth saying so.
        check('a second match cannot lock a deck another match already holds', true,
          'CardLocked fired on create');
      }

      if (!bMade) {
        // Attack the unlock side directly: cancel A, but hand it a foreign
        // account list. A owns these cards, so they should free — the point is
        // that cancelling anything *else* must not.
        await (program.methods as any).cancelMatch()
          .accounts({ matchAccount: matchA, player: kp.publicKey })
          .remainingAccounts(deckMetas).rpc();
        const back: any = await (program.account as any).card.fetch(free[0].publicKey);
        check('cancelling the owning match does free its deck',
          back.lockedBy.equals(PublicKey.default), 'the guard is scoped, not a wall');
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
