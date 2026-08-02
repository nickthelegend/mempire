import { MoneyRow } from '../components/ui';
import { fmtSol, shortAddr } from '../lib/format';
import { useCollection } from '../state/collection';
import { useMatch } from '../state/match';
import { useWallet } from '../state/wallet';

export function Empire() {
  const wallet = useWallet();
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
        {wallet.connected ? (
          <p className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
            {wallet.walletName} · {shortAddr(wallet.address)}
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--dim)' }}>connect on the Arena tab first</p>
        )}
      </header>

      {wallet.connected && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <MoneyRow stack label="Balance" value={fmtSol(wallet.sol)} />
            <MoneyRow stack label="Won" value={fmtSol(earned)} />
          </section>

          <section className="panel" style={{ padding: '12px 16px', display: 'flex', gap: 0, justifyContent: 'space-around', textAlign: 'center' }}>
            {[
              ['Record', `${wins}W · ${losses}L`],
              ['Cards', String(cards.length)],
              ['House raked', fmtSol(raked)],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{value}</div>
                <div className="label" style={{ fontSize: 10 }}>{label}</div>
              </div>
            ))}
          </section>

          <section aria-label="match history">
            <div className="label" style={{ marginBottom: 8 }}>Battles</div>
            {history.length === 0 ? (
              <div className="panel" style={{ padding: 24, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
                no battles yet — the arena awaits, anon
              </div>
            ) : (
              <div className="panel" style={{ padding: '2px 14px' }}>
                {history.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <span
                      className="display"
                      style={{
                        fontSize: 17,
                        color: h.draw ? 'var(--dim)' : h.won ? 'var(--teal)' : 'var(--red)',
                      }}
                    >
                      {h.draw ? 'DRAW' : h.won ? 'WON' : 'REKT'}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                      pot {fmtSol(h.potSol)} · {h.hashes} state commits
                    </span>
                    <span className="money" style={{ marginLeft: 'auto', color: h.payoutSol > 0 ? 'var(--gold)' : 'var(--red)' }}>
                      {h.payoutSol > 0 ? `+${fmtSol(h.payoutSol)}` : `−${fmtSol(h.potSol / 2)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <p style={{ fontSize: 11, color: 'var(--dim)' }}>
            Devnet build — balances, opponents, and the settlement feed are simulated.
            Mint fee 0.02 SOL · rake 10% · unstake fee 2%.
          </p>
        </>
      )}
    </div>
  );
}
