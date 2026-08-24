use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
#[cfg(feature = "nft")]
use anchor_spl::metadata::{
    create_metadata_accounts_v3, CreateMetadataAccountsV3, Metadata,
    mpl_token_metadata::types::{Creator, DataV2},
};
#[cfg(feature = "rollup")]
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
#[cfg(feature = "rollup")]
use ephemeral_rollups_sdk::cpi::DelegateConfig;
#[cfg(feature = "rollup")]
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP");


const MIN_LIQUIDITY_USD: u64 = 25_000;

/// The game's currency. Constants rather than `Config` fields on purpose:
/// `Config::SIZE` is exact, so widening it would orphan the live config
/// account the same way a wider `Card` would orphan every existing card.
#[cfg(not(feature = "mainnet"))]
const MEMPIRE_MINT: Pubkey = pubkey!("AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8");
/// The mainnet mint. Generated offline before launch — the keypair lives in
/// the gitignored `chain/.mempire-mint-mainnet.json` and MUST be the key that
/// actually mints on mainnet, or every $MEMPIRE constraint refuses.
#[cfg(feature = "mainnet")]
const MEMPIRE_MINT: Pubkey = pubkey!("EzN1R1qbU4Vx1XC8FJFKuLJxN8hjxvMNipHi3uLBPAcU");

/// Base units of $MEMPIRE (6 decimals) for the first upgrade — 100 whole
/// tokens. Multiplied by the current level, so 1→2 costs 100 and 9→10 costs
/// 900, and the climb is a decision rather than an afternoon.
const UPGRADE_BASE_FEE: u64 = 100_000_000;

/// $MEMPIRE paid to the winner of a settled match, in base units (50 whole
/// tokens).
///
/// The onboarding problem this solves: chests pay cards, so a player arrives
/// holding no $MEMPIRE at all — while merging, chest skips, the shop and clan
/// charters all price in it. Winning is the one thing every player already
/// does, so it is what pays. Two wins covers a first merge.
///
/// A constant rather than a `Config` field on purpose: widening `Config` would
/// orphan an already-initialised config account, and `Config::SIZE` is exact.
/// Retuning this is a program upgrade, which is the same bar `UPGRADE_BASE_FEE`
/// already sits behind.
const WIN_REWARD: u64 = 50_000_000;

/// What a card costs in $MEMPIRE instead of SOL — 250, matching the fee table.
///
/// The shop advertised "250 $MEMPIRE" beside "0.02 SOL" as two ways to buy the
/// same card, and charged the first player *both*: the client paid $MEMPIRE and
/// then called `mint_card`, which takes `mint_fee_lamports` unconditionally.
/// The $MEMPIRE route was therefore strictly worse than the SOL one — a
/// surcharge wearing the label of an alternative — and no player who understood
/// it would ever have chosen it.
///
/// It lives here rather than in the client because the client used to name its
/// own price: the shop's offers are generated browser-side and `priceOf` takes
/// "a bare number", so a patched client could have bought at one token. A price
/// the payer chooses is not a price.
const MINT_FEE_MEMPIRE: u64 = 250_000_000;

/// The four stake tiers, in lamports: Pauper, Knight, Duke, Emperor.
///
/// These existed only in the client until now. `create_match` took `tier` and
/// `stake_lamports` as two independent arguments and checked neither, so a
/// patched client could escrow any amount it liked and label it any tier —
/// which made the tier meaningless to anything reading it back (matchmaking,
/// the leaderboard) and left the "small tiers only" launch control living
/// entirely in a UI that the player controls.
///
/// Binding them here costs a comparison and makes the tier a fact.
const TIER_STAKES: [u64; 4] = [
    50_000_000,    // 0.05 SOL
    250_000_000,   // 0.25 SOL
    1_000_000_000, // 1 SOL
    5_000_000_000, // 5 SOL
];

/// Where a card's metadata JSON lives. The ticker is appended, lower-cased.
const METADATA_BASE_URI: &str = "https://play.mempire.fun/nft/";
const DECK_SIZE: usize = 8;


/// FNV-1a over the base58 string of the mint — byte-identical to the
/// TypeScript `archetypeForMint`, so client and chain always agree.
fn archetype_for_mint(mint: &Pubkey) -> u8 {
    let s = mint.to_string();
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    (h % 6) as u8
}

/// Injects the `process_undelegation` callback the delegation program CPIs into
/// when returning a delegated account, plus the commit/undelegate intent
/// builders. Required on any program that delegates — without it a `MatchLog`
/// could be delegated and never come back.
#[cfg_attr(feature = "rollup", ephemeral)]
#[program]
pub mod mempire {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        mint_fee_lamports: u64,
        rake_bps: u16,
        tie_rake_bps: u16,
        unstake_fee_bps: u16,
        unstake_cooldown_secs: i64,
        match_timeout_secs: i64,
        min_age_secs: i64,
        power_band: u32,
    ) -> Result<()> {
        require!(rake_bps <= 2000, MempireError::FeeTooHigh);
        require!(tie_rake_bps <= rake_bps, MempireError::FeeTooHigh);
        require!(unstake_fee_bps <= 1000, MempireError::FeeTooHigh);
        /*
         * The durations must be sane, and the fees only checked themselves.
         * A zero or negative cooldown makes request/claim a single-block
         * round trip (the two-step design worthless); a zero timeout lets
         * claim_timeout fire the instant a match opens and take the pot; and
         * i64 accepts negatives everywhere a human meant "seconds". Bounds
         * are wide — one minute to thirty days — because devnet legitimately
         * runs a 60s cooldown; what they exclude is nonsense, not policy.
         */
        require!(
            (60..=30 * 86_400).contains(&unstake_cooldown_secs),
            MempireError::BadConfig
        );
        require!(
            (60..=7 * 86_400).contains(&match_timeout_secs),
            MempireError::BadConfig
        );
        require!((0..=365 * 86_400).contains(&min_age_secs), MempireError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.treasury = ctx.accounts.treasury.key();
        c.mint_fee_lamports = mint_fee_lamports;
        c.rake_bps = rake_bps;
        c.tie_rake_bps = tie_rake_bps;
        c.unstake_fee_bps = unstake_fee_bps;
        c.unstake_cooldown_secs = unstake_cooldown_secs;
        c.match_timeout_secs = match_timeout_secs;
        c.min_age_secs = min_age_secs;
        c.power_band = power_band;
        c.next_card_id = 1;
        c.next_match_id = 1;
        c.bump = ctx.bumps.config;
        Ok(())
    }


    /// Admin: point fees and rake at a different treasury.
    ///
    /// `init_config` runs once against a fixed PDA, so without this the
    /// treasury chosen on day one is the treasury forever. On devnet that
    /// treasury was the admin wallet — which meant rake and payout landed in
    /// the same account and no test could tell them apart, so the rake split
    /// was asserted only by arithmetic and never by observation.
    ///
    /// Gated on `config.admin` via `has_one`, and the admin cannot change:
    /// this moves where fees go, not who decides.
    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
        let previous = ctx.accounts.config.treasury;
        let next = ctx.accounts.treasury.key();
        require_keys_neq!(previous, next, MempireError::TreasuryUnchanged);
        ctx.accounts.config.treasury = next;
        emit!(TreasuryChanged { previous, next });
        Ok(())
    }

    /// Devnet mock oracle: the admin registers a coin with its liquidity and
    /// price. Mainnet replaces this with Jupiter/Pyth-fed data.
    pub fn register_coin(
        ctx: Context<RegisterCoin>,
        liquidity_usd: u64,
        price_micro_usd: u64,
        first_seen_ts: i64,
    ) -> Result<()> {
        let info = &mut ctx.accounts.coin_info;
        info.mint = ctx.accounts.mint.key();
        info.liquidity_usd = liquidity_usd;
        info.price_micro_usd = price_micro_usd;
        info.first_seen_ts = first_seen_ts;
        info.decimals = ctx.accounts.mint.decimals;
        info.bump = ctx.bumps.coin_info;
        Ok(())
    }

    pub fn set_price(
        ctx: Context<SetPrice>,
        liquidity_usd: u64,
        price_micro_usd: u64,
    ) -> Result<()> {
        let info = &mut ctx.accounts.coin_info;
        info.liquidity_usd = liquidity_usd;
        info.price_micro_usd = price_micro_usd;
        Ok(())
    }

    /// Mint a card from a coin the player holds. The eligibility gate lives
    /// here: liquidity floor + coin age. Fee goes to the treasury.
    pub fn mint_card(ctx: Context<MintCard>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let info = &ctx.accounts.coin_info;
        let cfg = &ctx.accounts.config;
        require!(
            info.liquidity_usd >= MIN_LIQUIDITY_USD,
            MempireError::CoinNotEligible
        );
        require!(
            now.saturating_sub(info.first_seen_ts) >= cfg.min_age_secs,
            MempireError::CoinTooYoung
        );
        // Holding the coin is no longer required to mint its card.
        //
        // "Your bags are your army" was the premise, and enforcing it here is
        // what made it true rather than marketing. It also meant the only
        // people who could field a deck were people who already held eight
        // specific SPL tokens — on mainnet a rounding error of an audience,
        // and on devnet a faucet dependency for every single new player. The
        // game gated itself behind a wallet audit before anyone had seen a
        // match.
        //
        // The eligibility rules above stay: liquidity and age are claims about
        // the *coin*, and they are what stop someone minting a god card from a
        // token they launched this morning. What is gone is the claim about
        // the player's wallet. Power now comes from playing the card, which is
        // a thing anyone can start doing.

        /*
         * One fee or the other, never both.
         *
         * When the $MEMPIRE accounts are supplied the lamport fee is waived and
         * `MINT_FEE_MEMPIRE` is taken instead, which is what makes the shop's
         * two prices genuine alternatives rather than a surcharge stacked on
         * the mint fee. All three accounts are required together — a payment
         * missing its token program is not a payment.
         */
        match (
            ctx.accounts.owner_mempire.as_ref(),
            ctx.accounts.treasury_mempire.as_ref(),
            ctx.accounts.token_program.as_ref(),
        ) {
            (Some(from), Some(to), Some(token_program)) => {
                token::transfer(
                    CpiContext::new(
                        token_program.to_account_info(),
                        Transfer {
                            from: from.to_account_info(),
                            to: to.to_account_info(),
                            authority: ctx.accounts.owner.to_account_info(),
                        },
                    ),
                    MINT_FEE_MEMPIRE,
                )?;
            }
            _ => {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.owner.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                        },
                    ),
                    cfg.mint_fee_lamports,
                )?;
            }
        }

        let card = &mut ctx.accounts.card;
        card.id = ctx.accounts.config.next_card_id;
        card.owner = ctx.accounts.owner.key();
        card.coin_mint = info.mint;
        card.archetype = archetype_for_mint(&info.mint);
        card.staked_tokens = 0;
        card.staked_micro_usd = 0;
        card.level = 1;
        card.pending_unstake_tokens = 0;
        card.unstake_ready_at = 0;
        card.locked_by = Pubkey::default();
        card.bump = ctx.bumps.card;

        let cfg = &mut ctx.accounts.config;
        cfg.next_card_id += 1;

        emit!(CardMinted {
            card: card.key(),
            owner: card.owner,
            mint: card.coin_mint,
            archetype: card.archetype,
        });
        Ok(())
    }


    /// Merge a duplicate card into one you keep, for a level.
    ///
    /// # Why this is how cards level now
    ///
    /// Levels used to come from `stake`: lock more of a coin into its card and
    /// the card got stronger. That made power a function of how much of a token
    /// you could afford to immobilise, which is a wealth ladder wearing a
    /// progression system's clothes — and it required holding the coin, which
    /// `mint_card` no longer does either.
    ///
    /// So power comes from playing. You win, you earn a chest, the chest drops
    /// a card. A card for a coin you already own is otherwise dead weight —
    /// decks are one-per-coin, so a second `$BTC` can never be fielded — and
    /// this is what turns that duplicate into the reward it should have been.
    /// Eleven duplicate cards used to be eleven mint fees for nothing.
    ///
    /// The duplicate is closed and its rent returned to the owner, so merging
    /// costs the fee below and nothing else.
    ///
    /// Both cards must be free. Levelling a card mid-match would change the
    /// power band a match was opened under, and closing one that a match still
    /// names would strand settlement on a missing account.
    pub fn upgrade_card(ctx: Context<UpgradeCard>) -> Result<()> {
        let keep = &ctx.accounts.card;
        let dupe = &ctx.accounts.duplicate;

        require!(keep.key() != dupe.key(), MempireError::SameCard);
        require!(
            keep.coin_mint == dupe.coin_mint,
            MempireError::DifferentCoins
        );
        require!(!keep.is_locked() && !dupe.is_locked(), MempireError::CardLocked);
        require!(keep.level < 10, MempireError::MaxLevel);

        // Priced per level, so the last one costs what the whole climb did.
        // A flat fee makes level 10 an afternoon's grinding; this makes it a
        // decision. Charged in $MEMPIRE because that is the game's currency and
        // the only sink that gives it a reason to be held.
        let price = UPGRADE_BASE_FEE.saturating_mul(keep.level as u64);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_mempire.to_account_info(),
                    to: ctx.accounts.treasury_mempire.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            price,
        )?;

        let keep = &mut ctx.accounts.card;
        keep.level += 1;

        emit!(CardUpgraded {
            card: keep.key(),
            owner: keep.owner,
            mint: keep.coin_mint,
            level: keep.level,
            burned: dupe.key(),
            paid: price,
        });
        Ok(())
    }

    /// Turn an existing card into a real NFT.
    ///
    /// # Why this is separate from `mint_card`
    ///
    /// A card has always been an Anchor PDA: correct, cheap, and completely
    /// invisible to every wallet and explorer, which render it as a program
    /// account full of bytes. "Your bags are your army" is a claim nobody could
    /// see anywhere except inside this game.
    ///
    /// This mints the 1-of-1 that makes it visible — a 0-decimal mint with a
    /// supply of one, a Metaplex metadata account carrying the fighter's name
    /// and art, and mint authority burned afterwards so the supply can never
    /// move off one.
    ///
    /// Additive rather than folded into `mint_card`, for two reasons: minting
    /// stays cheap for anyone who does not want the NFT, and every card that
    /// already exists can still be tokenised. Folding it in would have changed
    /// `mint_card`'s account list and stranded the cards already on chain.
    ///
    /// `level` is deliberately *not* written into the metadata. It changes
    /// every time a duplicate is merged, and metadata that lies within a minute
    /// of being written is worse than metadata that stays quiet — the card
    /// account is the authority on level, and the URI points at art, not stats.
    #[cfg(feature = "nft")]
    pub fn tokenize_card(ctx: Context<TokenizeCard>, ticker: String) -> Result<()> {
        require!(ticker.len() <= 12 && !ticker.is_empty(), MempireError::TickerTooLong);
        /*
         * The ticker lands in the NFT's on-chain name and its metadata URI.
         * Free-form input there means a caller can title an NFT
         * "Mempire $<anything>" and point its JSON at a path they influence —
         * phishing surface wearing this program's name. Alphanumerics only;
         * every real ticker in the registry already satisfies this.
         */
        require!(
            ticker.bytes().all(|b| b.is_ascii_alphanumeric()),
            MempireError::TickerTooLong
        );
        let card = &ctx.accounts.card;
        let card_id = card.id;

        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"nft", &card_id.to_le_bytes(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        // One token, then the authority is dropped. A 1-of-1 whose issuer can
        // still print is not a 1-of-1.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    to: ctx.accounts.owner_nft.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            1,
        )?;

        let upper = ticker.to_uppercase();
        let lower = ticker.to_lowercase();
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    mint_authority: ctx.accounts.mint_authority.to_account_info(),
                    payer: ctx.accounts.owner.to_account_info(),
                    update_authority: ctx.accounts.mint_authority.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer,
            ),
            DataV2 {
                name: format!("Mempire ${}", upper),
                symbol: "MEMFTR".to_string(),
                uri: format!("{}{}.json", METADATA_BASE_URI, lower),
                seller_fee_basis_points: 500,
                /*
                 * A royalty percentage with no creators array is a fee nobody
                 * receives. Metaplex takes the *rate* from
                 * `seller_fee_basis_points` and the *recipients* from
                 * `creators`; with `None` here marketplaces computed 5% and had
                 * no address to send it to, so the royalty line in the fee
                 * table was uncollectible on every card ever tokenised.
                 *
                 * Unverified is correct at mint: verification requires the
                 * creator to sign, and the treasury is not a signer on a
                 * transaction the card's owner sends. Marketplaces route
                 * payment on the address regardless; `verify_creator` can add
                 * provenance later without reminting.
                 */
                creators: Some(vec![Creator {
                    address: ctx.accounts.config.treasury,
                    verified: false,
                    share: 100,
                }]),
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.nft_mint.to_account_info(),
                },
                signer,
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        emit!(CardTokenized {
            card: card.key(),
            owner: card.owner,
            nft_mint: ctx.accounts.nft_mint.key(),
        });
        Ok(())
    }

    /// One-time: rewrite a `Card` written under the pre-`locked_by` layout.
    ///
    /// `in_match: bool` became `locked_by: Pubkey` so settlement could tell
    /// *which* match a lock belongs to. That is 31 bytes wider and shifts
    /// `bump`, so an account written under the old shape no longer
    /// deserialises — and a card that cannot be read cannot be staked into,
    /// battled with, or unstaked from. The alternative to this instruction is
    /// telling every existing holder their staked tokens are unreachable.
    ///
    /// Owner-signed, and a no-op on anything already the new size, so running
    /// it twice is harmless. The lock is cleared: the old layout recorded only
    /// *that* a card was locked, never to what, so there is nothing to carry
    /// over — and a stranded lock with no match to release it is precisely the
    /// bug this field exists to prevent.
    pub fn migrate_card(ctx: Context<MigrateCard>) -> Result<()> {
        const OLD_LEN: usize = 8 + 108;
        let info = &ctx.accounts.card;

        if info.data_len() >= Card::SIZE {
            return Ok(());
        }
        require!(info.data_len() == OLD_LEN, MempireError::BadCardLayout);

        // Read the two trailing fields before the account grows under us.
        let bump = {
            let data = info.try_borrow_data()?;
            // owner, at offset 8 + 8, must be the signer — the seeds alone do
            // not bind this account to anyone.
            let owner = Pubkey::try_from(&data[16..48]).unwrap();
            require_keys_eq!(owner, ctx.accounts.owner.key(), MempireError::NotCardOwner);
            data[8 + 107]
        };

        let rent = Rent::get()?;
        let needed = rent.minimum_balance(Card::SIZE);
        let have = info.lamports();
        if needed > have {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: info.to_account_info(),
                    },
                ),
                needed - have,
            )?;
        }
        info.resize(Card::SIZE)?;

        let mut data = info.try_borrow_mut_data()?;
        // `locked_by` = default, then `bump` at its new home. Everything before
        // offset 106 is unchanged and stays exactly where it was.
        data[8 + 106..8 + 138].fill(0);
        data[8 + 138] = bump;
        Ok(())
    }




    /// Player 0 opens a match at a tier, escrowing the stake in the match PDA.
    /// The 8 deck cards ride in `remaining_accounts` and are validated and
    /// locked here — ownership, one card per coin, and the power score.
    pub fn create_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateMatch<'info>>,
        tier: u8,
        stake_lamports: u64,
        // Ignored. Kept so the instruction's shape does not change under
        // existing clients; the commitment is derived from the locked cards.
        _deck_hash: [u8; 32],
    ) -> Result<()> {
        // Before anything moves: the tier must be real and the stake must be
        // the one that tier means. Checked here rather than after the deck
        // work so a malformed match costs nothing to reject.
        let tier_stake = *TIER_STAKES
            .get(tier as usize)
            .ok_or(MempireError::BadStake)?;
        require!(stake_lamports == tier_stake, MempireError::BadStake);

        let match_key = ctx.accounts.match_account.key();
        let (power, deck_hash) = validate_and_lock_deck(
            ctx.remaining_accounts,
            &ctx.accounts.player.key(),
            &match_key,
        )?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.match_account.to_account_info(),
                },
            ),
            stake_lamports,
        )?;

        let m = &mut ctx.accounts.match_account;
        m.id = ctx.accounts.config.next_match_id;
        m.tier = tier;
        m.stake_lamports = stake_lamports;
        m.players[0] = ctx.accounts.player.key();
        m.deck_hash[0] = deck_hash;
        m.power[0] = power;
        m.state = MatchState::Open as u8;
        m.created_at = Clock::get()?.unix_timestamp;
        m.deadline = 0;
        m.winner = u8::MAX;
        m.final_hash = 0;
        m.bump = ctx.bumps.match_account;

        let cfg = &mut ctx.accounts.config;
        cfg.next_match_id += 1;

        emit!(MatchCreated {
            match_id: m.id,
            tier,
            stake_lamports
        });
        Ok(())
    }

    /// Player 1 joins: same stake, deck validated + locked, bracket checked.
    pub fn join_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, JoinMatch<'info>>,
        // Ignored — see `create_match`.
        _deck_hash: [u8; 32],
    ) -> Result<()> {
        let match_key = ctx.accounts.match_account.key();
        let (power, deck_hash) = validate_and_lock_deck(
            ctx.remaining_accounts,
            &ctx.accounts.player.key(),
            &match_key,
        )?;

        let stake = ctx.accounts.match_account.stake_lamports;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.match_account.to_account_info(),
                },
            ),
            stake,
        )?;

        let band = ctx.accounts.config.power_band;
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Open as u8, MempireError::BadMatchState);
        require!(
            m.players[0] != ctx.accounts.player.key(),
            MempireError::SelfMatch
        );
        require!(
            power.abs_diff(m.power[0]) <= band,
            MempireError::PowerMismatch
        );
        m.players[1] = ctx.accounts.player.key();
        m.deck_hash[1] = deck_hash;
        m.power[1] = power;
        m.state = MatchState::Active as u8;
        m.deadline = Clock::get()?.unix_timestamp + ctx.accounts.config.match_timeout_secs;
        Ok(())
    }

    /// Withdraw a match nobody joined: stake back, deck released.
    ///
    /// Without this an `Open` match was a one-way door. Nobody is obliged to
    /// join, and if nobody did, the creator's stake sat in the match account
    /// and eight cards stayed locked with no instruction anywhere that could
    /// free them — every unmatched queue entry permanently burned a deck.
    ///
    /// Only the creator, only while still `Open`, so this can never touch a
    /// live match or a pot that has two contributors. No rake: no game was
    /// played, so there is nothing to take a cut of.
    pub fn cancel_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelMatch<'info>>,
    ) -> Result<()> {
        {
            let m = &ctx.accounts.match_account;
            require!(m.state == MatchState::Open as u8, MempireError::BadMatchState);
            require!(
                m.players[0] == ctx.accounts.player.key(),
                MempireError::NotAPlayer
            );
        }

        // Return exactly the stake, not the whole balance: the rest is the
        // account's rent, and it is `close`d to the player below anyway.
        let stake = ctx.accounts.match_account.stake_lamports;
        let m_info = ctx.accounts.match_account.to_account_info();
        **m_info.try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += stake;

        unlock_deck(ctx.remaining_accounts, &ctx.accounts.match_account.key())?;

        let m = &mut ctx.accounts.match_account;
        m.state = MatchState::Settled as u8;
        m.winner = 3;
        emit!(MatchCancelled {
            match_id: m.id,
            player: ctx.accounts.player.key(),
            refunded: stake,
        });
        Ok(())
    }


    /// Release cards still locked to a match that is already over.
    ///
    /// Settlement frees the decks handed to it in `remaining_accounts`, and a
    /// client only reliably knows its *own* eight cards. So the loser's deck
    /// routinely survived the match that locked it: the match reached
    /// `Settled`, the pot paid out correctly, and eight cards stayed pinned to
    /// a finished game with no instruction able to free them. That wallet
    /// could never field a legal deck again.
    ///
    /// Permissionless on purpose. The match is over — the lock protects
    /// nothing at this point, and requiring the stranded player to be the one
    /// who notices is how the bug survived in the first place. Anything not
    /// locked to *this* settled match is skipped rather than rejected, so a
    /// caller can sweep a wallet's whole collection in one call.
    pub fn release_cards<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReleaseCards<'info>>,
    ) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(
            m.state == MatchState::Settled as u8,
            MempireError::BadMatchState
        );

        let match_key = m.key();
        let mut freed: u32 = 0;
        for acc in ctx.remaining_accounts {
            if let Ok(mut card) = Account::<Card>::try_from(acc) {
                if card.locked_by != match_key {
                    continue;
                }
                card.locked_by = Pubkey::default();
                card.exit(&crate::ID)?;
                freed += 1;
            }
        }

        emit!(CardsReleased { match_id: m.id, freed });
        Ok(())
    }

    /// Settlement: both players sign the same final state hash (the lockstep
    /// sim's last checkpoint). Winner takes pot minus rake; a draw splits it.
    /// The ER-delegated input log is the next hardening step; dual signatures
    /// already prevent either side from settling unilaterally.
    pub fn settle<'info>(
        ctx: Context<'_, '_, 'info, 'info, Settle<'info>>,
        final_hash: u64,
        winner: u8,
    ) -> Result<()> {
        require!(winner <= 2, MempireError::BadWinner);
        {
            let m = &ctx.accounts.match_account;
            require!(
                m.state == MatchState::Active as u8,
                MempireError::BadMatchState
            );
            require!(
                ctx.accounts.player_a.key() == m.players[0]
                    && ctx.accounts.player_b.key() == m.players[1],
                MempireError::NotAPlayer
            );
        }

        let pot = ctx.accounts.match_account.stake_lamports * 2;
        let (rake_bps, tie) = if winner == 2 {
            (ctx.accounts.config.tie_rake_bps, true)
        } else {
            (ctx.accounts.config.rake_bps, false)
        };
        let rake = (pot as u128 * rake_bps as u128 / 10_000) as u64;
        let payout = pot - rake;

        let m_info = ctx.accounts.match_account.to_account_info();
        **m_info.try_borrow_mut_lamports()? -= rake;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += rake;
        if tie {
            let half = payout / 2;
            **m_info.try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player_a.try_borrow_mut_lamports()? += half;
            **ctx.accounts.player_b.try_borrow_mut_lamports()? += payout - half;
        } else {
            let to = if winner == 0 {
                ctx.accounts.player_a.to_account_info()
            } else {
                ctx.accounts.player_b.to_account_info()
            };
            **m_info.try_borrow_mut_lamports()? -= payout;
            **to.try_borrow_mut_lamports()? += payout;
        }

        unlock_deck(ctx.remaining_accounts, &ctx.accounts.match_account.key())?;

        let m = &mut ctx.accounts.match_account;
        m.state = MatchState::Settled as u8;
        m.winner = winner;
        m.final_hash = final_hash;
        emit!(MatchSettled {
            match_id: m.id,
            winner,
            final_hash,
            rake
        });
        Ok(())
    }

    /// If the opponent vanishes, the present player claims after the deadline.
    /// Permissionless once a further grace period passes, so pots never lock.
    pub fn claim_timeout<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimTimeout<'info>>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let m = &ctx.accounts.match_account;
            require!(
                m.state == MatchState::Active as u8,
                MempireError::BadMatchState
            );
            require!(now >= m.deadline, MempireError::TooEarly);

            /*
             * A timeout is for an opponent who left. A disagreement is not.
             *
             * `settle_from_log` refuses to pay a disputed result, which is
             * right — but it left the match Active, and this instruction pays
             * whichever player calls it. So after the deadline the two seats
             * raced, and a client that lied about the winner and then called
             * this first took the entire pot. Disagreement was not griefing,
             * it was theft, and stalling beat playing honestly.
             *
             * The log says which happened. Both seats having spoken and
             * contradicted each other is a dispute; anything else — nobody
             * spoke, one seat spoke, no log exists, the log is still delegated
             * — is the abandonment this instruction was written for.
             *
             * The account is pinned by seeds, so a caller cannot omit it or
             * swap in an empty one to make a dispute look like an absence.
             */
            let log_info = ctx.accounts.match_log.to_account_info();
            let readable = log_info.owner == &crate::ID && log_info.data_len() >= 8;
            let claims: Option<[u8; 2]> = if readable {
                let data = log_info.try_borrow_data()?;
                MatchLog::try_deserialize(&mut &data[..])
                    .ok()
                    .filter(|log: &MatchLog| log.match_id == m.id)
                    .map(|log| log.claims)
            } else {
                None
            };

            /*
             * A log we cannot read is not a log that says nothing.
             *
             * While delegated, the account is owned by the delegation program,
             * so the read above yields `None` — the same value as "no log was
             * ever created". The two were then treated identically and fell
             * through to "genuine abandonment, either may claim". Under the
             * `rollup` build that is *every* match where one seat stayed
             * silent, because `end_match_log` only commits the log home once
             * both seats have claimed. So the protection written directly
             * above disabled itself in precisely the case it describes: the
             * loser who never claims could call this at the deadline and take
             * the pot.
             *
             * Existing but unreadable is therefore treated as a dispute —
             * refund both, rake nothing. It cannot reward the stall, and it
             * cannot rob a winner whose opponent genuinely vanished of more
             * than the upside.
             */
            let unreadable = !readable && log_info.data_len() > 0;

            /*
             * A seat that recorded a claim proved it was here.
             *
             * The first version of this only detected *disagreement*, and paid
             * the first caller in every other shape — which left the cheapest
             * cheat untouched and, worse, made it the best one. A loser who
             * simply never calls `end_match_log` leaves `claims = [0, 3]`: the
             * log stays delegated, `settle_from_log` is permanently
             * unreachable because it requires both claims, and the honest
             * winner's only remaining path is this instruction. The liar then
             * fires it at the deadline and takes the pot. Lying cost them the
             * pot; silence won it.
             *
             * So the log decides eligibility, not just the dispute:
             *
             *   both spoke, disagreed  → refund both, no rake (below)
             *   both spoke, agreed     → this is not a timeout; use settle
             *   exactly one spoke      → only that seat may claim
             *   nobody spoke / no log  → genuine abandonment, either may claim
             */
            let disputed = if unreadable { true } else { match claims {
                Some([a, b]) if a != 3 && b != 3 && a != b => true,
                Some([a, b]) if a != 3 && b != 3 => {
                    // An agreed, committed result is a settlement, not an
                    // absence. Paying the loser here would ignore an on-chain
                    // answer the program can already read.
                    return err!(MempireError::BadMatchState);
                }
                Some([a, b]) => {
                    // One seat spoke. That seat was present, so the *other* one
                    // is the absent party and must not be paid for absence.
                    let present = if a != 3 {
                        Some(m.players[0])
                    } else if b != 3 {
                        Some(m.players[1])
                    } else {
                        None
                    };
                    if let Some(who) = present {
                        require_keys_eq!(
                            ctx.accounts.claimer.key(),
                            who,
                            MempireError::NotAPlayer
                        );
                    }
                    false
                }
                None => false,
            } };

            if disputed {
                /*
                 * Refund both, in full, and take no rake.
                 *
                 * One of these two is lying and the program cannot tell which,
                 * so the only outcome that does not reward the liar is the one
                 * that pays nobody. Rake is skipped deliberately: charging it
                 * would take money from the honest seat to settle a dispute the
                 * house could not resolve.
                 *
                 * A cheat can still force this — losing nothing but winning
                 * nothing either. Turning that last gap into a loss needs the
                 * result attested by something that watched the match, and is
                 * tracked in AUDIT.md.
                 */
                let stake = m.stake_lamports;
                let id = m.id;
                let key = ctx.accounts.match_account.key();
                let m_info = ctx.accounts.match_account.to_account_info();
                **m_info.try_borrow_mut_lamports()? -= stake * 2;
                **ctx.accounts.player_a.try_borrow_mut_lamports()? += stake;
                **ctx.accounts.player_b.try_borrow_mut_lamports()? += stake;

                unlock_deck(ctx.remaining_accounts, &key)?;

                let m = &mut ctx.accounts.match_account;
                m.state = MatchState::Settled as u8;
                m.winner = 2;
                emit!(MatchSettled {
                    match_id: id,
                    winner: 2,
                    final_hash: 0,
                    rake: 0,
                });
                return Ok(());
            }

            // You may only claim a timeout for yourself.
            //
            // This used to accept any `winner_account` that was one of the two
            // players, and after a 60-second grace, from any third party at
            // all. So the losing player's best move was never to sign
            // `settle`: wait out the deadline, call this with themselves as
            // winner, and take the whole pot. The honest 2-of-2 path was
            // strictly dominated by stalling.
            //
            // A timeout is now what it says — the opponent stopped
            // responding, so the player who is still here takes it — and the
            // third-party grace path is gone, because there is no honest
            // reason for a stranger to decide who won a match.
            let claimer = ctx.accounts.claimer.key();
            require!(
                claimer == m.players[0] || claimer == m.players[1],
                MempireError::NotAPlayer
            );
            require_keys_eq!(
                ctx.accounts.winner_account.key(),
                claimer,
                MempireError::NotAPlayer
            );
        }

        let pot = ctx.accounts.match_account.stake_lamports * 2;
        let rake = (pot as u128 * ctx.accounts.config.rake_bps as u128 / 10_000) as u64;
        let payout = pot - rake;
        let m_info = ctx.accounts.match_account.to_account_info();
        **m_info.try_borrow_mut_lamports()? -= rake + payout;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += rake;
        **ctx.accounts.winner_account.try_borrow_mut_lamports()? += payout;

        unlock_deck(ctx.remaining_accounts, &ctx.accounts.match_account.key())?;

        let m = &mut ctx.accounts.match_account;
        m.state = MatchState::Settled as u8;
        m.winner = if ctx.accounts.winner_account.key() == m.players[0] {
            0
        } else {
            1
        };
        Ok(())
    }

    // ── MagicBlock Ephemeral Rollup: the live battle loop ────────────────────
    //
    // Only `MatchLog` is delegated. It carries the input log and the state-hash
    // checkpoints and holds **zero lamports**, so delegation can never strand
    // the pot: the escrow stays in `MatchAccount` on base layer, which is never
    // delegated. If the ER is unreachable the match degrades to the existing
    // `claim_timeout` path rather than trapping money in a rollup.
    //
    // Routing (enforced by where each instruction can succeed):
    //   init_match_log      → base layer
    //   delegate_match_log  → base layer
    //   play_card           → ER
    //   checkpoint          → ER
    //   end_match_log       → ER  (commits + undelegates)
    //   settle_from_log     → base layer, after the log has landed

    /// Creates the log for a match. Base layer, either player pays.
    pub fn init_match_log(ctx: Context<InitMatchLog>, match_id: u64) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(m.id == match_id, MempireError::BadMatchState);
        require!(
            m.state == MatchState::Active as u8,
            MempireError::BadMatchState
        );
        require!(
            ctx.accounts.payer.key() == m.players[0] || ctx.accounts.payer.key() == m.players[1],
            MempireError::NotAPlayer
        );

        let log = &mut ctx.accounts.match_log;
        log.match_id = match_id;
        log.players = m.players;
        log.plays = Vec::new();
        log.last_tick = 0;
        log.last_hash = 0;
        log.checkpoints = 0;
        log.ended = false;
        log.claims = [3, 3]; // neither seat has said anything yet
        log.winner = u8::MAX;
        log.bump = ctx.bumps.match_log;
        Ok(())
    }

    /// Hands the log to the ephemeral rollup. Base layer.
    #[cfg(feature = "rollup")]
    pub fn delegate_match_log(ctx: Context<DelegateMatchLog>, match_id: u64) -> Result<()> {
        // Only a player in this match may delegate its log.
        //
        // This was permissionless, with a caller-supplied validator. That let
        // anyone delegate any log to a validator they operate — and the
        // delegated account's authority is what computes and commits its state,
        // so a hostile validator could commit an arbitrary winner. Naming a
        // validator that does not exist was just as bad in the other direction:
        // the log became permanently un-delegatable, forcing the match down the
        // timeout path.
        //
        // The account is raw AccountInfo because the delegation macro needs it
        // that way, so `players` is read by deserialising the account before it
        // leaves this program's ownership.
        {
            let info = &ctx.accounts.match_log;
            let data = info.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let log = MatchLog::try_deserialize(&mut slice)?;
            require!(
                log.players.contains(ctx.accounts.payer.key),
                MempireError::NotAPlayer
            );
        }

        // Seeds must match the account definition exactly or the delegation
        // record is derived for a different address and the ER never sees it.
        ctx.accounts.delegate_match_log(
            &ctx.accounts.payer,
            &[b"log", &match_id.to_le_bytes()],
            DelegateConfig::default(),
        )?;
        Ok(())
    }

    /// One card play. Runs on the ER at rollup latency, not base-layer latency.
    ///
    /// This is what makes the input log genuinely onchain rather than relayed by
    /// a server we happen to run: at ~10-50ms and gasless within the sponsored
    /// commit quota, a play per few seconds is affordable to write for real.
    pub fn play_card(
        ctx: Context<PlayCard>,
        tick: u32,
        deck_index: u8,
        x: i32,
        y: i32,
    ) -> Result<()> {
        let log = &mut ctx.accounts.match_log;
        require!(!log.ended, MempireError::BadMatchState);
        require!((deck_index as usize) < DECK_SIZE, MempireError::BadDeck);

        // Delegation status is routing, never authorization: the ER must enforce
        // the same player check the base layer would.
        let signer = ctx.accounts.player.key();
        let seat = if signer == log.players[0] {
            0u8
        } else if signer == log.players[1] {
            1u8
        } else {
            return err!(MempireError::NotAPlayer);
        };

        // Ticks only move forward, so a replayed or reordered play cannot
        // rewrite history that both sims have already simulated past.
        require!(tick >= log.last_tick, MempireError::StaleTick);

        /*
         * Half the log each, rather than one shared pool.
         *
         * `MAX_PLAYS` was a single budget both seats drew from, so one seat
         * could spend all 128 entries — at one tick, since the guard below is
         * non-strict — and every input the opponent made afterwards was
         * unrecordable. The two seats then necessarily disagreed at the end
         * and the pot voided, which is a strictly better outcome for whoever
         * was losing.
         */
        let mine = log
            .plays
            .iter()
            .filter(|p| p.player == seat)
            .count();
        require!(mine < MAX_PLAYS / 2, MempireError::LogFull);

        log.plays.push(PlayEntry {
            tick,
            player: seat,
            deck_index,
            x,
            y,
        });
        log.last_tick = tick;
        Ok(())
    }

    /// Records a state-hash checkpoint. ER.
    ///
    /// Stores only the latest hash and a count, not the whole stream: what
    /// settlement needs is the final hash, and a divergence is caught live by
    /// the clients comparing checkpoints as they go.
    pub fn checkpoint(ctx: Context<PlayCard>, tick: u32, hash: u64) -> Result<()> {
        let signer = ctx.accounts.player.key();
        let log = &mut ctx.accounts.match_log;
        require!(!log.ended, MempireError::BadMatchState);
        require!(
            signer == log.players[0] || signer == log.players[1],
            MempireError::NotAPlayer
        );
        require!(tick >= log.last_tick, MempireError::StaleTick);
        /*
         * Record the hash, but do not advance `last_tick`.
         *
         * `play_card` gates on that same field, and `tick` here is unbounded
         * above — so a seat that was losing could checkpoint at `u32::MAX` and
         * every subsequent play by *either* seat failed `StaleTick` for the
         * rest of the match. That converts a lost position into a forced
         * timeout, which is a payout path rather than a loss. A checkpoint's
         * job is to attest a state hash; moving the play cursor was never part
         * of it.
         */
        log.last_hash = hash;
        log.checkpoints = log.checkpoints.saturating_add(1);
        Ok(())
    }

    /// Seals the match on the ER and sends the log home. ER.
    ///
    /// `commit_and_undelegate` is deliberately used **without** a post-commit
    /// Magic Action for the payout: an action that fails can be stripped from
    /// the whole transaction strategy before the committor retries, and a
    /// payout must never depend on that. Settlement is a separate base-layer
    /// instruction that reads the committed log.
    pub fn end_match_log(ctx: Context<EndMatchLog>, winner: u8, final_hash: u64) -> Result<()> {
        require!(winner <= 2, MempireError::BadWinner);
        let seat = {
            let signer = ctx.accounts.payer.key();
            let log = &ctx.accounts.match_log;
            if signer == log.players[0] {
                0usize
            } else if signer == log.players[1] {
                1usize
            } else {
                return err!(MempireError::NotAPlayer);
            }
        };

        // This seat's claim, and only this seat's.
        //
        // It used to write `log.winner` directly, which `settle_from_log` then
        // paid out — so whoever called first took the pot, and calling first
        // required playing exactly zero cards. A result is only a result when
        // both seats say the same thing; settlement checks that, and a
        // disagreement voids and refunds rather than paying either claim.
        // One claim per seat, and `ended` cannot be the guard.
        //
        // The check used to be `!log.ended` — but the first claim *sets*
        // `ended`, so it rejected the second seat and settlement could never
        // reach the agreement it requires. What actually needs preventing is a
        // seat revising its own claim after seeing the other's, which is what
        // this checks instead.
        require!(
            ctx.accounts.match_log.claims[seat] == 3,
            MempireError::AlreadyClaimed
        );

        let both_in = {
            let log = &mut ctx.accounts.match_log;
            log.claims[seat] = winner;
            log.last_hash = final_hash;
            // `ended` means "no further plays", which is true as soon as one
            // seat has called it — the other can still record its own claim.
            log.ended = true;
            log.claims[0] != 3 && log.claims[1] != 3
        };

        // Hand the log back only once BOTH seats have spoken.
        //
        // This used to undelegate on the first claim, which made
        // `settle_from_log` — the whole point of the log — unreachable: the
        // account left the rollup before the second seat could record, so the
        // agreement it requires could never be assembled and every staked
        // match fell through to the timeout path. Committing once, when the
        // result is actually complete, is also one commit instead of two.
        //
        // If a seat never claims, the log simply stays delegated; the pot is
        // still recoverable on base layer through `claim_timeout`, which does
        // not read the log at all.
        if both_in {
            ctx.accounts.match_log.exit(&crate::ID)?;
            /*
             * Hand the sealed log back to base layer — when it ever left.
             *
             * A build without the `rollup` feature never delegates it, so there
             * is nothing to commit and undelegate: the claims were written on
             * base layer and `settle_from_log` reads them from there anyway.
             * The rollup trip speeds up the plays during a match; it is not
             * what makes settling one possible.
             */
            #[cfg(feature = "rollup")]
            {
                MagicIntentBundleBuilder::new(
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.magic_context.to_account_info(),
                    ctx.accounts.magic_program.to_account_info(),
                )
                .commit_and_undelegate(&[ctx.accounts.match_log.to_account_info()])
                .build_and_invoke()?;
            }
        }
        Ok(())
    }

    /// Pays the pot from the committed log. Base layer, **one** signer.
    ///
    /// The ER log is the onchain record of who won, which is what lets this
    /// replace the two-signature `settle`: a player whose opponent has closed
    /// their laptop can still settle honestly instead of waiting out the
    /// timeout. The log must be back from the ER (owned by this program again)
    /// and sealed, so a match still in the rollup cannot be cashed early.
    pub fn settle_from_log<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleFromLog<'info>>,
    ) -> Result<()> {
        let (winner, final_hash) = {
            let log = &ctx.accounts.match_log;
            let m = &ctx.accounts.match_account;
            require!(log.match_id == m.id, MempireError::BadMatchState);
            require!(log.ended, MempireError::MatchNotEnded);
            require!(
                m.state == MatchState::Active as u8,
                MempireError::BadMatchState
            );
            require!(
                ctx.accounts.player_a.key() == m.players[0]
                    && ctx.accounts.player_b.key() == m.players[1],
                MempireError::NotAPlayer
            );
            // Both seats must have spoken, and must agree.
            //
            // Disagreement is not settled for either side: one of them is
            // lying and the program cannot tell which, so the honest outcome
            // is the one the whole design already uses for a desync — void,
            // and both stakes go home. A cheater can therefore turn a loss
            // into a refund, which is griefing; they cannot turn it into a
            // win, which is theft. Closing the griefing gap needs the log's
            // plays verified onchain and is recorded in AUDIT.md as open.
            require!(
                log.claims[0] != 3 && log.claims[1] != 3,
                MempireError::MatchNotEnded
            );
            require!(
                log.claims[0] <= 2 && log.claims[1] <= 2,
                MempireError::BadWinner
            );
            require!(
                log.claims[0] == log.claims[1],
                MempireError::ResultDisputed
            );
            (log.claims[0], log.last_hash)
        };

        let pot = ctx.accounts.match_account.stake_lamports * 2;
        let (rake_bps, tie) = if winner == 2 {
            (ctx.accounts.config.tie_rake_bps, true)
        } else {
            (ctx.accounts.config.rake_bps, false)
        };
        let rake = (pot as u128 * rake_bps as u128 / 10_000) as u64;
        let payout = pot - rake;

        let m_info = ctx.accounts.match_account.to_account_info();
        **m_info.try_borrow_mut_lamports()? -= rake;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += rake;
        if tie {
            let half = payout / 2;
            **m_info.try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player_a.try_borrow_mut_lamports()? += half;
            **ctx.accounts.player_b.try_borrow_mut_lamports()? += payout - half;
        } else {
            let to = if winner == 0 {
                ctx.accounts.player_a.to_account_info()
            } else {
                ctx.accounts.player_b.to_account_info()
            };
            **m_info.try_borrow_mut_lamports()? -= payout;
            **to.try_borrow_mut_lamports()? += payout;
        }

        /*
         * The winner's $MEMPIRE, paid from a vault the program controls.
         *
         * Optional on purpose, and for the same reason the chest rail is: a
         * reward account that is missing must never be able to strand a pot.
         * An empty vault, a winner with no token account, a client that does
         * not know about the reward yet — each of those skips the payout and
         * settles the SOL exactly as before.
         *
         * Un-farmable by construction. It pays only on a settled match, which
         * means two seats escrowed real SOL, played, and agreed on the result.
         * Nobody can mint themselves an income here without first risking the
         * pot against a real opponent.
         */
        if !tie && WIN_REWARD > 0 {
            if let (Some(vault), Some(dest), Some(token_program)) = (
                ctx.accounts.reward_vault.as_ref(),
                ctx.accounts.winner_tokens.as_ref(),
                ctx.accounts.token_program.as_ref(),
            ) {
                let expected = ctx.accounts.match_account.players[winner as usize];
                let amount = WIN_REWARD.min(vault.amount);
                if amount > 0 && dest.owner == expected && dest.mint == MEMPIRE_MINT {
                    let bump = ctx.bumps.reward_authority;
                    let seeds: &[&[u8]] = &[b"rewards", &[bump]];
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.to_account_info(),
                            Transfer {
                                from: vault.to_account_info(),
                                to: dest.to_account_info(),
                                authority: ctx.accounts.reward_authority.to_account_info(),
                            },
                            &[seeds],
                        ),
                        amount,
                    )?;
                    emit!(WinRewardPaid { to: expected, amount });
                }
            }
        }

        unlock_deck(ctx.remaining_accounts, &ctx.accounts.match_account.key())?;

        let m = &mut ctx.accounts.match_account;
        m.state = MatchState::Settled as u8;
        m.winner = winner;
        m.final_hash = final_hash;
        emit!(MatchSettled {
            match_id: m.id,
            winner,
            final_hash,
            rake
        });
        Ok(())
    }
}

/// Deck validation over remaining_accounts: 8 Card PDAs, owned by `player`,
/// distinct coins, not already locked. Locks each card and returns the
/// summed power (levels) plus a commitment to the exact deck that was locked.
///
/// # Why the hash is derived here and not accepted from the caller
///
/// `deck_hash` used to be an instruction argument, written verbatim and read
/// by nothing — so the only thing tying a match to the cards it locked was the
/// summed `power`. That let a player lock eight freshly minted level-1 cards
/// (power 8, cheap), pass the power bracket against any level-1 opponent, and
/// then hand the simulation a deck of eight level-10 cards over the relay.
/// Both clients hashed the same fabricated deck, so no desync fired, and the
/// staked match was won with a deck nobody ever staked for.
///
/// Derived from `(coin_mint, level)` in the order the cards were passed, which
/// is the order the client builds its own deck in — so a client can hash its
/// opponent's relayed deck and compare against the chain before agreeing to
/// play.
fn validate_and_lock_deck<'a>(
    accounts: &'a [AccountInfo<'a>],
    player: &Pubkey,
    match_key: &Pubkey,
) -> Result<(u32, [u8; 32])> {
    require!(accounts.len() == DECK_SIZE, MempireError::BadDeck);
    let mut mints: Vec<Pubkey> = Vec::with_capacity(DECK_SIZE);
    let mut power: u32 = 0;
    let mut preimage: Vec<u8> = Vec::with_capacity(DECK_SIZE * 33);
    for acc in accounts {
        let mut card: Account<Card> = Account::try_from(acc)?;
        require!(card.owner == *player, MempireError::NotCardOwner);
        require!(!card.is_locked(), MempireError::CardLocked);
        require!(
            !mints.contains(&card.coin_mint),
            MempireError::DuplicateCoin
        );
        mints.push(card.coin_mint);
        power += card.level as u32;
        preimage.extend_from_slice(card.coin_mint.as_ref());
        preimage.push(card.level);
        card.locked_by = *match_key;
        card.exit(&crate::ID)?;
    }
    Ok((power, solana_sha256_hasher::hash(&preimage).to_bytes()))
}

/// Release the decks this match locked — and only those.
///
/// The skip is deliberate rather than an error: settlement passes both decks
/// as remaining accounts, and a caller can put anything in that list. A card
/// locked into another live match, or a card that is not this match's, is
/// left exactly as it was. Failing the whole instruction instead would let
/// anyone append one foreign account and block a legitimate settlement.
fn unlock_deck<'a>(accounts: &'a [AccountInfo<'a>], match_key: &Pubkey) -> Result<()> {
    for acc in accounts {
        if let Ok(mut card) = Account::<Card>::try_from(acc) {
            if card.locked_by != *match_key {
                continue;
            }
            card.locked_by = Pubkey::default();
            card.exit(&crate::ID)?;
        }
    }
    Ok(())
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub mint_fee_lamports: u64,
    pub rake_bps: u16,
    pub tie_rake_bps: u16,
    pub unstake_fee_bps: u16,
    pub unstake_cooldown_secs: i64,
    pub match_timeout_secs: i64,
    pub min_age_secs: i64,
    pub power_band: u32,
    pub next_card_id: u64,
    pub next_match_id: u64,
    pub bump: u8,
}
impl Config {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 2 + 2 + 2 + 8 + 8 + 8 + 4 + 8 + 8 + 1;
}

#[account]
pub struct CoinInfo {
    pub mint: Pubkey,
    pub liquidity_usd: u64,
    pub price_micro_usd: u64,
    pub first_seen_ts: i64,
    pub decimals: u8,
    pub bump: u8,
}
impl CoinInfo {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct Card {
    pub id: u64,
    pub owner: Pubkey,
    pub coin_mint: Pubkey,
    pub archetype: u8,
    pub staked_tokens: u64,
    pub staked_micro_usd: u64,
    pub level: u8,
    pub pending_unstake_tokens: u64,
    pub unstake_ready_at: i64,
    /// The match this card is locked into, or the default key when free.
    ///
    /// This used to be a bare `in_match: bool`, and a bool cannot answer the
    /// question `unlock_deck` actually has to ask. Settlement takes the deck
    /// as remaining accounts, so with only a flag it would clear the lock on
    /// any account that happened to deserialise as a `Card` — including a
    /// card locked into a *different, still-running* match. A player could
    /// settle one match and free their heavy deck out of another, which is
    /// the power bracket bypassed. Naming the match makes the check possible.
    pub locked_by: Pubkey,
    pub bump: u8,
}
impl Card {
    pub const SIZE: usize = 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 8 + 8 + 32 + 1;

    /// Locked into some match. Kept as a method so no caller has to remember
    /// that "free" is spelled `Pubkey::default()`.
    pub fn is_locked(&self) -> bool {
        self.locked_by != Pubkey::default()
    }
}

#[derive(Clone, Copy)]
pub enum MatchState {
    Open = 0,
    Active = 1,
    Settled = 2,
}

#[account]
pub struct MatchAccount {
    pub id: u64,
    pub tier: u8,
    pub stake_lamports: u64,
    pub players: [Pubkey; 2],
    pub deck_hash: [[u8; 32]; 2],
    pub power: [u32; 2],
    pub state: u8,
    pub created_at: i64,
    pub deadline: i64,
    pub winner: u8,
    pub final_hash: u64,
    pub bump: u8,
}
impl MatchAccount {
    pub const SIZE: usize = 8 + 8 + 1 + 8 + 64 + 64 + 8 + 1 + 8 + 8 + 1 + 8 + 1;
}

/// A single card play. 14 bytes, appended on the ER.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PlayEntry {
    pub tick: u32,
    pub player: u8,
    pub deck_index: u8,
    pub x: i32,
    pub y: i32,
}
impl PlayEntry {
    pub const SIZE: usize = 4 + 1 + 1 + 4 + 4;
}

/// Generous for a 3-minute match plus overtime at ~1 play/2s per player.
/// Fixed at creation because a delegated account must not resize on the ER.
pub const MAX_PLAYS: usize = 128;

/// The delegated half of a match.
///
/// Holds the input log and the newest state-hash checkpoint, and **no lamports**.
/// That separation is the whole safety argument for putting a wagered match on a
/// rollup: the money never leaves base layer, so an ER that stalls costs latency,
/// not the pot.
#[account]
pub struct MatchLog {
    pub match_id: u64,
    pub players: [Pubkey; 2],
    pub plays: Vec<PlayEntry>,
    pub last_tick: u32,
    pub last_hash: u64,
    pub checkpoints: u16,
    pub ended: bool,
    pub winner: u8,
    /// What each seat says the result was. 3 = has not said.
    ///
    /// A single seat used to be able to set `winner` outright, and
    /// `settle_from_log` paid it verbatim — so the first player to call
    /// `end_match_log` took the pot without a card being played. Both seats
    /// now record their own claim and settlement requires them to agree.
    pub claims: [u8; 2],
    pub bump: u8,
}
impl MatchLog {
    // discriminator + match_id + players + Vec len prefix + entries
    //   + last_tick + last_hash + checkpoints + ended + winner + claims + bump
    pub const SIZE: usize =
        8 + 8 + 64 + 4 + (MAX_PLAYS * PlayEntry::SIZE) + 4 + 8 + 2 + 1 + 1 + 2 + 1;
}

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = Config::SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: fee destination chosen by the admin
    pub treasury: UncheckedAccount<'info>,

    /// The program's own account and its ProgramData, used to prove the
    /// signer is the upgrade authority.
    ///
    /// `config` is a fixed PDA with no init constraint beyond being unwritten,
    /// so whoever called this first owned the rake, the fees and the prices
    /// permanently — and a deployment is public the moment the transaction
    /// lands. Anchor's `constraint` on `program.programdata_address()?` is the
    /// standard way to say "only whoever can upgrade this program".
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MempireError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Mempire>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ MempireError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterCoin<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = CoinInfo::SIZE,
        seeds = [b"coin", mint.key().as_ref()],
        bump
    )]
    pub coin_info: Account<'info, CoinInfo>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    /// CHECK: any address the admin nominates; it only ever receives lamports.
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"coin", coin_info.mint.as_ref()], bump = coin_info.bump)]
    pub coin_info: Account<'info, CoinInfo>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintCard<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"coin", coin_info.mint.as_ref()], bump = coin_info.bump)]
    pub coin_info: Account<'info, CoinInfo>,
    #[account(
        init,
        payer = owner,
        space = Card::SIZE,
        seeds = [b"card", config.next_card_id.to_le_bytes().as_ref()],
        bump
    )]
    pub card: Account<'info, Card>,
    /// Optional, and no longer checked for a balance.
    ///
    /// A player who does not hold the coin has no associated token account for
    /// it at all, so leaving this required would make the transaction
    /// unbuildable for exactly the people minting is now open to — the account
    /// does not exist to pass. Kept as an option rather than deleted so a
    /// client that still sends it is not broken by the change, and the mint
    /// and owner constraints still hold for anyone who does.
    #[account(
        constraint = owner_tokens.mint == coin_info.mint,
        constraint = owner_tokens.owner == owner.key(),
    )]
    pub owner_tokens: Option<Account<'info, TokenAccount>>,

    /*
     * Paying in $MEMPIRE instead of SOL. All three are optional and are only
     * supplied together; naming them waives the lamport fee and takes
     * `MINT_FEE_MEMPIRE` from the payer instead.
     */
    #[account(
        mut,
        constraint = owner_mempire.mint == MEMPIRE_MINT @ MempireError::WrongTreasury,
        constraint = owner_mempire.owner == owner.key() @ MempireError::NotCardOwner,
    )]
    pub owner_mempire: Option<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury_mempire.mint == MEMPIRE_MINT @ MempireError::WrongTreasury,
        constraint = treasury_mempire.owner == config.treasury @ MempireError::WrongTreasury,
    )]
    pub treasury_mempire: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "nft")]
#[derive(Accounts)]
pub struct TokenizeCard<'info> {
    /// Only read, for `treasury` — the royalty recipient. Carried here rather
    /// than hardcoded so that changing the treasury changes where royalties
    /// land, instead of silently leaving them addressed to an old wallet.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [b"card", card.id.to_le_bytes().as_ref()],
        bump = card.bump,
        has_one = owner @ MempireError::NotCardOwner,
    )]
    pub card: Account<'info, Card>,

    /// The 1-of-1. Zero decimals so the supply cannot be fractional, and
    /// derived from the card id so a card can be tokenised exactly once —
    /// `init` fails the second time rather than minting a rival copy.
    #[account(
        init,
        payer = owner,
        seeds = [b"nftmint", card.id.to_le_bytes().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
    )]
    pub nft_mint: Account<'info, Mint>,

    /// CHECK: PDA that signs the mint and the metadata write. Never holds data.
    #[account(seeds = [b"nft", card.id.to_le_bytes().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = nft_mint,
        associated_token::authority = owner,
    )]
    pub owner_nft: Account<'info, TokenAccount>,

    /// CHECK: validated by the token metadata program, which owns this PDA.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpgradeCard<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// The card that survives and gains the level.
    #[account(
        mut,
        seeds = [b"card", card.id.to_le_bytes().as_ref()],
        bump = card.bump,
        has_one = owner @ MempireError::NotCardOwner,
    )]
    pub card: Account<'info, Card>,

    /// The duplicate, closed into the owner. Its rent comes back, so a merge
    /// costs the $MEMPIRE fee and nothing else.
    #[account(
        mut,
        seeds = [b"card", duplicate.id.to_le_bytes().as_ref()],
        bump = duplicate.bump,
        has_one = owner @ MempireError::NotCardOwner,
        close = owner,
    )]
    pub duplicate: Account<'info, Card>,

    #[account(
        mut,
        constraint = owner_mempire.mint == MEMPIRE_MINT @ MempireError::WrongTreasury,
        constraint = owner_mempire.owner == owner.key() @ MempireError::NotCardOwner,
    )]
    pub owner_mempire: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_mempire.mint == MEMPIRE_MINT @ MempireError::WrongTreasury,
        constraint = treasury_mempire.owner == config.treasury @ MempireError::WrongTreasury,
    )]
    pub treasury_mempire: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}




#[derive(Accounts)]
pub struct CreateMatch<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = player,
        space = MatchAccount::SIZE,
        seeds = [b"match", config.next_match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateCard<'info> {
    /// CHECK: untyped on purpose — the whole point is that this account does
    /// not deserialise as a `Card` yet. Ownership is verified by reading the
    /// owner field out of the raw bytes.
    #[account(mut, owner = crate::ID)]
    pub card: AccountInfo<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseCards<'info> {
    #[account(
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    /// Anyone may pay for this; the match being settled is the whole authority.
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelMatch<'info> {
    #[account(
        mut,
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut)]
    pub player_a: Signer<'info>,
    #[account(mut)]
    pub player_b: Signer<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    pub claimer: Signer<'info>,
    /// CHECK: must be one of the match players (asserted in handler)
    #[account(mut)]
    pub winner_account: UncheckedAccount<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: validated against match_account.players[0]
    #[account(mut, address = match_account.players[0])]
    pub player_a: UncheckedAccount<'info>,
    /// CHECK: validated against match_account.players[1]
    #[account(mut, address = match_account.players[1])]
    pub player_b: UncheckedAccount<'info>,
    /// CHECK: this match's log PDA, pinned by seeds so a caller cannot pass a
    /// different account — or a blank one — to hide a disagreement. It may be
    /// genuinely uninitialised (no log was ever created) or still delegated,
    /// and the handler distinguishes those from a real dispute by ownership.
    #[account(
        seeds = [b"log", match_account.id.to_le_bytes().as_ref()],
        bump,
    )]
    pub match_log: UncheckedAccount<'info>,
}

// ── Ephemeral Rollup contexts ────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct InitMatchLog<'info> {
    #[account(
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        init,
        payer = payer,
        space = MatchLog::SIZE,
        seeds = [b"log", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_log: Account<'info, MatchLog>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `#[delegate]` injects the delegation accounts. The target must be a raw
/// `AccountInfo` with the `del` constraint — an `Account<>` here fails because
/// delegation hands ownership to the delegation program.
#[cfg(feature = "rollup")]
#[delegate]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DelegateMatchLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the log PDA being delegated; seeds are re-checked in the handler.
    #[account(mut, del, seeds = [b"log", match_id.to_le_bytes().as_ref()], bump)]
    pub match_log: AccountInfo<'info>,
}

/// Shared by `play_card` and `checkpoint`. Runs on the ER, where the log is
/// owned by this program again and normal Anchor constraints apply.
#[derive(Accounts)]
pub struct PlayCard<'info> {
    #[account(
        mut,
        seeds = [b"log", match_log.match_id.to_le_bytes().as_ref()],
        bump = match_log.bump,
    )]
    pub match_log: Account<'info, MatchLog>,
    pub player: Signer<'info>,
}

/// `#[commit]` injects `magic_context` and `magic_program`.
#[cfg(feature = "rollup")]
#[commit]
#[derive(Accounts)]
pub struct EndMatchLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"log", match_log.match_id.to_le_bytes().as_ref()],
        bump = match_log.bump,
    )]
    pub match_log: Account<'info, MatchLog>,
}

/// The same instruction without a rollup to hand the log back to.
///
/// A lean build never delegates the log, so there is no commit to schedule and
/// the two magic accounts `#[commit]` injects would be dead required accounts
/// a caller has to invent. The seats' claims are written here on base layer,
/// which is where `settle_from_log` reads them from anyway.
#[cfg(not(feature = "rollup"))]
#[derive(Accounts)]
pub struct EndMatchLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"log", match_log.match_id.to_le_bytes().as_ref()],
        bump = match_log.bump,
    )]
    pub match_log: Account<'info, MatchLog>,
}

#[derive(Accounts)]
pub struct SettleFromLog<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"match", match_account.id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    /// Readable as `Account<MatchLog>` only once the ER has committed and
    /// undelegated it — while delegated it is owned by the delegation program,
    /// so this constraint is itself the "log is home" check.
    #[account(
        seeds = [b"log", match_log.match_id.to_le_bytes().as_ref()],
        bump = match_log.bump,
    )]
    pub match_log: Account<'info, MatchLog>,
    /*
     * Either *player* may settle — and only a player.
     *
     * This said so in a comment and enforced nothing, while the three reward
     * accounts below are optional and a mismatch on them is skipped rather
     * than raised. Any stranger could therefore settle a finished match with
     * the reward omitted: the pot paid out correctly, the state became
     * `Settled`, and the winner's `WIN_REWARD` became unpayable, because every
     * settlement path requires `Active`. One transaction to grief, nothing to
     * gain, and no way back for the winner.
     */
    #[account(
        constraint = settler.key() == match_account.players[0]
            || settler.key() == match_account.players[1]
            @ MempireError::NotAPlayer,
    )]
    pub settler: Signer<'info>,
    /// CHECK: validated against match_account.players[0]
    #[account(mut, address = match_account.players[0])]
    pub player_a: UncheckedAccount<'info>,
    /// CHECK: validated against match_account.players[1]
    #[account(mut, address = match_account.players[1])]
    pub player_b: UncheckedAccount<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: PDA that owns the reward vault; signs the transfer out of it.
    #[account(seeds = [b"rewards"], bump)]
    pub reward_authority: UncheckedAccount<'info>,
    /// The $MEMPIRE the program can pay out. Optional so a settlement never
    /// depends on a reward account existing — see the payout in the handler.
    #[account(mut, constraint = reward_vault.mint == MEMPIRE_MINT)]
    pub reward_vault: Option<Account<'info, TokenAccount>>,
    /// The winner's $MEMPIRE account. Owner and mint are checked in the
    /// handler against the seat the log actually says won.
    #[account(mut)]
    pub winner_tokens: Option<Account<'info, TokenAccount>>,
    pub token_program: Option<Program<'info, Token>>,
}

// ── Events & errors ──────────────────────────────────────────────────────────

#[event]
pub struct CardTokenized {
    pub card: Pubkey,
    pub owner: Pubkey,
    pub nft_mint: Pubkey,
}

#[event]
pub struct CardUpgraded {
    pub card: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub level: u8,
    /// The duplicate that was consumed.
    pub burned: Pubkey,
    /// Base units of $MEMPIRE paid to the treasury.
    pub paid: u64,
}

#[event]
pub struct CardMinted {
    pub card: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub archetype: u8,
}

#[event]
pub struct Staked {
    pub card: Pubkey,
    pub amount_tokens: u64,
    pub staked_micro_usd: u64,
    pub level: u8,
}

#[event]
pub struct MatchCreated {
    pub match_id: u64,
    pub tier: u8,
    pub stake_lamports: u64,
}

#[event]
pub struct WinRewardPaid {
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MatchSettled {
    pub match_id: u64,
    pub winner: u8,
    pub final_hash: u64,
    pub rake: u64,
}

#[event]
pub struct CardsReleased {
    pub match_id: u64,
    pub freed: u32,
}

#[event]
pub struct TreasuryChanged {
    pub previous: Pubkey,
    pub next: Pubkey,
}

#[event]
pub struct MatchCancelled {
    pub match_id: u64,
    pub player: Pubkey,
    pub refunded: u64,
}

#[error_code]
pub enum MempireError {
    #[msg("the two players reported different winners; the match voids")]
    ResultDisputed,
    #[msg("fee exceeds allowed maximum")]
    FeeTooHigh,
    #[msg("coin does not meet the liquidity floor")]
    CoinNotEligible,
    #[msg("coin is younger than the minimum age")]
    CoinTooYoung,
    #[msg("wallet holds none of this coin")]
    NoHoldings,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("card is locked in a match or cooldown")]
    CardLocked,
    #[msg("a card cannot be merged into itself")]
    SameCard,
    #[msg("both cards must be the same coin")]
    DifferentCoins,
    #[msg("card is already at the maximum level")]
    MaxLevel,
    #[msg("config value is outside the sane range")]
    BadConfig,
    #[msg("stake does not match a real tier")]
    BadStake,
    #[msg("ticker is too long")]
    TickerTooLong,
    #[msg("an unstake is already pending")]
    UnstakePending,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("unstake cooldown still active")]
    CooldownActive,
    #[msg("deck must be exactly 8 owned, unlocked cards")]
    BadDeck,
    #[msg("card not owned by player")]
    NotCardOwner,
    #[msg("deck may contain each coin only once")]
    DuplicateCoin,
    #[msg("match is not in the required state")]
    BadMatchState,
    #[msg("cannot battle yourself")]
    SelfMatch,
    #[msg("deck power outside the tier band")]
    PowerMismatch,
    #[msg("invalid winner value")]
    BadWinner,
    #[msg("signer is not a match player")]
    NotAPlayer,
    #[msg("deadline has not passed")]
    TooEarly,
    #[msg("input log is full")]
    LogFull,
    #[msg("tick is older than the last recorded tick")]
    StaleTick,
    #[msg("match has not ended on the rollup yet")]
    MatchNotEnded,
    #[msg("fee account is not the treasury named in config")]
    WrongTreasury,
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("card account is not a recognised layout")]
    BadCardLayout,
    #[msg("this seat has already recorded its result")]
    AlreadyClaimed,
    #[msg("the treasury is already that address")]
    TreasuryUnchanged,
}
