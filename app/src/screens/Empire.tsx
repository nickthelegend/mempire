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
          <p className="fine">
            {wallet.walletName} · <span className="mono">{shortAddr(wallet.address)}</span>
          </p>
        ) : (
          <p className="fine">connect on the Arena tab first</p>
        )}
      </header>

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
                <div className="display" style={{ fontSize: 18 }}>{value}</div>
                <div className="label" style={{ fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </section>

          <section aria-label="match history">
            <div className="label" style={{ marginBottom: 8 }}>Battles</div>
            {history.length === 0 ? (
              <div className="well" style={{ padding: 22, textAlign: 'center' }}>
                <span className="fine">no battles yet — the arena awaits, anon</span>
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
                      className="display"
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

          <p className="fine" style={{ fontSize: 12 }}>
            Devnet build — balances, opponents, and the settlement feed are simulated.
            Mint fee 0.02 SOL · rake 10% · unstake fee 2%.
          </p>
        </>
      )}
    </div>
  );
}
