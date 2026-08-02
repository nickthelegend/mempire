# Deploying Mempire

Three pieces, three hosts. The program is already live; the other two ship
with the configs in this repo.

| Piece | Host | Config |
|---|---|---|
| Anchor program | Solana devnet | **already deployed** — `BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP` |
| `app/` (static SPA) | Vercel | `app/vercel.json` |
| `server/` (API + matchmaker) | Railway | `server/railway.json` |

## 1. API + matchmaker → Railway

1. New project → deploy from this repo, root directory `server/`.
2. Set variables (shapes in `server/.env.example`):
   - `MONGODB_URI` — the Atlas connection string. **Rotate the password first**;
     the old one was pasted in a chat and is burned.
   - `MONGODB_DB` — `mempire`
   - `CORS_ORIGIN` — the exact app origin, e.g. `https://mempire.fun`
     (comma-separate extras like a Vercel preview origin)
3. Railway injects `PORT` — the server reads it. Health check: `/api/health`.
4. The matchmaker WebSocket rides the same deployment at `/ws` — nothing
   separate to run. Railway supports WS upgrades out of the box.
5. Seed the demo clan ladder once: `API=https://<railway-url> node seed-clans.mjs`.

## 2. App → Vercel

1. New project → this repo, root directory `app/`. `vercel.json` supplies the
   SPA rewrite and asset caching.
2. Set variables (shapes in `app/.env.example`):
   - `VITE_API_URL` — the Railway URL, no trailing slash. PvP derives its
     `wss://` endpoint from this.
   - `VITE_RPC_URL` — a devnet RPC. The public endpoint works but rate-limits;
     a free Helius devnet key makes mint/stake snappy.
   - `VITE_CLUSTER` — `devnet`
3. Deploy. The app is fully static; every dynamic thing goes through the API
   or the chain.

## 3. Program → devnet (already done, for reference)

```bash
cd chain
anchor build
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/zorr.json
npx tsx scripts/seed-devnet.ts   # resumable — rerun until "seed complete"
npx tsx scripts/verify-devnet.ts # read the live state back
npx tsx scripts/e2e-devnet.ts    # 16 assertions against the deployed program
```

Upgrade authority and (devnet) treasury: `3YUgUPu9AdJj6FCFFvzR9pJixCN7EcAnCXMJoTuYwsS5`.

## Smoke test after a deploy

1. Open the app → ChainBadge on Cards reads **live · devnet** with a wallet,
   **simulated** as Guest.
2. Two browsers (or one + a phone) → Battle in both within 8 seconds → the
   same match, seats 0 and 1. On one machine, run
   `sessionStorage.setItem('pvpWaitMs','60000')` in both tabs first — hidden
   tabs get their timers throttled by the browser, not by us.
3. Win a match → chest → open → real cards land in the collection.
4. `node server/test-clans.mjs` and `node server/test-pvp.mjs` against the
   deployed API (`API=`/`WS=` env vars) — 48 + 12 assertions.

## Before mainnet — non-negotiable

- Rotate **both** leaked credentials (Mongo password, GitHub PAT).
- Treasury multisig (ROADMAP #23), program security review (#24),
  geo-blocking + ToS (#50) — a rake on a wagered pot is real-money skill
  gaming in most jurisdictions.
