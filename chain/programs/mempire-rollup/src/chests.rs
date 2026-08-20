//! Treasure chests, rolled by MagicBlock VRF.
//!
//! # Why this is onchain at all
//!
//! Chests are the one place in Mempire where the house decides what a player
//! gets. Everything else — card power, match outcome, payout — is either a
//! function of what the player staked or of how they played, and both are
//! verifiable. A chest tier picked by `Math.random()` in the client is not, and
//! in a game that also holds real SOL that is exactly the mechanic people are
//! right to be suspicious of.
//!
//! So the roll is a VRF request and the randomness that produced it is stored
//! on the chest. Anyone can re-derive the drop from those 32 bytes.
//!
//! # Why on the rollup rather than base layer
//!
//! MagicBlock prices ER randomness at zero and base-layer randomness at
//! 0.0008 SOL per request (docs: pricing, VRF). A player opening four chests a
//! session would otherwise pay a meaningful fraction of a Pauper-tier stake in
//! oracle fees for cosmetics. Requesting from inside the rollup also means the
//! queue is `DEFAULT_EPHEMERAL_QUEUE` — the delegated queue — because a
//! transaction running on the ER can only write a queue that lives there.
//!
//! # The lifecycle this enforces
//!
//! `empty → pending(nonce) → filled`, with one live request per player and an
//! explicit timeout. A request that is accepted is not an outcome: the oracle
//! calls back separately, and until it does the chest reads as pending rather
//! than as anything a player can spend.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::consts::{DEFAULT_EPHEMERAL_QUEUE, DEFAULT_EPHEMERAL_TEST_QUEUE};
use ephemeral_rollups_sdk::vrf::rnd::random_u8_with_range;

/// Four slots, matching the client's chest rail.
pub const CHEST_SLOTS: usize = 4;

/// Slots a request may stay pending before anyone can clear it.
///
/// The rollup runs at roughly 50ms a slot, so this is on the order of a minute
/// — long enough that a healthy oracle is never cancelled out from under, short
/// enough that a player is not locked out of their own rail by one lost
/// callback.
pub const REQUEST_TIMEOUT_SLOTS: u64 = 1_200;

/// Chest tiers, and the weights the roll uses. Mirrors `CHESTS` in the client
/// so the odds a player is shown are the odds the chain applies.
pub const TIER_WEIGHTS: [(u8, u8); 4] = [
    (0, 62), // silver
    (1, 26), // golden
    (2, 9),  // magic
    (3, 3),  // legendary
];

pub const STATE_EMPTY: u8 = 0;
pub const STATE_PENDING: u8 = 1;
pub const STATE_FILLED: u8 = 2;

/// One slot on the rail.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Chest {
    pub state: u8,
    pub tier: u8,
    /// The nonce of the request that filled (or is filling) this slot. Kept
    /// after fulfilment so a support question about a specific drop can be
    /// answered from the account alone.
    pub nonce: u64,
    /// The oracle's randomness, verbatim.
    ///
    /// Stored rather than consumed so the *contents* stay derivable off-chain:
    /// the client expands these bytes into card drops with a documented rule,
    /// and any third party can repeat that expansion and get the same answer.
    /// Putting the card list on-chain instead would cost a much larger account
    /// and buy nothing that this does not.
    pub randomness: [u8; 32],
}

impl Chest {
    pub const SIZE: usize = 1 + 1 + 8 + 32;
}

/// A player's chest rail. Delegated to the rollup so opens are free and fast.
#[account]
pub struct PlayerChests {
    pub owner: Pubkey,
    pub slots: [Chest; CHEST_SLOTS],
    /// Monotonic request counter. Never reused, so a late callback from a
    /// cancelled request can always be told apart from the live one.
    pub nonce: u64,
    /// Slot index of the live request, or `u8::MAX` when idle.
    pub pending_slot: u8,
    /// Nonce of the live request. Meaningless while idle.
    pub pending_nonce: u64,
    /// Rollup slot the live request was made at, for the timeout path.
    pub requested_at: u64,
    /// Lifetime chests filled. Purely for display and reconciliation.
    pub opened: u32,
    /// Unspent chest entitlements — wins that have not been rolled yet.
    ///
    /// This is what makes a chest cost something. Without it `request_chest`
    /// only checked that the rail was idle and the slot empty, so anyone could
    /// loop request → claim → request and mint drops forever; "one chest per
    /// win" lived in the client, where it was a suggestion. Granted by
    /// `end_log` to the seat that actually won, spent by `request_chest`.
    pub earned: u16,
    pub bump: u8,
}

impl PlayerChests {
    pub const SIZE: usize =
        8 + 32 + (CHEST_SLOTS * Chest::SIZE) + 8 + 1 + 8 + 8 + 4 + 2 + 1;

    pub fn idle(&self) -> bool {
        self.pending_slot == u8::MAX
    }
}

/// Weighted tier from one byte of oracle randomness.
///
/// Takes the roll as a parameter rather than the raw bytes so the weighting is
/// unit-testable without an oracle.
pub fn tier_for_roll(roll: u8) -> u8 {
    let mut acc = 0u8;
    for (tier, weight) in TIER_WEIGHTS {
        acc = acc.saturating_add(weight);
        if roll <= acc {
            return tier;
        }
    }
    // Unreachable while the weights total 100, but a silent wrong-tier drop is
    // worse than the cheapest possible tier.
    TIER_WEIGHTS[0].0
}

/// Expands the stored randomness into a tier. The callback's whole decision.
pub fn tier_from_randomness(randomness: &[u8; 32]) -> u8 {
    tier_for_roll(random_u8_with_range(randomness, 1, 100))
}

/// True when this queue is one a rollup transaction may write.
///
/// Only the two *delegated* queues qualify. Accepting the base-layer queue here
/// would build a request that cannot be served from where it runs, and the
/// failure would surface as a request that is simply never fulfilled.
pub fn is_ephemeral_queue(key: &Pubkey) -> bool {
    /*
     * The test queue's fulfiller is documented as usable by anyone — meaning
     * on mainnet, "verifiable randomness" that anyone can fulfil is chest
     * tiers chosen by whoever answers first. The mainnet build accepts only
     * the production oracle queue; dev and localnet keep the test queue
     * because that is what runs there.
     */
    #[cfg(feature = "mainnet")]
    { *key == DEFAULT_EPHEMERAL_QUEUE }
    #[cfg(not(feature = "mainnet"))]
    { *key == DEFAULT_EPHEMERAL_QUEUE || *key == DEFAULT_EPHEMERAL_TEST_QUEUE }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_total_one_hundred() {
        let total: u8 = TIER_WEIGHTS.iter().map(|(_, w)| w).sum();
        assert_eq!(total, 100, "tier weights must partition the 1..=100 roll");
    }

    #[test]
    fn every_roll_maps_into_a_tier_and_the_boundaries_are_where_the_odds_say() {
        // Silver 1-62, golden 63-88, magic 89-97, legendary 98-100.
        assert_eq!(tier_for_roll(1), 0);
        assert_eq!(tier_for_roll(62), 0);
        assert_eq!(tier_for_roll(63), 1);
        assert_eq!(tier_for_roll(88), 1);
        assert_eq!(tier_for_roll(89), 2);
        assert_eq!(tier_for_roll(97), 2);
        assert_eq!(tier_for_roll(98), 3);
        assert_eq!(tier_for_roll(100), 3);
    }

    #[test]
    fn the_distribution_matches_the_published_odds() {
        let mut counts = [0u32; 4];
        for roll in 1..=100u8 {
            counts[tier_for_roll(roll) as usize] += 1;
        }
        assert_eq!(counts, [62, 26, 9, 3]);
    }
}
