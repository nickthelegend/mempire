//! Mempire's match log, on a MagicBlock ephemeral rollup.
//!
//! # Why this is a separate program
//!
//! The main `mempire` program carries `anchor-spl` for the staking vaults, and
//! adding the ER SDK on top of that (which links a second copy of `anchor-lang`
//! via `anchor-compat`) pushed its binary to 517KB — more than its deploy buffer
//! could be funded for. This program holds only the hot rollup state, needs no
//! token CPI at all, and is therefore small enough to deploy and iterate on
//! independently.
//!
//! The split is also the safer shape. This program can **never move money**: it
//! owns no lamports beyond its own rent and has no transfer path. The escrow,
//! the deck locks, and the payout stay entirely in `mempire` on base layer,
//! settled by its existing two-signature `settle` using the final hash this
//! program commits. A rollup that stalls costs latency and falls back to
//! `claim_timeout`; it can never strand a pot.
//!
//! # Routing
//!
//! | instruction          | layer |
//! |----------------------|-------|
//! | `init_log`           | base  |
//! | `delegate_log`       | base  |
//! | `play_card`          | ER    |
//! | `checkpoint`         | ER    |
//! | `end_log`            | ER (commit + undelegate) |
//! | `close_log`          | base (reclaim rent once settled) |

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N");

/// Generous for 3 minutes plus overtime at roughly one play per two seconds per
/// player. Fixed at creation: a delegated account must not resize on the rollup.
pub const MAX_PLAYS: usize = 128;
const DECK_SIZE: u8 = 8;

/// `#[ephemeral]` injects `process_undelegation`, the callback the delegation
/// program CPIs into when handing an account back. Without it a delegated log
/// could never return to base layer.
#[ephemeral]
#[program]
pub mod mempire_rollup {
    use super::*;

    /// Base layer. Creates the log for a match the main program already opened.
    ///
    /// `players` is supplied by the caller and then enforced on every rollup
    /// write. This program cannot read the main program's `MatchAccount` from
    /// inside the rollup, so the seats are captured here, on base layer, while
    /// the payer still has to be one of them.
    pub fn init_log(
        ctx: Context<InitLog>,
        match_id: u64,
        players: [Pubkey; 2],
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == players[0] || ctx.accounts.payer.key() == players[1],
            RollupError::NotAPlayer
        );
        require_keys_neq!(players[0], players[1], RollupError::NotAPlayer);

        let log = &mut ctx.accounts.log;
        log.match_id = match_id;
        log.players = players;
        log.plays = Vec::new();
        log.last_tick = 0;
        log.last_hash = 0;
        log.checkpoints = 0;
        log.ended = false;
        log.winner = u8::MAX;
        log.bump = ctx.bumps.log;
        Ok(())
    }

    /// Base layer. Hands the log to an ephemeral rollup.
    ///
    /// `validator` is optional and must be set when the delegation has to land on
    /// a *specific* ER — which is always true on localnet, where the only rollup
    /// is the one you started. Leaving it `None` (the `DelegateConfig::default()`
    /// behaviour) publishes an unassigned delegation, and a specific validator
    /// will then refuse writes to the account even though base ownership and the
    /// ER clone both look correct. On devnet the router assigns placement, so
    /// `None` is the normal case there.
    pub fn delegate_log(ctx: Context<DelegateLog>, match_id: u64) -> Result<()> {
        // Seeds must match the account definition exactly, or the delegation
        // record is derived for a different address and the rollup never sees it.
        ctx.accounts.delegate_log(
            &ctx.accounts.payer,
            &[b"log", &match_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Rollup. One card play, at rollup latency instead of base-layer latency.
    ///
    /// This is what makes the input log genuinely onchain rather than relayed by
    /// a server we happen to operate.
    pub fn play_card(
        ctx: Context<Write>,
        tick: u32,
        deck_index: u8,
        x: i32,
        y: i32,
    ) -> Result<()> {
        let signer = ctx.accounts.player.key();
        let log = &mut ctx.accounts.log;
        require!(!log.ended, RollupError::AlreadyEnded);
        require!(deck_index < DECK_SIZE, RollupError::BadDeckIndex);
        require!(log.plays.len() < MAX_PLAYS, RollupError::LogFull);

        // Delegation is routing, never authorization: the rollup enforces the
        // same seat check the base layer would.
        let seat = if signer == log.players[0] {
            0u8
        } else if signer == log.players[1] {
            1u8
        } else {
            return err!(RollupError::NotAPlayer);
        };

        // Monotonic ticks: a replayed or reordered play cannot rewrite history
        // both simulations have already run past.
        require!(tick >= log.last_tick, RollupError::StaleTick);

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

    /// Rollup. Records a state-hash checkpoint.
    ///
    /// Keeps the newest hash and a count rather than the whole stream:
    /// settlement needs the final hash, and a divergence is caught live by the
    /// clients comparing checkpoints as they go.
    pub fn checkpoint(ctx: Context<Write>, tick: u32, hash: u64) -> Result<()> {
        let signer = ctx.accounts.player.key();
        let log = &mut ctx.accounts.log;
        require!(!log.ended, RollupError::AlreadyEnded);
        require!(
            signer == log.players[0] || signer == log.players[1],
            RollupError::NotAPlayer
        );
        require!(tick >= log.last_tick, RollupError::StaleTick);
        log.last_tick = tick;
        log.last_hash = hash;
        log.checkpoints = log.checkpoints.saturating_add(1);
        Ok(())
    }

    /// Rollup. Seals the log and commits it back to base layer.
    ///
    /// No post-commit Magic Action is attached. An action that fails can be
    /// stripped from its whole transaction strategy before the committor retries,
    /// so the payout must not ride on one — settlement is a separate base-layer
    /// transaction against the main program.
    pub fn end_log(ctx: Context<EndLog>, winner: u8, final_hash: u64) -> Result<()> {
        require!(winner <= 2, RollupError::BadWinner);
        {
            let signer = ctx.accounts.payer.key();
            let log = &ctx.accounts.log;
            require!(!log.ended, RollupError::AlreadyEnded);
            require!(
                signer == log.players[0] || signer == log.players[1],
                RollupError::NotAPlayer
            );
        }

        {
            let log = &mut ctx.accounts.log;
            log.ended = true;
            log.winner = winner;
            log.last_hash = final_hash;
        }

        // Flush the mutations to the account *before* handing it off.
        //
        // Anchor serializes `Account<T>` changes when the instruction exits, but
        // `commit_and_undelegate` transfers the account away during the
        // instruction — so the deferred write lands after ownership has changed
        // and the runtime rejects it with "modified data of an account it does
        // not own". Writing explicitly here means the committed state is the
        // sealed state, which is the whole point of this instruction.
        ctx.accounts.log.exit(&crate::ID)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.log.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer. Reclaims the log's rent once the match is over.
    ///
    /// Only a player may close it, and only after `end_log` has sealed it — so a
    /// live match cannot have its record deleted out from under settlement.
    pub fn close_log(ctx: Context<CloseLog>) -> Result<()> {
        let log = &ctx.accounts.log;
        require!(log.ended, RollupError::NotEnded);
        require!(
            ctx.accounts.payer.key() == log.players[0]
                || ctx.accounts.payer.key() == log.players[1],
            RollupError::NotAPlayer
        );
        Ok(())
    }
}

/// A single card play. 14 bytes, appended on the rollup.
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

/// The delegated account. Holds the input log and the newest checkpoint, and no
/// lamports beyond its own rent — which is the whole safety argument for putting
/// a wagered match on a rollup.
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
    pub bump: u8,
}
impl MatchLog {
    pub const SIZE: usize =
        8 + 8 + 64 + 4 + (MAX_PLAYS * PlayEntry::SIZE) + 4 + 8 + 2 + 1 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct InitLog<'info> {
    #[account(
        init,
        payer = payer,
        space = MatchLog::SIZE,
        seeds = [b"log", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub log: Account<'info, MatchLog>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `#[delegate]` injects the delegation accounts. The target must be a raw
/// `AccountInfo` with the `del` constraint — delegation hands base-layer
/// ownership to the delegation program, so `Account<>` cannot model it.
#[delegate]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DelegateLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the log PDA being delegated; seeds match the account definition.
    #[account(mut, del, seeds = [b"log", match_id.to_le_bytes().as_ref()], bump)]
    pub log: AccountInfo<'info>,
    /// CHECK: optional target ER validator, forwarded in DelegateConfig. Required
    /// on localnet; omitted on devnet so the router chooses placement.
    pub validator: Option<UncheckedAccount<'info>>,
}

/// Shared by `play_card` and `checkpoint`. Runs on the rollup, where the log is
/// owned by this program again and normal Anchor constraints apply.
#[derive(Accounts)]
pub struct Write<'info> {
    #[account(
        mut,
        seeds = [b"log", log.match_id.to_le_bytes().as_ref()],
        bump = log.bump,
    )]
    pub log: Account<'info, MatchLog>,
    pub player: Signer<'info>,
}

/// `#[commit]` injects `magic_context` and `magic_program`.
#[commit]
#[derive(Accounts)]
pub struct EndLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"log", log.match_id.to_le_bytes().as_ref()],
        bump = log.bump,
    )]
    pub log: Account<'info, MatchLog>,
}

#[derive(Accounts)]
pub struct CloseLog<'info> {
    #[account(
        mut,
        close = payer,
        seeds = [b"log", log.match_id.to_le_bytes().as_ref()],
        bump = log.bump,
    )]
    pub log: Account<'info, MatchLog>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[error_code]
pub enum RollupError {
    #[msg("signer is not a player in this match")]
    NotAPlayer,
    #[msg("match already ended")]
    AlreadyEnded,
    #[msg("match has not ended yet")]
    NotEnded,
    #[msg("deck index out of range")]
    BadDeckIndex,
    #[msg("input log is full")]
    LogFull,
    #[msg("tick is older than the last recorded tick")]
    StaleTick,
    #[msg("invalid winner value")]
    BadWinner,
}
