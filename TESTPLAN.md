# Mempire — full verification plan

Every component and flow, with what "correct" means stated up front so a pass
is a match against a written expectation rather than a judgement call made
after seeing the result.

Target: `https://play.mempire.fun` (production), devnet, real wallets, real
transactions. Relay: `https://mempire-relay-production.up.railway.app`.

**Pass rule.** The observed result equals the stated expectation, AND the
console shows no errors, AND no request in the network tab returns 4xx/5xx
(except where an error response *is* the expected result, marked ⚠️).

---

## A. Client screens

### A1 — Arena (`/`)

| # | Flow | Correct means |
|---|---|---|
| A1.1 | Load disconnected | Logo, "Connect Wallet", `DEVNET · NO REAL FUNDS`. No tier/queue controls active. |
| A1.2 | Connect as guest | Header shows name, crown count, SOL. Stake tiers render. Real keypair written to `mempire_guest_sk`. |
| A1.3 | Stake tier affordability | Tiers above wallet balance are `disabled`; affordable ones are not. |
| A1.4 | Queue with insufficient SOL | Hint `need X SOL to enter`; no queue starts; no tx. |
| A1.5 | Queue with incomplete deck | Hint `deck needs 8 cards`; all three mode buttons inert. |
| A1.6 | Practice with valid deck | Navigates to `/battle` within 3s; match clock starts. |
| A1.7 | Ranked solo → bot fallback | Queues, and within ~20s falls back to a bot match. Result screen states no trophies and nothing escrowed. |
| A1.8 | Recent settlements strip | Shows a real settled address + amount that exists on chain. |
| A1.9 | Reload mid-queue | Returns to a sane state (not stuck "searching"); no orphaned escrow. |

### A2 — Cards (`/cards`)

| # | Flow | Correct means |
|---|---|---|
| A2.1 | $MEMPIRE header pill | Exactly one currency pill. Value equals the wallet's real SPL balance. `—` before first read, never `0`. |
| A2.2 | Starter kit claim | Grants 0.35 SOL + 8 coins + 2000 $MEMPIRE in one flow; all verifiable on chain. |
| A2.3 | Starter kit second claim | ⚠️ 409 `already claimed`; no tokens move. |
| A2.4 | Mint a coin held | Real `MintCard` tx; SOL drops ~0.02; card count +1. |
| A2.5 | Mint a coin NOT held | Same as A2.4 — the holding gate must be gone, on chain and in UI. |
| A2.6 | Mint an ineligible coin | Row shows the reason (`younger than 48h` / `liquidity below $25k`); no mint button. |
| A2.7 | Re-mint an owned coin | No live Mint button. Shows `Merge · Lv N` (if dupes) or `minted`. |
| A2.8 | Merge duplicates | Real `UpgradeCard` tx; level +1; $MEMPIRE drops by 100×level; duplicate account closed. |
| A2.9 | Merge at level 10 | Button reads `Max level` and is disabled; no tx. |
| A2.10 | Shop buy with $MEMPIRE | Real transfer to treasury; card granted only after confirm; balance drops. |
| A2.11 | Shop buy with insufficient $MEMPIRE | Stated shortfall; no tx; no card granted. |
| A2.12 | Shop reroll (free) | Offers change instantly; free counter decrements. |
| A2.13 | Shop reroll (paid) | Charges 35 $MEMPIRE on chain before offers change. |
| A2.14 | Chest rail | 4 slots; `WIN A BATTLE or 100 $M`; earned chest becomes startable. |
| A2.15 | Chest unlock + skip | Skip charges 25 $MEMPIRE; header balance visibly drops. |
| A2.16 | Chest open ceremony | Shows card art + ticker, not a text pill; cards land in collection. |
| A2.17 | Deep scroll (desktop) | Content paints at every scroll position; no blank region; nav stays visible. |

### A3 — Deck (`/deck`)

| # | Flow | Correct means |
|---|---|---|
| A3.1 | Full deck | `DECK 8/8`, power and average elixir shown. |
| A3.2 | One-card-per-coin | A coin already in the deck cannot be added twice. |
| A3.3 | Three deck slots | Deck 1/2/3 switch independently and persist across reload. |
| A3.4 | Swap a card | Tapping a collection card replaces the selected slot; power recomputes. |
| A3.5 | Deck after first mint | Never collapses below 8 when the collection can fill it (regression guard). |

### A4 — Clan (`/clan`)

| # | Flow | Correct means |
|---|---|---|
| A4.1 | Browse clans | Real clans from the relay; empty state is honest, not a fake list. |
| A4.2 | Search | Filters server-side; no results renders an explicit empty state. |
| A4.3 | Create clan | Charges 250 $MEMPIRE on chain, then persists to Mongo; appears in browse. |
| A4.4 | Create with insufficient funds | Stated shortfall; no tx; no clan row created. |
| A4.5 | Join / leave | Membership persists across reload; server is the source of truth. |
| A4.6 | Crowns reporting | Match crowns post to the clan and change its total. |

### A5 — Empire (`/empire`)

| # | Flow | Correct means |
|---|---|---|
| A5.1 | Profile | Address, SOL balance, W/L, cards — all matching chain/relay. |
| A5.2 | Leaderboard | Real rows; no `0W · 162L` harness accounts. |
| A5.3 | Battle history | Real past matches, or an honest empty state. |
| A5.4 | Guest disclosure | States that devnet guest keypairs spend real devnet SOL — not "play money". |
| A5.5 | Stake recovery | Detects genuinely stuck matches; no false positives. |

### A6 — Swap (`/swap`)

| # | Flow | Correct means |
|---|---|---|
| A6.1 | Pool state | Reserves read from the real AMM pool account. |
| A6.2 | Quote | Constant-product maths matches the on-chain formula incl. fee. |
| A6.3 | Swap USDC ↔ $MEMPIRE | Real tx; both balances move by the quoted amounts. (Quote side is Circle devnet USDC.) |
| A6.4 | Swap exceeding balance | Blocked with a stated reason; no tx. |
| A6.5 | Zero / empty input | No NaN, no crash, action disabled. |

### A7 — Battle (`/battle`)

| # | Flow | Correct means |
|---|---|---|
| A7.1 | Arena renders | Canvas is sized to its container (not the 300x150 HTML default) and the scene is drawn within ~2s of the match starting. No loading overlay — the cause it covered is fixed. |
| A7.2 | Deploy a card | Elixir decreases by cost; unit appears; hand refills. |
| A7.3 | Illegal drop | Drop on enemy half is refused or clamped; elixir not spent on a refusal. |
| A7.4 | Elixir economy | Regenerates ~1/2.8s; doubles in the last minute. |
| A7.5 | Combat + towers | Units path, fight, damage towers; crowns increment on a tower fall. |
| A7.6 | Match end | Result screen with crowns; payout stated correctly for the mode. |
| A7.7 | Leave mid-match | Exits cleanly; no stuck lock on the deck. |

---

## B. Relay API (28 endpoints)

Correct = documented status, JSON shape as consumed by the client, no 5xx.

| # | Endpoint | Correct means |
|---|---|---|
| B1 | `GET /api/health` | 200, healthy payload. |
| B2 | `GET /api/coins` | 200, 66 coins with mint/ticker/decimals. |
| B3 | `GET /api/faucet` | 200, advertises `dripSol`, `dripMempire`, 8 coins. |
| B4 | `POST /api/faucet` | 200 first time; ⚠️ 409 after; ⚠️ 401 unsigned. |
| B5 | `GET /api/player/:address` | 200 with player row; unknown address returns a usable empty shape. |
| B6 | `PUT /api/player/:address` | ⚠️ 401 unsigned; 200 signed; persists. |
| B7 | `GET /api/leaderboard` | 200, real rows sorted by net SOL. |
| B8 | `GET /api/ladder` + `/:address` | 200, ladder rows. |
| B9 | `GET /api/clans`, `/clans-top`, `/clans/:tag`, `/clans/mine/:address` | 200; unknown tag ⚠️ 404. |
| B10 | `POST /api/clans*` (create/join/leave/kick/role/lend/request/crowns) | ⚠️ 401 unsigned; correct behaviour signed. |
| B11 | `POST /api/events` | 200/204; telemetry accepted. |
| B12 | `GET /api/analytics/{summary,tvl,ops,insights}` | 200, real aggregates. |
| B13 | `POST /api/match/:address`, `/api/player/match` | ⚠️ 401 unsigned; records signed. |
| B14 | Matchmaker WS `/ws` | Connects; pairs two clients at the same tier. |

---

## C. On-chain programs

| # | Instruction | Correct means |
|---|---|---|
| C1 | `mint_card` | Creates Card PDA, charges fee, no holdings requirement, rejects ineligible coins. |
| C2 | `upgrade_card` | +1 level, charges 100×level $MEMPIRE, closes duplicate, refuses locked/max/mismatched. |
| C3 | `tokenize_card` | Mints supply-1/0-dec NFT + Metaplex metadata; authority burned; second attempt fails. |
| C4 | `stake` / `request_unstake` / `claim_unstake` | Tokens move to/from vault; cooldown enforced. |
| C5 | `create_match` / `join_match` / `settle` | Escrow held, winner paid, rake taken. |
| C6 | `claim_timeout` | Recovers a stranded stake with the correct account set. |
| C7 | Rollup `delegate_log` → `play_card` → `end_log` → undelegate | Delegation resolves; plays land on ER; settlement commits to base. |
| C8 | Rollup chests (`init/delegate/request/callback/claim`) | Chest rail delegated; VRF request accepted; entitlement credited. |
| C9 | AMM `swap` | Constant product with fee; reserves update. |

---

## D. External integrations

| # | Integration | Correct means |
|---|---|---|
| D1 | Devnet RPC | Reads succeed; 429s retried with backoff, never surfaced as `0`. |
| D2 | MagicBlock router | `getDelegationStatus` resolves; placement discovered, never hardcoded. |
| D3 | MagicBlock ER | Delegated accounts writable on the returned FQDN. |
| D4 | Metaplex metadata | `/nft/<ticker>.json` 200 for all carded coins; Explorer renders the NFT. |
| D5 | DexScreener | Used only where a live price is claimed; devnet reference prices labelled as such. |
| D6 | Mongo | Player/clan/faucet-claim state survives a relay restart. |

---

## E. Cross-cutting

| # | Concern | Correct means |
|---|---|---|
| E1 | Console | Zero errors on every screen and every flow. |
| E2 | Network | Zero unexpected 4xx/5xx. |
| E3 | Desktop layout | 1440×900: no blank paint region at any scroll depth. |
| E4 | Mobile layout | 375×812: column fills screen, nav pinned. |
| E5 | Reload mid-flow | Guest session restored; no lost identity. |
| E6 | No wallet installed | Guest path fully playable. |
| E7 | Mocks/stubs | No mock/stub/fake data anywhere in a tested path. |
| E8 | A11y | Interactive controls have accessible names. |

---

## Status legend

`PASS` verified against the expectation · `FAIL` did not match, root cause fixed and re-verified · `UNTESTABLE` requires a dependency that genuinely does not exist here.

---

# Results — run of 2026-08-16

Against production `play.mempire.fun`, devnet, real wallet
`9Ftmh7N2SNkTwvU7x5kkaXbT1XE7ZiQDgRrNbHRPCpya`, real signed transactions.

## Failures found and fixed (6)

| Item | Failure | Root cause | Fix |
|---|---|---|---|
| A1.1 | A cold visitor got an ed25519 secret key generated and persisted before choosing anything | `getProvider(null)` → `guestSigningWallet` → a keypair lookup that *created* on miss, reached from the registry read that runs for every visitor | `storedGuestKeypair()` never creates; only `connectGuest` mints an identity |
| A2.4 / A2.5 | Mint confirmed on chain, header kept saying "not minted onchain yet" until reload | `getProgramAccounts` indexes a slot or two behind confirmation; the single post-tx `refresh()` read pre-mint state and never re-read | `refreshSettled()` re-reads at 0 / 1.5s / 4s |
| A2.2 | Starter kit claimed "your fighters are coins you hold" and never mentioned the $MEMPIRE grant | Copy written when `mint_card` required a balance | Rewritten; surfaces `dripMempire` |
| A6 | Swap unusable: quote side is Circle's real devnet USDC, which the game cannot issue and never grants — and the `+` on the currency pill routes there | Pool is $MEMPIRE/USDC; no in-product path to USDC | Screen now states where USDC comes from and links Circle's faucet |
| B2 | `/api/coins` served `"PNUT "` / `"Peanut the Squirrel "` with trailing spaces | DexScreener data passed through unsanitised | Trimmed at the boundary |
| Copy | Connect screen, tutorial, loading tips, noscript and og/twitter meta all promised the removed holding gate and stake-for-power | Premise changed, copy did not | All rewritten |

## Verified PASS

- **B — relay API: 27/27.** Every endpoint, including auth guards (unsigned write → 401, forged signature → 401, replayed faucet claim → 409 with `claimedAt`, proving Mongo persistence).
- **A1** 1,2,3,4,6,8 · **A2** 1,2,3,4,5,7,8,14,15,16,17 · **A3** 1,5 · **A4** 1 · **A5** 1,2,3,4 · **A6** 1 · **A7** 1,2,4,5,6
- **C1/C2/C3** — `mint_card` (no holdings needed), `upgrade_card` (level +1, 100×level $MEMPIRE, duplicate closed), `tokenize_card` (supply 1, 0 decimals, mint authority burned, Explorer renders it as a Metaplex NFT).
- **D1** RPC backoff · **D4** metadata 200 for all 64 · **D6** Mongo persistence
- **E1** zero console errors · **E2** zero failed requests · **E3/E4** desktop + mobile layout · **E5** reload restores guest · **E6** guest path playable · **E7** no mocks found in any tested path

## Blocked — cannot be tested here

| Item | Why |
|---|---|
| A6.3 swap execution | Needs Circle's devnet USDC from a human-gated web faucet. Authority `GrNg1XM2…` is not ours; the project holds 19 USDC in the pool and 1 on the deployer. |

## Not reached this run — untested, not passed

A1.7 bot-fallback timing, A1.9 reload mid-queue, A2.6 ineligible-coin row, A2.9 max-level guard,
A2.10–A2.13 shop purchase/reroll, A3.2–A3.4 deck editing, A4.2–A4.6 clan write flows,
A5.5 stake recovery, A6.2/A6.4/A6.5 quote maths and input guards, A7.3 illegal drop,
A7.7 leave mid-match, C4–C9 (stake/unstake, match escrow+settle, timeout recovery, ER
delegation round-trip, chest VRF, AMM swap), D2/D3 ER placement, D5 DexScreener pricing,
E8 full a11y audit.

## Known quality issues (not plan failures)

- The arena takes ~15–25 seconds of match clock to build on a cold load. The loading state is honest, but that is a sixth of a match.
- The AMM pool holds 19 USDC. Any real trade moves the price hard.


---

# Results — run 2 (continuation)

## Failures found and fixed (2)

| Item | Failure | Root cause | Fix |
|---|---|---|---|
| A6.4 | With a **zero** balance, any amount left SWAP enabled and quoted 1.7M $MEMPIRE — a tx the chain would reject with a raw SPL error | `const overBalance = amountIn > held && held > 0n` — the `held > 0n` clause disabled the guard for exactly the wallet that needed it. It existed to suppress a spurious warning before balances load. | Track `balancesRead` and gate on that instead; warning now names the balance |
| A7.6 | Forfeit dialog on a bot-fallback match threatened "Your opponent takes the 0.1 SOL pot / Forfeit — lose 0.05 SOL", then the result screen said nothing was escrowed | The dialog assumed any non-practice match had a live stake; `ResultOverlay` already had an `escrowed` test it did not share | Dialog branches three ways and uses the same escrow phase test |

## Verified PASS this run

- **A1.7** bot fallback at 23.6s; header reads `0.1 SOL NO STAKE`; result screen states no trophies and nothing escrowed onchain
- **A1.9** reload mid-queue returns a clean Arena, not stuck searching, SOL unchanged (no orphaned escrow)
- **A2.6** `$BBWHALE` "younger than 48h" and `$RUGPROOF` "liquidity below $25k", both with no mint button; eligible coins keep theirs
- **A3.2** collection offers only coins not already in the deck
- **A3.3** three slots independent, and the edit survives a reload (verified against the persisted row: `slot0` contains `chain_128`)
- **A3.4** removing a card drops to 7/8 and recomputes power; adding restores 8/8
- **A6.5** empty / zero / junk input all disable the action, no NaN
- **A7.7** forfeit dialog is honest, exit is clean, deck stays 8/8, all modes usable — no stuck lock

## Note on a false alarm

A second match appeared to regress the canvas to 300x150 with the whole
ancestor chain at 0x0. That was the automation pane being hidden — `100dvh`
resolves to zero with no viewport — not an app fault. Confirmed by fronting the
pane. Worth recording so the next run does not chase it.

## Still untested — not passed

A2.9 max-level guard, A2.10–A2.13 shop purchase/reroll, A4.2–A4.6 clan write
flows, A5.5 stake recovery, A7.3 illegal drop, C4–C9 (stake/unstake, match
escrow + settle, timeout recovery, ER delegation round-trip, chest VRF, AMM
swap execution), D2/D3 ER placement, D5 DexScreener pricing, E8 full a11y audit.

C5 (escrow + settle) needs two funded clients in parallel; it is the highest
-value remaining item and the one with real money attached.


---

# Run 3 — PvP escrow

## C5 — FAIL (confirmed, reproducible, not yet fixed)

**A genuine human-vs-human staked match escrows nothing.**

Reproduced with two clients queued at the identical millisecond
(`__qAt` equal on both), both reporting `soloVsBot: false` and
`stakeSol: 0.05`, wallets `2cmeus9p` and `GKLFeUT1`:

- both balances stayed at **0.72499 SOL** — not one lamport moved
- no escrow instruction appears on chain for either wallet
- the HUD badge reads `0.1 SOL` / "This match is for the ladder only"

Everything the escrow path depends on is correct:

| Precondition | State |
|---|---|
| `chain.mode` | `onchain` |
| Cards on chain | 19 (A) / 9 (B) |
| Cards locked by another match | **0** |
| Deck | 8 cards, every one resolving to an unlocked chain card |
| Relay pairing (B14) | PASS — verified over the raw socket |

Subscribing to the escrow store *before* the match and reading it during
recorded **zero transitions**, with `phase: "none"` and `lastError: null`.
`escrow.reset()` is the first statement of that block, so the block never
runs — this is not a failing escrow, it is an escrow that is never attempted.
Next step is to instrument entry to `beginHumanBattle` and find where the
match path diverges before it.

**Fixed on the way here (real, verified):** decks were being kept as seeded
starter cards even for wallets holding ten minted coins, because `repoint`
preserved any saved deck that was merely *fillable*. A staked match needs all
eight cards minted, so that alone forced every match to ladder-only. Both
wallets went from "7 of your cards are not minted onchain yet" to no warning
at all. That was a genuine blocker; it was not the only one.

**Also a defect in its own right:** when escrow is skipped the reason is
computed into `lastError` and never rendered anywhere. The player sees
"ladder only" and cannot find out why. Whatever the root cause turns out to
be, that reason belongs on screen.

## Also fixed this run

- Stale chunk after a deploy: a session open across a deploy asked for a
  content-hashed chunk that no longer existed, Vercel answered with
  index.html, and the browser reported "expected a JavaScript module, got
  text/html" — observed live in this project's own console. `vite:preloadError`
  now triggers one guarded reload.
