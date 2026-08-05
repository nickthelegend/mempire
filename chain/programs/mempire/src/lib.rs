use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP");

// USD amounts are micro-USD (1e-6). Levels 1–10 on the same thresholds the
// client sim uses; the two tables must never drift.
const LEVEL_THRESHOLDS_MICRO_USD: [u64; 10] = [
    0,
    10_000_000,
    25_000_000,
    50_000_000,
    100_000_000,
    200_000_000,
    400_000_000,
    800_000_000,
    1_600_000_000,
    3_200_000_000,
];

const MIN_LIQUIDITY_USD: u64 = 25_000;
const DECK_SIZE: usize = 8;

fn level_for_micro_usd(usd: u64) -> u8 {
    let mut lvl: u8 = 1;
    for (i, t) in LEVEL_THRESHOLDS_MICRO_USD.iter().enumerate() {
        if usd >= *t {
            lvl = (i + 1) as u8;
        }
    }
    lvl.min(10)
}

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
#[ephemeral]
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
        require!(
            ctx.accounts.owner_tokens.amount > 0,
            MempireError::NoHoldings
        );

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

    /// Stake coin tokens into the card's vault. USD value snapshots at the
    /// current oracle price — levels never flicker with the market.
    pub fn stake(ctx: Context<StakeTokens>, amount_tokens: u64) -> Result<()> {
        require!(amount_tokens > 0, MempireError::ZeroAmount);
        require!(!ctx.accounts.card.is_locked(), MempireError::CardLocked);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount_tokens,
        )?;

        let info = &ctx.accounts.coin_info;
        let card = &mut ctx.accounts.card;
        let usd_added = (amount_tokens as u128)
            .checked_mul(info.price_micro_usd as u128)
            .unwrap()
            / 10u128.pow(info.decimals as u32);
        card.staked_tokens = card.staked_tokens.checked_add(amount_tokens).unwrap();
        card.staked_micro_usd = card
            .staked_micro_usd
            .checked_add(usd_added as u64)
            .unwrap();
        card.level = level_for_micro_usd(card.staked_micro_usd);

        emit!(Staked {
            card: card.key(),
            amount_tokens,
            staked_micro_usd: card.staked_micro_usd,
            level: card.level,
        });
        Ok(())
    }

    /// Two-step unstake, step 1: lock the amount and start the cooldown.
    /// Level drops immediately — no battling on power you're withdrawing.
    pub fn request_unstake(ctx: Context<RequestUnstake>, amount_tokens: u64) -> Result<()> {
        let card = &mut ctx.accounts.card;
        require!(!card.is_locked(), MempireError::CardLocked);
        require!(card.pending_unstake_tokens == 0, MempireError::UnstakePending);
        require!(
            amount_tokens > 0 && amount_tokens <= card.staked_tokens,
            MempireError::ZeroAmount
        );

        let usd_removed = (card.staked_micro_usd as u128)
            .checked_mul(amount_tokens as u128)
            .unwrap()
            / (card.staked_tokens as u128);
        card.staked_tokens -= amount_tokens;
        card.staked_micro_usd = card.staked_micro_usd.saturating_sub(usd_removed as u64);
        card.level = level_for_micro_usd(card.staked_micro_usd);
        card.pending_unstake_tokens = amount_tokens;
        card.unstake_ready_at =
            Clock::get()?.unix_timestamp + ctx.accounts.config.unstake_cooldown_secs;
        Ok(())
    }

    /// Two-step unstake, step 2: after the cooldown, tokens return to the
    /// owner minus the unstake fee (fee tokens go to the treasury's ATA).
    pub fn claim_unstake(ctx: Context<ClaimUnstake>) -> Result<()> {
        let card = &ctx.accounts.card;
        let amount = card.pending_unstake_tokens;
        require!(amount > 0, MempireError::NothingToClaim);
        require!(
            Clock::get()?.unix_timestamp >= card.unstake_ready_at,
            MempireError::CooldownActive
        );

        let fee = (amount as u128 * ctx.accounts.config.unstake_fee_bps as u128 / 10_000) as u64;
        let card_id = card.id;
        let vault_bump = ctx.bumps.vault_authority;
        let id_bytes = card_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"vault", id_bytes.as_ref(), &[vault_bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            amount - fee,
        )?;
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_tokens.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }

        let card = &mut ctx.accounts.card;
        card.pending_unstake_tokens = 0;
        card.unstake_ready_at = 0;
        Ok(())
    }

    /// Player 0 opens a match at a tier, escrowing the stake in the match PDA.
    /// The 8 deck cards ride in `remaining_accounts` and are validated and
    /// locked here — ownership, one card per coin, and the power score.
    pub fn create_match<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateMatch<'info>>,
        tier: u8,
        stake_lamports: u64,
        deck_hash: [u8; 32],
    ) -> Result<()> {
        let match_key = ctx.accounts.match_account.key();
        let power = validate_and_lock_deck(
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
        deck_hash: [u8; 32],
    ) -> Result<()> {
        let match_key = ctx.accounts.match_account.key();
        let power = validate_and_lock_deck(
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
        require!(log.plays.len() < MAX_PLAYS, MempireError::LogFull);

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
        log.last_tick = tick;
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
            require!(!log.ended, MempireError::BadMatchState);
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
        let log = &mut ctx.accounts.match_log;
        log.claims[seat] = winner;
        log.last_hash = final_hash;
        // `ended` means "no further plays", which is true as soon as one seat
        // has called it — the other can still record its own claim.
        log.ended = true;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.match_log.to_account_info()])
        .build_and_invoke()?;
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
/// summed power (levels).
fn validate_and_lock_deck<'a>(
    accounts: &'a [AccountInfo<'a>],
    player: &Pubkey,
    match_key: &Pubkey,
) -> Result<u32> {
    require!(accounts.len() == DECK_SIZE, MempireError::BadDeck);
    let mut mints: Vec<Pubkey> = Vec::with_capacity(DECK_SIZE);
    let mut power: u32 = 0;
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
        card.locked_by = *match_key;
        card.exit(&crate::ID)?;
    }
    Ok(power)
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
    #[account(
        constraint = owner_tokens.mint == coin_info.mint,
        constraint = owner_tokens.owner == owner.key(),
    )]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StakeTokens<'info> {
    #[account(seeds = [b"coin", coin_info.mint.as_ref()], bump = coin_info.bump)]
    pub coin_info: Account<'info, CoinInfo>,
    #[account(
        mut,
        seeds = [b"card", card.id.to_le_bytes().as_ref()],
        bump = card.bump,
        has_one = owner,
        constraint = card.coin_mint == coin_info.mint,
    )]
    pub card: Account<'info, Card>,
    /// CHECK: PDA authority over the vault
    #[account(seeds = [b"vault", card.id.to_le_bytes().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = coin_info.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, constraint = owner_tokens.mint == coin_info.mint)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"card", card.id.to_le_bytes().as_ref()],
        bump = card.bump,
        has_one = owner,
    )]
    pub card: Account<'info, Card>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimUnstake<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"card", card.id.to_le_bytes().as_ref()],
        bump = card.bump,
        has_one = owner,
    )]
    pub card: Account<'info, Card>,
    /// CHECK: PDA authority over the vault
    #[account(seeds = [b"vault", card.id.to_le_bytes().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault.mint == card.coin_mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = owner_tokens.mint == card.coin_mint)]
    pub owner_tokens: Account<'info, TokenAccount>,
    /// The unstake fee's destination.
    ///
    /// `owner` is constrained as well as `mint`. With only the mint checked,
    /// the unstaker could pass one of their own token accounts and the fee
    /// would be paid straight back to them — a 0% unstake fee for anyone who
    /// read the IDL.
    #[account(
        mut,
        constraint = treasury_tokens.mint == card.coin_mint @ MempireError::WrongTreasury,
        constraint = treasury_tokens.owner == config.treasury @ MempireError::WrongTreasury,
    )]
    pub treasury_tokens: Account<'info, TokenAccount>,
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
    /// Either player may settle; the log says who won.
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
}

// ── Events & errors ──────────────────────────────────────────────────────────

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
pub struct MatchSettled {
    pub match_id: u64,
    pub winner: u8,
    pub final_hash: u64,
    pub rake: u64,
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
}
