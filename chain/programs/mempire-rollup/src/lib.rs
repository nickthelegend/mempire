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
//! | `seal_log`           | ER (open the private permission) |
//! | `play_card`          | ER    |
//! | `checkpoint`         | ER    |
//! | `end_log`            | ER (close permission, commit + undelegate) |
//! | `close_log`          | base (reclaim rent once settled) |
//! | `init_chests`        | base  |
//! | `delegate_chests`    | base  |
//! | `request_chest`      | ER (VRF request) |
//! | `callback_chest`     | ER (VRF oracle callback) |
//! | `cancel_chest`       | ER (timeout recovery) |
//! | `commit_chests`      | ER (commit + undelegate) |
//!
//! # Why the log is private (PER)
//!
//! The simulation runs two ticks behind the input a player submits, which is
//! what hides network latency. That delay is only safe while nobody can read
//! the log faster than the simulation consumes it: an observer polling the
//! rollup could otherwise see the opponent's card and placement *before* it
//! resolves on screen, and counter a push it has not officially seen yet. On a
//! match with real SOL on it that is not a leak, it is a cheat.
//!
//! So the log is sealed inside a TEE-backed validator with an ER-local
//! `EphemeralPermission` whose only members are the two seats. Delegation still
//! decides *where* the account lives; the permission decides *who may look*.

pub mod chests;

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, ACCOUNT_SIGNATURES_FLAG, PERMISSION_SEED,
    TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::{
    EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID,
};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_scoped_randomness_ix, RequestRandomnessParams,
};

use chests::{
    Chest, PlayerChests, CHEST_SLOTS, REQUEST_TIMEOUT_SLOTS, STATE_EMPTY, STATE_FILLED,
    STATE_PENDING,
};

declare_id!("3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N");

/// Generous for 3 minutes plus overtime at roughly one play per two seconds per
/// player. Fixed at creation: a delegated account must not resize on the rollup.
pub const MAX_PLAYS: usize = 128;
const DECK_SIZE: u8 = 8;

/// Members of the log's ephemeral permission: exactly the two seats.
///
/// Fixed at two on purpose. The permission's rent is pre-funded on the base
/// layer from a size computed here, so a cap that instructions do not enforce
/// would let a permission grow past the lamports that were set aside for it —
/// and the failure would land on the rollup, mid-match. `size_of` already
/// reserves one slot beyond this for the permission program's own default
/// member.
pub const MAX_PERMISSION_MEMBERS: usize = 2;

/// What a seat is allowed to see inside the sealed rollup.
///
/// Both players get full visibility of the match they are playing — logs,
/// balances, messages, signatures — because each of them can already see every
/// one of their own plays and the results of the other's. What the permission
/// withholds is a *third* party's ability to read either. `AUTHORITY_FLAG` is
/// deliberately absent: a player may observe the log, never re-permission it.
const SEAT_FLAGS: u8 =
    TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG;

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

        // The ephemeral permission is created on the rollup, but its rent is
        // paid by this PDA — and a PDA cannot be topped up from inside the
        // rollup. Fund it here, on base, for the largest member list the
        // permission is ever allowed to hold. Getting this wrong surfaces as a
        // failed `seal_log` after the match has already been paid for.
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.log.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(
                EphemeralPermission::size_of(MAX_PERMISSION_MEMBERS) as u32,
            ),
        )?;

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

    /// Rollup. Seals the log so only the two seats can read it.
    ///
    /// Idempotent by construction: clients retry rollup transactions freely, and
    /// creating a permission that already exists would fail the whole match
    /// start. An already-initialised permission account is treated as success.
    ///
    /// Note this runs *after* delegation and on the rollup, not on base. There
    /// is no base-layer permission account in this model — the permission is
    /// ER-local for its whole life, which is also why closing it is a rollup
    /// instruction rather than part of settlement.
    pub fn seal_log(ctx: Context<Permission>) -> Result<()> {
        let log = &ctx.accounts.log;
        require!(!log.ended, RollupError::AlreadyEnded);

        // Anyone may seal, but only into the membership the log itself names,
        // so a third party racing this instruction cannot seal themselves in.
        if ctx.accounts.permission.owner == &PERMISSION_PROGRAM_ID
            && !ctx.accounts.permission.data_is_empty()
        {
            return Ok(());
        }

        let match_id = log.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"log", match_id.as_ref(), &[log.bump]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.log.to_account_info(),
            permissioned_account: ctx.accounts.log.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: seat_members(&log.players),
            },
        }
        .invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Rollup. Rewrites the membership to exactly the two seats.
    ///
    /// An update replaces the member list wholesale rather than merging into
    /// it, so this doubles as the repair path if a permission was ever created
    /// with the wrong set. It cannot be used to *add* anyone: the membership is
    /// derived from the log, which was fixed on the base layer at init.
    pub fn reseal_log(ctx: Context<Permission>) -> Result<()> {
        let log = &ctx.accounts.log;
        require!(!log.ended, RollupError::AlreadyEnded);

        let match_id = log.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"log", match_id.as_ref(), &[log.bump]];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.log.to_account_info(),
            permissioned_account: ctx.accounts.log.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.log.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: true,
                members: seat_members(&log.players),
            },
        }
        .invoke_signed(&[seeds])?;
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

        // Close the ephemeral permission before the log leaves the rollup.
        //
        // It is ER-local state: it does not travel with the account, and once
        // the log is undelegated nothing can reach it to close it. Closing here
        // also refunds its rent back to the log, which `close_log` then returns
        // to the player along with the rest — so the seal costs a player
        // nothing beyond the lamports that were parked for the duration.
        //
        // Optional in the account list, and skipped when absent, because a
        // match that was never sealed (a client that failed between delegate
        // and seal) must still be able to end and settle. Losing the pot to a
        // missing permission would be a far worse failure than an unsealed log.
        if let Some(permission) = ctx.accounts.permission.as_ref() {
            if permission.owner == &PERMISSION_PROGRAM_ID && !permission.data_is_empty() {
                let match_id = ctx.accounts.log.match_id.to_le_bytes();
                let seeds: &[&[u8]] = &[b"log", match_id.as_ref(), &[ctx.accounts.log.bump]];
                CloseEphemeralPermissionCpi {
                    payer: ctx.accounts.log.to_account_info(),
                    permissioned_account: ctx.accounts.log.to_account_info(),
                    permission: permission.to_account_info(),
                    vault: ctx
                        .accounts
                        .ephemeral_vault
                        .as_ref()
                        .ok_or(RollupError::PermissionAccountsMissing)?
                        .to_account_info(),
                    magic_program: ctx.accounts.magic_program.to_account_info(),
                    permission_program: ctx
                        .accounts
                        .permission_program
                        .as_ref()
                        .ok_or(RollupError::PermissionAccountsMissing)?
                        .to_account_info(),
                    authority: ctx.accounts.log.to_account_info(),
                    authority_is_signer: false,
                }
                .invoke_signed(&[seeds])?;
            }
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

    // ── Chests ──────────────────────────────────────────────────────────────

    /// Base layer. Creates a player's chest rail.
    pub fn init_chests(ctx: Context<InitChests>) -> Result<()> {
        let c = &mut ctx.accounts.chests;
        c.owner = ctx.accounts.owner.key();
        c.slots = [Chest::default(); CHEST_SLOTS];
        c.nonce = 0;
        c.pending_slot = u8::MAX;
        c.pending_nonce = 0;
        c.requested_at = 0;
        c.opened = 0;
        c.bump = ctx.bumps.chests;
        Ok(())
    }

    /// Base layer. Hands the rail to an ephemeral rollup.
    pub fn delegate_chests(ctx: Context<DelegateChests>) -> Result<()> {
        ctx.accounts.delegate_chests(
            &ctx.accounts.owner,
            &[b"chests", ctx.accounts.owner.key.as_ref()],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Rollup. Asks the oracle for the randomness that decides one chest.
    ///
    /// Acceptance is not an outcome. This marks the slot pending and returns;
    /// the tier exists only once `callback_chest` runs, which is a separate
    /// transaction the oracle submits. The UI must show "opening" here, never a
    /// result.
    pub fn request_chest(
        ctx: Context<RequestChest>,
        slot_index: u8,
        client_seed: u8,
    ) -> Result<()> {
        require!(
            chests::is_ephemeral_queue(&ctx.accounts.oracle_queue.key()),
            RollupError::WrongQueue
        );
        let idx = slot_index as usize;
        require!(idx < CHEST_SLOTS, RollupError::BadSlot);

        {
            let c = &ctx.accounts.chests;
            // One live request per player. Concurrency here would let two
            // callbacks race for the same slot, and the loser would silently
            // overwrite a drop the player had already been shown.
            require!(c.idle(), RollupError::RequestInFlight);
            require!(
                c.slots[idx].state == STATE_EMPTY,
                RollupError::SlotNotEmpty
            );
        }

        let nonce = {
            let c = &mut ctx.accounts.chests;
            c.nonce = c.nonce.saturating_add(1);
            c.pending_slot = slot_index;
            c.pending_nonce = c.nonce;
            c.requested_at = Clock::get()?.slot;
            c.slots[idx].state = STATE_PENDING;
            c.slots[idx].nonce = c.nonce;
            c.nonce
        };

        // The callback is bound to this exact request by (slot, nonce), which
        // are forwarded as callback args and re-checked on arrival. A late
        // callback from a cancelled request carries a stale nonce and is
        // dropped rather than applied to whatever is in the slot now.
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackChest::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta {
                    pubkey: ctx.accounts.chests.key(),
                    is_signer: false,
                    is_writable: true,
                },
            ]),
            callback_args: Some(
                [vec![slot_index], nonce.to_le_bytes().to_vec()].concat(),
            ),
            ..Default::default()
        });

        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Rollup. The oracle delivering randomness for exactly one request.
    ///
    /// `#[vrf_callback]` injects the scoped-identity signer check, which is what
    /// stops anyone else calling this with bytes of their choosing. Everything
    /// below is the *application* half of that: proving this delivery belongs to
    /// the request still outstanding, and doing nothing at all if it does not.
    pub fn callback_chest(
        ctx: Context<CallbackChest>,
        randomness: [u8; 32],
        slot_index: u8,
        nonce: u64,
    ) -> Result<()> {
        let c = &mut ctx.accounts.chests;
        let idx = slot_index as usize;

        // Idempotent, and deliberately not an error. A duplicate delivery is
        // the oracle doing its job under retry; failing it would leave a
        // perfectly good chest looking broken. What must never happen is a
        // second fill, so the guard is on state, not on the transaction.
        if idx >= CHEST_SLOTS
            || c.pending_slot != slot_index
            || c.pending_nonce != nonce
            || c.slots[idx].state != STATE_PENDING
            || c.slots[idx].nonce != nonce
        {
            msg!("vrf: stale or duplicate callback for slot {} nonce {}", slot_index, nonce);
            return Ok(());
        }

        c.slots[idx].tier = chests::tier_from_randomness(&randomness);
        c.slots[idx].randomness = randomness;
        c.slots[idx].state = STATE_FILLED;
        c.opened = c.opened.saturating_add(1);
        c.pending_slot = u8::MAX;
        c.pending_nonce = 0;
        c.requested_at = 0;
        Ok(())
    }

    /// Rollup. Takes a filled chest and frees its slot.
    ///
    /// Without this the rail is write-once: four chests fill the four slots and
    /// the player can never roll again. The randomness is returned to the
    /// caller in the event rather than kept, because the drop it expands into
    /// has already been shown — what the chain needs to retain is that the slot
    /// is free, not what used to be in it.
    pub fn claim_chest(ctx: Context<ClaimChest>, slot_index: u8) -> Result<()> {
        let idx = slot_index as usize;
        require!(idx < CHEST_SLOTS, RollupError::BadSlot);
        let c = &mut ctx.accounts.chests;
        require!(c.slots[idx].state == STATE_FILLED, RollupError::SlotNotFilled);

        let claimed = c.slots[idx];
        emit!(ChestClaimed {
            owner: c.owner,
            slot_index,
            tier: claimed.tier,
            nonce: claimed.nonce,
            randomness: claimed.randomness,
        });
        c.slots[idx] = Chest::default();
        Ok(())
    }

    /// Rollup. Releases a slot whose callback never arrived.
    ///
    /// Permissionless on purpose: the owner may be the one whose client died,
    /// and a rail wedged forever because nobody could clear it is a worse
    /// outcome than a stranger paying the fee to unstick it. The nonce is not
    /// reused, so the cancelled request's callback can still turn up and will
    /// be ignored.
    pub fn cancel_chest(ctx: Context<CancelChest>) -> Result<()> {
        let c = &mut ctx.accounts.chests;
        require!(!c.idle(), RollupError::NoRequestInFlight);
        require!(
            Clock::get()?.slot.saturating_sub(c.requested_at) >= REQUEST_TIMEOUT_SLOTS,
            RollupError::RequestNotStale
        );
        let idx = c.pending_slot as usize;
        if idx < CHEST_SLOTS && c.slots[idx].state == STATE_PENDING {
            c.slots[idx] = Chest::default();
        }
        c.pending_slot = u8::MAX;
        c.pending_nonce = 0;
        c.requested_at = 0;
        Ok(())
    }

    /// Rollup. Commits the rail back to base layer and hands it back.
    ///
    /// Refused while a request is outstanding: undelegating mid-flight would
    /// send the callback to an account that is no longer on the rollup, and the
    /// player would lose the chest they were waiting on.
    pub fn commit_chests(ctx: Context<CommitChests>) -> Result<()> {
        require!(ctx.accounts.chests.idle(), RollupError::RequestInFlight);
        ctx.accounts.chests.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.chests.to_account_info()])
        .build_and_invoke()?;
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
    /// CHECK: derived and checked under the permission program. Optional so an
    /// unsealed match can still end — settlement must never depend on it.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, log.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: Option<UncheckedAccount<'info>>,
    /// CHECK: fixed address, validated by constraint.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: Option<UncheckedAccount<'info>>,
    /// CHECK: fixed address, validated by constraint.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: Option<UncheckedAccount<'info>>,
}

/// Shared by `seal_log` and `reseal_log`. Rollup-only.
///
/// The log signs its own permission CPIs with its program seeds, so no seat has
/// to be a signer here — and deliberately is not: sealing is a property of the
/// match, not a privilege one player exercises over the other.
#[derive(Accounts)]
pub struct Permission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"log", log.match_id.to_le_bytes().as_ref()],
        bump = log.bump,
    )]
    pub log: Account<'info, MatchLog>,
    /// CHECK: derived and checked under the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, log.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed address, validated by constraint.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address, validated by constraint.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed address, validated by constraint.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// The two seats, as permission members.
///
/// Built from the log rather than from instruction data on purpose: the seats
/// were fixed on the base layer at `init_log`, where the payer had to be one of
/// them. Deriving membership from that record means no rollup instruction can
/// widen it.
fn seat_members(players: &[Pubkey; 2]) -> Vec<Member> {
    players
        .iter()
        .map(|p| Member { flags: SEAT_FLAGS, pubkey: *p })
        .collect()
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


// ── Chest contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitChests<'info> {
    #[account(
        init,
        payer = owner,
        space = PlayerChests::SIZE,
        seeds = [b"chests", owner.key().as_ref()],
        bump
    )]
    pub chests: Account<'info, PlayerChests>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateChests<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the rail PDA being delegated; seeds match the account definition.
    #[account(mut, del, seeds = [b"chests", owner.key().as_ref()], bump)]
    pub chests: AccountInfo<'info>,
    /// CHECK: optional target ER validator, forwarded in DelegateConfig.
    pub validator: Option<UncheckedAccount<'info>>,
}

/// `#[vrf]` injects `program_identity`, `vrf_program`, `slot_hashes`,
/// `system_program`, and the `invoke_signed_vrf` helper. Without it the request
/// simply does not compile, which is the failure mode you want.
#[vrf]
#[derive(Accounts)]
pub struct RequestChest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"chests", chests.owner.as_ref()],
        bump = chests.bump,
        has_one = owner,
    )]
    pub chests: Account<'info, PlayerChests>,
    /// The rail's owner must authorise the roll. Delegation is routing, not
    /// authorization — the rollup enforces the same rule base layer would.
    pub owner: Signer<'info>,
    /// CHECK: constrained to a delegated queue, since this runs on the rollup.
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// `#[vrf_callback]` injects a `vrf_program_identity: Signer` bound to this
/// program's scoped identity PDA.
///
/// Omitting it still compiles — which is precisely why it is called out here.
/// The struct would look complete and accept randomness from anyone.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackChest<'info> {
    #[account(
        mut,
        seeds = [b"chests", chests.owner.as_ref()],
        bump = chests.bump,
    )]
    pub chests: Account<'info, PlayerChests>,
}

/// Emitted when a chest is taken. Carries the randomness so a client — or
/// anyone auditing a drop after the fact — can re-derive exactly what it
/// contained from the transaction alone.
#[event]
pub struct ChestClaimed {
    pub owner: Pubkey,
    pub slot_index: u8,
    pub tier: u8,
    pub nonce: u64,
    pub randomness: [u8; 32],
}

#[derive(Accounts)]
pub struct ClaimChest<'info> {
    #[account(
        mut,
        seeds = [b"chests", chests.owner.as_ref()],
        bump = chests.bump,
        has_one = owner,
    )]
    pub chests: Account<'info, PlayerChests>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelChest<'info> {
    /// Anyone may pay to unstick a stale request; see `cancel_chest`.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"chests", chests.owner.as_ref()],
        bump = chests.bump,
    )]
    pub chests: Account<'info, PlayerChests>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitChests<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"chests", chests.owner.as_ref()],
        bump = chests.bump,
        has_one = owner,
    )]
    pub chests: Account<'info, PlayerChests>,
}

#[error_code]
pub enum RollupError {
    #[msg("signer is not a player in this match")]
    NotAPlayer,
    #[msg("match already ended")]
    AlreadyEnded,
    #[msg("match has not ended yet")]
    NotEnded,
    #[msg("oracle queue is not a delegated (ephemeral) queue")]
    WrongQueue,
    #[msg("chest slot index out of range")]
    BadSlot,
    #[msg("a randomness request is already in flight")]
    RequestInFlight,
    #[msg("no randomness request is in flight")]
    NoRequestInFlight,
    #[msg("the in-flight request has not timed out yet")]
    RequestNotStale,
    #[msg("chest slot is not empty")]
    SlotNotEmpty,
    #[msg("chest slot has nothing to claim")]
    SlotNotFilled,
    #[msg("permission accounts must all be supplied together")]
    PermissionAccountsMissing,
    #[msg("deck index out of range")]
    BadDeckIndex,
    #[msg("input log is full")]
    LogFull,
    #[msg("tick is older than the last recorded tick")]
    StaleTick,
    #[msg("invalid winner value")]
    BadWinner,
}
