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
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB = 'mempire', PORT = 8787 } = process.env;
if (!MONGODB_URI) {
  console.error('MONGODB_URI missing — copy server/.env.example to server/.env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
let players;
let leaderboard;

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

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

/** Upsert the whole saved slice. Client sends it debounced after changes. */
app.put('/api/player/:address', async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const { cards, deck, tier, sol, history, nextId } = req.body ?? {};
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
          tier: Number(tier) || 0,
          sol: Number(sol) || 0,
          nextId: Number(nextId) || 1,
          history: Array.isArray(history) ? history.slice(0, 50) : [],
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
app.post('/api/match/:address', async (req, res) => {
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
  await leaderboard.createIndex({ netSol: -1 });
  console.log(`mongo connected → ${MONGODB_DB}`);
  return app.listen(PORT, () => console.log(`mempire api on :${PORT}`));
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await client.close();
    process.exit(0);
  });
}
