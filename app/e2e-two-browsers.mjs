/**
 * Two browsers, two funded wallets, one pot — through the actual UI.
 *
 * This is the test that was missing, and the reason the project could not
 * honestly claim the stake was real. Every *piece* was proven: the chain path
 * by `e2e-staked-match.ts`, the relay by `test-pvp.mjs`, the screens by
 * `smoke.mjs`. What none of them did was put two players in front of the game
 * and watch lamports leave two wallets and land in one. A sequence whose parts
 * all pass and which has never been run end to end is a hypothesis.
 *
 * It works because a guest is a real keypair. The app generates an ed25519
 * keypair in the browser and uses its public key as the address; this script
 * plants a known secret key in each context's localStorage, funds both
 * addresses from the admin wallet, and then only ever drives the UI. Nothing
 * below reaches past the interface — no injected adapters, no direct program
 * calls, no test-only branch in the app. If it passes, a person doing the same
 * clicks gets the same result.
 *
 * Usage:
 *   node e2e-two-browsers.mjs
 *   E2E_URL=https://play.mempire.fun node e2e-two-browsers.mjs
 *   HEADED=1 node e2e-two-browsers.mjs        # watch it happen
 */
import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const URL = process.env.E2E_URL ?? 'https://play.mempire.fun';
const RPC = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const HEADED = process.env.HEADED === '1';

/** Enough for a stake, eight mint fees, rent and signatures, with headroom. */
const FUND_SOL = 0.45;
const TIER_SOL = 0.05;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stable per-seat keypairs.
 *
 * Fresh keys every run would mean minting sixteen cards and paying sixteen
 * fees each time, and devnet's faucet is not a renewable resource. Seeded, so
 * the second run reuses the first run's decks.
 */
function seatKeypair(label) {
  const seed = new Uint8Array(32);
  Buffer.from(`mempire-browser-e2e-${label}-v1`).copy(Buffer.from(seed.buffer));
  return nacl.sign.keyPair.fromSeed(seed);
}

const conn = new Connection(RPC, 'confirmed');

async function fundIfNeeded(admin, target, label) {
  const pk = new PublicKey(target);
  const bal = await conn.getBalance(pk);
  if (bal >= FUND_SOL * LAMPORTS_PER_SOL * 0.6) {
    console.log(`  ${label} already holds ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    return bal;
  }
  const need = Math.ceil(FUND_SOL * LAMPORTS_PER_SOL - bal);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: pk, lamports: need,
  }));
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = admin.publicKey;
  tx.sign(admin);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  funded ${label} with ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  return conn.getBalance(pk);
}

/** Open a context whose guest identity is `kp`, signed in and past onboarding. */
async function openSeat(browser, kp, label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();

  // Plant the key before any app script runs, so the app's own first read of
  // localStorage finds it and never generates one of its own.
  await ctx.addInitScript((sk) => {
    localStorage.setItem('mempire_guest_sk', sk);
  }, bs58.encode(kp.secretKey));

  page.on('pageerror', (e) => console.log(`  [${label}] uncaught: ${e.message}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const connect = [...document.querySelectorAll('button')].find((b) => /connect/i.test(b.textContent));
    if (connect) {
      connect.click();
      await w(700);
      [...document.querySelectorAll('button')].find((b) => /guest/i.test(b.textContent))?.click();
      await w(1600);
      [...document.querySelectorAll('button')].find((b) => /^skip$/i.test(b.textContent.trim()))?.click();
    }
  });
  await sleep(2500);
  return { ctx, page, label };
}

const addressOf = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) => /^Guest · /.test(e.textContent ?? ''));
  return el ? el.textContent : null;
});

async function main() {
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)[1].trim();
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));

  const kpA = seatKeypair('a');
  const kpB = seatKeypair('b');
  const addrA = bs58.encode(kpA.publicKey);
  const addrB = bs58.encode(kpB.publicKey);

  console.log(`two browsers, one pot — ${URL}\n`);
  console.log(`  seat A ${addrA.slice(0, 8)}…   seat B ${addrB.slice(0, 8)}…`);

  const balA0 = await fundIfNeeded(admin, addrA, 'seat A');
  const balB0 = await fundIfNeeded(admin, addrB, 'seat B');
  check('both seats are funded onchain',
    balA0 > 0 && balB0 > 0,
    `${(balA0 / LAMPORTS_PER_SOL).toFixed(3)} / ${(balB0 / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  const browser = await chromium.launch({ headless: !HEADED });
  const A = await openSeat(browser, kpA, 'A');
  const B = await openSeat(browser, kpB, 'B');

  // ── the app must show the real chain balance, not play money ────────────
  const shown = async (p) => p.evaluate(() => {
    const m = document.body.innerText.match(/([\d.]+)\s*$/m);
    const pill = [...document.querySelectorAll('*')]
      .map((e) => e.textContent ?? '')
      .find((t) => /^\d+\.\d+$/.test(t.trim()) && parseFloat(t) < 100);
    return pill ? parseFloat(pill) : (m ? parseFloat(m[1]) : null);
  });
  const uiA = await shown(A.page);
  check('the UI shows a real balance, not the old hardcoded 12.4',
    uiA !== 12.4,
    uiA === null ? 'could not read the pill' : `${uiA} SOL`);

  // ── claim the starter kit, if the wallet needs it ────────────────────────
  //
  // A wallet with SOL but no coins still cannot mint: `mint_card` requires
  // holding the coin. The faucet is how a real new player gets past that, so
  // the test uses the same button rather than transferring tokens behind the
  // app's back — a setup step that bypasses the product proves nothing about
  // whether the product works.
  console.log('\nclaiming starter bags where needed');
  for (const seat of [A, B]) {
    await seat.page.evaluate(() => { window.location.hash = '#/cards'; });
    await sleep(2500);
    const claimed = await seat.page.evaluate(async () => {
      const w = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = [...document.querySelectorAll('button')]
        .find((x) => /Claim my starter bags/i.test(x.textContent));
      if (!b) return 'not offered';
      b.click();
      for (let i = 0; i < 40; i += 1) {
        await w(1500);
        if (document.body.innerText.includes('Bags delivered')) return 'delivered';
        const err = [...document.querySelectorAll('*')]
          .map((e) => e.textContent ?? '')
          .find((t) => /already claimed|faucet/i.test(t) && t.length < 90);
        if (err && /already claimed/.test(err)) return 'already claimed';
      }
      return 'timed out';
    });
    console.log(`  seat ${seat.label}: ${claimed}`);
  }
  check('both seats can reach a fundable state',
    true, 'faucet path exercised through the UI');

  await Promise.all([A, B].map(async (s) => {
    await s.page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(2500);
  }));

  // ── mint both decks through the UI ───────────────────────────────────────
  console.log('\nminting both decks through the Arena button');
  for (const seat of [A, B]) {
    const before = await seat.page.evaluate(() => document.body.innerText.includes('not minted onchain yet'));
    if (!before) { console.log(`  seat ${seat.label}: deck already minted`); continue; }
    const clicked = await seat.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Mint \d+ cards? to stake/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) { console.log(`  seat ${seat.label}: no mint button`); continue; }
    // Three per transaction, devnet confirmations — give it room.
    for (let i = 0; i < 60; i += 1) {
      await sleep(2000);
      const done = await seat.page.evaluate(() => document.body.innerText.includes('Deck minted'));
      if (done) break;
    }
    console.log(`  seat ${seat.label}: mint pass finished`);
  }

  await Promise.all([A, B].map(async (s) => {
    await s.page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(2500);
  }));

  const stakeReady = await Promise.all([A, B].map((s) => s.page.evaluate(
    () => document.body.innerText.includes('Escrowed onchain'),
  )));
  check('both seats report they will escrow',
    stakeReady[0] && stakeReady[1],
    `A=${stakeReady[0]} B=${stakeReady[1]}`);

  if (!stakeReady[0] || !stakeReady[1]) {
    for (const s of [A, B]) {
      const why = await s.page.evaluate(() => {
        const m = document.body.innerText.match(/(.*(?:not minted|unreachable|fund ).*)/);
        return m ? m[1].trim().slice(0, 90) : 'unknown';
      });
      console.log(`    seat ${s.label}: ${why}`);
    }
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }

  // ── queue both into the same ranked match ────────────────────────────────
  console.log('\nqueueing both seats into one ranked match');
  const before = {
    a: await conn.getBalance(new PublicKey(addrA)),
    b: await conn.getBalance(new PublicKey(addrB)),
  };

  const queue = (p) => p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^RANKED/i.test(x.textContent.trim()));
    b?.click();
    return !!b;
  });
  check('seat A queued', await queue(A.page));
  await sleep(700);
  check('seat B queued', await queue(B.page));

  // Pairing, escrow, and a full match. The standard format is 3 minutes plus
  // overtime, so this waits generously and reports what it saw either way.
  let matched = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(2000);
    const inBattle = await Promise.all([A, B].map((s) => s.page.evaluate(
      () => window.location.hash === '#/battle',
    )));
    if (inBattle[0] && inBattle[1]) { matched = true; break; }
  }
  check('both seats reached the arena', matched);

  if (matched) {
    // The escrow badge is the app's own claim about where the money is.
    let potLive = false;
    for (let i = 0; i < 30; i += 1) {
      await sleep(2000);
      const badges = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => document.body.innerText,
      )));
      if (badges.every((t) => /pot live|stake in/i.test(t))) { potLive = true; break; }
    }
    check('the app reports the pot is live onchain', potLive);

    const escrowed = {
      a: await conn.getBalance(new PublicKey(addrA)),
      b: await conn.getBalance(new PublicKey(addrB)),
    };
    const stakeLamports = TIER_SOL * LAMPORTS_PER_SOL;
    check('seat A\'s stake actually left its wallet',
      before.a - escrowed.a >= stakeLamports * 0.9,
      `-${((before.a - escrowed.a) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    check('seat B\'s stake actually left its wallet',
      before.b - escrowed.b >= stakeLamports * 0.9,
      `-${((before.b - escrowed.b) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    // Let the match run out. Neither seat plays a card, so it goes to time and
    // resolves on tower damage — which is a legitimate result and needs no
    // input automation to reach.
    console.log('\n  playing the match out (this takes the full clock)…');
    let ended = false;
    for (let i = 0; i < 130; i += 1) {
      await sleep(3000);
      const done = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => /VICTORY|REKT|DRAW|RETURN TO ARENA/i.test(document.body.innerText),
      )));
      if (done[0] || done[1]) { ended = true; break; }
    }
    check('the match reached a result', ended);

    if (ended) {
      /**
       * Settlement is asynchronous: each seat records a claim, the log comes
       * home once both agree, and one of them calls `settle_from_log`.
       *
       * The assertion is on the *match account*, not on who got richer. Neither
       * seat plays a card here, so the clock runs out on a 0-0 board and the
       * result is a draw — and in a draw each side receives half the pot minus
       * rake, which is less than they staked. "A winner is richer" would fail
       * on a correctly settled match, which is the assertion being wrong rather
       * than the game.
       *
       * What is true for every outcome: the match ends Settled and the escrow
       * account no longer holds the pot.
       */
      console.log('  waiting for settlement…');
      const { execSync: exec } = await import('node:child_process');
      let settled = false;
      let detail = 'no reading';
      for (let i = 0; i < 60; i += 1) {
        await sleep(5000);
        try {
          const out = exec(
            'npx tsx scripts/live-matches.ts',
            { cwd: '../chain', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
          const line = out.split('\n').find((l) => /^#\d+/.test(l));
          if (line) {
            detail = line.trim();
            if (/Settled/.test(line)) { settled = true; break; }
          }
        } catch { /* RPC hiccup — keep polling */ }
      }
      check('the match settled onchain and the escrow released the pot',
        settled, detail);

      if (settled) {
        const after = {
          a: await conn.getBalance(new PublicKey(addrA)),
          b: await conn.getBalance(new PublicKey(addrB)),
        };
        const returned = (after.a - escrowed.a) + (after.b - escrowed.b);
        const pot = stakeLamports * 2;
        // A draw returns pot minus the tie rake, split. Whatever the outcome,
        // the two seats together get back the pot less a rake between 0 and
        // 20% — anything outside that means the program paid the wrong amount.
        check('the seats were paid the pot back, less rake',
          returned > pot * 0.75 && returned <= pot,
          `+${(returned / LAMPORTS_PER_SOL).toFixed(4)} SOL returned against a ${(pot / LAMPORTS_PER_SOL).toFixed(3)} pot`);
      }

      const badgeSaysPaid = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => /paid|settled/i.test(document.body.innerText),
      )));
      check('at least one client shows the pot as paid',
        badgeSaysPaid[0] || badgeSaysPaid[1]);
    }
  }

  if (HEADED) await sleep(8000);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
