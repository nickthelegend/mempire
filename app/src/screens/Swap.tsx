import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Pill, Spinner } from '../components/ui';
import {
  AMM_CONFIG_MATCHES_CLUSTER, MEMPIRE_MINT, POOL, UNIT, USDC_MINT,
  quote, readPool, swap, tokenBalance, type PoolState,
} from '../chain/amm';
import { IS_MAINNET, canSign, explorerUrl } from '../chain/provider';
import { describe as describeMarket, type MarketInfo } from '../chain/market';
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

/**
 * The same number, without the thousands separators.
 *
 * `fmt` is for reading and goes through `toLocaleString()`. Feeding its output
 * back into the amount field was a silent dead end: "max" wrote `1,234.5678`,
 * `parseAmount` refuses a comma and returned `0n`, and the quote, the button
 * and the whole screen just stopped responding. Only above a thousand, which
 * is why it survived — every test balance was smaller.
 */
const plain = (raw: bigint): string => {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const frac = (v % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / UNIT}${frac ? `.${frac}` : ''}`;
};

/** Parses a typed amount into base units without going through a float. */
function parseAmount(text: string): bigint {
  // Grouping separators are stripped rather than rejected: a pasted amount
  // from anywhere else in the app, or from a block explorer, carries them.
  const m = text.trim().replace(/,/g, '').match(/^(\d*)(?:\.(\d{0,6}))?$/);
  if (!m) return 0n;
  const whole = m[1] ? BigInt(m[1]) : 0n;
  const frac = (m[2] ?? '').padEnd(6, '0');
  return whole * UNIT + BigInt(frac || '0');
}

/**
 * The swap itself, with no page around it.
 *
 * Lives apart from the screen because it is reached two ways: as a route, and
 * as a sheet from the + on the $MEMPIRE balance. A trade started from the
 * balance should be the *same* trade, against the same pool with the same
 * guards — not a simplified one that happens to look similar.
 */
export function SwapPanel({ compact = false }: { compact?: boolean }) {
  /*
   * Where $MEMPIRE actually trades.
   *
   * Two venues, and the difference matters to a player only in that one of
   * them exists: the local `mempire_amm` pool, and the Bags market. Bags is
   * preferred where it is configured, because it means no second program was
   * deployed and no liquidity had to be seeded. Asked once, cached.
   */
  const [market, setMarket] = useState<MarketInfo | null>(null);
  useEffect(() => { void describeMarket().then(setMarket); }, []);

  const address = useWallet((s) => s.address);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolFailed, setPoolFailed] = useState(false);
  const [buying, setBuying] = useState(true); // USDC -> MEMPIRE
  const [input, setInput] = useState('');
  const [slippage, setSlippage] = useState<bigint>(50n);
  const [balances, setBalances] = useState({ usdc: 0n, mempire: 0n });
  /**
   * Whether the balances above are an answer or just their initial value.
   *
   * They start at zero, which is indistinguishable from a genuinely empty
   * wallet — so "is this more than you hold?" cannot be asked until a read has
   * actually landed. The old guard dodged that by only firing when the balance
   * was above zero, which disabled it for precisely the wallet that needed it:
   * hold nothing, type any number, and the button stayed live to submit a
   * transfer the chain would reject with a raw SPL error.
   */
  const [balancesRead, setBalancesRead] = useState(false);
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
        setBalancesRead(true);
      } catch {
        // No token account yet — zero is the right answer, and it is an answer.
        setBalancesRead(true);
      }
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
  const overBalance = balancesRead && amountIn > held;
  const canSwap = !!q && !busy && amountIn > 0n && !overBalance && canSign(signer());

  /*
   * The one state where quoting at all would be a lie: no venue can fill an
   * order. Either Bags has no market yet (before $MEMPIRE is launched) or
   * this build's cluster disagrees with the pool baked into amm.json — a
   * mainnet bundle cut before the mainnet pool existed, or the reverse.
   * Refuse with the reason rather than show a price nobody can trade at.
   *
   * This sat directly under `market`'s own hooks, above the fourteen that
   * follow — so the first render (with `market` still null) called eighteen
   * hooks and the render after `describeMarket()` resolved called four and
   * returned. React counts hooks per render and throws "rendered fewer hooks
   * than expected", which is not a caught error: it takes the whole app down,
   * not just this screen. And the branch is precisely the shipping mainnet
   * configuration — a bundle cut before Bags is configured — so the crash was
   * waiting for launch day rather than for an edge case.
   *
   * The refusal is unchanged in shape; it just happens after every hook has run.
   *
   * It no longer makes an exception for Bags, either. `onBags` was allowed to
   * wave the cluster check through on the grounds that Bags would fill the
   * order — but nothing on this screen has ever routed to Bags. `quote` and
   * `swap` are imported from `../chain/amm`, and the Bags client in
   * `../chain/market` exports its own `quote` and `swap` that are imported
   * nowhere; `describe` is the only thing this screen takes from it. So a
   * configured Bags market disabled the one guard standing between the player
   * and a pool baked into `amm.json` for a different cluster, and then traded
   * against that pool while the screen said the venue was Bags.
   *
   * Until the Bags venue is wired to this button, the only venue that can fill
   * an order here is the local pool, and the guard is about that pool.
   */
  if (market !== null && !AMM_CONFIG_MATCHES_CLUSTER) {
    return (
      <div className="panel" style={{ padding: 16 }}>
        <p className="fine" style={{ color: 'var(--dim)', margin: 0, lineHeight: 1.5 }}>
          {market.note} There is no market for $MEMPIRE on this cluster yet, and
          quoting one you cannot trade against would be worse than saying so.
          Everything else in the game works; swaps arrive with the market.
        </p>
      </div>
    );
  }

  async function onSwap() {
    if (!q) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      /*
       * Price the floor against the pool as it is now, not as it was on mount.
       *
       * `refresh()` runs on mount and after a completed swap — no interval, no
       * re-read on focus, and none at submit. `minReceived` is derived from
       * those reserves and handed to the program as `min_amount_out`, so the
       * 0.1%–1% the player picked was being applied to a price that could be
       * hours old. That is precisely backwards: the guard is meant to bound
       * how far the price may move *from now*, and instead it was absorbing
       * all the drift that had already happened. This file's own docstring
       * promises the opposite — "nothing is estimated and nothing is cached
       * across a trade".
       */
      const fresh = await readPool();
      if (!fresh) {
        setError('The pool is unreachable — there is no price to trade against right now.');
        return;
      }
      setPool(fresh);
      const fq = buying
        ? quote(amountIn, fresh.reserveQuote, fresh.reserveBase, slippage)
        : quote(amountIn, fresh.reserveBase, fresh.reserveQuote, slippage);
      if (!fq) {
        setError('That amount cannot be quoted against the pool as it stands.');
        return;
      }
      /*
       * If the world moved more than the tolerance while the screen sat there,
       * show the new number and make them look at it. Signing silently against
       * a price they never saw is the thing the tolerance exists to prevent.
       */
      if (q.amountOut > 0n) {
        const drift = fq.amountOut > q.amountOut
          ? q.amountOut * 10_000n / fq.amountOut
          : fq.amountOut * 10_000n / q.amountOut;
        if (10_000n - drift > slippage) {
          setError('The price moved while this was open — the quote above is updated. Check it and swap again.');
          return;
        }
      }
      const sig = await swap(signer(), amountIn, fq.minReceived, buying);
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

  // Every grid on this panel, sized so it can never be wider than its parent.
  //
  // Two defaults conspire here. A grid *item* is `min-width: auto`, so it
  // refuses to shrink below its own min-content; and an `auto` grid *track*
  // is sized to its items' min-content, so one unbreakable row widens the
  // track and the overflow escapes the panel. `minmax(0, 1fr)` caps the
  // track at the container, and `minWidth: 0` lets the grid itself shrink
  // when it is in turn an item of the grid above.
  //
  // This never showed on the full-width /swap route — it has 398px of room.
  // It only appeared inside the Crowns sheet, which is 61px narrower.
  const NARROW = {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0,
  } as const;

  const inLabel = buying ? 'USDC' : '$MEMPIRE';
  const outLabel = buying ? '$MEMPIRE' : 'USDC';

  return (
    <div style={{ ...NARROW, gap: compact ? 11 : 14 }}>
      {!compact && (
        <header>
          <h1 style={{ margin: 0 }}>SWAP</h1>
          <p className="fine" style={{ color: 'var(--dim)', margin: '2px 0 0' }}>
            {pool && pool.reserveBase > 0n
              ? `1 $MEMPIRE = $${pool.price.toFixed(8)} · pool ${fmt(pool.reserveQuote, 2)} USDC`
              : 'reading the pool…'}
          </p>
        </header>
      )}

      {poolFailed && (
        <div className="well" role="alert" style={{ ...NARROW, padding: 12, borderRadius: 10 }}>
          <strong>The pool is unreachable.</strong>
          <p className="fine" style={{ margin: '4px 0 0', color: 'var(--dim)' }}>
            No quote is shown rather than a stale one. Check your connection and retry.
          </p>
        </div>
      )}

      {/*
        A player who cannot pay needs the next step, not a disabled form.

        The quote side of this pool is Circle's *real* devnet USDC, which the
        game cannot mint and does not hand out — so someone who has just
        claimed the starter kit (SOL, eight coins, $MEMPIRE) arrives here with
        a zero balance and no way, anywhere in the product, to get one. The
        `+` on the $MEMPIRE pill routes straight to this screen, which made
        "get more $MEMPIRE" a dead end. Saying where the token comes from is
        the difference between a broken screen and an errand.
      */}
      {!IS_MAINNET && buying && balances.usdc === 0n && (
        <p
          className="fine"
          style={{
            ...NARROW, padding: '10px 12px', margin: 0, borderRadius: 12,
            background: 'var(--recess)', border: '2px solid var(--ink)',
            color: 'var(--dim)', lineHeight: 1.4,
          }}
        >
          This pool quotes in Circle&apos;s devnet USDC, which Mempire does not
          issue. Grab some free at{' '}
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--teal)' }}
          >
            faucet.circle.com
          </a>{' '}
          (pick Solana Devnet), then come back. Winning matches and merging
          duplicates costs no USDC at all — this is only for topping up.
        </p>
      )}

      {/* ── you pay ────────────────────────────────────────────────────── */}
      <div className="well" style={{ ...NARROW, padding: 12, borderRadius: 12, gap: 6 }}>
        {/* wraps rather than blows out: "balance 1,234.5678 USDC · max" is a
            long string next to a label, and both refuse to shrink */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span className="label">You pay</span>
          <button
            type="button"
            onClick={() => setInput(plain(held))}
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
            More than you hold — you have {fmt(held, 4)} {inLabel}.
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
      <div className="well" style={{ ...NARROW, padding: 12, borderRadius: 12, gap: 6 }}>
        <span className="label">You receive</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            className="display"
            style={{ flex: 1, minWidth: 0, fontSize: 26, color: q ? 'var(--text)' : 'var(--dim)' }}
          >
            {q ? fmt(q.amountOut, 4) : '0.0'}
          </span>
          <span className="display" style={{ fontSize: 16 }}>{outLabel}</span>
        </div>
      </div>

      {/* ── the costs, stated ──────────────────────────────────────────── */}
      {q && (
        <div className="well" style={{ ...NARROW, padding: 12, borderRadius: 10, gap: 5 }}>
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
        {busy ? ' Swapping…' : 'Swap'}
      </Pill>

      {/* A guest CAN swap now — its address is a real keypair held in this
          browser, and on devnet it signs for itself. What it cannot do is
          survive a cleared browser, so the warning is about custody rather
          than capability. */}
      {!signer() && canSign(null) && (
        <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
          You are playing as a guest. Your address is a real keypair kept in
          this browser, so swaps and staked matches work — but clearing site
          data destroys it and there is no recovery phrase. Connect a wallet to
          hold anything you would miss.
        </p>
      )}

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
        {IS_MAINNET ? 'Mainnet.' : 'Devnet.'} Quoted in Circle&apos;s USDC ({USDC_MINT.toBase58().slice(0, 4)}…
        {USDC_MINT.toBase58().slice(-4)}), constant product, 0.30% to liquidity
        providers. Pool {POOL.toBase58().slice(0, 4)}…{POOL.toBase58().slice(-4)}.
      </p>
    </div>
  );
}

/** The Swap route. Still deep-linkable; no longer a tab. */
export function Swap() {
  return (
    <div className="screen-in" style={{ padding: '18px 16px' }}>
      <SwapPanel />
    </div>
  );
}

function Row({ label, children, warn }: {
  label: string; children: React.ReactNode; warn?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span className="fine" style={{ color: 'var(--dim)', flexShrink: 0 }}>{label}</span>
      <span
        className="fine"
        style={{
          color: warn ? 'var(--red)' : 'var(--text)', textAlign: 'right',
          // "1 USDC = 0.00012345 $MEMPIRE" is longer than the row is wide in
          // the sheet; let it wrap instead of pushing the row past the panel.
          minWidth: 0, wordBreak: 'break-word',
        }}
      >
        {children}
      </span>
    </div>
  );
}
