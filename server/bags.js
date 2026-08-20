/**
 * The $MEMPIRE market, proxied from Bags.
 *
 * Bags runs on Meteora's Dynamic Bonding Curve: a token trades against a
 * virtual pool from the moment it launches and graduates into a real DAMM pool
 * at a threshold. That replaces deploying and seeding our own AMM — the market
 * makes itself, the token gets a Dexscreener listing, and the creator earns a
 * share of every trade in perpetuity.
 *
 * # Why the relay sits in the middle
 *
 * Bags authenticates with an `x-api-key`, and a key shipped to a browser is a
 * key anyone can read and spend this project's rate limit on. So the browser
 * asks the relay, the relay holds the key, and the client stays exactly as
 * dumb about credentials as it was for the coin feed.
 *
 * # Absent is a state, not an error
 *
 * With no key configured these routes report `configured: false` rather than
 * failing. The swap screen already knows how to refuse honestly when there is
 * no market for the current cluster, and this is the same condition arriving
 * from a different direction: before $MEMPIRE is launched on Bags there is
 * genuinely nothing to quote, and inventing a number would be the one
 * unacceptable answer.
 */
const BAGS_API = process.env.BAGS_API ?? 'https://public-api-v2.bags.fm/api/v1';
const BAGS_KEY = process.env.BAGS_API_KEY ?? '';

/** The mint Bags created for $MEMPIRE. Empty until the token is launched. */
const MEMPIRE_MINT = process.env.MEMPIRE_MINT ?? '';
const WSOL = 'So11111111111111111111111111111111111111112';

export const bagsConfigured = () => Boolean(BAGS_KEY && MEMPIRE_MINT);

async function bags(path, init = {}) {
  const res = await fetch(`${BAGS_API}${path}`, {
    ...init,
    headers: { 'x-api-key': BAGS_KEY, accept: 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? `bags ${res.status}`;
    const err = new Error(String(msg).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  // Bags wraps payloads in { success, response }.
  return body?.response ?? body;
}

export function registerBagsRoutes(app, limit) {
  const gate = limit ?? ((_req, _res, next) => next());

  /**
   * What the client needs before it can render a swap screen at all: whether a
   * market exists, and which mint it is against.
   */
  app.get('/api/market', gate, (_req, res) => {
    res.json({
      configured: bagsConfigured(),
      venue: 'bags',
      mint: MEMPIRE_MINT || null,
      quoteMint: WSOL,
      // Stated so the UI can show it rather than the player discovering it in
      // the difference between the quote and the fill.
      note: MEMPIRE_MINT
        ? 'Quotes come from the Bags market for $MEMPIRE.'
        : '$MEMPIRE has not been launched on Bags yet.',
    });
  });

  /**
   * A quote for swapping in either direction.
   *
   * `amount` is in the input token's smallest unit, matching the upstream
   * contract exactly — converting units in two places is how a swap screen
   * ends up quoting one number and filling another.
   */
  app.get('/api/market/quote', gate, async (req, res) => {
    if (!bagsConfigured()) {
      return res.status(503).json({ error: 'no market configured', configured: false });
    }
    const { inputMint, outputMint, amount, slippageBps } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'inputMint, outputMint and amount are required' });
    }
    const qs = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: String(amount),
    });
    if (slippageBps) {
      qs.set('slippageMode', 'manual');
      qs.set('slippageBps', String(slippageBps));
    }
    try {
      const q = await bags(`/trade/quote?${qs}`);
      res.json({
        inAmount: q.inAmount,
        outAmount: q.outAmount,
        minOutAmount: q.minOutAmount,
        priceImpactPct: q.priceImpactPct,
        slippageBps: q.slippageBps,
        requestId: q.requestId,
      });
    } catch (e) {
      res.status(e.status === 400 ? 400 : 502).json({ error: e.message });
    }
  });

  /**
   * The unsigned swap transaction for a quote the client already has.
   *
   * Returned unsigned on purpose: the relay never holds a player's key, so it
   * builds and the wallet signs. `requestId` ties it to the exact quote that
   * was shown, which is what stops the fill drifting from the number on screen.
   */
  app.post('/api/market/swap', gate, async (req, res) => {
    if (!bagsConfigured()) {
      return res.status(503).json({ error: 'no market configured', configured: false });
    }
    const { requestId, userPublicKey } = req.body ?? {};
    if (!requestId || !userPublicKey) {
      return res.status(400).json({ error: 'requestId and userPublicKey are required' });
    }
    try {
      const tx = await bags('/trade/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, userPublicKey }),
      });
      res.json({ transaction: tx.transaction ?? tx.swapTransaction ?? null });
    } catch (e) {
      res.status(e.status === 400 ? 400 : 502).json({ error: e.message });
    }
  });
}
