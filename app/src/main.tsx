import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/lilita-one/400.css';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
// body copy is 600 — without this it resolves upward to 700 and every string in
// the app renders at button weight, flattening the hierarchy
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/hanken-grotesk/800.css';
import '@fontsource/martian-mono/400.css';
import '@fontsource/martian-mono/700.css';
import './styles/tokens.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only console handle for the stores — lets a second tab be driven and
// asserted against when testing PvP on one machine. Stripped from production
// builds by the DEV guard.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/match'), import('./state/wallet'), import('./state/deck'),
    import('./state/economy'), import('./state/collection'),
    import('./state/chain'), import('./state/erMatch'),
  ]).then(([m, w, d, e, c, ch, er]) => {
    (window as unknown as Record<string, unknown>).__mempire = {
      match: m.useMatch, wallet: w.useWallet, deck: d.useDeck,
      economy: e.useEconomy, collection: c.useCollection,
      chain: ch.useChain, erMatch: er.useErMatch,
    };
  });
}
