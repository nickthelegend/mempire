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
