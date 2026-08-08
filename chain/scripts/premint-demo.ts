/**
 * Mint eight distinct cards for each demo wallet, so the recording can start.
 *
 * # Why this is a prerequisite and not a nicety
 *
 * `useChainSync` replaces the app's locally seeded eight-card collection with
 * whatever the connected wallet actually holds on chain, and then re-points the
 * deck at the cards that survive. A wallet holding one card therefore ends up
 * with a one-card collection and a one-card deck, and `BATTLE` refuses with
 * "deck needs 8 cards".
 *
 * That makes a fresh wallet a trap on camera: the mint shot succeeds, looks
 * great, and silently breaks the match shot that follows it. Minting eight up
 * front means the on-camera mint produces a *ninth* card — the collection grows
 * and nothing collapses.
 *
 * The mint loop is the one from `e2e-staked-match.ts`, which has been run
 * against devnet repeatedly: skip coins the wallet already has a card for,
 * hand it a token of any coin it lacks, and converge over several passes
 * because individual mints fail for reasons only the chain knows — a coin below
 * the liquidity floor, one too young, a token account that turned out empty.
 *
 * Run: npx tsx scripts/premint-demo.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const WALLETS = '../app/.demo-wallets.json';

const u64le = (n: number | bigint) => new anchor.BN(n.toString()).toArrayLike(Buffer, 'le', 8);
const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** Byte offset of `Card.owner`: 8 discriminator + 8 for `id`. */
const OWNER_OFFSET = 16;

async function main() {
  const conn = new Connection(BASE, { commitment: 'confirmed' });
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim()
    ?? join(homedir(), '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const program = new anchor.Program(idl, provider);
  const pid = program.programId;
  const accounts: any = program.account;
  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], pid)[0];
  const cardPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from('card'), u64le(id)], pid)[0];

  const demo: Keypair[] = JSON.parse(readFileSync(WALLETS, 'utf8'))
    .map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)));

  /**
   * Only coins the *client* knows about.
   *
   * The on-chain registry has outgrown the list the app was built against — 86
   * against 66 — and a card minted from one of the extra twenty is real, owned,
   * and unfieldable: `buildDecks` resolves each deck card's mint against the
   * bundled `COINS` and returns null on the first miss, which the player sees
   * as "your deck has retired cards". Minting from the chain registry produced
   * exactly one such card per wallet and killed the whole demo deck.
   */
  const clientCoins = JSON.parse(readFileSync('../app/src/lib/devnet-coins.json', 'utf8'));
  const fieldable = new Set<string>(clientCoins.coins.map((c: any) => c.mint));

  /**
   * Cards this owner holds, one per coin, unlocked — the same rule a deck follows.
   *
   * Filtered server-side on `owner` rather than fetching every card and
   * discarding most of them. An unfiltered `.all()` is a full
   * `getProgramAccounts` scan, and calling it once per coin per attempt is what
   * got this script 429'd off the public devnet RPC.
   */
  async function deckFor(owner: PublicKey): Promise<number[]> {
    const all: any[] = await accounts.card.all([
      { memcmp: { offset: OWNER_OFFSET, bytes: owner.toBase58() } },
    ]);
    const seen = new Set<string>();
    return all
      // Unfieldable cards must not count toward the eight, or a wallet holding
      // seven good ones and one unusable looks complete and gets no top-up.
      .filter((c) => fieldable.has(c.account.coinMint.toBase58()))
      .filter((c) => c.account.lockedBy.equals(PublicKey.default))
      .filter((c) => {
        const m = c.account.coinMint.toBase58();
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      })
      .slice(0, 8)
      .map((c) => Number(c.account.id));
  }

  // Fetched once for the whole run. The registry does not change while this is
  // running, and re-reading eighty accounts per attempt is exactly the traffic
  // that got the previous version rate-limited off the public RPC.
  const allCoins: any[] = await accounts.coinInfo.all();
  const coins = allCoins.filter((ci) => fieldable.has(ci.account.mint.toBase58()));
  console.log(`  ${allCoins.length} coins on chain, ${coins.length} fieldable by the client\n`);

  async function ensureDeck(who: Keypair, label: string): Promise<number[]> {
    let ids = await deckFor(who.publicKey);
    if (ids.length >= 8) return ids;

    const mine: any[] = await accounts.card.all([
      { memcmp: { offset: OWNER_OFFSET, bytes: who.publicKey.toBase58() } },
    ]);
    const carded = new Set(mine.map((c) => c.account.coinMint.toBase58()));

    // Each demo wallet signs its own mints, so the card's owner is the wallet
    // the recording connects — not the admin paying for the setup.
    const theirProvider = new anchor.AnchorProvider(conn, new anchor.Wallet(who), { commitment: 'confirmed' });
    const theirProgram = new anchor.Program(idl, theirProvider);

    // `nextCardId` is read once and then tracked locally, incrementing on each
    // success. Re-fetching config before every mint doubled the request count
    // for a value this loop already knows.
    let nextId = Number((await accounts.config.fetch(configPda)).nextCardId);
    let treasury: PublicKey = (await accounts.config.fetch(configPda)).treasury;

    let minted = 0;
    for (const ci of coins) {
      if (ids.length + minted >= 8) break;
      const mint: PublicKey = ci.account.mint;
      if (carded.has(mint.toBase58())) continue;

      const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey);
      const theirAta = getAssociatedTokenAddressSync(mint, who.publicKey);
      const adminBal = await conn.getTokenAccountBalance(adminAta).catch(() => null);
      if (!adminBal || Number(adminBal.value.amount) < 2) continue;

      const theirBal = await conn.getTokenAccountBalance(theirAta).catch(() => null);
      if (!theirBal || Number(theirBal.value.amount) === 0) {
        try {
          await provider.sendAndConfirm(new Transaction()
            .add(createAssociatedTokenAccountIdempotentInstruction(
              admin.publicKey, theirAta, who.publicKey, mint))
            .add(createTransferInstruction(adminAta, theirAta, admin.publicKey, 1)));
        } catch { continue; }
      }

      try {
        await (theirProgram.methods as any).mintCard().accounts({
          config: configPda,
          coinInfo: ci.publicKey,
          card: cardPda(nextId),
          ownerTokens: theirAta,
          owner: who.publicKey,
          treasury,
          systemProgram: SystemProgram.programId,
        }).rpc();
        carded.add(mint.toBase58());
        nextId += 1;
        minted += 1;
        console.log(`    ${label} minted card ${nextId - 1} — ${ci.account.ticker ?? mint.toBase58().slice(0, 6)}`);
      } catch {
        // Too young, too illiquid, or the id raced another minter. Re-read the
        // counter so a lost race does not poison every subsequent attempt.
        const cfgNow: any = await accounts.config.fetch(configPda);
        nextId = Number(cfgNow.nextCardId);
        treasury = cfgNow.treasury;
      }
      // The public devnet RPC is the constraint here, not the chain.
      await sleep(400);
    }
    ids = await deckFor(who.publicKey);
    return ids;
  }

  console.log('pre-minting eight cards per demo wallet\n');
  for (const [i, kp] of demo.entries()) {
    const label = i === 0 ? 'A' : 'B';
    console.log(`  ${label}  ${kp.publicKey.toBase58()}`);
    let ids: number[] = [];
    // One pass mints against a snapshot; re-running converges.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ids = await ensureDeck(kp, label);
      if (ids.length >= 8) break;
    }
    const ok = ids.length >= 8;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} has ${ids.length} distinct unlocked cards — [${ids.join(', ')}]\n`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
