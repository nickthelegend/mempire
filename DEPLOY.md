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
     a free Helius devnet key makes minting, merging and match transactions
     snappy.
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

`anchor build` with no flags is the full build — both the `nft` (Metaplex 1-of-1
cards) and `rollup` (MagicBlock ER + VRF chests) cargo features — which is what
devnet runs. Mainnet deploys the lean `--no-default-features` build instead;
`MAINNET.md` carries the sizes, the budget and the launch order. Escrow and
settlement are identical in both: a match settles off the two seats' claims
whether or not the play log ever visited a rollup.

Upgrade authority and (devnet) treasury: `3YUgUPu9AdJj6FCFFvzR9pJixCN7EcAnCXMJoTuYwsS5`.

## Smoke test after a deploy

1. Open the app → ChainBadge on Cards reads **live · devnet** with a wallet,
   **simulated** as Guest.
2. Two browsers (or one + a phone) → Battle in both within 8 seconds → the
   same match, seats 0 and 1. On one machine, run
   `sessionStorage.setItem('pvpWaitMs','60000')` in both tabs first — hidden
   tabs get their timers throttled by the browser, not by us.
3. Win a match → chest → open → real cards land in the collection. If the drop
   duplicates a card already owned, merge it and confirm the kept card goes up
   a level — that is the only path to level 2–10, so it is worth a look on
   every deploy.
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
4. **Real prices.** `register_coin` and `set_price` let the admin write a coin's
   price and liquidity, and the liquidity floor plus coin age are what decide
   whether a coin can be minted as a card at all. Card power is the sum of the
   deck's levels, earned by winning, so no admin number moves it any more — but
   eligibility is still the admin's word against nothing. The mainnet roster is
   built from Jupiter's verified list; a live Pyth or Switchboard feed is what
   would make the on-chain number mean something after that.
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

## The Android app

`mobile/` is an Expo app that wraps the deployed game. It is not a rewrite, on
purpose: the arena is React Three Fiber over a deterministic fixed-point
simulation, and a second native implementation of that simulation would desync
against every web opponent — the one failure this architecture cannot absorb.

What the shell adds that a browser cannot:

- **Mobile Wallet Adapter.** Android has no wallet extension. Native code owns
  MWA and injects a provider shaped like an extension's into the WebView, so the
  game's existing wallet layer reaches Phantom and Solflare untouched. Verified
  in the emulator: the picker shows `PHANTOM — Detected — READY`.
- **Notifications with the game's own chime**, scheduled when a chest starts
  unlocking and withdrawn if it is opened early.
- Adaptive icon, splash, deep links for `play.mempire.fun`, and hardware back
  that navigates the game rather than exiting.

### Building the APK

```
cd mobile
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

Output: `mobile/android/app/build/outputs/apk/release/`.

`android/` is generated and gitignored, so a clean prebuild throws away
anything hand-edited into it. `plugins/withMempireGradle.js` re-applies the
release signing config and the ABI splits on every prebuild — do not hand-edit
`app/build.gradle`, edit the plugin.

That plugin exists because both were hand-edited once and the next clean
prebuild silently reverted them. The signing one matters: reverted, a release
APK is signed with the *debug* key, installs perfectly, and can never be
updated by a properly signed build.

Four APKs come out. `app-arm64-v8a-release.apk` (29 MB) is what
download.mempire.fun serves; the universal build (70 MB) is the fallback for
older armeabi-v7a hardware.

### The signing key

`mobile/keys/mempire-release.keystore`, gitignored.
SHA-256 `88:6A:36:AC:0A:D1:58:B4:…:40:A0:E8:CD`.

**Back this up somewhere you will still have it in a year.** Android identifies
an app by its signature, not its package name — lose this and no future build
can update an existing install, on the dApp Store or off it. Passwords are
overridable via `MEMPIRE_KEYSTORE`, `MEMPIRE_KEYSTORE_PASSWORD`,
`MEMPIRE_KEY_ALIAS`, `MEMPIRE_KEY_PASSWORD`.

### Serving the download

**https://download.mempire.fun** — its own Vercel project, `mempire-download/`.
Copy `app-arm64-v8a-release.apk` to `public/mempire-arm64.apk` and the universal
build to `public/mempire-universal.apk`, then deploy. Both are gitignored.

`vercel.json` sets the APK MIME type and `Content-Disposition: attachment`;
without it Vercel serves an APK as `text/plain` and Chrome renders it as text.
Deployment Protection must stay off on that project or every asset 302s to an
SSO login — the page itself still answers 200 with the login HTML, so it looks
fine until you fetch an asset.

### The dApp Store

`mobile/dapp-store/config.yaml` carries the listing. Publishing mints three
NFTs on mainnet-beta (publisher, app, release) via `@solana-mobile/dapp-store-cli`;
the addresses belong here once they exist. Screenshots must be real captures
from a device — the emulator software-renders WebGL and the arena does not look
like itself there.
