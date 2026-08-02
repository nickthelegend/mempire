import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Pill, Spinner } from '../components/ui';
import {
  MEMPIRE_MINT, POOL, UNIT, USDC_MINT, quote, readPool, swap, tokenBalance,
  type PoolState,
} from '../chain/amm';
import { explorerUrl } from '../chain/provider';
import { useWallet } from '../state/wallet';
import { signer } from '../state/wallet';

/**
 * Swap USDC for $MEMPIRE, against the live pool.
 *
 * Every figure on this screen is read from the pool account. Nothing is
 * estimated and nothing is cached across a trade: a quote the pool would not
 * honour is worse than no quote at all, because the trader only finds out by
 * losing money. When the pool cannot be read the screen says so and refuses to
 * quote rather than showing a stale number.
 */

/** Slippage the swap will tolerate before the program reverts it. */
const SLIPPAGE_CHOICES = [10n, 50n, 100n] as const; // 0.1%, 0.5%, 1%

const fmt = (raw: bigint, dp = 6): string => {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(6, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString()}${frac ? `.${frac}` : ''}`;
};

/** Parses a typed amount into base units without going through a float. */
function parseAmount(text: string): bigint {
  const m = text.trim().match(/^(\d*)(?:\.(\d{0,6}))?$/);
  if (!m) return 0n;
  const whole = m[1] ? BigInt(m[1]) : 0n;
  const frac = (m[2] ?? '').padEnd(6, '0');
  return whole * UNIT + BigInt(frac || '0');
}

export function Swap() {
  const address = useWallet((s) => s.address);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolFailed, setPoolFailed] = useState(false);
  const [buying, setBuying] = useState(true); // USDC -> MEMPIRE
  const [input, setInput] = useState('');
  const [slippage, setSlippage] = useState<bigint>(50n);
  const [balances, setBalances] = useState({ usdc: 0n, mempire: 0n });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const p = await readPool();
    setPool(p);
    setPoolFailed(p === null);
    if (address) {
      try {
        const owner = new PublicKey(address);
        setBalances({
          usdc: await tokenBalance(owner, USDC_MINT),
          mempire: await tokenBalance(owner, MEMPIRE_MINT),
        });
      } catch { /* a guest address is not a real key; balances stay zero */ }
    }
  }, [address]);

  useEffect(() => { void refresh(); }, [refresh]);

  const amountIn = parseAmount(input);
  const q = useMemo(() => {
    if (!pool || amountIn <= 0n) return null;
    return buying
      ? quote(amountIn, pool.reserveQuote, pool.reserveBase, slippage)
      : quote(amountIn, pool.reserveBase, pool.reserveQuote, slippage);
  }, [pool, amountIn, buying, slippage]);

  const held = buying ? balances.usdc : balances.mempire;
  const overBalance = amountIn > held && held > 0n;
  const canSwap = !!q && !busy && amountIn > 0n && !overBalance && !!signer();

  async function onSwap() {
    if (!q) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const sig = await swap(signer(), amountIn, q.minReceived, buying);
      setDone(sig);
      setInput('');
      await refresh();
    } catch (e) {
      // Surface the program's own words. A swap that reverts on slippage is
      // not a bug and should not read like one.
      const msg = String((e as { message?: string })?.message ?? e);
      setError(
        /SlippageExceeded|below the minimum/i.test(msg)
          ? 'Price moved past your slippage limit. Try again, or raise the tolerance.'
          : msg.slice(0, 160),
      );
    } finally {
      setBusy(false);
    }
  }

  const inLabel = buying ? 'USDC' : '$MEMPIRE';
  const outLabel = buying ? '$MEMPIRE' : 'USDC';

  return (
    <div className="screen-in" style={{ display: 'grid', gap: 14 }}>
      <header>
        <h1 style={{ margin: 0 }}>SWAP</h1>
        <p className="fine" style={{ color: 'var(--dim)', margin: '2px 0 0' }}>
          {pool && pool.reserveBase > 0n
            ? `1 $MEMPIRE = $${pool.price.toFixed(8)} · pool ${fmt(pool.reserveQuote, 2)} USDC`
            : 'reading the pool…'}
        </p>
      </header>

      {poolFailed && (
        <div className="well" role="alert" style={{ padding: 12, borderRadius: 10 }}>
          <strong>The pool is unreachable.</strong>
          <p className="fine" style={{ margin: '4px 0 0', color: 'var(--dim)' }}>
            No quote is shown rather than a stale one. Check your connection and retry.
          </p>
        </div>
      )}

      {/* ── you pay ────────────────────────────────────────────────────── */}
      <div className="well" style={{ padding: 12, borderRadius: 12, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="label">You pay</span>
          <button
            type="button"
            onClick={() => setInput(fmt(held))}
            className="fine"
            style={{
              background: 'none', border: 0, color: 'var(--dim)', cursor: 'pointer', padding: 0,
            }}
          >
            balance {fmt(held, 4)} {inLabel} · max
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.0"
            aria-label={`Amount of ${inLabel} to swap`}
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 0,
              color: 'var(--text)', fontFamily: 'var(--font-display)', fontSize: 26,
              outline: 'none',
            }}
          />
          <span className="display" style={{ fontSize: 16 }}>{inLabel}</span>
        </div>
        {overBalance && (
          <span className="fine" style={{ color: 'var(--red)' }}>
            More than you hold.
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => { setBuying((b) => !b); setInput(''); }}
        aria-label="Swap direction"
        className="btn-3d"
        style={{
          justifySelf: 'center', width: 40, height: 40, borderRadius: '50%',
          border: '2px solid var(--ink)', background: 'var(--recess)',
          color: 'var(--text)', fontSize: 18, cursor: 'pointer',
        }}
      >
        ↓
      </button>

      {/* ── you receive ────────────────────────────────────────────────── */}
      <div className="well" style={{ padding: 12, borderRadius: 12, display: 'grid', gap: 6 }}>
        <span className="label">You receive</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="display"
            style={{ flex: 1, fontSize: 26, color: q ? 'var(--text)' : 'var(--dim)' }}
          >
            {q ? fmt(q.amountOut, 4) : '0.0'}
          </span>
          <span className="display" style={{ fontSize: 16 }}>{outLabel}</span>
        </div>
      </div>

      {/* ── the costs, stated ──────────────────────────────────────────── */}
      {q && (
        <div className="well" style={{ padding: 12, borderRadius: 10, display: 'grid', gap: 5 }}>
          <Row label="Rate">
            1 {inLabel} = {fmt((q.amountOut * UNIT) / amountIn, 6)} {outLabel}
          </Row>
          <Row label="Fee (0.30%)">{fmt(q.fee, 6)} {inLabel}</Row>
          <Row
            label="Price impact"
            warn={q.priceImpact > 0.05}
          >
            {(q.priceImpact * 100).toFixed(2)}%
          </Row>
          <Row label="Minimum received">{fmt(q.minReceived, 4)} {outLabel}</Row>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <span className="fine" style={{ color: 'var(--dim)' }}>Slippage</span>
            {SLIPPAGE_CHOICES.map((bps) => (
              <button
                key={String(bps)}
                type="button"
                onClick={() => setSlippage(bps)}
                aria-pressed={slippage === bps}
                className="fine"
                style={{
                  border: `1.5px solid ${slippage === bps ? 'var(--gold)' : 'var(--border)'}`,
                  background: slippage === bps ? 'rgba(255,196,34,.14)' : 'transparent',
                  color: slippage === bps ? 'var(--gold)' : 'var(--dim)',
                  borderRadius: 999, padding: '2px 9px', cursor: 'pointer',
                }}
              >
                {Number(bps) / 100}%
              </button>
            ))}
          </div>
          {q.priceImpact > 0.05 && (
            <p className="fine" style={{ color: 'var(--red)', margin: '4px 0 0' }}>
              This trade is large relative to the pool and moves the price
              {' '}{(q.priceImpact * 100).toFixed(1)}%. You will get a worse rate than the
              headline price.
            </p>
          )}
        </div>
      )}

      <Pill
        tone="gold"
        onClick={onSwap}
        disabled={!canSwap}
        aria-label={`Swap ${input || '0'} ${inLabel} for ${outLabel}`}
      >
        {busy ? <Spinner /> : null}
        {busy ? ' Swapping…' : signer() ? 'Swap' : 'Connect a wallet to swap'}
      </Pill>

      {error && (
        <p role="alert" className="fine" style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
      )}
      {done && (
        <p className="fine" style={{ margin: 0 }}>
          Swapped.{' '}
          <a href={explorerUrl(done)} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--teal)' }}>
            View the transaction
          </a>
        </p>
      )}

      <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
        Devnet. Quoted in Circle&apos;s USDC ({USDC_MINT.toBase58().slice(0, 4)}…
        {USDC_MINT.toBase58().slice(-4)}), constant product, 0.30% to liquidity
        providers. Pool {POOL.toBase58().slice(0, 4)}…{POOL.toBase58().slice(-4)}.
      </p>
    </div>
  );
}

function Row({ label, children, warn }: {
  label: string; children: React.ReactNode; warn?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span className="fine" style={{ color: 'var(--dim)' }}>{label}</span>
      <span className="fine" style={{ color: warn ? 'var(--red)' : 'var(--text)', textAlign: 'right' }}>
        {children}
      </span>
    </div>
  );
}
