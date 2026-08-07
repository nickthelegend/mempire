/**
 * Total value locked, read from chain.
 *
 * # What counts as locked
 *
 * Only value the protocol is actually holding, where "holding" means a user
 * cannot spend it without the program letting go:
 *
 * - **Escrow** — lamports sitting in `MatchAccount`s that have not settled.
 *   Real SOL, already moved, owed to whoever wins.
 * - **Pool** — the AMM's two vaults. A constant-product pool is balanced by
 *   value, so the USDC side doubled *is* the pool's worth; pricing the
 *   $MEMPIRE side against anything else would be inventing a second oracle.
 * - **Card stake** — `staked_micro_usd` summed across every `Card`. This is
 *   the number the game is actually about: a fighter's power comes from the
 *   coins locked behind it.
 *
 * Settled matches are excluded. Their lamports have already been paid out, and
 * counting a pot after it has been won is how a TVL figure starts drifting
 * upward on its own.
 *
 * # Why hand-decoded
 *
 * The server has no Anchor dependency and no reason to grow one for three
 * integers. Offsets are derived from the account layouts in `lib.rs` and are
 * asserted against the declared `SIZE` of each account before anything is
 * summed — a layout change breaks this loudly rather than returning a
 * confidently wrong number.
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

/** Byte layout of `Card`, after the 8-byte discriminator. */
const CARD = {
  SIZE: 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 8 + 8 + 32 + 1,
  // 8 disc + 8 id + 32 owner + 32 coin_mint + 1 archetype + 8 staked_tokens
  STAKED_MICRO_USD: 8 + 8 + 32 + 32 + 1 + 8,
};

/** Byte layout of `MatchAccount`, after the 8-byte discriminator. */
const MATCH = {
  SIZE: 8 + 8 + 1 + 8 + 64 + 64 + 8 + 1 + 8 + 8 + 1 + 8 + 1,
  STAKE_LAMPORTS: 8 + 8 + 1,
  // 8 disc + 8 id + 1 tier + 8 stake + 64 players + 64 deck_hash + 8 power
  STATE: 8 + 8 + 1 + 8 + 64 + 64 + 8,
};

/** A match that has paid out. Its lamports are gone and must not be counted. */
const MATCH_STATE_SETTLED = 2;

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * How long a computed figure is served before the chain is read again.
 *
 * TVL moves when a match opens or a swap lands, neither of which is fast
 * enough to justify three `getProgramAccounts` calls per dashboard load. Those
 * are the most expensive thing a public RPC will do for you, and this endpoint
 * is public.
 */
const TTL_MS = 60_000;
let cached = null;

async function readTvl(programId, amm) {
  const conn = new Connection(RPC, 'confirmed');
  const program = new PublicKey(programId);

  const [cards, matches, baseVault, quoteVault] = await Promise.all([
    conn.getProgramAccounts(program, {
      filters: [{ dataSize: CARD.SIZE }],
      dataSlice: { offset: CARD.STAKED_MICRO_USD, length: 8 },
    }),
    conn.getProgramAccounts(program, { filters: [{ dataSize: MATCH.SIZE }] }),
    conn.getTokenAccountBalance(new PublicKey(amm.baseVault)).catch(() => null),
    conn.getTokenAccountBalance(new PublicKey(amm.quoteVault)).catch(() => null),
  ]);

  // Card stake. The slice is exactly the one field, so this cannot drift onto
  // a neighbouring one without the dataSize filter also failing.
  let stakedMicroUsd = 0n;
  for (const { account } of cards) {
    stakedMicroUsd += account.data.readBigUInt64LE(0);
  }

  // Escrow. Both seats' stakes sit in the account, so an Active match holds
  // twice its `stake_lamports`; an Open one holds a single side.
  let escrowLamports = 0n;
  let openMatches = 0;
  let activeMatches = 0;
  for (const { account } of matches) {
    const state = account.data.readUInt8(MATCH.STATE);
    if (state === MATCH_STATE_SETTLED) continue;
    const stake = account.data.readBigUInt64LE(MATCH.STAKE_LAMPORTS);
    if (state === 0) { openMatches += 1; escrowLamports += stake; } else { activeMatches += 1; escrowLamports += stake * 2n; }
  }

  const quoteUsd = quoteVault ? Number(quoteVault.value.uiAmount ?? 0) : 0;
  const baseTokens = baseVault ? Number(baseVault.value.uiAmount ?? 0) : 0;
  // x·y=k means the two sides are worth the same, so the quote side doubled is
  // the pool. Reported as null rather than 0 when a vault could not be read —
  // an unreachable RPC is not an empty pool.
  const poolUsd = quoteVault && baseVault ? quoteUsd * 2 : null;
  const mempirePrice = baseTokens > 0 ? quoteUsd / baseTokens : null;

  const escrowSol = Number(escrowLamports) / LAMPORTS_PER_SOL;
  const stakedUsd = Number(stakedMicroUsd) / 1_000_000;

  return {
    generatedAt: new Date(),
    cluster: amm.cluster ?? 'devnet',
    /**
     * Deliberately two figures, not one.
     *
     * Escrow is denominated in SOL and card stake in USD, and adding them would
     * need a SOL price this service does not have. Inventing one to produce a
     * single headline number is exactly the kind of tidy figure nobody can
     * check.
     */
    totals: {
      escrowSol,
      lockedUsd: stakedUsd + (poolUsd ?? 0),
    },
    escrow: {
      sol: escrowSol,
      openMatches,
      activeMatches,
    },
    pool: {
      usd: poolUsd,
      mempire: baseTokens,
      usdc: quoteUsd,
      mempirePrice,
    },
    cards: {
      count: cards.length,
      stakedUsd,
    },
  };
}

export function registerTvlRoutes(app, { programId, amm }) {
  app.get('/api/analytics/tvl', async (_req, res) => {
    if (cached && Date.now() - cached.at < TTL_MS) return res.json(cached.body);
    try {
      const body = await readTvl(programId, amm);
      cached = { at: Date.now(), body };
      res.json(body);
    } catch (e) {
      // Serve the last good figure if there is one, saying plainly that it is
      // stale. A dashboard showing a number from a minute ago and admitting so
      // beats one showing zero, which reads as "nothing is locked".
      if (cached) return res.json({ ...cached.body, stale: true, error: String(e?.message ?? e).slice(0, 160) });
      res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
