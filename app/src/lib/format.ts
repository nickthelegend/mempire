export const fmtSol = (n: number): string =>
  `${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 3 : 2 })} SOL`;

export const fmtUsd = (n: number): string =>
  n >= 1000
    ? `$${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 0 })}`;

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
      : n.toFixed(0);

export const shortAddr = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

export const fmtClock = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(ticks / 20));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
