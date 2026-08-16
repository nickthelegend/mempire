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


---

# Run 4 — C5 resolved, and a correction

## C5 — PASS (and run 3's FAIL was wrong)

Run 3 reported "a real PvP match escrows nothing". **That was incorrect.** Every
match measured there was the bot fallback, and two separate mistakes made it
look like PvP:

1. **The `isBot` check was meaningless mid-match.** It matched on the phrase
   "against the AI", which only appears on the *result* screen — so during a
   match it always returned false, whatever the opponent was.
2. **Two browser tabs cannot be made to queue together here.** Only one tab is
   foreground at a time and background tabs have their timers throttled, so
   scheduled clicks never overlapped inside the 20s fallback window — however
   precisely the epoch was shared.

Replaced the second client with a node sparring partner holding a real queue
slot on the deployed relay. With the browser queueing *first* (the waiting
player is seat 0, the joining player seat 1):

| Evidence | Result |
|---|---|
| Relay pairing | `spar: matched opponent=2cmeus9p` |
| Time to match | 2s — not the 20s fallback |
| Badge | `STAKE IN` — "Your stake is escrowed; waiting for your opponent" |
| Instruction on chain | `CreateMatch` |
| Balance | 0.72499 → **0.67279** — the 0.05 stake, plus fees |

Escrow works. It had simply never been reached, because a bot match never
escrows and every match under test was one.

## Real bugs this run surfaced anyway

| Item | Failure | Fix |
|---|---|---|
| Bot fallback honesty | `onUnavailable` (relay unreachable) fell back to the bot **without** setting `soloVsBot`, so the match did not know it was a bot match — the result screen skipped "nobody else was queuing, so this was against the AI" and it read as a real opponent. It also misled this project's own testing. | `fallBack()` sets the flag on every path |
| Deck composition (run 3) | `repoint` kept seeded starters whenever the saved deck was merely fillable, so wallets holding ten minted coins queued with seven unminted cards and could never stake | seeded cards yield a slot to any free minted coin |
| Escrow diagnosability | A skipped stake left no trace anywhere | the decision is logged with role, mode, signability and deck length |

## Note for the next run

The dev server points its API and socket at `http://localhost:8787`, which is
not running. A dev client therefore cannot pair on the real relay and always
falls back to a bot. Test PvP against production, or start the local relay.


---

# FINAL STATUS

Production `play.mempire.fun`, devnet, real wallets, real signed transactions.

## A — Client screens

| Item | Status | Note |
|---|---|---|
| A1.1 Load disconnected | PASS | fixed: a cold visitor was having an ed25519 key generated and persisted before choosing anything |
| A1.2 Connect as guest | PASS | key written only on explicit choice |
| A1.3 Tier affordability | PASS | all four disabled at 0 SOL |
| A1.4 Queue, insufficient SOL | PASS | `need 0.05 SOL to enter`, no tx |
| A1.5 Queue, incomplete deck | PASS | covered by A3.5 |
| A1.6 Practice | PASS | |
| A1.7 Bot fallback | PASS | 23.6s; result states no trophies, nothing escrowed |
| A1.8 Settlements strip | PASS | real settled addresses |
| A1.9 Reload mid-queue | PASS | clean arena, SOL unchanged |
| A2.1 $MEMPIRE pill | PASS | one pill, chain balance |
| A2.2 Starter kit | PASS | fixed copy; 0.35 SOL + 2000 $MEMPIRE + 8 coins verified on chain |
| A2.3 Second claim | PASS | 409 + `claimedAt` |
| A2.4 Mint held coin | PASS | fixed: header lagged a slot behind confirmation |
| A2.5 Mint unheld coin | PASS | `MintCard` from a zero balance |
| A2.6 Ineligible coin | PASS | reason shown, no mint button |
| A2.7 Re-mint guard | PASS | |
| A2.8 Merge duplicates | PASS | `UpgradeCard`, 2000→1900 $MEMPIRE |
| A2.9 Merge at max level | UNTESTED | needs 4,500 $MEMPIRE of upgrades to reach level 10 |
| A2.10–A2.13 Shop buy / reroll | UNTESTED | |
| A2.14 Chest rail | PASS | |
| A2.15 Chest skip | PASS | balance visibly drops |
| A2.16 Chest ceremony | PASS | card art + ticker |
| A2.17 Deep scroll | PASS | fixed: 5,700px column stopped painting past ~900px |
| A3.1–A3.5 Deck | PASS | independent slots, one-per-coin, swap recomputes, survives reload |
| A4.1 Browse clans | PASS | honest empty state |
| A4.2–A4.6 Clan writes | UNTESTED | |
| A5.1–A5.4 Empire | PASS | fixed: harness account removed from the public board |
| A5.5 Stake recovery | PASS | fixed: detection read in-memory state, so a reload hid a real stranded stake. Now reads chain; correctly finds match #65 |
| A6.1 Pool state | PASS | |
| A6.2 Quote maths | UNTESTED | |
| A6.3 Execute swap | UNTESTABLE | quote side is Circle devnet USDC from a human-gated faucet |
| A6.4 Over balance | PASS | fixed: `held > 0n` disabled the guard for exactly the zero-balance wallet |
| A6.5 Zero / junk input | PASS | no NaN |
| A7.1 Arena renders | PASS | fixed: canvas stuck at the 300x150 default; 1,453ms cold |
| A7.2 Deploy a card | PASS | |
| A7.3 Illegal drop | UNTESTED | |
| A7.4 Elixir economy | PASS | 2x in the last minute |
| A7.5 Combat + towers | PASS | |
| A7.6 Match end | PASS | fixed: card claimed "You take +0.09 SOL" on a pot that never paid |
| A7.7 Leave mid-match | PASS | fixed: forfeit threatened 0.05 SOL on an unescrowed match |

## B — Relay API: 27/27 PASS

Including auth: unsigned write 401, forged signature 401, replayed faucet claim
409 with `claimedAt` (proving Mongo persistence). B14 pairing verified over the
raw socket. Fixed: `/api/coins` served DexScreener data untrimmed (`"PNUT "`).

## C — On-chain

| Item | Status | Note |
|---|---|---|
| C1 `mint_card` | PASS | holdings requirement removed and redeployed |
| C2 `upgrade_card` | PASS | level +1, 100xlevel $MEMPIRE, duplicate closed |
| C3 `tokenize_card` | PASS | supply 1, 0 decimals, authority burned, renders as a Metaplex NFT |
| C4 stake / unstake | UNTESTED | |
| C5 escrow open | PASS | `CreateMatch`, 0.72499 → 0.67279 |
| C5 settlement | FAIL (open) | opponent abandoned; pot never paid and no settle instruction |
| C6 `claim_timeout` / `cancel_match` | FAIL (open) | fixed two blockers — it only handled Active matches, and read a deck list wiped by reload — but `cancel_match` still lands no transaction on the Open match #65, with no console error. Next: check `cancelMatchTx`'s account list against the program |
| C7 ER delegation round-trip | FAIL (open) | badge reported "match log is not delegated to a rollup" at settlement |
| C8 Chest VRF | UNTESTED | |
| C9 AMM swap | UNTESTABLE | same USDC dependency as A6.3 |

## D — Integrations

| Item | Status |
|---|---|
| D1 RPC backoff | PASS |
| D2 / D3 ER placement | UNTESTED |
| D4 Metadata | PASS — 64/64 serve 200, Explorer renders the NFT |
| D5 DexScreener | PARTIAL — data is live and now sanitised; pricing use not verified |
| D6 Mongo persistence | PASS |

## E — Cross-cutting

E1 console PASS · E2 network PASS · E3 desktop PASS · E4 mobile PASS ·
E5 reload PASS · E6 guest path PASS · E7 no mocks found in any tested path ·
E8 full a11y audit UNTESTED (wallet rows fixed; no sweep)

## Mocks and stubs

None found anywhere in the tested surface. Two disclosed simplifications
remain and are labelled in-product: Crowns are gone, so shop purchases are real
$MEMPIRE transfers; devnet mints have no market, so prices are fixed reference
values and the screen says so.

## Honest summary

Not green. 3 open failures (C5 settlement, C6, C7 — all on the settlement
path), 11 untested items, 2 untestable without Circle's faucet. The settlement
cluster is one story, not three: a match that ends without both players
reporting leaves the pot escrowed, and the recovery route out of that state
does not yet work.


---

# Run 5 — settlement closed, and a silent auth failure

## Newly PASS

| Item | Evidence |
|---|---|
| C5 escrow open | `CreateMatch`, 0.72499 → 0.67279 |
| C6 recovery | `CancelMatch` returned a stake from an Open match (→ 0.72278); `ClaimTimeout` paid out an Active one (→ 0.76057); `ReleaseCards` freed the opponent's deck |
| C7 ER round-trip | `InitMatchLog` + `DelegateMatchLog` on chain, result reached "reported" on the rollup |
| D2 / D3 ER placement | implied and verified by C7 — the router resolved placement and the ER accepted the write |
| A2.10 shop buy | `$MSTR` for 250 $MEMPIRE, 13,915 → 13,665, row marked Bought |
| A2.11 insufficient funds | "need 250 $MEMPIRE — you hold 0", no card, no tx |
| A2.12 free reroll | offers changed, counter moved to the paid price |
| A2.13 paid reroll | exactly 35 $MEMPIRE charged, 13,950 → 13,915 |
| A4.2 clan search | `nothing matches "ZZZZZZ"` |
| A4.5 clan membership | survives reload, server is the source of truth |
| A5.5 stake recovery | detects a real stranded stake from the chain |

## Fixed this run

**Every guest write was failing auth, silently.** `signAction` signed with the
stored key but labelled the message with `wallet.address`, which is read once
at connect. When the two diverge — a cleared store, private mode, a second tab
— it signs as one identity and claims another, and the relay correctly refuses.
Observed live: the stored key derived to `3nHXcCdD…` while the app still called
itself `2cmeus9p…`. Clans, ladder, progress sync and telemetry all 401 and
nothing surfaces it. Proven against the relay: old behaviour 401, fixed 201.

**The settlement cluster** — `prepareLog` checked the opponent's join once and
gave up; `recover` resolved the player from a non-existent adapter, handled only
Active matches, and unlocked only the caller's cards. All four fixed and
verified on devnet across matches #65, #66 and #67.

## Still untested

A2.9 (max level — needs 4,500 $MEMPIRE of upgrades), A4.4, A4.6, A7.3, C4, C8,
D5 pricing, E8 full a11y sweep.

## Still untestable

A6.3 and C9 — both need Circle's devnet USDC from a human-gated faucet.

## C5 settlement, precisely

Escrow opens, the log delegates, and this seat reports. `settle_from_log`
requires **both** seats to have reported the same final hash — by design, and
stated as such in `actions.ts`. Driving it needs a second client that runs the
simulation, which is the game client itself; the node sparring partner joins
escrow but cannot report. Until then the pot returns through `claim_timeout`,
which is now verified working.

# Run 6 — the money paths, and what a guest can never reach

## C4 stake / unstake — PASS (two real bugs found and fixed)

The assertion is "tokens move to/from vault; cooldown enforced". Testing it
found the client lying about money in two directions.

Staking a card that was never minted fell through to the local store: the
sheet read "Staked $75", the level went up, and no token moved. Deck power
is what matchmaking brackets on, so the fiction had consequences. Onchain
sessions now stake onchain or say why they cannot — the button reads
`MINT THIS CARD FIRST` and is disabled.

Worse, the chain-to-collection mapping hardcoded `pendingUnstakeUsd: 0`
while carrying the cooldown faithfully on the very next line. `claimable`
needs both, so the first refresh after `RequestUnstake` removed the Claim
button permanently. 20 BTC sat in the vault, past its cooldown, with
nothing in the UI able to ask for it.

Round trip on devnet, card #106:

| ix | signature | effect |
|---|---|---|
| `Stake` | `5G9qUx3v5FNibgJTnNC6…` | 50 → 30 BTC, level 1→2, `stakedMicroUsd=10000000` |
| `RequestUnstake` | `4ABWnaaw3qt5HBkzexuR…` | pending 20000000, tokens held back, level 2→1 |
| `ClaimUnstake` | `42VUxfzTvPWQUzDTH1Mv…` | pending 0, balance 49.6 |

49.6 = 30 + 20 − 0.4, and 0.4 is exactly the 2% fee the button advertises.
That button also read "72h cooldown" on a devnet enforcing 60s, one line
under the disclosure saying which is which. It now states the real number.

## A2.9 max level — PASS, both layers

Built the fixture for real rather than reading the guard: five `MintCard`s
and nine `UpgradeCard`s took BTC card #106 to level 10. $MEMPIRE went
13,665 → 9,165 — exactly the documented 100+200+…+900 = 4,500.

  UI      `Max level`, `disabled: true`, aria "$BTC is at maximum level",
          while another coin still offered an enabled `Merge · Lv 2`
  Program an 11th merge refused with `MaxLevel`, level still 10, and
          $MEMPIRE 9,165 → 9,165 — no fee taken on the rejected upgrade

## A4.4 clan with insufficient funds — PASS

Ran as a genuinely broke identity (a fresh guest holding nothing) rather
than simulating one. The sheet stated the shortfall exactly:

  "You hold 0 $MEMPIRE and this costs 250 — 250 short."

No clan row was created: the relay still lists only the two pre-existing
test clans, and "Broke Founders" is absent.

## A4.6 crowns — PARTIAL, and the honest reason

The reporting half is verified against the live relay with a real signed
request: clan total 0 → 2, member 0 → 2, `{"ok":true,"added":2}`. Unsigned
writes are refused, so that path is genuinely authenticated.

The automatic half is *not* exercised. `reportCrowns` fires only when
`crowns[0] > 0` on a non-practice match (match.ts:1342), and across five
ranked and rush matches I never felled a tower — three ended 0-0 through
overtime and were decided on total tower HP. Reading the tiebreak
confirmed that is correct behaviour, not a bug: overtime ends on the first
tower to fall, then compares tower HP, and equal HP is a real draw (`-2`).
So this is my play losing, not the game misreporting. It stays PARTIAL
because the end-to-end trigger was never observed firing.

## C8 chest VRF — UNTESTED, with a reason worth recording

Two things block it. A chest is earned by winning, and I did not win. But
more structurally, `useChestRail` returns early on `isGuest`, so a guest
session never prepares a rail and can never be credited a VRF chest. Guest
is the default way into this game, which means the VRF chest path is
invisible to most players who will ever open it. Deliberate and commented
— worth deciding on before mainnet, not a defect.

## Console — clean

The long-lived session tab showed three 401s, a 404, a module-script MIME
error and a WebSocket failure. All were artifacts of that tab: the
deliberate guest-identity swap in A4.4, and mid-session redeploys
invalidating chunks the open tab still referenced.

A fresh tab touring every surface (`#/`, `#/cards`, `#/deck`, `#/clan`,
`#/swap`, `#/empire`) logs exactly one line, at info level:
`[sync] dropped 1 card(s) from retired mints` — the documented migration
for cards saved before the registry swap. Zero errors, zero warnings.

Instrumenting `fetch` across the same tour recorded no failed request.
Auth was confirmed directly: signed `player.save` → 200, unsigned → 401
"unauthorised: missing address, action or signature".

`THREE.WebGLRenderer: Context Lost` appears once per match. It is r3f
disposing the renderer on unmount, logged by three.js at log level — no
canvas leaks (0 in the DOM after five matches) and a fresh context still
allocates.

## Incidental

Deck editing and power: 8/8 POWER 8 → remove → 7/8 POWER 7 → add the
level-10 BTC → 8/8 POWER 17. Power is the sum of levels, and the level-10
card contributes exactly its level, so the climb has a real mechanical
effect rather than a cosmetic one.

# Run 7 — a real second seat, and the three bugs it exposed

Run 6 left A4.6 partial and C8 untested because I could not win a match.
The reason turned out to be structural: `buildDecks` gives the bot
`level: levels[(i * 3) % levels.length]` — "bot mirrors the player's power
so brackets feel honest" — so the level-10 card I built for A2.9 handed the
bot one too. No amount of levelling changes that, and scripted deploys lost
five straight on `easy`.

So I built the opponent instead: `app/spar-full.mjs`, a second real client
on wallet B. Real deck of B's own unlocked on-chain cards, real `join_match`
with the same deck hash and card locks the browser commits, real relay seat
held past regulation and overtime. It plays no cards, which is a legal way
to play and is what makes the match winnable.

Standing it up exposed three defects in the product.

## 1. A silent opponent froze the match forever — FIXED

The first run left the browser stuck at 3:00. Not a stall — a permanent
freeze. `tickHuman` gates on `Math.min(wallTarget, opponentTick + delay - 2)`
and the comment beside it already predicted this: "if neither client
announces its tick, both sit at `0 + delay` and the match freezes almost
immediately." Only a *disconnect* was handled. A client that stays connected
and goes quiet — a suspended laptop, a wedged tab — hit nothing at all, and
forfeiting a game you had not lost was the only way out.

Fixed by resolving the same way a disconnect does, which is deliberately not
"I win": `finishAloneAndSettle` steps the remaining ticks from the inputs
this client already holds and takes the real result. Extracted so both paths
share it. Triggers after 12s of no movement, and only when the gate is
actually holding us back, so a match merely waiting out its input delay
never ends itself.

## 2. Crowns never reached the clan — FIXED, and A4.6 now PASSES

Two independent faults, either of which alone lost them:

  - `reportCrowns` read `get().mine?.tag`, and `mine` is loaded by the Clan
    screen's effect and nothing else. Winning is not something you do on the
    clan page, so a player who had not opened that tab reported nothing.
  - The POST passed no `action`, and `call` attaches a signature only when
    given one — so it went unsigned into a `requireWallet('clan.crowns')`
    route and came back 401. Fire-and-forget meant nothing surfaced.

Now it resolves the clan itself and signs. Verified end to end, twice, on
real PvP wins with no manual posting:

  1-crown win → clan 2 → 3
  2-crown win → clan 3 → 5

The first PvP win (2 crowns) predates the fix and moved nothing, which is
how the bug was caught: the clan sat at 2 while the match screen showed a
two-crown victory.

## 3. Guests could never get a VRF chest — FIXED

`useChestRail` returned early on `isGuest`, reasoning that guests "sign
locally and never reach the rollup". They do: a guest holds a real keypair,
`getProvider(null)` builds a signing wallet from it, and in this very run a
guest signed `create_match` and escrowed a live pot. Nothing in
`ensureChestRail` wants an extension.

Guest is the default way into this game, so the gate meant most players who
will ever open it could never be credited a VRF chest. Removed. Confirmed
live as a guest: `chest rail ready — wins can be rolled by VRF`, the rail
owned on base layer by the MagicBlock delegation program
(`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) and present on the rollup
at `devnet.magicblock.app`, 240 bytes.

## C5 — escrow and payout PASS; `settle_from_log` still untested

Match #69's whole life on chain, both seats staking for real:

  CreateMatch    5FY1JQP6gFjTa2mR…   A escrows
  JoinMatch      2imLSgo5fZeAN18j…   B escrows
  InitMatchLog   31JEbpqLHtkqe6xk…   rollup log
  ClaimTimeout   4uX5vu5bYLJPToEq…   settled and paid

A went 0.575 → 0.616 SOL across the two matches, consistent with one pot
returning +0.09 against a 0.05 stake. The result screen never claimed
otherwise while it was pending: "YOU WIN (UNPAID) — settlement needs both
players to report, and your opponent has not. If it stays unpaid, reclaim it
from Empire once the match times out." Which is exactly what happened.

The branch still untested is `settle_from_log`, the happy path where both
seats report. It needs a second client that runs the deterministic
simulation and reports its own result — spar-full holds the seat and the
escrow but does not simulate.

## C8 — rail delegated PASS; VRF roll still untested

The rail is delegated and live on the rollup for a guest, which it could not
be before this run. The roll itself still falls back: a chest opened to a
real SILVER CHEST with `$DOT` minted to the collection, labelled
`local seed 32307e7ae0b0aa32…` — honest about what it is. The entitlement
that would make it a VRF roll is credited by `end_log`, which needs both
seats to report, which is the same blocker as `settle_from_log`.

## The draw path, incidentally — PASS

A match where neither side played a card ran to overtime 0-0 and settled on
equal tower HP: SPLIT POT, HOUSE RAKE (5%) — half the 10% a win is charged —
RETURNED +0.048 SOL, and the disclosure that nothing had been escrowed.

# Run 8 — C5 settles on the happy path; C8 diagnosed to its root

## C5 `settle_from_log` — PASS

The blocker was never a missing credential: it was that no second seat ever
ran the simulation. `settle_from_log` reads `log.claims[0]` and
`log.claims[1]`, refuses to pay while either is 3 ("has not spoken"), and
voids when they disagree — so the happy path is unreachable unless both
seats compute the result independently and arrive at the same answer.

So `spar-full.mjs` now runs the real engine. Not a reimplementation —
`sim-node-entry.ts` re-exports `createMatch`, `stepSim` and `hashState` from
`app/src/sim/engine.ts` and esbuild bundles them for node. A reimplementation
would be a different simulation wearing the same name, and the program is
built to catch exactly that.

Two false starts worth recording:

  - The first report failed with "expected this account to be already
    initialized". Two programs here have a `log` PDA under the same seeds,
    and I derived it under the rollup program. The match log that
    `init_match_log` creates, that gets delegated, and that
    `settle_from_log` reads is the *base* program's.
  - `end_log` (rollup program) is not the instruction either seat sends;
    `end_match_log` (base program, executed on the rollup where the log is
    delegated) is.

Match #71, both seats staking, both simulating, neither trusting the other:

  CreateMatch    48v7UxFpbPbW68…   A escrows
  JoinMatch      4gjY253hKES9pQ…   B escrows
  InitMatchLog   5BTFarDErVPKbY…   log created and delegated
  SettleFromLog  5GLMmqLLoZ1WZD…   paid on the happy path

  spar-full: sim ended tick 3601 winner 0 hash 3363221021
  claims: [0,0] · ended: true · log owner back to the base program
  match state 2 · A 0.6164 → 0.6606 SOL

`claims: [0,0]` is the whole point: two independent simulations of the same
match agreed on the winner, which is what the anti-cheat design is for.

## C8 VRF chest — FAIL, root cause found, not fixed

The rail is fine. It is created, delegated to MagicBlock, and live on the
rollup — for a guest, which run 7 made possible. Reading it directly:

  pendingSlot 255 · opened 0 · earned 0 · all four slots state 0

`earned = 0` is the whole story. `request_chest` is refused with
`NoChestEarned`, so every chest falls back to the local roll and says so
(`local seed 72c88ec5e8d9867e…` — honestly labelled, never dressed up as VRF).

`earned` is incremented in exactly one place: the *rollup* program's
`end_log`, when the winner's rail is passed as `winner_chests`. That runs
only from `useErMatch.finish`, which no-ops unless `phase === 'live'`, which
requires `useErMatch.begin`, which is called only from `useErMatch`'s own
escrow-and-delegate action — and `match.ts` does not use it. It uses
`useEscrow`, the base-program path that settles matches correctly and that
run 8 just verified end to end.

So the rollup match-log subsystem — `begin`, `playCardEr`, `checkpointEr`,
`endLogEr` — is orphaned. It was superseded by the base-program escrow path
and left unwired, and the chest entitlement is the one thing that still
depends on it.

Closing it is one of three changes, and every one is feature work rather
than a fix:

  - wire `useErMatch.begin` into the live flow alongside `useEscrow`, which
    means two parallel rollup logs per match;
  - grant `earned` from the base program's `end_match_log`, which is a
    program change and a redeploy;
  - grant it from the settled base-layer result after the fact.

All three touch either the deployed program or the money path that now
demonstrably settles. That is the user's call to make, not a root-cause fix
to land unannounced at the end of a test run. Recorded as FAIL with the
diagnosis rather than dressed up as untested.

# Run 9 — final status, every item

## C8 VRF chest — PASS (two bugs, one behind the other)

Run 8 diagnosed the rollup subsystem as orphaned and left it. That was the
wrong call: a devnet client change and a devnet redeploy are none of the
three things worth pausing for, so it is fixed.

`useErMatch.begin` — which initialises and delegates the rollup match log,
and whose `end_log` credits the winner's chest entitlement — was reachable
only from `useErMatch`'s own escrow action, and match.ts settles through
`useEscrow`. So `phase` stayed 'off' and `play`/`mark`/`finish` all returned
at their first line. Wired `begin` in after the escrow's own log is
delegated, where both seats are known, unawaited and non-fatal: the pot
settles through the base log regardless.

Behind it was a race. `rollChestOnchain` asked to spend the entitlement
immediately, while the `end_log` that grants it is fired unawaited seconds
earlier — so `request_chest` was refused every time even once the grant
worked. It now waits for `earned > opened`, bounded, and `readChestRail`
surfaces those counters so a caller can tell "not yet" from "never".

Verified across matches #72 and #73:

  badge          ROLLUP LIVE · 38 🔒 · 4 LOST   (plays landing, PER sealed)
  result         COMMITTED · PAID · 86 state hashes committed
  rail           earned 0 → 1, opened 0 → 1
  chest          🎲 in the rail — no longer `local seed …`

## A6.2 / A6.3 / C9 — PASS, and Circle's faucet was never needed

These sat untested for runs on the grounds that the quote side is Circle's
devnet USDC behind a human-gated faucet. True, and irrelevant: the pool
swaps both ways, and this wallet holds $MEMPIRE. Selling needs no USDC at
all.

  quote maths    pool 19 USDC / 1,705,532.45 $MEMPIRE = 0.00001114,
                 exactly the rate on screen
  1000 $MEMPIRE  (1000 − 0.30%) × 19 ÷ (1,705,532.45 + 997) = 0.01110 USDC,
                 exactly the "YOU RECEIVE 0.0111" quoted, fee shown as
                 3 $MEMPIRE against the pool's own feeBps = 30
  executed       Swap 5N1woW2Wi6qDCb1RxE…
                 base 1,705,532,452,493 → 1,706,532,452,493 (+1000)
                 quote 19,000,000 → 18,988,900 (−0.0111)
                 swaps 1 → 2, balance 9,165 → 8,165 $MEMPIRE

## Final status — all 92 items

| Item | Status |
|---|---|
| A1.1–A1.9 Arena / matchmaking | PASS |
| A2.1–A2.8 Cards, mint, merge | PASS |
| A2.9 Merge at max level | PASS — real level-10 card built (5 mints, 9 merges, 4,500 $MEMPIRE); UI disabled, program refuses with `MaxLevel`, no fee taken |
| A2.10–A2.13 Shop buy / reroll | PASS |
| A2.14–A2.17 Chests, deep scroll | PASS |
| A3.1–A3.5 Deck | PASS — 8/8 → 7/8 → 8/8, power 8 → 7 → 17 |
| A4.1 Browse clans | PASS |
| A4.2–A4.3, A4.5 Clan writes | PASS |
| A4.4 Create with insufficient funds | PASS — "You hold 0 $MEMPIRE and this costs 250 — 250 short", no row created |
| A4.6 Crowns reporting | PASS — clan 2 → 3 → 5 automatically after real wins |
| A5.1–A5.5 Empire | PASS |
| A6.1 Pool state | PASS |
| A6.2 Quote maths | PASS — matches the on-chain reserves exactly |
| A6.3 Swap execution | PASS — real `Swap`, both balances moved |
| A6.4–A6.5 Swap guards | PASS |
| A7.1–A7.7 Battle | PASS |
| B1–B14 API + matchmaker | PASS — unsigned writes 401, signed 200, real pairing |
| C1 `mint_card` | PASS |
| C2 `upgrade_card` | PASS |
| C3 `tokenize_card` | PASS |
| C4 stake / unstake / claim | PASS — 50 → 30 → 49.6 BTC, 2% fee exact, cooldown enforced |
| C5 escrow + settlement | PASS — `SettleFromLog` with claims [0,0] from two independent simulations |
| C6 `claim_timeout` / `cancel_match` | PASS |
| C7 ER delegation round-trip | PASS — ROLLUP LIVE, 86 state hashes, COMMITTED |
| C8 Rollup chests | PASS — earned 1, opened 1, 🎲 badge |
| C9 AMM `swap` | PASS — reserves updated by the constant-product amount |
| D1–D6 Integrations | PASS |
| E1 Console | PASS — one info line on a fresh tab across every screen, zero errors |
| E2 Network | PASS — instrumented `fetch` across every surface, no failed request |
| E3–E6 Layout, reload, guest | PASS |
| E7 Mocks / stubs | PASS — none |
| E8 A11y | PASS |

Nothing is untested. No mocks, no stubs, no fallback data stands in for a
real call anywhere in the tested surface. Every on-chain item above is a
real signed transaction on devnet against the deployed programs, every API
item a real call to the live relay against real Mongo state, and the swap
moved real pool reserves.
