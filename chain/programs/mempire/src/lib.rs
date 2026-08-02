use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

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
        card.in_match = false;
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

    /// Stake coin tokens into the card's vault. USD value snapshots at the
    /// current oracle price — levels never flicker with the market.
    pub fn stake(ctx: Context<StakeTokens>, amount_tokens: u64) -> Result<()> {
        require!(amount_tokens > 0, MempireError::ZeroAmount);
        require!(!ctx.accounts.card.in_match, MempireError::CardLocked);

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
        require!(!card.in_match, MempireError::CardLocked);
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
        let power = validate_and_lock_deck(ctx.remaining_accounts, &ctx.accounts.player.key())?;

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
        let power = validate_and_lock_deck(ctx.remaining_accounts, &ctx.accounts.player.key())?;

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

        unlock_deck(ctx.remaining_accounts)?;

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
            let is_player = ctx.accounts.claimer.key() == m.players[0]
                || ctx.accounts.claimer.key() == m.players[1];
            let grace_passed = now >= m.deadline + 60;
            require!(is_player || grace_passed, MempireError::NotAPlayer);
            require!(
                ctx.accounts.winner_account.key() == m.players[0]
                    || ctx.accounts.winner_account.key() == m.players[1],
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

        unlock_deck(ctx.remaining_accounts)?;

        let m = &mut ctx.accounts.match_account;
        m.state = MatchState::Settled as u8;
        m.winner = if ctx.accounts.winner_account.key() == m.players[0] {
            0
        } else {
            1
        };
        Ok(())
    }
}

/// Deck validation over remaining_accounts: 8 Card PDAs, owned by `player`,
/// distinct coins, not already locked. Locks each card and returns the
/// summed power (levels).
fn validate_and_lock_deck<'a>(
    accounts: &'a [AccountInfo<'a>],
    player: &Pubkey,
) -> Result<u32> {
    require!(accounts.len() == DECK_SIZE, MempireError::BadDeck);
    let mut mints: Vec<Pubkey> = Vec::with_capacity(DECK_SIZE);
    let mut power: u32 = 0;
    for acc in accounts {
        let mut card: Account<Card> = Account::try_from(acc)?;
        require!(card.owner == *player, MempireError::NotCardOwner);
        require!(!card.in_match, MempireError::CardLocked);
        require!(
            !mints.contains(&card.coin_mint),
            MempireError::DuplicateCoin
        );
        mints.push(card.coin_mint);
        power += card.level as u32;
        card.in_match = true;
        card.exit(&crate::ID)?;
    }
    Ok(power)
}

fn unlock_deck<'a>(accounts: &'a [AccountInfo<'a>]) -> Result<()> {
    for acc in accounts {
        if let Ok(mut card) = Account::<Card>::try_from(acc) {
            card.in_match = false;
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
    pub in_match: bool,
    pub bump: u8,
}
impl Card {
    pub const SIZE: usize = 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 8 + 8 + 1 + 1;
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

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = Config::SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: fee destination chosen by the admin
    pub treasury: UncheckedAccount<'info>,
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
    #[account(mut, constraint = treasury_tokens.mint == card.coin_mint)]
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

#[error_code]
pub enum MempireError {
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
}
