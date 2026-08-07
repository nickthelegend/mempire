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

## Why the relay is one instance, and what it would take to change

`matchmaker.js` holds its queues and live matches in process `Map`s, and a
lockstep match relays every input through the single socket pair both clients
are attached to. Adding a second region does not make that highly available —
it makes two isolated queues, so two players who happen to land in different
regions never see each other, and any match whose seats split across instances
cannot relay at all.

Scaling this out is a real piece of work, not a config change:

1. A shared queue both instances read (Redis, or Mongo with a short poll —
   pairing is not latency-critical, only the in-match relay is).
2. Sticky routing per match, so once two seats are paired every message for
   that match reaches the same instance. Either the pairing instance owns the
   match and the other proxies to it, or clients are handed that instance's
   address at `matched` and reconnect to it directly.
3. A drain path, so a deploy does not cut live matches — the current rolling
   restart ends every match in flight.

Until then a single instance is the honest configuration, and the region is
chosen for where players actually are. Moving it is a one-line change to
`multiRegionConfig` above; running two is not.

## Mainnet checklist

Devnet keeps its convenient key on purpose; none of this is run there.
`chain/scripts/harden.ts` reports current custody with no arguments and changes
nothing without `--yes`.

**Before a single real dollar is in escrow:**

1. **`npx tsx scripts/harden.ts --freeze --yes`** — nothing in Mempire uses the
   freeze authority. It exists only as a way to lock someone's balance, so
   holding it is pure liability.
2. **`npx tsx scripts/harden.ts --upgrade <SQUADS_MULTISIG> --yes`** — until
   this runs, the key that operates the game can also replace the program
   holding every escrow. A 2-of-3 is the minimum that means anything.
3. **`npx tsx scripts/harden.ts --mint --yes`** — last, and deliberately so.
   After it the supply is fixed forever, including against you.
4. **Real prices.** `register_coin` lets the admin set price and liquidity, and
   card power derives from staked USD — so on mainnet the admin can move any
   card's power, and power gates matchmaking. Needs Pyth or Switchboard before
   the number means anything.
5. **A paid RPC.** The public devnet endpoint 429s under two concurrent test
   suites; it will not survive players. Set `SOLANA_RPC` and the client's
   cluster endpoint to a dedicated provider.
6. **An audit.** The escrow program moves real SOL and nobody independent has
   read it.
7. **The remaining integrity gap** — see C9 in AUDIT.md. Theft on a disputed
   match is fixed; a cheat can still force a refund and decline any loss. That
   needs the result attested by something that watched the match.

**Also not technical:** real-money wagering is regulated in most jurisdictions.
That question comes before any of the above.
