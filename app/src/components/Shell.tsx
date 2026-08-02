import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { WalletPicker } from './WalletPicker';
import { useMatch } from '../state/match';
import { usePlayerSync } from '../state/sync';
import { useWallet } from '../state/wallet';

const TABS = [
  { to: '/', label: 'Arena', icon: '/art/tab_arena.png' },
  { to: '/cards', label: 'Cards', icon: '/art/tab_cards.png' },
  { to: '/deck', label: 'Deck', icon: '/art/tab_deck.png' },
  { to: '/empire', label: 'Empire', icon: '/art/tab_empire.png' },
];

/**
 * Layout law: one centered 430px column on the quilted field, gutters
 * intentionally empty (reserved: future ads). Battle hides the tab bar.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const inBattle = pathname === '/battle';
  const autoConnect = useWallet((s) => s.autoConnect);
  const matchStatus = useMatch((s) => s.status);
  const nav = useNavigate();

  useEffect(() => { void autoConnect(); }, [autoConnect]);
  usePlayerSync();

  // Router-level so the arena opens from whichever tab the player is on —
  // otherwise a match could run headless with the stake escrowed.
  useEffect(() => {
    if (matchStatus === 'battle' && pathname !== '/battle') nav('/battle');
  }, [matchStatus, pathname, nav]);

  const searching = matchStatus === 'queuing' || matchStatus === 'found';

  return (
    <div className={inBattle ? undefined : 'quilt'} style={{ minHeight: '100dvh', display: 'flex', justifyContent: 'center' }}>
      <div
        className={inBattle ? undefined : 'quilt'}
        style={{
          width: 'min(100vw, 430px)', minHeight: '100dvh', position: 'relative',
          display: 'flex', flexDirection: 'column',
          boxShadow: inBattle ? 'none' : '0 0 0 3px rgba(0,0,0,.45), 0 0 60px rgba(0,0,0,.6)',
          background: inBattle ? 'var(--ink)' : undefined,
        }}
      >
        <main
          style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            paddingBottom: inBattle ? 0 : 'calc(80px + env(safe-area-inset-bottom))',
          }}
        >
          {children}
        </main>

        {!inBattle && (
          <nav
            aria-label="Main"
            style={{
              position: 'fixed', bottom: 0, width: 'min(100vw, 430px)', zIndex: 20,
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
              background:
                'linear-gradient(180deg, rgba(255,255,255,.1), transparent 30%),'
                + "url('/art/wood_seamless.png') center / 340px repeat, var(--wood)",
              borderTop: '3px solid var(--wood-edge)',
              boxShadow: '0 -6px 18px rgba(0,0,0,.5), inset 0 2px 0 rgba(255,255,255,.16)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                onClick={(e) => { if (searching) e.preventDefault(); }}
                aria-disabled={searching}
                style={({ isActive }) => ({
                  position: 'relative',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  padding: '8px 0 9px', textDecoration: 'none',
                  color: 'var(--text)',
                  opacity: searching && !isActive ? 0.4 : 1,
                  pointerEvents: searching && !isActive ? 'none' : undefined,
                  fontFamily: 'var(--font-display)',
                  fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase',
                  WebkitTextStroke: '2px var(--ink)',
                  paintOrder: 'stroke fill',
                  // the active tab lifts out of the wood on a lit plate
                  background: isActive
                    ? 'linear-gradient(180deg, var(--blue-lit), var(--blue))'
                    : 'transparent',
                  boxShadow: isActive
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), inset 0 -3px 0 rgba(0,0,0,.3)'
                    : 'none',
                  borderLeft: isActive ? '2px solid var(--ink)' : '2px solid transparent',
                  borderRight: isActive ? '2px solid var(--ink)' : '2px solid transparent',
                  transition: 'background 160ms var(--ease-snap), opacity 160ms var(--ease-snap)',
                })}
              >
                {({ isActive }: { isActive: boolean }) => (
                  <>
                    <img
                      src={t.icon}
                      alt=""
                      aria-hidden
                      width={34}
                      height={34}
                      draggable={false}
                      style={{
                        display: 'block',
                        filter: isActive
                          ? 'drop-shadow(0 2px 4px rgba(0,0,0,.6))'
                          : 'saturate(.55) brightness(.78) drop-shadow(0 2px 3px rgba(0,0,0,.5))',
                        transform: isActive ? 'translateY(-2px) scale(1.1)' : 'none',
                        transition: 'transform 160ms var(--ease-snap), filter 160ms var(--ease-snap)',
                      }}
                    />
                    {t.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}
        <WalletPicker />
      </div>
    </div>
  );
}
