/**
 * Mempire persistence API.
 *
 * The browser cannot talk to Atlas directly, so player state lives behind this
 * thin service. One document per wallet address; the client owns game logic and
 * this only stores the result, so a compromised client can't do anything it
 * couldn't already do locally. Real balances move onchain, never here.
 */
import cors from 'cors';
import express from 'express';
import { requireWallet } from './auth.js';
import { MongoClient } from 'mongodb';
import { registerClanRoutes } from './clans.js';
import { applyMatch, leagueFor } from './ranking.js';
import { registerMatchmaker } from './matchmaker.js';

const { MONGODB_URI, MONGODB_DB = 'mempire', PORT = 8787 } = process.env;
if (!MONGODB_URI) {
  console.error('MONGODB_URI missing — copy server/.env.example to server/.env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
let players;
let leaderboard;
let ladder;

const app = express();
// Heroku terminates TLS at its router, so without this req.ip is the router
// for every client — one shared limiter bucket, and one noisy player 429s the
// whole playerbase. One hop only: trusting the whole chain would make the key
// a spoofable X-Forwarded-For.
app.set('trust proxy', 1);
// Locked to the deployed app's origin in production; open in development.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json({ limit: '256kb' }));

/**
 * Token-bucket rate limit per IP on mutating routes. Hand-rolled because the
 * need is fifteen lines, not a dependency. 300 writes/min per IP: far above a
 * real player (the save loop is debounced to ~1/s at its busiest) and above
 * the ops scripts (seed-clans bursts ~200 writes), but a wall for a loop.
 */
const RATE = { capacity: 80, refillPerSec: 5 };
const buckets = new Map();
setInterval(() => {
  // drop buckets idle for 10+ minutes so the map cannot grow unbounded
  const cutoff = Date.now() - 600_000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 120_000).unref();

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: RATE.capacity, at: now };
  b.tokens = Math.min(RATE.capacity, b.tokens + ((now - b.at) / 1000) * RATE.refillPerSec);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return res.status(429).json({ error: 'slow down' });
  }
  b.tokens -= 1;
  buckets.set(key, b);
  next();
});

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, Solana pubkey shape
const badAddress = (a) => !a || !ADDRESS.test(a);

app.get('/api/health', async (_req, res) => {
  try {
    await client.db(MONGODB_DB).command({ ping: 1 });
    res.json({ ok: true, db: MONGODB_DB });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/** Full saved state for a wallet, or null if this is their first visit. */
app.get('/api/player/:address', async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await players.findOne({ _id: address }, { projection: { _id: 0 } });
    res.json(doc ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Upsert the whole saved slice. Client sends it debounced after changes.
 *
 * Values are clamped, not trusted: this API stores game state for a client
 * that already owns the simulation, so nothing here is authoritative — but a
 * hostile PUT must not be able to poison a document with Infinity, negative
 * gems, or a megabyte of "chests" that every later load chokes on.
 */
const num = (v, lo, hi, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
};

app.put('/api/player/:address', requireWallet('player.put'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const {
    cards, deck, tier, sol, history, nextId,
    slots, slot, gems, chests, nextChestId, gemsSpent, solSpentOnGems, shop,
  } = req.body ?? {};
  if (!Array.isArray(cards) || !Array.isArray(deck)) {
    return res.status(400).json({ error: 'cards and deck are required arrays' });
  }
  if (cards.length > 500 || deck.length > 8) {
    return res.status(400).json({ error: 'payload out of range' });
  }
  try {
    const now = new Date();
    await players.updateOne(
      { _id: address },
      {
        $set: {
          cards,
          deck,
          tier: num(tier, 0, 3),
          sol: num(sol, 0, 1_000_000),
          nextId: num(nextId, 1, 1_000_000, 1),
          history: Array.isArray(history) ? history.slice(0, 50) : [],
          slots: Array.isArray(slots) ? slots.slice(0, 3).map((s) => (Array.isArray(s) ? s.slice(0, 8) : [])) : [],
          slot: num(slot, 0, 2),
          gems: num(gems, 0, 10_000_000),
          chests: Array.isArray(chests) ? chests.slice(0, 4) : [],
          nextChestId: num(nextChestId, 1, 10_000_000, 1),
          gemsSpent: num(gemsSpent, 0, 100_000_000),
          solSpentOnGems: num(solSpentOnGems, 0, 1_000_000),
          shop: shop && typeof shop === 'object'
            ? {
              offers: Array.isArray(shop.offers) ? shop.offers.slice(0, 8) : [],
              day: num(shop.day, 0, 1_000_000),
              rerollsUsed: num(shop.rerollsUsed, 0, 1_000),
            }
            : null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Append one settled match and bump the player's standing. */
app.post('/api/match/:address', requireWallet('match.post'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const { won, draw, potSol, payoutSol, rakeSol, crowns } = req.body ?? {};
  try {
    const now = new Date();
    await leaderboard.updateOne(
      { _id: address },
      {
        $inc: {
          matches: 1,
          wins: won ? 1 : 0,
          losses: !won && !draw ? 1 : 0,
          draws: draw ? 1 : 0,
          netSol: Number(payoutSol || 0) - Number(potSol || 0) / 2,
          crowns: Array.isArray(crowns) ? Number(crowns[0]) || 0 : 0,
        },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    await players.updateOne(
      { _id: address },
      {
        $push: {
          history: {
            $each: [{ won: !!won, draw: !!draw, potSol, payoutSol, rakeSol, crowns, at: now }],
            $position: 0,
            $slice: 50,
          },
        },
      },
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live meme coin feed ──────────────────────────────────────────────────────
// Sourced server-side so the browser is not blocked by CORS and upstreams see
// one cached call rather than one per player. Anything that fails to parse is
// skipped rather than failing the whole list.

const COIN_TTL_MS = 60_000;
const MIN_LIQUIDITY_USD = 25_000;
const MIN_AGE_HOURS = 48;
let coinCache = { at: 0, coins: [] };

const HUE_STEPS = [38, 320, 265, 205, 130, 52, 12, 350, 88, 228, 190, 28, 165, 300, 15];

/**
 * The Solana meme coins worth building a game economy on: deep liquidity, real
 * culture, recognisable art. Addresses ending in `pump` are pump.fun natives.
 * Searching by keyword returned only the PUMP token itself, so the roster is
 * explicit and enriched live.
 */
const MEME_MINTS = [
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
  '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', // PNUT
  'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', // FWOG
  'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // GOAT
  'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump', // CHILLGUY
  'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY', // MOODENG
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', // ai16z
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', // TRUMP
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', // MEW
  'CATSrLdvUWzxXcnKzEVy9M5vBvfSHXDaAysu9DnEpump', // CATS
];

/** Enrich the roster with live DexScreener market data. */
async function fetchPumpCoins() {
  const urls = [
    `https://api.dexscreener.com/latest/dex/tokens/${MEME_MINTS.join(',')}`,
  ];
  const seen = new Map();

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const body = await res.json();
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken?.address;
        const symbol = p.baseToken?.symbol;
        if (!mint || !symbol) continue;
        const liquidityUsd = Math.round(p.liquidity?.usd ?? 0);
        const priceUsd = Number(p.priceUsd ?? 0);
        if (!priceUsd || liquidityUsd < MIN_LIQUIDITY_USD) continue;
        const createdAt = p.pairCreatedAt ? Number(p.pairCreatedAt) : 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
        if (ageHours < MIN_AGE_HOURS) continue;
        // several pools per token — keep the deepest, it has the best data
        const prior = seen.get(mint);
        if (prior && prior.liquidityUsd >= liquidityUsd) continue;
        seen.set(mint, {
          mint,
          // some symbols already ship a leading $; the UI adds its own
          ticker: symbol.replace(/^\$+/, '').toUpperCase().slice(0, 10),
          name: (p.baseToken?.name || symbol).slice(0, 28),
          priceUsd,
          liquidityUsd,
          ageHours: Math.round(ageHours),
          fdvUsd: Math.round(p.fdv ?? p.marketCap ?? 0),
          change24h: Number(p.priceChange?.h24 ?? 0),
          volume24h: Math.round(p.volume?.h24 ?? 0),
          imageUrl: p.info?.imageUrl ?? null,
          pumpFun: /pump$/i.test(mint) || p.dexId === 'pumpswap',
          url: p.url ?? null,
        });
      }
    } catch {
      // upstream flaked — try the next source
    }
  }

  const all = [...seen.values()];
  // pump.fun natives first, then by liquidity
  all.sort((a, b) => (Number(b.pumpFun) - Number(a.pumpFun)) || b.liquidityUsd - a.liquidityUsd);
  return all.slice(0, 40).map((c, i) => ({ ...c, hue: HUE_STEPS[i % HUE_STEPS.length] }));
}

app.get('/api/coins', async (_req, res) => {
  if (Date.now() - coinCache.at < COIN_TTL_MS && coinCache.coins.length) {
    return res.json({ coins: coinCache.coins, cached: true });
  }
  try {
    const coins = await fetchPumpCoins();
    if (coins.length) coinCache = { at: Date.now(), coins };
    res.json({ coins: coinCache.coins, cached: false });
  } catch (e) {
    // serve stale rather than nothing — the game must stay playable
    res.json({ coins: coinCache.coins, error: e.message });
  }
});

// ── Trophy ladder ───────────────────────────────────────────────────────────
// The server is the authority: it is the only party that sees both sides of a
// match. The client computes the same Elo optimistically so the result screen
// is instant, then reconciles with whatever comes back from here.

/** One player's ladder standing, plus their rank. */
app.get('/api/ladder/:address', async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await ladder.findOne({ _id: address });
    const trophies = doc?.trophies ?? 0;
    // Rank is derived, never stored — a stored rank is stale the moment anyone
    // else plays a match.
    const above = await ladder.countDocuments({ trophies: { $gt: trophies } });
    res.json({
      address,
      trophies,
      best: doc?.best ?? trophies,
      wins: doc?.wins ?? 0,
      losses: doc?.losses ?? 0,
      draws: doc?.draws ?? 0,
      streak: doc?.streak ?? 0,
      bestStreak: doc?.bestStreak ?? 0,
      league: leagueFor(trophies).name,
      rank: doc ? above + 1 : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Apply one ranked result. Returns the new standing. */
app.post('/api/ladder/:address', requireWallet('ladder.post'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const { opponentTrophies, outcome } = req.body ?? {};
  if (!['win', 'loss', 'draw'].includes(outcome)) {
    return res.status(400).json({ error: 'bad outcome' });
  }
  try {
    const doc = await ladder.findOne({ _id: address });
    const before = doc?.trophies ?? 0;
    const opp = num(opponentTrophies, 0, 100_000);
    const { delta, after, floored } = applyMatch(before, opp, outcome);
    const streak = outcome === 'win' ? (doc?.streak ?? 0) + 1
      : outcome === 'loss' ? 0
        : (doc?.streak ?? 0);
    const now = new Date();

    await ladder.updateOne(
      { _id: address },
      {
        $set: {
          trophies: after,
          best: Math.max(doc?.best ?? 0, after),
          streak,
          bestStreak: Math.max(doc?.bestStreak ?? 0, streak),
          updatedAt: now,
        },
        $inc: {
          wins: outcome === 'win' ? 1 : 0,
          losses: outcome === 'loss' ? 1 : 0,
          draws: outcome === 'draw' ? 1 : 0,
          matches: 1,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    const above = await ladder.countDocuments({ trophies: { $gt: after } });
    res.json({
      trophies: after,
      delta,
      floored,
      best: Math.max(doc?.best ?? 0, after),
      wins: (doc?.wins ?? 0) + (outcome === 'win' ? 1 : 0),
      losses: (doc?.losses ?? 0) + (outcome === 'loss' ? 1 : 0),
      streak,
      league: leagueFor(after).name,
      rank: above + 1,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The ladder itself — top players by trophies. */
app.get('/api/ladder', async (_req, res) => {
  try {
    const rows = await ladder.find({}).sort({ trophies: -1 }).limit(50).toArray();
    res.json({
      players: rows.map((r, i) => ({
        rank: i + 1,
        address: r._id,
        name: r.name ?? null,
        trophies: r.trophies ?? 0,
        best: r.best ?? 0,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        streak: r.streak ?? 0,
        league: leagueFor(r.trophies ?? 0).name,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Top players by net SOL — powers the Empire leaderboard. */
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const rows = await leaderboard
      .find({}, { projection: { netSol: 1, wins: 1, losses: 1, crowns: 1, matches: 1 } })
      .sort({ netSol: -1 })
      .limit(25)
      .toArray();
    res.json(rows.map((r) => ({ address: r._id, ...r, _id: undefined })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = await (async () => {
  await client.connect();
  const db = client.db(MONGODB_DB);
  players = db.collection('players');
  leaderboard = db.collection('leaderboard');
  ladder = db.collection('ladder');
  await leaderboard.createIndex({ netSol: -1 });
  // Both the ladder listing and every rank lookup sort on this.
  await ladder.createIndex({ trophies: -1 });
  registerClanRoutes(app, db);
  console.log(`mongo connected → ${MONGODB_DB}`);
  const httpServer = app.listen(PORT, () => console.log(`mempire api on :${PORT}`));
  registerMatchmaker(httpServer);
  return httpServer;
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await client.close();
    process.exit(0);
  });
}
