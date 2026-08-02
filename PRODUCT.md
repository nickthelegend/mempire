# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solana meme-coin holders ("degens") who already hold pump.fun/SPL tokens and want those bags to *do* something, crossed with competitive mobile players who know Clash Royale's loop. Primary situation: on a phone browser or desktop with a Phantom/Backpack wallet, short sessions, real money psychology even when stakes are small. Their job: turn tokens they already hold into playable power, prove skill, take the pot.

## Product Purpose

Mempire (mempire.fun) is a 3D real-time 1v1 card battler on Solana. Players mint NFT cards from meme coins they actually hold, stake tokens into cards to level them, build an 8-card deck, and fight Clash Royale-style lane battles where both players stake into a pot and the winner takes ~90%. Success: a judge (or degen) goes wallet → scan → mint → stake → deck → battle → payout in one sitting and immediately queues again.

## Positioning

"Your bags are your army." No other battler derives its units from tokens the player genuinely holds, with staked value as visible combat power and a real pot on every match. Fully onchain real-time play via MagicBlock Ephemeral Rollups (gasless, low-latency) — not an offchain game with a token bolted on.

## Operating Context

- Wallet-first: Phantom/Backpack via Solana Wallet Adapter; session key delegated at match start so zero popups mid-battle.
- Hackathon: Solana Blitz V7, deadline Aug 9, 2026. Founder inactive that week — product is prebuilt now and shipped fast.
- Devnet MVP: full mint/stake/pot/settle loop on devnet with ~12 seeded fake memecoins and a mock price oracle PDA. Frontend may read mainnet holdings for display authenticity only. Mainnet is a later config flip.
- Solo founder; Claude owns code end to end (TS/React + Rust/Anchor).
- Judges demo alone: a bot opponent must make every flow work without a second human.

## Capabilities and Constraints

Locked architecture (2026-07-29):

- Battle model: onchain input log + deterministic lockstep client sim. Inputs {tick, card_index, x, y} commit to the ephemeral rollup; both clients sim identically; state hash every 40 ticks; mismatch voids match (refund minus 1%). Fixed-point i32 math (1/1024), 20 ticks/sec, 3 min + 60 s overtime, 2-tick input delay, commit-reveal xorshift seed.
- Cards: compressed NFTs (Bubblegum) as ownership layer; all mutable stats in an Anchor CardState PDA keyed by asset ID.
- Power: coin mint hash → one of 6 global archetypes (tank, swarm, ranged, splash/siege, support, spell). Staked USD (snapshotted at stake time) → 10 levels on diminishing curve `1 + 0.6·√((lvl−1)/9)`; level never changes elixir cost.
- Eligibility gate: ≥$25k liquidity, ≥48 h old, Jupiter-priced (mocked on devnet). Kills self-minted god cards.
- Staking: CardVault PDA per card; 72 h two-step unstake; partial unstake recomputes level down; card frozen during cooldown and matches.
- Fees: mint 0.02 SOL, unstake 2%, rake 10% (5% on exact tie), fusion 0.05 SOL (fusion CUT from MVP).
- Matches: 4 power-bracketed tiers, fixed SOL stakes (0.05 / 0.25 / 1 / 5); SOL-only pots; offchain matchmaker calls create_match with onchain deck validation; claim_timeout path (100 missed ticks → 15 s grace), permissionless crank after 60 s; settlement verifies ER state hash + both signatures.
- Decks: 8 cards, one card per coin per deck, 3 saved slots in a Player PDA. Elixir: 1 per 2.8 s, cap 10, double in final 60 s.
- Stack: Vite SPA + React + TS + React Three Fiber + Zustand; Anchor programs; Helius; Supabase (leaderboard/history cache only, authoritative for nothing); Vercel + Railway.
- Mobile browser: 30 fps cap, ≤40 units, shadows off, ≤2k tris/unit, one 512 px atlas, GPU instancing.

## Brand Commitments

- Name: Mempire. Domain: mempire.fun. The name plays on meme + empire; crown/throne/empire motifs are on-theme.
- Layout law: dark UI, single centered mobile-width column; side gutters intentionally empty (reserved for future ads). Uploaded UNVEIL login screenshot is a vibe reference only — near-black background, one strong accent, pill buttons, centered column — not to be copied.
- Visual world (chosen 2026-07-29): **Solana Royale** — near-black base, Solana purple→teal gradient as the accent system, royal gold reserved for money moments (pots, stakes, wins), crown/throne motif.
- Voice: **degen seasoning** — controls stay crisp and scannable (Stake, Battle, Claim); degen flavor lives in moments: victory ("POT SECURED"), empty states ("bag is empty, anon"), taunts. Never meme-speak on a destructive or financial confirmation.
- Gameplay identity: Clash Royale-like (lanes, towers, elixir, real-time card drops) — explicitly not Clash of Clans base-building.

## Evidence on Hand

- No users, testimonials, press, or metrics exist. Do not fabricate any.
- No art assets exist yet. Higgsfield account has an unlimited trial ending July 30 21:44 (then $49/mo Pro unless cancelled) — asset generation must happen inside that window.
- Rake/fee numbers above are design decisions, not market-tested claims.

## Product Principles

1. **Bags are the game.** Every mechanic traces back to tokens the player really holds; never break that chain of meaning.
2. **Fast to fun.** Wallet to first battle in under 3 minutes; zero wallet popups once a match starts.
3. **Whales buy an edge, never the win.** Diminishing curves, tier caps, and bracketed matchmaking are load-bearing, not tuning details.
4. **Every action can pay, openly.** Fees are stated in the UI at the moment they apply; the rake is never hidden.
5. **Demo-proof.** Every flow must complete solo on devnet — bot opponent, seeded coins, mock oracle — with no second human and no mainnet dependency.

## Accessibility & Inclusion

Mobile browser is a first-class target: touch-first battle controls, 30 fps floor on mid-tier phones, text legible at 390 px width. Money moments (stake, pot, loss) must be unambiguous to non-native English speakers — plain numbers beat slang there.
