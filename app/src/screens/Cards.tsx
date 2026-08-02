import { useEffect, useMemo, useRef, useState } from 'react';
import { CardDetail } from '../components/CardDetail';
import { CardFrame } from '../components/CardFrame';
import { ChestRail, GemShop } from '../components/Chests';
import { CoinBadge, LevelPips, Pill } from '../components/ui';
import { COINS, ineligibleReason, type Coin } from '../lib/coins';
import { fmtSol, fmtTokens, fmtUsd } from '../lib/format';
import { levelForUsd, nextLevelAt } from '../lib/leveling';
import { FEES, UNSTAKE_COOLDOWN_MS, useCollection, type MintedCard } from '../state/collection';
import { useEconomy } from '../state/economy';
import { useWallet } from '../state/wallet';

const STAKE_CHIPS = [10, 25, 50, 100, 500];
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
  const [amount, setAmount] = useState(25);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(card.cooldownUntil);
  const coin = COINS.find((c) => c.mint === card.mint);

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
        aria-label={`Stake into ${coin.ticker}`}
        style={{
          position: 'absolute', bottom: 0, width: 'min(100vw, 430px)',
          background: 'var(--surface)', borderRadius: '22px 22px 0 0',
          border: '1px solid var(--border)', borderBottom: 'none',
          padding: '20px 18px calc(20px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 14, outline: 'none',
          animation: 'sheetUp 240ms var(--ease-snap)',
        }}
      >
        <style>{'@keyframes sheetUp{from{transform:translateY(40%);opacity:0}to{transform:none;opacity:1}}'}</style>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <CoinBadge mint={card.mint} size={44} />
          <div>
            <div style={{ fontWeight: 800 }}>{coin.ticker}</div>
            <LevelPips level={card.level} />
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', color: 'var(--dim)', fontSize: 24, width: 44, height: 44 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
          <div className="panel" style={{ padding: '10px 12px' }}>
            <div className="label" style={{ fontSize: 10 }}>Staked</div>
            <div className="money">{fmtUsd(card.stakedUsd)}</div>
            <div style={{ color: 'var(--dim)', fontSize: 11 }}>
              {fmtTokens(card.stakedTokens)} {coin.ticker}
            </div>
          </div>
          <div className="panel" style={{ padding: '10px 12px' }}>
            <div className="label" style={{ fontSize: 10 }}>Next level</div>
            <div style={{ fontWeight: 700 }}>
              {next ? `${fmtUsd(next.usd)} → Lv ${next.level}` : 'MAX'}
            </div>
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Stake more · <span className="money">{fmtUsd(available)}</span> of {coin.ticker} free
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
                  style={{
                    flex: 1, minWidth: 0, ...TAP, borderRadius: 10, fontWeight: 700, fontSize: 13,
                    background: amount === v ? 'var(--raised)' : 'transparent',
                    border: amount === v ? '1px solid var(--purple)' : '1px solid var(--border)',
                    color: !affordable ? 'var(--dim)' : amount === v ? 'var(--text)' : 'var(--dim)',
                    opacity: affordable ? 1 : 0.45,
                  }}
                >
                  ${v}
                </button>
              );
            })}
          </div>
        </div>

        {claimable ? (
          <Pill onClick={() => claimUnstake(card.id)}>
            Claim {fmtUsd(card.pendingUnstakeUsd * (1 - FEES.unstakePct / 100))}
          </Pill>
        ) : (
          <Pill
            disabled={cooling || amount > available}
            onClick={() => setError(stake(card.id, amount))}
          >
            {cooling ? 'Unstake pending' : `Stake $${amount} → Lv ${afterLevel}`}
          </Pill>
        )}

        {error && (
          <p role="alert" style={{ color: 'var(--red)', fontSize: 12.5, textAlign: 'center' }}>{error}</p>
        )}

        {cooling ? (
          <p style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center' }}>
            {fmtUsd(card.pendingUnstakeUsd)} unstaking — claimable in {remaining}s
            {' '}(72h on mainnet, {UNSTAKE_COOLDOWN_MS / 1000}s on this devnet demo)
          </p>
        ) : !claimable && (
          <button
            onClick={() => { requestUnstake(card.id, Math.min(amount, card.stakedUsd)); setError(null); }}
            disabled={card.stakedUsd === 0}
            style={{
              ...TAP, fontSize: 13, textDecoration: 'underline',
              color: card.stakedUsd === 0 ? 'var(--dim)' : 'var(--text)',
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
  const [minting, setMinting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reason = ineligibleReason(coin);
  const owned = cards.filter((c) => c.mint === coin.mint).length;
  const value = coin.balance * coin.priceUsd;
  const affordable = wallet.sol >= FEES.mintSol;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      <CoinBadge mint={coin.mint} size={40} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {coin.ticker}
          {owned > 0 && (
            <span style={{ color: 'var(--teal)', fontSize: 11, marginLeft: 6 }}>
              {owned} card{owned > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>
          {fmtTokens(coin.balance)} · {fmtUsd(value)}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
        {reason ? (
          <span style={{ fontSize: 11, color: 'var(--red)' }}>{reason}</span>
        ) : (
          <button
            onClick={() => {
              if (!wallet.spend(FEES.mintSol)) return;
              setMinting(true);
              timer.current = setTimeout(() => { mintCard(coin.mint); setMinting(false); }, 600);
            }}
            disabled={minting || !affordable}
            title={affordable ? undefined : `needs ${fmtSol(FEES.mintSol)}`}
            style={{
              padding: '0 14px', ...TAP, borderRadius: 'var(--r-pill)',
              fontWeight: 800, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
              border: '1px solid var(--purple)',
              color: minting || !affordable ? 'var(--dim)' : 'var(--text)',
              opacity: affordable ? 1 : 0.5,
              whiteSpace: 'nowrap',
            }}
          >
            {minting ? 'Minting…' : affordable ? `Mint · ${fmtSol(FEES.mintSol)}` : 'Need SOL'}
          </button>
        )}
      </div>
    </div>
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
        <h1 className="display" style={{ fontSize: 28 }}>Cards</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14 }}>
          Connect a wallet to see your bags and mint them into cards.
        </p>
        <Pill onClick={openPicker} style={{ maxWidth: 260 }}>Connect Wallet</Pill>
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div>
          <h1 className="display" style={{ fontSize: 30 }}>Cards</h1>
          <p className="fine">
            {cards.length} minted · <span className="money" style={{ fontSize: 14 }}>{fmtUsd(totalStaked)}</span> staked
          </p>
        </div>
        <button
          onClick={() => setGemShop(true)}
          aria-label="Buy gems"
          className="btn-3d"
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
            minHeight: 44, padding: '0 13px', borderRadius: 999,
            background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
            border: '2.5px solid var(--ink)',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)',
          }}
        >
          <span aria-hidden style={{ fontSize: 16 }}>💎</span>
          <span className="display" style={{ fontSize: 16 }}>{gems}</span>
          <span className="display" style={{ fontSize: 16, opacity: 0.85 }}>+</span>
        </button>
      </header>

      <ChestRail />

      <section aria-label="Your cards">
        {cards.length === 0 ? (
          <div className="panel" style={{ padding: 24, textAlign: 'center', color: 'var(--dim)' }}>
            bag is empty, anon — mint your first card below
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {cards.map((c) => (
              <CardFrame key={c.id} card={c} width={104} fluid onClick={() => setOpenCard(c.id)} />
            ))}

          </div>
        )}
      </section>

      <section aria-label="Your meme coins">
        <div className="label" style={{ marginBottom: 4 }}>Your bags · mint fee {fmtSol(FEES.mintSol)}</div>
        <div className="panel" style={{ padding: '4px 14px' }}>
          {COINS.map((c, i) => (
            <div key={c.mint} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <CoinRow coin={c} />
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--dim)', marginTop: 8 }}>
          Eligibility: ≥$25k liquidity and ≥48h old. Price via Jupiter (mocked on devnet).
        </p>
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
