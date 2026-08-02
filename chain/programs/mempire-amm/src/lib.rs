//! Mempire's AMM: a constant-product pool for **$MEMPIRE / USDC**.
//!
//! # Real, in the ways that matter
//!
//! The reserves are two genuine SPL token accounts owned by the pool PDA. A
//! swap moves tokens with a real `token::transfer` CPI in both directions —
//! there is no ledger of pretend balances anywhere in this program. LP shares
//! are a real SPL mint whose authority is the pool, so a liquidity provider
//! holds a transferable token rather than a row in a table.
//!
//! The quote asset is **USDC itself**, not a stand-in: the mint is supplied at
//! pool creation and the deploy config points at Circle's real mint on each
//! cluster. Nothing here creates a token called "USDC".
//!
//! # Why USDC rather than SOL
//!
//! A $MEMPIRE/SOL pool prices the token in something that moves on its own, so
//! a holder cannot tell a change in $MEMPIRE from a change in SOL. Against a
//! dollar stablecoin the price means what a price is supposed to mean.
//!
//! # Layers
//!
//! | instruction        | layer |
//! |--------------------|-------|
//! | `init_pool`        | base  |
//! | `add_liquidity`    | base  |
//! | `remove_liquidity` | base  |
//! | `swap`             | base **or** ER — see below |
//! | `delegate_pool`    | base  |
//! | `seal_pool`        | ER    |
//! | `commit_pool`      | ER    |
//!
//! `swap` is layer-agnostic on purpose. Once the pool and the trader's token
//! accounts are delegated, a delegated SPL balance materialises on the rollup as
//! an ordinary token account at its canonical address, so the same plain SPL CPI
//! executes there. The instruction does not know or care which layer it is on;
//! that is the property that makes an ER swap a real swap rather than a promise
//! to settle one later.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub mod math;
use math::{
    liquidity_for_deposit, swap_output, withdraw_amounts, MathError, FEE_BPS, MINIMUM_LIQUIDITY,
};

declare_id!("7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP");

#[ephemeral]
#[program]
pub mod mempire_amm {
    use super::*;

    /// Base layer. Opens the pool and its two real vaults.
    ///
    /// The pool PDA is derived from both mints, so a given pair has exactly one
    /// pool and nobody can open a second one to split liquidity or to sit in
    /// front of the real one.
    pub fn init_pool(ctx: Context<InitPool>, fee_bps: u16) -> Result<()> {
        // A fee above 1% is almost certainly a typo, and a pool is not something
        // you can quietly fix afterwards.
        require!(fee_bps <= 100, AmmError::FeeTooHigh);

        let pool = &mut ctx.accounts.pool;
        pool.base_mint = ctx.accounts.base_mint.key();
        pool.quote_mint = ctx.accounts.quote_mint.key();
        pool.base_vault = ctx.accounts.base_vault.key();
        pool.quote_vault = ctx.accounts.quote_vault.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.fee_bps = fee_bps;
        pool.lp_supply = 0;
        pool.reserve_base = 0;
        pool.reserve_quote = 0;
        pool.swaps = 0;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Base layer. Deposits both sides and mints LP tokens.
    ///
    /// `min_lp_out` is the depositor's protection: between quoting and landing,
    /// somebody else's trade can move the ratio, and a deposit priced off the
    /// new ratio can mint far less than expected.
    pub fn add_liquidity(
        ctx: Context<ModifyLiquidity>,
        base_in: u64,
        quote_in: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let minted = liquidity_for_deposit(
            base_in,
            quote_in,
            pool.reserve_base,
            pool.reserve_quote,
            pool.lp_supply,
        )?;
        require!(minted >= min_lp_out, MathError::SlippageExceeded);
        require!(minted > 0, MathError::ZeroAmount);

        // Tokens in first. If either transfer fails the whole instruction
        // reverts, so the pool can never mint shares against a deposit it did
        // not receive.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_base.to_account_info(),
                    to: ctx.accounts.base_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            base_in,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_quote.to_account_info(),
                    to: ctx.accounts.quote_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            quote_in,
        )?;

        let first = ctx.accounts.pool.lp_supply == 0;
        let seeds = pool_seeds!(ctx.accounts.pool);
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            minted,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.reserve_base = pool
            .reserve_base
            .checked_add(base_in)
            .ok_or(MathError::Overflow)?;
        pool.reserve_quote = pool
            .reserve_quote
            .checked_add(quote_in)
            .ok_or(MathError::Overflow)?;
        // The locked minimum is counted in supply but was never minted to
        // anyone, which is exactly what makes it unwithdrawable.
        pool.lp_supply = pool
            .lp_supply
            .checked_add(minted)
            .ok_or(MathError::Overflow)?
            .checked_add(if first { MINIMUM_LIQUIDITY } else { 0 })
            .ok_or(MathError::Overflow)?;

        emit!(LiquidityAdded {
            pool: pool.key(),
            provider: ctx.accounts.user.key(),
            base_in,
            quote_in,
            lp_minted: minted,
        });
        Ok(())
    }

    /// Base layer. Burns LP tokens and returns both sides.
    pub fn remove_liquidity(
        ctx: Context<ModifyLiquidity>,
        lp_amount: u64,
        min_base_out: u64,
        min_quote_out: u64,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let (base_out, quote_out) = withdraw_amounts(
            lp_amount,
            pool.reserve_base,
            pool.reserve_quote,
            pool.lp_supply,
        )?;
        require!(
            base_out >= min_base_out && quote_out >= min_quote_out,
            MathError::SlippageExceeded
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.user_lp.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        let seeds = pool_seeds!(ctx.accounts.pool);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.base_vault.to_account_info(),
                    to: ctx.accounts.user_base.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            base_out,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: ctx.accounts.user_quote.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            quote_out,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.reserve_base -= base_out;
        pool.reserve_quote -= quote_out;
        pool.lp_supply -= lp_amount;

        emit!(LiquidityRemoved {
            pool: pool.key(),
            provider: ctx.accounts.user.key(),
            base_out,
            quote_out,
            lp_burned: lp_amount,
        });
        Ok(())
    }

    /// Swaps one side for the other along `x·y = k`.
    ///
    /// Runs identically on base layer and on a rollup. `min_amount_out` is not
    /// optional in spirit: a swap sent without one is a swap that will accept
    /// any price, and on a public mempool that is an invitation.
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        quote_to_base: bool,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let (reserve_in, reserve_out) = if quote_to_base {
            (pool.reserve_quote, pool.reserve_base)
        } else {
            (pool.reserve_base, pool.reserve_quote)
        };

        let amount_out = swap_output(amount_in, reserve_in, reserve_out, pool.fee_bps)?;
        require!(amount_out >= min_amount_out, MathError::SlippageExceeded);
        require!(amount_out > 0, MathError::ZeroAmount);

        // Which real vault each leg touches. The constraint block already
        // proved these are the pool's own vaults for the right mints.
        let (vault_in, vault_out, user_in, user_out) = if quote_to_base {
            (
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.user_quote.to_account_info(),
                ctx.accounts.user_base.to_account_info(),
            )
        } else {
            (
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.user_base.to_account_info(),
                ctx.accounts.user_quote.to_account_info(),
            )
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: user_in,
                    to: vault_in,
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_in,
        )?;

        let seeds = pool_seeds!(ctx.accounts.pool);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault_out,
                    to: user_out,
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount_out,
        )?;

        let pool = &mut ctx.accounts.pool;
        if quote_to_base {
            pool.reserve_quote = pool
                .reserve_quote
                .checked_add(amount_in)
                .ok_or(MathError::Overflow)?;
            pool.reserve_base = pool
                .reserve_base
                .checked_sub(amount_out)
                .ok_or(MathError::Overflow)?;
        } else {
            pool.reserve_base = pool
                .reserve_base
                .checked_add(amount_in)
                .ok_or(MathError::Overflow)?;
            pool.reserve_quote = pool
                .reserve_quote
                .checked_sub(amount_out)
                .ok_or(MathError::Overflow)?;
        }
        pool.swaps = pool.swaps.saturating_add(1);

        emit!(Swapped {
            pool: pool.key(),
            trader: ctx.accounts.user.key(),
            amount_in,
            amount_out,
            quote_to_base,
            reserve_base: pool.reserve_base,
            reserve_quote: pool.reserve_quote,
        });
        Ok(())
    }

    /// Base layer. Hands the pool to an ephemeral rollup.
    pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
        let base = ctx.accounts.base_mint.key();
        let quote = ctx.accounts.quote_mint.key();
        ctx.accounts.delegate_pool(
            &ctx.accounts.payer,
            &[b"pool", base.as_ref(), quote.as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Rollup. Commits the reserves back to Solana and hands the pool back.
    ///
    /// Price is the pool's public output, so it must be verifiable at rest even
    /// while trading happens somewhere faster. Committing is what makes that
    /// true: between commits the rollup is authoritative, and after one anybody
    /// can read the reserves on Solana and check the price for themselves.
    pub fn commit_pool(ctx: Context<CommitPool>) -> Result<()> {
        ctx.accounts.pool.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.pool.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

/// The pool PDA's signer seeds. A macro because three instructions need it and
/// the bump has to come from stored state, not from a fresh `find_program_address`.
#[macro_export]
macro_rules! pool_seeds {
    ($pool:expr) => {
        [
            b"pool".as_ref(),
            $pool.base_mint.as_ref(),
            $pool.quote_mint.as_ref(),
            &[$pool.bump],
        ]
    };
}

#[account]
pub struct Pool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_mint: Pubkey,
    /// Mirrors the vaults. Kept in the account so a quote is one read rather
    /// than three, and so the rollup has the numbers without touching SPL state.
    pub reserve_base: u64,
    pub reserve_quote: u64,
    pub lp_supply: u64,
    pub swaps: u64,
    pub fee_bps: u16,
    pub bump: u8,
}
impl Pool {
    pub const SIZE: usize = 8 + 32 * 5 + 8 * 4 + 2 + 1;
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(
        init,
        payer = payer,
        space = Pool::SIZE,
        seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    /// LP shares. The pool is the authority, so nobody else can ever mint them.
    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = pool,
        seeds = [b"lp", pool.key().as_ref()],
        bump
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = pool,
    )]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = pool,
    )]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Shared by deposit and withdrawal.
///
/// Every vault and mint is pinned to what the pool recorded at creation, so a
/// caller cannot substitute an account they control for one of the pool's.
#[derive(Accounts)]
pub struct ModifyLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
        has_one = base_vault,
        has_one = quote_vault,
        has_one = lp_mint,
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,
    #[account(mut, token::mint = pool.base_mint, token::authority = user)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.quote_mint, token::authority = user)]
    pub user_quote: Account<'info, TokenAccount>,
    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
        has_one = base_vault,
        has_one = quote_vault,
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.base_mint, token::authority = user)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.quote_mint, token::authority = user)]
    pub user_quote: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the pool PDA being delegated; seeds match the account definition.
    #[account(mut, del, seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()], bump)]
    pub pool: AccountInfo<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: optional target ER validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[event]
pub struct Swapped {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub quote_to_base: bool,
    pub reserve_base: u64,
    pub reserve_quote: u64,
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub base_in: u64,
    pub quote_in: u64,
    pub lp_minted: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub provider: Pubkey,
    pub base_out: u64,
    pub quote_out: u64,
    pub lp_burned: u64,
}

#[error_code]
pub enum AmmError {
    #[msg("fee above the 1% ceiling")]
    FeeTooHigh,
}

/// Re-exported so clients and tests read the same constant the pool charges.
pub const DEFAULT_FEE_BPS: u16 = FEE_BPS;
