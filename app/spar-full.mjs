/**
 * A second real client: real deck, real escrow, real seat, for a whole match.
 *
 * `spar.mjs` holds a queue slot with an invented deck and no chain presence.
 * `spar-escrow.mjs` joins the escrow for real but hangs up after 150s, which is
 * shorter than a standard match plus overtime — so the browser seat lost its
 * opponent partway through and the match never settled from a full log.
 *
 * This is both halves at once, and it stays for the duration:
 *
 *   - queues with wallet B's actual on-chain cards, one per coin, unlocked
 *   - joins the opponent's open match with the same `join_match` the client
 *     sends, committing the same deck hash and locking the same eight cards
 *   - holds the socket open past regulation and overtime so the relay never
 *     reports `opponent_left`
 *
 * It plays no cards. That is not a stub standing in for an opponent — making
 * no move is a legal thing for a player to do, and it is the whole point here:
 * the browser seat needs an opponent it can actually beat so that felling a
 * tower, earning crowns, and winning a chest can be observed end to end
 * instead of inferred. The escrow, the deck lock, the seat and the settlement
 * are all real; only the tactics are bad.
 */
import WebSocket from 'ws';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

process.on('unhandledRejection', (e) => {
  console.log('spar-full: unhandled rejection (staying up) —', String(e).slice(0, 110));
});

const WS = 'wss://mempire-relay-production.up.railway.app/ws';
const RPC = 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const HOLD_MS = Number(process.env.HOLD_MS ?? 420000);

const idl = JSON.parse(readFileSync(new URL('./src/chain/mempire.idl.json', import.meta.url)));
const demo = JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url)));
const kp = Keypair.fromSecretKey(Uint8Array.from(demo['1']));

const conn = new Connection(RPC, 'confirmed');
const wallet = {
  publicKey: kp.publicKey,
  signTransaction: async (t) => { t.partialSign(kp); return t; },
  signAllTransactions: async (ts) => ts.map((t) => { t.partialSign(kp); return t; }),
};
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' }));

const le = (n) => new anchor.BN(n).toArrayLike(Buffer, 'le', 8);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const configPda = () => pda(Buffer.from('config'));
const matchPda = (id) => pda(Buffer.from('match'), le(id));
const cardPda = (id) => pda(Buffer.from('card'), le(id));

/** FNV-1a over the deck's mints, in order — byte-identical to the client. */
function deckHashBytes(mints) {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  const text = mints.join(',');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < 32; i += 1) { out[i] = h & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return out;
}

const DEFAULT = PublicKey.default.toBase58();

/** devnet refuses often enough that one attempt is not a load. */
async function withRetry(what, fn, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      console.log(`spar-full: ${what} attempt ${i + 1} failed —`, e.message?.slice(0, 60));
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${what} failed after ${tries} attempts`);
}

const owned = await withRetry('deck load', () => program.account.card.all([
  { memcmp: { offset: 16, bytes: kp.publicKey.toBase58() } },
]));
const byCoin = new Map();
for (const c of owned) {
  if (c.account.lockedBy.toBase58() !== DEFAULT) continue;
  const mint = c.account.coinMint.toBase58();
  if (!byCoin.has(mint)) byCoin.set(mint, c.account.id.toNumber());
}
const deckIds = [...byCoin.values()].slice(0, 8);
const deckMints = [...byCoin.keys()].slice(0, 8);
if (deckIds.length < 8) {
  console.log(`spar-full: only ${deckIds.length} free distinct coins — need 8`);
  process.exit(1);
}
console.log('spar-full: deck', deckIds.join(','));

// The relay wants the coin mints the browser will render, so send the real ones.
const relayDeck = deckMints.map((m, i) => ({
  coinId: m, name: `S${i}`, archetype: i % 6, level: 1,
}));

let joined = false;

/*
 * Queue second, on a trigger.
 *
 * The relay gives role 0 to whoever is already waiting and role 1 to whoever
 * arrives — and only role 0 creates the match this client is meant to join. So
 * the browser has to be in the queue first. But the chain reads above take
 * longer than the browser's bot-fallback window, so queueing on connect raced
 * the browser and won, leaving it to bail as role 0 while the browser played a
 * bot. Loading first and queueing on a file touch puts the order beyond doubt.
 */
const TRIGGER = process.env.QUEUE_TRIGGER;
async function waitForTrigger() {
  if (!TRIGGER) return;
  const { existsSync } = await import('node:fs');
  console.log('spar-full: loaded, waiting for the browser to queue first…');
  while (!existsSync(TRIGGER)) await new Promise((r) => setTimeout(r, 250));
}

const ws = new WebSocket(WS);
ws.on('open', async () => {
  await waitForTrigger();
  console.log('spar-full: queueing tier 0 ranked');
  ws.send(JSON.stringify({
    t: 'queue', tier: 0, address: kp.publicKey.toBase58(), deck: relayDeck,
    format: 'standard', ranked: true, trophies: 60, name: 'Sparring Partner',
  }));
});

/*
 * Announce our tick, the same way the browser does.
 *
 * Lockstep holds each seat to `opponentTick + delay`, so a seat that never
 * says where it is freezes the other one outright — the first run of this
 * client left the browser stuck at 3:00 until it was forfeited. This is not a
 * stand-in for a simulation: the tick a real client announces is derived from
 * the shared start instant and the wall clock, exactly as computed here, and
 * announcing it is the whole of that side of the protocol. What this client
 * genuinely does not do is play cards, which is a legal way to play.
 */
const TICK_MS = 50;
function announceTicks(startAt, offset) {
  const timer = setInterval(() => {
    const tick = Math.floor((Date.now() + offset - startAt) / TICK_MS);
    if (tick < 0) return;
    try { ws.send(JSON.stringify({ t: 'tick', tick })); } catch { clearInterval(timer); }
  }, 200);
  return timer;
}

ws.on('message', async (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.t !== 'matched') {
    if (m.t !== 'input' && m.t !== 'tick') console.log('spar-full: <-', m.t);
    return;
  }
  console.log('spar-full: matched, role', m.role, 'opponent', m.opponent?.address);
  // `serverNow` is the relay's clock at send time; the difference is the skew
  // both seats correct for so they agree on which tick it is.
  const offset = typeof m.serverNow === 'number' ? m.serverNow - Date.now() : 0;
  announceTicks(m.startAt, offset);
  console.log('spar-full: announcing ticks (offset', offset, 'ms)');
  if (m.role === 0) { console.log('spar-full: seat 0 — the browser must queue first'); return; }
  if (joined) return;

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    let all;
    try {
      all = await program.account.matchAccount.all();
    } catch (e) {
      // devnet times out often enough that letting it throw here killed the
      // process — and the seat with it, freezing the browser mid-match.
      console.log('spar-full: rpc poll failed, retrying —', e.message?.slice(0, 70));
      continue;
    }
    const open = all
      .map((x) => ({
        id: x.account.id.toNumber(),
        state: x.account.state,
        players: x.account.players.map((p) => p.toBase58()),
      }))
      .filter((x) => x.state === 0 && x.players[0] === m.opponent.address)
      .sort((a, b) => b.id - a.id)[0];
    if (!open) { console.log('spar-full: waiting for their CreateMatch…'); continue; }
    try {
      const sig = await program.methods
        .joinMatch(Array.from(deckHashBytes(deckMints)))
        .accounts({
          config: configPda(),
          matchAccount: matchPda(open.id),
          player: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckIds.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false })))
        .rpc();
      joined = true;
      console.log(`spar-full: JOINED match #${open.id} — ${sig}`);
    } catch (e) {
      console.log('spar-full: join failed —', e.message?.slice(0, 160));
    }
    return;
  }
});

ws.on('close', () => console.log('spar-full: socket closed'));
ws.on('error', (e) => console.log('spar-full: ws error', e.message));

// Outlast regulation plus overtime so the browser never sees `opponent_left`.
setTimeout(() => { console.log('spar-full: holding done'); process.exit(0); }, HOLD_MS);
