import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoneyRow, Pill } from '../components/ui';
import { RankChip } from '../components/ClanBits';
import { fmtSol, shortAddr } from '../lib/format';
import { loadLeaderboard, type LeaderRow } from '../lib/persist';
import { useCollection } from '../state/collection';
import { useMatch } from '../state/match';
import { useWallet } from '../state/wallet';

/**
 * Top players by net SOL, from the persistence API.
 *
 * Renders nothing when the API is down or the board is empty — a leaderboard
 * with no rows is dead weight, and the rest of the screen already works
 * without the server.
 */
function Leaderboard({ me }: { me: string }) {
  const [rows, setRows] = useState<LeaderRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadLeaderboard().then((r) => { if (!cancelled) setRows(r); });
    return () => { cancelled = true; };
  }, []);

  if (rows.length === 0) return null;

  return (
    <section aria-label="Leaderboard">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span className="label">Leaderboard</span>
        <span className="label" style={{ fontSize: 12 }}>by net SOL</span>
      </div>
      <div className="well" style={{ padding: '2px 10px' }}>
        {rows.slice(0, 10).map((r, i) => {
          const isMe = r.address === me;
          return (
            <div
              key={r.address}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0',
                borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.28)',
              }}
            >
              <RankChip rank={i + 1} />
              <span
                className="mono"
                style={{
                  fontSize: 12, minWidth: 0, flex: 1,
                  color: isMe ? 'var(--gold-hi)' : 'var(--dim)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: isMe ? 800 : 400,
                }}
              >
                {shortAddr(r.address)}
                {isMe && <span className="label" style={{ fontSize: 12, marginLeft: 5 }}>you</span>}
              </span>
              <span className="fine" style={{ fontSize: 12, flexShrink: 0 }}>
                {r.wins}W · {r.losses}L
              </span>
              <span
                className="money"
                style={{ fontSize: 13, flexShrink: 0, color: r.netSol >= 0 ? 'var(--gold)' : 'var(--red)' }}
              >
                {r.netSol >= 0 ? '+' : '−'}{fmtSol(Math.abs(r.netSol))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Empire() {
  const nav = useNavigate();
  const wallet = useWallet();
  const openPicker = useWallet((s) => s.openPicker);
  const history = useMatch((s) => s.history);
  const cards = useCollection((s) => s.cards);

  const wins = history.filter((h) => h.won).length;
  const losses = history.filter((h) => !h.won && !h.draw).length;
  const earned = history.reduce((s, h) => s + h.payoutSol, 0);
  const raked = history.reduce((s, h) => s + h.rakeSol, 0);

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header>
        <h1 className="display" style={{ fontSize: 30 }}>Empire</h1>
        {wallet.connected && (
          <p className="fine">
            {wallet.walletName} · <span className="mono">{shortAddr(wallet.address)}</span>
          </p>
        )}
      </header>

      {/* The same state on Cards offers a button, so sending the player to
          another tab to do the identical thing was two answers to one question. */}
      {!wallet.connected && (
        <div className="panel" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <span style={{ color: 'var(--dim-on-wood)', fontSize: 14, maxWidth: 260 }}>
            No empire yet, anon. Connect a wallet and your record starts counting.
          </span>
          <div style={{ width: 'min(100%, 240px)' }}>
            <Pill onClick={openPicker}>Connect Wallet</Pill>
          </div>
        </div>
      )}

      {wallet.connected && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <MoneyRow stack label="Balance" value={fmtSol(wallet.sol)} />
            <MoneyRow stack label="Won" value={fmtSol(earned)} />
          </section>

          <section className="panel" style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
            {[
              ['Record', `${wins}W · ${losses}L`],
              ['Cards', String(cards.length)],
              ['House raked', fmtSol(raked)],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="display display--sm" style={{ fontSize: 18 }}>{value}</div>
                <div className="label" style={{ fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </section>

          <section aria-label="match history">
            <div className="label" style={{ marginBottom: 8 }}>Battles</div>
            {history.length === 0 ? (
              /* The one screen a new player reaches with nothing on it. Saying
                 "the arena awaits" and then not opening the arena leaves them
                 to go and find the tab, which is the moment a first session
                 ends. */
              <div className="well" style={{ padding: '22px 20px', textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
                <span className="fine">No battles yet — the arena awaits, anon.</span>
                <Pill
                  tone="gold"
                  onClick={() => nav('/')}
                  style={{ fontSize: 15, minHeight: 44, padding: '10px 20px', width: 'auto' }}
                >
                  Find a match
                </Pill>
              </div>
            ) : (
              <div className="well" style={{ padding: '2px 12px' }}>
                {history.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                      borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.28)',
                    }}
                  >
                    <span
                      className="display display--sm"
                      style={{
                        fontSize: 17,
                        color: h.draw ? 'var(--dim)' : h.won ? 'var(--teal)' : 'var(--red)',
                      }}
                    >
                      {h.draw ? 'DRAW' : h.won ? 'WON' : 'REKT'}
                    </span>
                    <span className="fine" style={{ fontSize: 12 }}>
                      pot {fmtSol(h.potSol)} · {h.hashes} commits
                    </span>
                    <span className="money" style={{ marginLeft: 'auto', color: h.payoutSol > 0 ? 'var(--gold)' : 'var(--red)' }}>
                      {h.payoutSol > 0 ? `+${fmtSol(h.payoutSol)}` : `−${fmtSol(h.potSol / 2)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Leaderboard me={wallet.address} />

          <p className="fine" style={{ fontSize: 12 }}>
            Devnet build — balances, opponents, and the settlement feed are simulated.
            Mint fee 0.02 SOL · rake 10% · unstake fee 2%.
          </p>
        </>
      )}
    </div>
  );
}
