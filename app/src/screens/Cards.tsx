import { useEffect, useMemo, useRef, useState } from 'react';
import { CardDetail } from '../components/CardDetail';
import { CardFrame } from '../components/CardFrame';
import { ChainBadge } from '../components/ChainBadge';
import { ChestRail, GemShop } from '../components/Chests';
import { Shop } from '../components/Shop';
import { CoinBadge, LevelPips, Pill, Spinner } from '../components/ui';
import {
  claimUnstakeTx, mintCardTx, readableChainError, requestUnstakeTx, stakeTx,
} from '../chain/actions';
import { click, play } from '../lib/audio';
import { useChain } from '../state/chain';
import {
  ASSET_KINDS, COINS, ineligibleReason, tickerOf, toRawAmount,
  type AssetKind, type Coin,
} from '../lib/coins';
import { fmtSol, fmtTokens, fmtUsd } from '../lib/format';
import { levelForUsd, nextLevelAt } from '../lib/leveling';
import { EASE_SNAP, usePulse } from '../lib/motion';
import { revealSection } from '../lib/scroll';
import { FEES, UNSTAKE_COOLDOWN_MS, useCollection, type MintedCard } from '../state/collection';
import { useEconomy } from '../state/economy';
import { signer, useWallet } from '../state/wallet';
import { Token } from '../components/Token';

const STAKE_CHIPS = [10, 25, 50, 100, 500];

/** "All" first, then the three asset classes from the shared catalogue. */
const FILTERS: { id: AssetKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  ...ASSET_KINDS,
];
const TAP = { minHeight: 44 } as const;

/** Live seconds remaining; re-renders once a second only while counting. */
function useCountdown(until: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function StakeSheet({ card, onClose }: { card: MintedCard; onClose: () => void }) {
  const { stake, requestUnstake, claimUnstake, availableUsdFor } = useCollection();
  const chainMode = useChain((s) => s.mode);
  const chainCards = useChain((s) => s.cards);
  const refresh = useChain((s) => s.refresh);
  const noteSignature = useChain((s) => s.noteSignature);
  const [amount, setAmount] = useState(25);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(card.cooldownUntil);
  const coin = COINS.find((c) => c.mint === card.mint);

  // The onchain twin of this local card, when one exists. Local cards carry a
  // string id; chain cards a numeric PDA id — matched by mint, oldest first.
  const chainCard = chainMode === 'onchain'
    ? chainCards.find((c) => c.mint === card.mint)
    : undefined;

  /**
   * Onchain staking moves real SPL tokens into the card's vault. The local
   * store still updates afterwards so the rest of the app (deck power, level)
   * follows immediately; the next refresh reconciles from the chain.
   */
  const stakeOnchain = async (usd: number) => {
    if (!chainCard || !coin) return;
    setPending(true);
    setError(null);
    try {
      const tokens = usd / coin.priceUsd;
      const { signature } = await stakeTx(
        signer(), chainCard.id, coin.mint, toRawAmount(coin, tokens),
      );
      noteSignature(signature);
      setError(stake(card.id, usd));
      play('reward');
      void refresh();
    } catch (e) {
      setError(readableChainError(e));
      play('error');
    } finally {
      setPending(false);
    }
  };

  /** Both unstake steps run against the program when the card lives onchain. */
  const unstakeOnchain = async (usd: number) => {
    if (!chainCard || !coin) return;
    setPending(true);
    setError(null);
    try {
      const { signature } = await requestUnstakeTx(
        signer(), chainCard.id, toRawAmount(coin, usd / coin.priceUsd),
      );
      noteSignature(signature);
      requestUnstake(card.id, usd);
      void refresh();
    } catch (e) {
      setError(readableChainError(e));
      play('error');
    } finally {
      setPending(false);
    }
  };

  const claimOnchain = async () => {
    if (!chainCard || !coin) return;
    setPending(true);
    setError(null);
    try {
      const { signature } = await claimUnstakeTx(signer(), chainCard.id, coin.mint);
      noteSignature(signature);
      claimUnstake(card.id);
      play('reward');
      void refresh();
    } catch (e) {
      // CooldownActive here means the local clock ran ahead of the chain's —
      // the program is the authority, so surface it and leave the claim pending.
      setError(readableChainError(e));
      play('error');
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    sheet.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!coin) return null;
  const next = nextLevelAt(card.stakedUsd);
  const afterLevel = levelForUsd(card.stakedUsd + amount);
  const available = availableUsdFor(card.mint);
  const cooling = remaining > 0;
  const claimable = card.pendingUnstakeUsd > 0 && remaining === 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'center' }}>
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }}
      />
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Stake into ${tickerOf(coin)}`}
        className="panel sheet"
        style={{ gap: 12 }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <CoinBadge mint={card.mint} size={44} />
          <div>
            <div className="display" style={{ fontSize: 19 }}>{tickerOf(coin)}</div>
            <LevelPips level={card.level} />
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="icon-btn"
            style={{ marginLeft: 'auto', color: 'var(--dim-on-wood)', fontSize: 26, width: 44, height: 44 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
          <div className="well" style={{ padding: '9px 11px' }}>
            <div className="label" style={{ fontSize: 12 }}>Staked</div>
            <div className="money">{fmtUsd(card.stakedUsd)}</div>
            <div style={{ color: 'var(--dim)', fontSize: 12 }}>
              {fmtTokens(card.stakedTokens)} {tickerOf(coin)}
            </div>
          </div>
          <div className="well" style={{ padding: '9px 11px' }}>
            <div className="label" style={{ fontSize: 12 }}>Next level</div>
            <div style={{ fontWeight: 700 }}>
              {next ? `${fmtUsd(next.usd)} → Lv ${next.level}` : 'MAX'}
            </div>
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Stake more · <span className="money">{fmtUsd(available)}</span> of {tickerOf(coin)} free
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {STAKE_CHIPS.map((v) => {
              const affordable = v <= available;
              return (
                <button
                  key={v}
                  onClick={() => { setAmount(v); setError(null); }}
                  aria-pressed={amount === v}
                  disabled={!affordable}
                  className="btn-3d"
                  style={{
                    flex: 1, minWidth: 0, ...TAP, borderRadius: 9,
                    fontFamily: 'var(--font-display)', fontSize: 14,
                    background: amount === v
                      ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                      : 'var(--recess)',
                    border: '2px solid var(--ink)',
                    boxShadow: amount === v
                      ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)'
                      : 'var(--bevel-in)',
                    color: 'var(--text)',
                    WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                    filter: affordable ? 'none' : 'saturate(.3)',
                    opacity: affordable ? 1 : 0.55,
                    transition: 'background 160ms var(--ease-snap), box-shadow 120ms var(--ease-snap)',
                  }}
                >
                  ${v}
                </button>
              );
            })}
          </div>
        </div>

        {claimable ? (
          <Pill
            disabled={pending}
            onClick={() => {
              if (chainCard) { void claimOnchain(); return; }
              claimUnstake(card.id);
            }}
          >
            {pending ? 'Confirm in wallet…' : `Claim ${fmtUsd(card.pendingUnstakeUsd * (1 - FEES.unstakePct / 100))}`}
          </Pill>
        ) : (
          <Pill
            disabled={cooling || pending || amount > available}
            onClick={() => {
              if (chainCard) { void stakeOnchain(amount); return; }
              setError(stake(card.id, amount));
            }}
          >
            {pending ? 'Confirm in wallet…'
              : cooling ? 'Unstake pending'
                : `Stake $${amount} → Lv ${afterLevel}`}
          </Pill>
        )}

        {chainCard && (
          <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center', fontSize: 12, marginTop: -4 }}>
            Onchain card #{chainCard.id} — staking moves real tokens into its vault.
          </p>
        )}

        {error && (
          <p role="alert" className="fine" style={{ color: 'var(--red-on-wood)', textAlign: 'center' }}>{error}</p>
        )}

        {cooling ? (
          <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center' }}>
            {fmtUsd(card.pendingUnstakeUsd)} unstaking — claimable in {remaining}s
            {' '}(72h on mainnet, {UNSTAKE_COOLDOWN_MS / 1000}s on this devnet demo)
          </p>
        ) : !claimable && (
          <button
            onClick={() => {
              const usd = Math.min(amount, card.stakedUsd);
              if (chainCard) { void unstakeOnchain(usd); return; }
              requestUnstake(card.id, usd);
              setError(null);
            }}
            disabled={card.stakedUsd === 0 || pending}
            style={{
              ...TAP, fontSize: 13, fontWeight: 700, textDecoration: 'underline',
              color: card.stakedUsd === 0 ? 'var(--dim-on-wood)' : 'var(--text)',
              opacity: card.stakedUsd === 0 ? 0.5 : 1,
            }}
          >
            Unstake ${Math.min(amount, card.stakedUsd)} · {FEES.unstakePct}% fee, 72h cooldown
          </button>
        )}
      </div>
    </div>
  );
}

function CoinRow({ coin }: { coin: Coin }) {
  const wallet = useWallet();
  const { cards, mintCard } = useCollection();
  const chainMode = useChain((s) => s.mode);
  const chainBalances = useChain((s) => s.balances);
  const chainSol = useChain((s) => s.solBalance);
  const refresh = useChain((s) => s.refresh);
  const noteSignature = useChain((s) => s.noteSignature);
  const [minting, setMinting] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onchain = chainMode === 'onchain';
  const reason = ineligibleReason(coin);
  const owned = cards.filter((c) => c.mint === coin.mint).length;
  // Onchain, the balance shown is the wallet's real SPL holding of this mint —
  // the whole premise made literal. Simulated keeps the demo balance.
  const balance = onchain ? (chainBalances.get(coin.mint) ?? 0) : coin.balance;
  const value = balance * coin.priceUsd;
  const affordable = onchain ? chainSol >= FEES.mintSol : wallet.sol >= FEES.mintSol;
  const noHoldings = onchain && balance <= 0;

  /**
   * Onchain: one wallet-signed transaction; the program re-checks eligibility,
   * charges the fee, and creates the Card PDA. The local card is only minted
   * after the signature confirms, so the collection never shows a card the
   * chain refused.
   */
  const mintOnchain = async () => {
    setMinting(true);
    setChainError(null);
    try {
      const { signature } = await mintCardTx(signer(), coin.mint);
      noteSignature(signature);
      mintCard(coin.mint);
      play('reward');
      void refresh();
    } catch (e) {
      setChainError(readableChainError(e));
      play('error');
    } finally {
      setMinting(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      <CoinBadge mint={coin.mint} size={40} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {tickerOf(coin)}
          {owned > 0 && (
            <span style={{ color: 'var(--teal)', fontSize: 12, marginLeft: 6 }}>
              {owned} card{owned > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>
          {fmtTokens(balance)} · {fmtUsd(value)}
          {chainError && (
            <span role="alert" style={{ display: 'block', color: 'var(--red-on-wood)', fontWeight: 700 }}>
              {chainError}
            </span>
          )}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
        {reason ? (
          // Bare --red on wood is 2.3:1. The chip gives it a ground to sit on.
          <span
            className="well"
            style={{
              display: 'inline-block', padding: '5px 8px', fontSize: 12,
              fontWeight: 700, color: 'var(--red-on-wood)', maxWidth: 116,
              textAlign: 'center', lineHeight: 1.25,
            }}
          >
            {reason}
          </span>
        ) : noHoldings ? (
          <span
            className="well"
            style={{
              display: 'inline-block', padding: '5px 8px', fontSize: 12,
              fontWeight: 700, color: 'var(--dim)', maxWidth: 116,
              textAlign: 'center', lineHeight: 1.25,
            }}
          >
            none in wallet
          </span>
        ) : (
          <button
            onClick={() => {
              if (onchain) { void mintOnchain(); return; }
              if (!wallet.spend(FEES.mintSol)) return;
              setMinting(true);
              timer.current = setTimeout(() => { mintCard(coin.mint); setMinting(false); }, 600);
            }}
            disabled={minting || !affordable}
            title={affordable ? undefined : `needs ${fmtSol(FEES.mintSol)}`}
            className="btn-3d"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '0 14px', ...TAP, borderRadius: 'var(--r-pill)',
              fontFamily: 'var(--font-display)', fontSize: 14, letterSpacing: '0.03em',
              background: affordable
                ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 52%, var(--btn-gold-dark))'
                : 'var(--recess)',
              border: '2px solid var(--ink)',
              boxShadow: affordable
                ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 3px 0 var(--btn-gold-dark)'
                : 'var(--bevel-in)',
              color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
              opacity: minting ? 0.7 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {minting && <Spinner />}
            {minting ? 'Minting' : affordable ? `Mint · ${fmtSol(FEES.mintSol)}` : 'Need SOL'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The last confirmed transaction, linked to the explorer.
 *
 * This row is the difference between claiming the mint was onchain and letting
 * the player check. It renders only in onchain mode, because a link that
 * resolves to nothing would be worse than no link.
 */
function TxReceipt() {
  const sig = useChain((s) => s.lastSignature);
  const mode = useChain((s) => s.mode);
  const explorer = useChain((s) => s.explorer);
  if (!sig || mode !== 'onchain') return null;
  return (
    <a
      href={explorer(sig)}
      target="_blank"
      rel="noopener noreferrer"
      className="well"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
        padding: '9px 11px', minHeight: 44, textDecoration: 'none', color: 'inherit',
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--teal)', boxShadow: '0 0 7px var(--teal)', flexShrink: 0 }} />
      <span className="fine" style={{ fontSize: 12, minWidth: 0, flex: 1 }}>
        last tx <span className="mono">{sig.slice(0, 8)}…{sig.slice(-6)}</span>
      </span>
      <span className="label" style={{ fontSize: 12, color: 'var(--blue-pale)', flexShrink: 0 }}>
        explorer ↗
      </span>
    </a>
  );
}

export function Cards() {
  const cards = useCollection((s) => s.cards);
  const connected = useWallet((s) => s.connected);
  const openPicker = useWallet((s) => s.openPicker);
  const gems = useEconomy((s) => s.gems);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [stakeCard, setStakeCard] = useState<string | null>(null);
  const [gemShop, setGemShop] = useState(false);
  const bagsRef = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const shownCoins = useMemo(
    () => (kind === 'all' ? COINS : COINS.filter((c) => c.kind === kind)),
    [kind],
  );
  const gemRef = usePulse(gems, [
    { transform: 'scale(1)' },
    { transform: 'scale(1.28)', offset: 0.38 },
    { transform: 'scale(1)' },
  ], { duration: 440, easing: EASE_SNAP });
  const detail = useMemo(() => cards.find((c) => c.id === openCard), [cards, openCard]);
  const selected = useMemo(() => cards.find((c) => c.id === stakeCard), [cards, stakeCard]);
  const totalStaked = cards.reduce((s, c) => s + c.stakedUsd, 0);

  if (!connected) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, padding: 30, textAlign: 'center',
      }}
      >
        <h1 className="display" style={{ fontSize: 30 }}>Cards</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14 }}>
          Connect a wallet to see your bags and mint them into cards.
        </p>
        <Pill onClick={openPicker} style={{ maxWidth: 260 }}>Connect Wallet</Pill>
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div>
          <h1 className="display" style={{ fontSize: 30 }}>Cards</h1>
          <p className="fine">
            {cards.length} minted · <span className="money" style={{ fontSize: 14 }}>{fmtUsd(totalStaked)}</span> staked
          </p>
        </div>
        <button
          onClick={() => setGemShop(true)}
          aria-label="Get Crowns"
          className="btn-3d"
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
            minHeight: 44, padding: '0 13px', borderRadius: 999,
            background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
            border: '2.5px solid var(--ink)',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)',
          }}
        >
          <Token size={17} />
          {/* Crowns arrive from chests, lending and purchases — all of which happen
              elsewhere on the screen, so the counter has to announce itself. */}
          <span
            ref={gemRef as React.RefObject<HTMLSpanElement>}
            className="display display--sm"
            style={{ fontSize: 16, display: 'inline-block' }}
          >
            {gems}
          </span>
          <span className="display display--sm" style={{ fontSize: 16, opacity: 0.85 }}>+</span>
        </button>
      </header>

      <ChestRail />

      <Shop />

      <section aria-label="Your cards">
        {/* This section is the point of the screen; its neighbours both carry a
            visible header, so without one it read as a gap between them. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span className="label">Your cards</span>
          <span className="label" style={{ fontSize: 12 }}>{cards.length} minted</span>
        </div>
        {cards.length === 0 ? (
          <div className="panel" style={{ padding: '20px 18px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 11, alignItems: 'center' }}>
            <span style={{ color: 'var(--dim-on-wood)', fontSize: 14 }}>
              bag is empty, anon — turn a coin you hold into a card
            </span>
            <Pill
              tone="blue"
              onClick={() => revealSection(bagsRef.current)}
              style={{ maxWidth: 220, fontSize: 15, minHeight: 46, padding: '10px 18px' }}
            >
              Show my bags
            </Pill>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {cards.map((c) => (
              <CardFrame key={c.id} card={c} width={104} fluid onClick={() => setOpenCard(c.id)} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Your bags" ref={bagsRef} style={{ scrollMarginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <span className="label">Your bags · mint fee {fmtSol(FEES.mintSol)}</span>
          <ChainBadge compact />
        </div>

        {/* Memes, blue-chips and stocks are three different reasons to be here,
            and the list is long enough that scrolling past two of them to reach
            the third is the whole problem. Counts are on the chips so an empty
            class is visible before it is tapped. */}
        <div
          role="tablist"
          aria-label="Filter bags by asset class"
          style={{ display: 'flex', gap: 6, marginBottom: 7 }}
        >
          {FILTERS.map((f) => {
            const on = kind === f.id;
            const n = f.id === 'all' ? COINS.length : COINS.filter((c) => c.kind === f.id).length;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={on}
                onClick={() => { click(); setKind(f.id); }}
                className="btn-3d"
                style={{
                  flex: 1, minWidth: 0, minHeight: 44, borderRadius: 9,
                  background: on
                    ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: on
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)'
                    : 'var(--bevel-in)',
                  fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
                  WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                  transition: 'background 160ms var(--ease-snap)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                }}
              >
                {f.label}
                <span style={{ opacity: 0.8, fontSize: 12 }}>{n}</span>
              </button>
            );
          })}
        </div>

        <div className="panel" style={{ padding: '4px 14px' }}>
          {shownCoins.length === 0 ? (
            <p style={{ padding: '18px 0', textAlign: 'center', color: 'var(--dim-on-wood)', fontSize: 13 }}>
              nothing here yet, anon
            </p>
          ) : shownCoins.map((c, i) => (
            <div key={c.mint} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <CoinRow coin={c} />
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8 }}>
          Eligibility: ≥$25k liquidity and ≥48h old. Price via Jupiter (mocked on devnet).
        </p>
        <TxReceipt />
      </section>

      {detail && (
        <CardDetail
          card={detail}
          onClose={() => setOpenCard(null)}
          onStake={() => { setStakeCard(detail.id); setOpenCard(null); }}
        />
      )}
      {selected && <StakeSheet card={selected} onClose={() => setStakeCard(null)} />}
      {gemShop && <GemShop onClose={() => setGemShop(false)} />}
    </div>
  );
}
