/**
 * Builds the mainnet coin registry — from verified identities, not search.
 *
 * The first version of this script searched DexScreener by ticker and took
 * the deepest pair. That returned a "BTC" with eight billion dollars of
 * claimed liquidity on a mint nobody has heard of, and a "SOL" that was not
 * wrapped SOL — scam tokens wear real tickers and spoof their metrics, and a
 * card game that stakes real tokens cannot have one in its registry.
 *
 * So identity comes first and market data second:
 *
 *   1. the mint for each ticker comes from Jupiter's *verified* token list —
 *      a curated identity source — never from search results;
 *   2. market data (price, liquidity, pair age) is then read from
 *      DexScreener for that exact mint, deepest Solana pair;
 *   3. decimals must agree between Jupiter and mainnet RPC;
 *   4. anything without a verified identity or under the $25k liquidity
 *      floor the program enforces is dropped, and the drop is printed.
 *
 * Output: app/src/lib/mainnet-coins.json + server/mainnet-coins.json,
 * stamped "cluster": "mainnet-beta". Reads only — free to run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '../app/node_modules/@solana/web3.js/lib/index.cjs.js';

const RPC = process.env.SOLANA_RPC ?? 'https://rpc.magicblock.app/mainnet';
const conn = new Connection(RPC, 'confirmed');
const devnet = JSON.parse(readFileSync(new URL('../app/src/lib/devnet-coins.json', import.meta.url)));

const MIN_LIQUIDITY_USD = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Majors that trade on Solana under a wrapped/bridged symbol. The registry
// keeps the game's ticker; the identity is the bridged asset.
const ALIASES = { BTC: ['WBTC', 'CBBTC'], ETH: ['WETH'], SOL: ['SOL'] };

console.log('fetching Jupiter verified token list…');
// v2 of the token API; the old tokens.jup.ag hostname no longer resolves.
const jupRes = await fetch('https://lite-api.jup.ag/tokens/v2/tag?query=verified', {
  headers: { accept: 'application/json' },
});
if (!jupRes.ok) throw new Error(`Jupiter list: HTTP ${jupRes.status}`);
const verified = (await jupRes.json())
  .filter((t) => t.isVerified !== false)
  .map((t) => ({ address: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals }));
const bySymbol = new Map();
for (const t of verified) {
  const sym = String(t.symbol ?? '').toUpperCase();
  if (!bySymbol.has(sym)) bySymbol.set(sym, []);
  bySymbol.get(sym).push(t);
}
console.log(`  ${verified.length} verified tokens`);

async function marketFor(mint) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const pairs = (body.pairs ?? [])
    .filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint)
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  return pairs[0] ?? null;
}

const out = [];
const skipped = [];
for (const seed of devnet.coins) {
  const ticker = seed.ticker.toUpperCase();
  const candidates = [ticker, ...(ALIASES[ticker] ?? [])]
    .flatMap((sym) => bySymbol.get(sym) ?? []);
  if (!candidates.length) { skipped.push(`${ticker} (not in verified list)`); continue; }

  let picked = null;
  let market = null;
  for (const cand of candidates) {
    const m = await marketFor(cand.address).catch(() => null);
    await sleep(350);
    if (m && Number(m.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD
        && (!market || Number(m.liquidity.usd) > Number(market.liquidity.usd))) {
      picked = cand; market = m;
    }
  }
  if (!picked || !market) { skipped.push(`${ticker} (no liquid market)`); continue; }

  let rpcDecimals = null;
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(picked.address));
    rpcDecimals = info.value?.data?.parsed?.info?.decimals ?? null;
  } catch { /* unverifiable */ }
  if (rpcDecimals === null || rpcDecimals !== picked.decimals) {
    skipped.push(`${ticker} (decimals disagree: jup ${picked.decimals} rpc ${rpcDecimals})`);
    continue;
  }

  out.push({
    mint: picked.address,
    ticker: seed.ticker,
    name: picked.name ?? seed.name,
    hue: seed.hue,
    priceUsd: Number(market.priceUsd ?? 0),
    liquidityUsd: Math.round(Number(market.liquidity.usd)),
    firstSeen: market.pairCreatedAt ? Math.floor(market.pairCreatedAt / 1000) : 0,
    decimals: rpcDecimals,
  });
  console.log(`  ${seed.ticker.padEnd(9)} ${picked.address.slice(0, 10)}… $${Number(market.priceUsd).toPrecision(5)} liq $${Math.round(Number(market.liquidity.usd) / 1000)}k dec ${rpcDecimals}`);
}

const registry = { cluster: 'mainnet-beta', builtAt: new Date().toISOString(), coins: out };
writeFileSync(new URL('../app/src/lib/mainnet-coins.json', import.meta.url), JSON.stringify(registry, null, 2));
writeFileSync(new URL('../server/mainnet-coins.json', import.meta.url), JSON.stringify(registry, null, 2));
console.log(`\nwrote ${out.length} coins; skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
