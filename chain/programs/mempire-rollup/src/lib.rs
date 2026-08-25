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
//! | `unseal_log`         | ER (close the permission) |
//! | `end_log`            | ER (commit + undelegate) |
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
use anchor_lang::system_program::{self, transfer, Transfer};
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

/// The money program. Its `MatchAccount` is the only thing that can say who is
/// actually playing a match, and this program has to ask it rather than take a
/// caller's word.
pub const MEMPIRE_PROGRAM_ID: Pubkey = pubkey!("BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP");

/*
 * Byte offsets into `mempire::MatchAccount`.
 *
 * Read raw because the type belongs to the other crate and this one does not
 * depend on it. That makes these numbers load-bearing, so `init_log` also
 * checks the `id` it reads against the `match_id` it was given: if the layout
 * ever shifts, that comparison fails loudly instead of silently authorising
 * against the wrong bytes. The same offsets are used by `server/chain-verify.js`.
 *
 *   8   id: u64          25  players: [Pubkey; 2]      161  state: u8
 */
const MATCH_LEN: usize = 188;
const MATCH_ID_AT: usize = 8;
const MATCH_PLAYERS_AT: usize = 25;
const MATCH_STATE_AT: usize = 161;
/// `mempire::MatchState::Active`
const MATCH_STATE_ACTIVE: u8 = 1;

/// Generous for 3 minutes plus overtime at roughly one play per two seconds per
/// player. Fixed at creation: a delegated account must not resize on the rollup.
pub const MAX_PLAYS: usize = 128;
const DECK_SIZE: u8 = 8;

/// Ceiling on unspent chest entitlements.
///
/// Wins accrue faster than anyone opens chests, and an unbounded counter is a
/// balance nobody reconciles. Four is the number of slots on the rail, so a
/// player at the cap already has every slot's worth waiting.
pub const MAX_UNSPENT_CHESTS: u16 = 4;

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
        /*
         * Who is playing is a fact about the escrowed match, not a parameter.
         *
         * This used to take `players` as instruction data and check only that
         * the payer was one of the two keys they had just supplied. Nothing
         * tied the log to a real match, so two self-owned wallets could invent
         * one, "win" it, and mint the chest entitlement that exists precisely
         * to make a chest cost a win — and, because the seeds are public and
         * match ids are sequential, could squat the log PDA of a genuine match
         * and deny it. The sibling handler in the money program,
         * `mempire::init_match_log`, has always read these from chain state;
         * this one now does too.
         */
        let seats = {
            let data = ctx.accounts.match_account.try_borrow_data()?;
            require!(data.len() >= MATCH_LEN, RollupError::NotAPlayer);

            // The offsets are hand-written, so prove them before trusting them.
            let id = u64::from_le_bytes(
                data[MATCH_ID_AT..MATCH_ID_AT + 8]
                    .try_into()
                    .map_err(|_| error!(RollupError::NotAPlayer))?,
            );
            require_eq!(id, match_id, RollupError::NotAPlayer);
            require!(
                data[MATCH_STATE_AT] == MATCH_STATE_ACTIVE,
                RollupError::NotAPlayer
            );

            let a = Pubkey::try_from(&data[MATCH_PLAYERS_AT..MATCH_PLAYERS_AT + 32])
                .map_err(|_| error!(RollupError::NotAPlayer))?;
            let b = Pubkey::try_from(&data[MATCH_PLAYERS_AT + 32..MATCH_PLAYERS_AT + 64])
                .map_err(|_| error!(RollupError::NotAPlayer))?;
            [a, b]
        };

        // The argument survives as a checked assertion rather than a source of
        // truth: a client that disagrees with the chain fails here instead of
        // quietly getting a log describing a different match than it meant.
        require_keys_eq!(players[0], seats[0], RollupError::NotAPlayer);
        require_keys_eq!(players[1], seats[1], RollupError::NotAPlayer);
        require!(
            ctx.accounts.payer.key() == seats[0] || ctx.accounts.payer.key() == seats[1],
            RollupError::NotAPlayer
        );

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
        log.players = seats;
        log.plays = Vec::new();
        log.last_tick = 0;
        log.last_hash = 0;
        log.checkpoints = 0;
        log.ended = false;
        log.winner = u8::MAX;
        log.bump = ctx.bumps.log;
        log.session_signers = [Pubkey::default(); 2];
        log.session_expires = [0; 2];
        // 3 = "has not spoken". Both seats must speak before the log seals.
        log.claims = [3; 2];
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
            let info = &ctx.accounts.log;
            let data = info.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let log = MatchLog::try_deserialize(&mut slice)?;
            require!(
                log.players.contains(ctx.accounts.payer.key),
                RollupError::NotAPlayer
            );
        }

        // Seeds must match the account definition exactly, or the delegation
        // record is derived for a different address and the rollup never sees it.
        ctx.accounts.delegate_log(
            &ctx.accounts.payer,
            &[b"log", &match_id.to_le_bytes()],
            DelegateConfig {
                /*
                 * Router-assigned, never caller-named.
                 *
                 * The delegated account's authority is what computes and
                 * commits its state, so letting the rail's own owner pick the
                 * validator let them pick who authors `earned`, every slot's
                 * `tier`, and the randomness behind it — the whole chest
                 * economy, written by its beneficiary. This repo already
                 * deleted `delegate_pool` from the AMM for exactly that
                 * reason, and `mempire::delegate_match_log` already passes
                 * `DelegateConfig::default()`.
                 */
                validator: None,
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

    /// Rollup. Closes the seal, refunding its rent to the log.
    ///
    /// Deliberately **not** folded into `end_log`.
    ///
    /// The first version did exactly that, with the permission accounts as
    /// Anchor `Option`s. Anchor substitutes the program id for an omitted
    /// optional account, and these were marked `mut`, so every existing caller
    /// — the app's settlement path included — started failing preflight with
    /// "loads a writable account that cannot be written". Settlement is the one
    /// path in this program that must never acquire a new way to fail, so the
    /// permission lifecycle stays in its own instructions and `end_log` keeps
    /// the account list it always had.
    ///
    /// Safe to call on a log that was never sealed: an existing-but-empty
    /// permission returns `Ok` without a CPI.
    ///
    /// It is **not** safe to assume a second call succeeds. Once the permission
    /// is fully closed the account no longer exists, and transaction
    /// verification rejects it as a writable account before this instruction
    /// runs at all — the early return never gets a chance. Clients should treat
    /// a failed unseal as non-fatal and continue straight to `end_log`, which
    /// deliberately does not depend on the permission: the worst case is the
    /// seal's rent staying behind on the rollup, and the pot still settles.
    pub fn unseal_log(ctx: Context<Permission>) -> Result<()> {
        let log = &ctx.accounts.log;

        // Only a seat may unseal.
        //
        // Sealing is the whole point of running on a *permissioned* rollup: the
        // sim runs two ticks behind the input that produced it, so anyone who
        // can read the log faster than the sim consumes it sees the opponent's
        // card before it resolves on screen. Unsealed by a stranger, that is
        // not a leak of history — it is a spectator reading your hand, on a
        // match with SOL on it.
        //
        // Deliberately not also gated on `ended`. Closing the permission has to
        // happen *before* `end_log`, because the permission is rollup-local and
        // `end_log` undelegates the account out from under it — requiring the
        // match to be over would strand the permission's rent every game. A
        // seat unsealing early gains nothing anyway: both seats are already
        // members and can read every play.
        require!(
            log.players.contains(ctx.accounts.payer.key),
            RollupError::NotAPlayer
        );

        if ctx.accounts.permission.owner != &PERMISSION_PROGRAM_ID
            || ctx.accounts.permission.data_is_empty()
        {
            return Ok(());
        }
        let match_id = log.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"log", match_id.as_ref(), &[log.bump]];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.log.to_account_info(),
            permissioned_account: ctx.accounts.log.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.log.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Rollup. Authorises a temporary key to write for the caller's seat.
    ///
    /// One wallet signature at the start of a match, and then none for the rest
    /// of it. Without this a real wallet prompts on every card drop and on every
    /// checkpoint — dozens of popups in three minutes, which does not make the
    /// game annoying so much as unplayable.
    ///
    /// # Why this is safe to hand out
    ///
    /// This program has **no transfer path**. It owns no lamports beyond its own
    /// rent and cannot move a token. The worst a stolen session key can do is
    /// write nonsense plays into one match log — and the lockstep hash check
    /// already voids a match whose log does not match the simulation, refunding
    /// both stakes. Escrow and payout live in `mempire` on the base layer and
    /// are wallet-only, deliberately.
    ///
    /// The scope is therefore: one seat, one match, until it expires.
    pub fn open_session(
        ctx: Context<Session>,
        session_signer: Pubkey,
        ttl_secs: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.log.ended, RollupError::AlreadyEnded);
        require_keys_neq!(session_signer, Pubkey::default(), RollupError::BadSession);
        // A session may not outlive the match it is scoped to by much. Three
        // minutes plus overtime plus slack; an hour-long key for a five-minute
        // game is a key that outlives the reason it existed.
        require!(
            (0..=1_800).contains(&ttl_secs),
            RollupError::BadSession
        );
        // The session key must not be a seat: that would let one player's
        // "session" be the other player's wallet.
        let log = &ctx.accounts.log;
        require!(
            session_signer != log.players[0] && session_signer != log.players[1],
            RollupError::BadSession
        );
        // Nor may it be the key the *other* seat is already using. `seat_for`
        // resolves a signer by scanning seats in order, so one key registered
        // to both seats makes attribution depend on array position rather than
        // on who signed. Nobody can exploit that without the other seat's
        // secret, but a signature whose meaning depends on iteration order is
        // not something to leave in a program that settles money.
        require!(
            session_signer != log.session_signers[0]
                && session_signer != log.session_signers[1],
            RollupError::BadSession
        );

        let signer = ctx.accounts.player.key();
        let seat = if signer == log.players[0] {
            0usize
        } else if signer == log.players[1] {
            1usize
        } else {
            return err!(RollupError::NotAPlayer);
        };

        let log = &mut ctx.accounts.log;
        log.session_signers[seat] = session_signer;
        log.session_expires[seat] = Clock::get()?.unix_timestamp + ttl_secs;
        emit!(SessionOpened { match_id: log.match_id, seat: seat as u8, session_signer,
            expires_at: log.session_expires[seat] });
        Ok(())
    }

    /// Rollup. Revokes the caller's session immediately.
    ///
    /// Expiry is the backstop, not the mechanism — a player who closes the tab
    /// or suspects their key leaked should not have to wait it out. Wallet-only
    /// on purpose: a session key cannot revoke itself, because a stolen one
    /// would then be able to lock the real owner out of their own seat.
    pub fn close_session(ctx: Context<Session>) -> Result<()> {
        let signer = ctx.accounts.player.key();
        let log = &ctx.accounts.log;
        let seat = if signer == log.players[0] {
            0usize
        } else if signer == log.players[1] {
            1usize
        } else {
            return err!(RollupError::NotAPlayer);
        };
        let log = &mut ctx.accounts.log;
        log.session_signers[seat] = Pubkey::default();
        log.session_expires[seat] = 0;
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
        //
        // The signer may be the seat's wallet or the temporary key that seat
        // authorised. `seat_for` resolves which, and returns the seat index
        // rather than a yes/no so a session write cannot be attributed to the
        // wrong player — that would be worse than refusing it.
        //
        // The account list is deliberately unchanged. Widening authority is a
        // change to who may sign, not to what must be passed, and every existing
        // caller keeps working.
        let now = Clock::get()?.unix_timestamp;
        let seat = log.seat_for(&signer, now).ok_or(RollupError::NotAPlayer)?;

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
        let now = Clock::get()?.unix_timestamp;
        let log = &mut ctx.accounts.log;
        require!(!log.ended, RollupError::AlreadyEnded);
        require!(log.seat_for(&signer, now).is_some(), RollupError::NotAPlayer);
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
        let seat: usize;
        {
            let signer = ctx.accounts.payer.key();
            let log = &ctx.accounts.log;
            require!(!log.ended, RollupError::AlreadyEnded);
            require!(
                signer == log.players[0] || signer == log.players[1],
                RollupError::NotAPlayer
            );
            seat = if signer == log.players[0] { 0 } else { 1 };
        }

        /*
         * One seat's word ends nothing.
         *
         * This used to seal on the first call with whatever winner the caller
         * named — so a loser quick on the trigger could declare themselves
         * winner and, by passing their own rail, take the chest that pays for
         * a real card mint. Now each seat records a claim; the log seals when
         * the second one lands. Agreement grants the chest and commits that
         * winner; disagreement seals as disputed (3) and grants nothing —
         * the same shape `settle_from_log` enforces for the pot, because a
         * result one party declares alone is not a result.
         */
        {
            let log = &mut ctx.accounts.log;
            require!(log.claims[seat] == 3, RollupError::AlreadyEnded);
            log.claims[seat] = winner;
            let other = log.claims[1 - seat];
            if other == 3 {
                // First claim: record it and stay delegated for the second.
                log.exit(&crate::ID)?;
                return Ok(());
            }
        }
        let agreed = ctx.accounts.log.claims[0] == ctx.accounts.log.claims[1];
        let winner = if agreed { ctx.accounts.log.claims[0] } else { 3 };

        // Grant the winner their one chest, here and nowhere else.
        //
        // It has to happen inside this instruction: the log is delegated to
        // the rollup right up until the `commit_and_undelegate` below, and the
        // chest rails live on the rollup too, so this is the only moment both
        // are readable in one transaction. Afterwards the log is on the base
        // layer and the rails are not, and no instruction can see both.
        //
        // Optional, and deliberately not fatal when absent.
        //
        // A player's rail is created lazily, so the very first match a wallet
        // ever wins can end before the rail exists — and settlement failing
        // because a *reward* account was missing would be a far worse defect
        // than the one this is fixing. When the account is supplied it must be
        // the winner's, which is the part that actually matters: a wrong rail
        // is refused, never credited.
        //
        // Residual: a loser who hand-builds `end_log` without the account
        // denies the winner one chest. They gain nothing by it, and the pot is
        // untouched — worth accepting to keep settlement unconditional.
        if agreed && winner < 2 {
            let expected = ctx.accounts.log.players[winner as usize];
            if let Some(chests) = ctx.accounts.winner_chests.as_mut() {
                require_keys_eq!(chests.owner, expected, RollupError::NotAPlayer);
                // Capped rather than saturating at u16: entitlements are meant
                // to be spent, and an unbounded balance is a backlog nobody
                // reconciles.
                chests.earned = (chests.earned + 1).min(MAX_UNSPENT_CHESTS);
                chests.exit(&crate::ID)?;
            }
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
        c.earned = 0;
        c.bump = ctx.bumps.chests;
        Ok(())
    }


    /// Base layer. Reclaims a chest rail so it can be recreated.
    ///
    /// Exists because `PlayerChests` gained the `earned` counter, and a rail
    /// written under the previous layout is a fixed-size account two bytes
    /// short of what the new struct deserialises — every read of it fails, and
    /// `init_chests` will not touch an address that already exists. Without a
    /// way out, a wallet that had ever opened a chest could never open another.
    ///
    /// Owner-only and base-layer-only: the account must be undelegated first
    /// (`commit_chests`), so this can never race a live roll. `AccountInfo`
    /// rather than `Account<PlayerChests>` on purpose — the whole point is to
    /// close accounts that no longer deserialise.
    pub fn close_chests(ctx: Context<CloseChests>) -> Result<()> {
        let rail = &ctx.accounts.chests;
        let owner = &ctx.accounts.owner;

        let lamports = rail.lamports();
        **rail.try_borrow_mut_lamports()? = 0;
        **owner.to_account_info().try_borrow_mut_lamports()? += lamports;
        rail.assign(&system_program::ID);
        rail.resize(0)?;
        Ok(())
    }

    /// Base layer. Hands the rail to an ephemeral rollup.
    pub fn delegate_chests(ctx: Context<DelegateChests>) -> Result<()> {
        ctx.accounts.delegate_chests(
            &ctx.accounts.owner,
            &[b"chests", ctx.accounts.owner.key.as_ref()],
            DelegateConfig {
                /*
                 * Router-assigned, never caller-named.
                 *
                 * A delegated account's authority is what computes and commits
                 * its state, so letting the rail's own owner name the validator
                 * let them pick who authors `earned`, every slot's `tier`, and
                 * the randomness behind it — the chest economy written by its
                 * beneficiary.
                 */
                validator: None,
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
            // A chest costs a win. Until this check existed the loop
            // request → claim → request minted drops indefinitely, and the
            // rule that made them scarce lived only in the client.
            require!(c.earned > 0, RollupError::NoChestEarned);
        }

        let nonce = {
            let c = &mut ctx.accounts.chests;
            // Spent up front, not on the callback. A request that the oracle
            // never answers is recovered through the timeout path, which
            // refunds the entitlement — whereas charging on delivery would
            // let a player cancel and re-request on a roll they could see.
            c.earned -= 1;
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
        // Give the entitlement back. `request_chest` spends it on the way in,
        // so an oracle that never answered would otherwise cost the player the
        // win they earned. This is not a free re-roll: the drop was never
        // revealed, and the timeout is long enough that stalling deliberately
        // is not a strategy.
        c.earned = (c.earned + 1).min(MAX_UNSPENT_CHESTS);
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
        // Refuse while a roll is outstanding — undelegating mid-flight sends
        // the oracle's callback to an account that is no longer here. Read by
        // hand rather than through `Account<T>` so a stale-layout rail can
        // still be brought home; one that cannot be parsed cannot have a live
        // request either, since nothing could have written one.
        {
            let data = ctx.accounts.chests.try_borrow_data()?;
            if let Ok(rail) = PlayerChests::try_deserialize(&mut &data[..]) {
                require!(rail.owner == ctx.accounts.owner.key(), RollupError::NotAPlayer);
                require!(rail.idle(), RollupError::RequestInFlight);
            }
        }
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
    /// A temporary signer each seat may authorise to write on its behalf.
    ///
    /// Kept on the log rather than in a separate session account for two
    /// reasons. The log is already delegated to the rollup, so the session is
    /// readable exactly where `play_card` runs — a session account created
    /// elsewhere would have to be delegated to the same validator, and getting
    /// that wrong fails mid-match. And a session stored here is scoped to *one
    /// match* by construction: there is nowhere for it to be replayed.
    ///
    /// `Pubkey::default()` means no session.
    pub session_signers: [Pubkey; 2],
    /// Unix seconds each session stops being accepted. Enforced on-chain; a UI
    /// timer is not a security control.
    pub session_expires: [i64; 2],
    /// Each seat's claimed result: 0/1 a seat index, 2 a draw, 3 "has not
    /// spoken". Mirrors the base program's design for the same reason it has
    /// it — a result one party declares alone is not a result.
    pub claims: [u8; 2],
}
impl MatchLog {
    pub const SIZE: usize =
        8 + 8 + 64 + 4 + (MAX_PLAYS * PlayEntry::SIZE) + 4 + 8 + 2 + 1 + 1 + 1
        + 64  // session_signers
        + 16  // session_expires
        + 2; // claims

    /// The seat this key may write for, if any, honouring expiry.
    ///
    /// Returns the seat index rather than a bool so the caller cannot forget to
    /// attribute the play to the right player — attributing a session write to
    /// the wrong seat would be worse than rejecting it.
    pub fn seat_for(&self, key: &Pubkey, now: i64) -> Option<u8> {
        for (i, p) in self.players.iter().enumerate() {
            if p == key {
                return Some(i as u8);
            }
        }
        for (i, s) in self.session_signers.iter().enumerate() {
            if s == key && *s != Pubkey::default() && now < self.session_expires[i] {
                return Some(i as u8);
            }
        }
        None
    }
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct InitLog<'info> {
    /// CHECK: the escrowed match this log belongs to. Not deserialized as a
    /// typed account because it belongs to `mempire`, so it is pinned three
    /// ways instead: owned by that program, at that program's own `match` PDA
    /// for this `match_id`, and re-checked field-by-field in the handler.
    /// `init_log` runs on base layer, where this account is readable.
    #[account(
        owner = MEMPIRE_PROGRAM_ID,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump,
        seeds::program = MEMPIRE_PROGRAM_ID,
    )]
    pub match_account: UncheckedAccount<'info>,

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
    /// The winner's chest rail, so the win can pay out an entitlement.
    ///
    /// Optional in the struct and required by the instruction whenever there
    /// is a winner — a draw has nobody to pay, and making it `Option` is what
    /// lets a draw be ended without inventing an account to satisfy the type.
    #[account(
        mut,
        seeds = [b"chests", winner_chests.owner.as_ref()],
        bump = winner_chests.bump,
    )]
    pub winner_chests: Option<Account<'info, PlayerChests>>,
}

/// Opening or closing a session. Wallet-only: the `player` here must be a seat,
/// never a session key, or a stolen key could extend or revoke itself.
#[derive(Accounts)]
pub struct Session<'info> {
    #[account(
        mut,
        seeds = [b"log", log.match_id.to_le_bytes().as_ref()],
        bump = log.bump,
    )]
    pub log: Account<'info, MatchLog>,
    pub player: Signer<'info>,
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

#[derive(Accounts)]
pub struct CloseChests<'info> {
    /// CHECK: PDA checked by seeds; deliberately untyped so a rail written
    /// under an older layout — which is the reason this instruction exists —
    /// can still be closed.
    #[account(mut, seeds = [b"chests", owner.key().as_ref()], bump)]
    pub chests: AccountInfo<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateChests<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the rail PDA being delegated; seeds match the account definition.
    #[account(mut, del, seeds = [b"chests", owner.key().as_ref()], bump)]
    pub chests: AccountInfo<'info>,
    /// CHECK: accepted for wire compatibility and deliberately ignored — the
    /// validator is router-assigned. See `delegate_chests`.
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
/// Emitted when a seat authorises a temporary signer, so the delegation is
/// visible on-chain rather than only in the client that created it.
#[event]
pub struct SessionOpened {
    pub match_id: u64,
    pub seat: u8,
    pub session_signer: Pubkey,
    pub expires_at: i64,
}

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
    /// CHECK: the PDA seeds bind this to `owner`, which is the same guarantee
    /// `has_one` gave. Untyped on purpose: undelegating is how an account
    /// written under a previous layout gets back to base layer to be fixed,
    /// and a typed account would refuse to deserialise exactly then — leaving
    /// the rail stranded on the rollup with no way home.
    #[account(mut, seeds = [b"chests", owner.key().as_ref()], bump)]
    pub chests: AccountInfo<'info>,
}

#[error_code]
pub enum RollupError {
    #[msg("signer is not a player in this match")]
    NotAPlayer,
    #[msg("match already ended")]
    AlreadyEnded,
    #[msg("no unopened chest earned; win a match first")]
    NoChestEarned,
    #[msg("match has not ended yet")]
    NotEnded,
    #[msg("session key is invalid, expired, or would collide with a seat")]
    BadSession,
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

#[cfg(test)]
mod session_tests {
    use super::*;

    fn log_with(sessions: [Pubkey; 2], expires: [i64; 2]) -> MatchLog {
        MatchLog {
            match_id: 1,
            players: [Pubkey::new_unique(), Pubkey::new_unique()],
            plays: Vec::new(),
            last_tick: 0,
            last_hash: 0,
            checkpoints: 0,
            ended: false,
            winner: u8::MAX,
            bump: 255,
            session_signers: sessions,
            session_expires: expires,
            claims: [3; 2],
        }
    }

    #[test]
    fn a_seat_always_writes_for_itself() {
        let log = log_with([Pubkey::default(); 2], [0; 2]);
        assert_eq!(log.seat_for(&log.players[0], 0), Some(0));
        assert_eq!(log.seat_for(&log.players[1], 0), Some(1));
    }

    #[test]
    fn a_live_session_writes_for_the_seat_that_opened_it() {
        let key = Pubkey::new_unique();
        let mut log = log_with([Pubkey::default(); 2], [0; 2]);
        log.session_signers[1] = key;
        log.session_expires[1] = 100;
        // Attributed to seat 1, not merely accepted — a session write landing on
        // the wrong seat would corrupt the match rather than fail it.
        assert_eq!(log.seat_for(&key, 50), Some(1));
    }

    #[test]
    fn an_expired_session_is_refused() {
        let key = Pubkey::new_unique();
        let mut log = log_with([Pubkey::default(); 2], [0; 2]);
        log.session_signers[0] = key;
        log.session_expires[0] = 100;
        assert_eq!(log.seat_for(&key, 99), Some(0));
        assert_eq!(log.seat_for(&key, 100), None, "expiry is inclusive of the deadline");
        assert_eq!(log.seat_for(&key, 101), None);
    }

    #[test]
    fn a_revoked_session_is_refused() {
        let key = Pubkey::new_unique();
        let mut log = log_with([key, Pubkey::default()], [i64::MAX, 0]);
        assert_eq!(log.seat_for(&key, 0), Some(0));
        log.session_signers[0] = Pubkey::default();
        log.session_expires[0] = 0;
        assert_eq!(log.seat_for(&key, 0), None);
    }

    #[test]
    fn the_default_pubkey_is_never_a_valid_session() {
        // Both slots are empty, and an empty slot is Pubkey::default(). If that
        // matched, anyone could sign as the zero key and write for both seats.
        let log = log_with([Pubkey::default(); 2], [i64::MAX; 2]);
        assert_eq!(log.seat_for(&Pubkey::default(), 0), None);
    }

    #[test]
    fn a_stranger_is_refused() {
        let log = log_with([Pubkey::new_unique(), Pubkey::new_unique()], [i64::MAX; 2]);
        assert_eq!(log.seat_for(&Pubkey::new_unique(), 0), None);
    }

    #[test]
    fn one_seats_session_cannot_write_for_the_other() {
        let a = Pubkey::new_unique();
        let log = log_with([a, Pubkey::new_unique()], [i64::MAX; 2]);
        // Seat 0's key resolves to seat 0 and nothing else.
        assert_eq!(log.seat_for(&a, 0), Some(0));
    }
}
