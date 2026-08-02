// Seeded devnet meme coins. Mints are stable strings so archetype mapping
// (hash % 6) matches what the onchain program will derive.
export interface Coin {
  mint: string;
  ticker: string;
  name: string;
  hue: number; // procedural logo color until generated art lands
  balance: number; // user's holdings (token units)
  priceUsd: number;
  liquidityUsd: number;
  ageHours: number;
  logoUrl?: string; // generated art, or the coin's real pump.fun image
  /** Live market data, present only on coins fetched from the feed. */
  fdvUsd?: number;
  change24h?: number;
  volume24h?: number;
  pumpFun?: boolean;
  url?: string; // DexScreener pair page
}

/** Tickers always render with the $ the culture uses. */
export const tickerOf = (c: Coin): string => `$${c.ticker.replace(/^\$+/, '')}`;

export const ELIGIBILITY = { minLiquidityUsd: 25_000, minAgeHours: 48 };

export const isEligible = (c: Coin): boolean =>
  c.liquidityUsd >= ELIGIBILITY.minLiquidityUsd && c.ageHours >= ELIGIBILITY.minAgeHours;

export const ineligibleReason = (c: Coin): string | null => {
  if (c.liquidityUsd < ELIGIBILITY.minLiquidityUsd) return 'liquidity below $25k';
  if (c.ageHours < ELIGIBILITY.minAgeHours) return 'younger than 48h';
  return null;
};

export const COINS: Coin[] = [
  { mint: 'DoggoMint111111111111111111111111111111111', ticker: 'DOGGO', name: 'Doggo', hue: 38, balance: 1_250_000, priceUsd: 0.000082, liquidityUsd: 410_000, ageHours: 2100, logoUrl: '/art/coin_doggo.png' },
  { mint: 'WifhatMint11111111111111111111111111111111', ticker: 'WIFHAT', name: 'Dog Wif Hat', hue: 320, balance: 48_000, priceUsd: 0.0021, liquidityUsd: 890_000, ageHours: 5300, logoUrl: '/art/coin_wifhat.png' },
  { mint: 'PopkatMint11111111111111111111111111111111', ticker: 'POPKAT', name: 'Popkat', hue: 265, balance: 310_000, priceUsd: 0.00034, liquidityUsd: 260_000, ageHours: 3900, logoUrl: '/art/coin_popkat.png' },
  { mint: 'PengMint1111111111111111111111111111111111', ticker: 'PENG', name: 'Peng', hue: 205, balance: 92_000, priceUsd: 0.00095, liquidityUsd: 175_000, ageHours: 1400, logoUrl: '/art/coin_peng.png' },
  { mint: 'FrgMint11111111111111111111111111111111111', ticker: 'FRG', name: 'Frog', hue: 130, balance: 660_000, priceUsd: 0.00012, liquidityUsd: 96_000, ageHours: 7800, logoUrl: '/art/coin_frg.png' },
  { mint: 'MooncatMint1111111111111111111111111111111', ticker: 'MOONCAT', name: 'Mooncat', hue: 52, balance: 178_000, priceUsd: 0.00048, liquidityUsd: 71_000, ageHours: 900, logoUrl: '/art/coin_mooncat.png' },
  { mint: 'RktMint11111111111111111111111111111111111', ticker: 'RKT', name: 'Rocket', hue: 12, balance: 84_500, priceUsd: 0.0013, liquidityUsd: 154_000, ageHours: 2600, logoUrl: '/art/coin_rkt.png' },
  { mint: 'ChadMint111111111111111111111111111111111x', ticker: 'CHAD', name: 'Chad', hue: 350, balance: 21_000, priceUsd: 0.0044, liquidityUsd: 330_000, ageHours: 4700, logoUrl: '/art/coin_chad.png' },
  { mint: 'GmiMint111111111111111111111111111111111xx', ticker: 'GMI', name: 'Gonna Make It', hue: 88, balance: 505_000, priceUsd: 0.00019, liquidityUsd: 59_000, ageHours: 1900, logoUrl: '/art/coin_gmi.png' },
  { mint: 'SerMint111111111111111111111111111111111xx', ticker: 'SER', name: 'Ser', hue: 228, balance: 130_000, priceUsd: 0.00061, liquidityUsd: 88_000, ageHours: 3100, logoUrl: '/art/coin_ser.png' },
  // the gate at work: these two can't mint
  { mint: 'BabywhaleMint111111111111111111111111111xx', ticker: 'BBWHALE', name: 'Baby Whale', hue: 190, balance: 44_000, priceUsd: 0.0008, liquidityUsd: 140_000, ageHours: 12, logoUrl: '/art/coin_bbwhale.png' },
  { mint: 'RugproofMint11111111111111111111111111111x', ticker: 'RUGPROOF', name: 'Rugproof', hue: 28, balance: 900_000, priceUsd: 0.000031, liquidityUsd: 8_200, ageHours: 5200, logoUrl: '/art/coin_rugproof.png' },
];

export const coinByMint = (mint: string): Coin | undefined =>
  COINS.find((c) => c.mint === mint);
