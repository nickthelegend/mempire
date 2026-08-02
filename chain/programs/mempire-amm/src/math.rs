//! The pool's arithmetic, kept apart from its plumbing so it can be tested
//! exhaustively without a validator.
//!
//! Everything here is integer-only and checked. There are no floats anywhere in
//! this program: a rounding difference of one lamport is a rounding difference
//! in somebody's money, and floats make that difference depend on the order the
//! optimiser happened to emit.
//!
//! Every intermediate widens to `u128` before multiplying. `reserve_in * 10_000`
//! overflows `u64` at roughly 1.8e15 base units — well inside the range a pool
//! with six-decimal USDC can reach — so the widening is load-bearing, not
//! defensive habit.

use anchor_lang::prelude::*;

/// Swap fee in basis points. 30 = 0.30%, the constant-product convention.
pub const FEE_BPS: u16 = 30;
pub const BPS_DENOM: u128 = 10_000;

/// Liquidity permanently burned by the first depositor.
///
/// Without it, the first LP can withdraw everything, leave 1 unit in the pool,
/// then donate directly to the vaults to make one LP token worth an arbitrary
/// amount — which lets them round every later depositor's share down to zero.
/// Locking a small amount forever makes the share price un-manipulable at the
/// bottom. This is the Uniswap V2 fix and it exists because the attack is real.
pub const MINIMUM_LIQUIDITY: u64 = 1_000;

#[error_code]
pub enum MathError {
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("pool has no liquidity")]
    NoLiquidity,
    #[msg("output below the minimum you asked for")]
    SlippageExceeded,
    #[msg("first deposit is too small to open a pool")]
    InsufficientInitialLiquidity,
}

/// Integer square root, by Newton's method.
///
/// Used for the first LP mint, where the share is `sqrt(base * quote)` so that
/// the pool's initial token count does not depend on which side is denominated
/// in what. Newton's method converges in a handful of iterations and, unlike a
/// float `sqrt`, gives exactly the same answer on every machine.
pub fn isqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Output of a constant-product swap, after fees.
///
/// `dy = (dx' * y) / (x + dx')` where `dx' = dx * (10000 - fee) / 10000`.
///
/// The fee is taken off the *input* before it touches the curve, which is what
/// leaves it in the pool as LP earnings rather than paying it out. Division is
/// floor throughout, so any dust rounds toward the pool and never toward the
/// trader — the invariant tests below assert exactly that.
pub fn swap_output(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u16,
) -> Result<u64> {
    require!(amount_in > 0, MathError::ZeroAmount);
    require!(reserve_in > 0 && reserve_out > 0, MathError::NoLiquidity);

    let amount_in = amount_in as u128;
    let reserve_in = reserve_in as u128;
    let reserve_out = reserve_out as u128;

    let after_fee = amount_in
        .checked_mul(BPS_DENOM - fee_bps as u128)
        .ok_or(MathError::Overflow)?;

    // Numerator and denominator both carry the ×10_000 from the fee so the
    // ratio stays exact; cancelling it early would round twice.
    let numerator = after_fee.checked_mul(reserve_out).ok_or(MathError::Overflow)?;
    let denominator = reserve_in
        .checked_mul(BPS_DENOM)
        .ok_or(MathError::Overflow)?
        .checked_add(after_fee)
        .ok_or(MathError::Overflow)?;

    let out = numerator / denominator;
    // A swap can never drain the pool: the curve is asymptotic, so this only
    // trips if the maths above is wrong. Cheap to assert, catastrophic to miss.
    require!(out < reserve_out, MathError::Overflow);
    Ok(out as u64)
}

/// LP tokens minted for a deposit.
///
/// First deposit: `sqrt(base * quote)`, minus the permanently locked minimum.
/// Later deposits: the smaller of the two proportional shares, which is what
/// forces a depositor to supply both sides at the pool's current ratio instead
/// of shifting the price for free.
pub fn liquidity_for_deposit(
    base_in: u64,
    quote_in: u64,
    reserve_base: u64,
    reserve_quote: u64,
    lp_supply: u64,
) -> Result<u64> {
    require!(base_in > 0 && quote_in > 0, MathError::ZeroAmount);

    if lp_supply == 0 {
        let product = (base_in as u128)
            .checked_mul(quote_in as u128)
            .ok_or(MathError::Overflow)?;
        let minted = isqrt(product);
        require!(
            minted > MINIMUM_LIQUIDITY as u128,
            MathError::InsufficientInitialLiquidity
        );
        return Ok((minted - MINIMUM_LIQUIDITY as u128) as u64);
    }

    require!(reserve_base > 0 && reserve_quote > 0, MathError::NoLiquidity);
    let from_base = (base_in as u128)
        .checked_mul(lp_supply as u128)
        .ok_or(MathError::Overflow)?
        / reserve_base as u128;
    let from_quote = (quote_in as u128)
        .checked_mul(lp_supply as u128)
        .ok_or(MathError::Overflow)?
        / reserve_quote as u128;
    Ok(from_base.min(from_quote) as u64)
}

/// Tokens returned for burning `lp_amount`, proportional to the pool.
pub fn withdraw_amounts(
    lp_amount: u64,
    reserve_base: u64,
    reserve_quote: u64,
    lp_supply: u64,
) -> Result<(u64, u64)> {
    require!(lp_amount > 0, MathError::ZeroAmount);
    require!(lp_supply > 0, MathError::NoLiquidity);
    require!(lp_amount <= lp_supply, MathError::Overflow);

    let base = (lp_amount as u128)
        .checked_mul(reserve_base as u128)
        .ok_or(MathError::Overflow)?
        / lp_supply as u128;
    let quote = (lp_amount as u128)
        .checked_mul(reserve_quote as u128)
        .ok_or(MathError::Overflow)?
        / lp_supply as u128;
    Ok((base as u64, quote as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole pool rests on: a swap never lowers `k`.
    ///
    /// If it ever did, value would be leaving the pool and every liquidity
    /// provider would be paying for each trade. Checked across a wide spread of
    /// reserve sizes and trade sizes rather than a couple of hand-picked cases,
    /// because the failure would be a rounding edge and rounding edges hide.
    #[test]
    fn k_never_decreases_across_a_swap() {
        let reserves = [1_000u64, 1_000_000, 1_000_000_000, 500_000_000_000];
        let inputs = [1u64, 7, 999, 100_000, 12_345_678];
        let mut checked = 0;

        for &x in &reserves {
            for &y in &reserves {
                for &dx in &inputs {
                    if dx > x / 2 {
                        continue; // absurd trades are a separate case, below
                    }
                    let dy = swap_output(dx, x, y, FEE_BPS).unwrap();
                    let k_before = x as u128 * y as u128;
                    let k_after = (x as u128 + dx as u128) * (y as u128 - dy as u128);
                    assert!(
                        k_after >= k_before,
                        "k fell: x={x} y={y} dx={dx} dy={dy} ({k_before} -> {k_after})"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 50, "the sweep did not actually run");
    }

    #[test]
    fn the_fee_is_the_only_thing_that_grows_k() {
        // With no fee, k should be preserved up to floor rounding — never more.
        let (x, y, dx) = (1_000_000u64, 1_000_000u64, 1_000u64);
        let free = swap_output(dx, x, y, 0).unwrap();
        let charged = swap_output(dx, x, y, FEE_BPS).unwrap();
        assert!(charged < free, "the fee did not reduce the output");
        // 0.3% of the input, roughly, at this size.
        let diff = free - charged;
        assert!((2..=5).contains(&diff), "fee moved output by {diff}, expected ~3");
    }

    #[test]
    fn rounding_always_favours_the_pool() {
        // Trader-favourable rounding is how a pool bleeds out one unit at a
        // time. Re-deriving the output from the post-trade reserves must never
        // show the trader got more than the curve allows.
        for dx in 1..500u64 {
            let (x, y) = (7_919u64, 104_729u64); // primes, to make dust likely
            let dy = swap_output(dx, x, y, FEE_BPS).unwrap();
            let k_before = x as u128 * y as u128;
            let k_after = (x + dx) as u128 * (y - dy) as u128;
            assert!(k_after >= k_before, "dx={dx} let value out");
        }
    }

    #[test]
    fn a_swap_can_never_empty_the_pool() {
        // The curve is asymptotic: even an enormous input leaves reserves.
        let out = swap_output(u64::MAX / 1_000_000, 1_000, 1_000_000, FEE_BPS).unwrap();
        assert!(out < 1_000_000, "a single swap drained the pool");
    }

    #[test]
    fn zero_and_empty_pools_are_refused_rather_than_returning_zero() {
        assert!(swap_output(0, 100, 100, FEE_BPS).is_err());
        assert!(swap_output(10, 0, 100, FEE_BPS).is_err());
        assert!(swap_output(10, 100, 0, FEE_BPS).is_err());
    }

    #[test]
    fn isqrt_is_exact_on_squares_and_floors_between_them() {
        for n in 0u128..1_000 {
            assert_eq!(isqrt(n * n), n, "isqrt({}) wrong", n * n);
            if n > 0 {
                assert_eq!(isqrt(n * n - 1), n - 1);
                assert_eq!(isqrt(n * n + 1), n);
            }
        }
        assert_eq!(isqrt(u64::MAX as u128), 4_294_967_295);
    }

    #[test]
    fn the_first_deposit_locks_the_minimum_forever() {
        let minted = liquidity_for_deposit(1_000_000, 1_000_000, 0, 0, 0).unwrap();
        // sqrt(1e6 * 1e6) = 1e6, minus the locked minimum.
        assert_eq!(minted, 1_000_000 - MINIMUM_LIQUIDITY);
    }

    #[test]
    fn a_dust_first_deposit_is_refused() {
        // Otherwise the pool opens with a share price that can be manipulated.
        assert!(liquidity_for_deposit(10, 10, 0, 0, 0).is_err());
    }

    #[test]
    fn an_unbalanced_deposit_is_priced_off_the_scarcer_side() {
        // Pool is 1:1. Depositing 2:1 must mint on the smaller share, so the
        // depositor cannot move the price by over-supplying one side.
        let lp = liquidity_for_deposit(2_000, 1_000, 100_000, 100_000, 100_000).unwrap();
        assert_eq!(lp, 1_000, "the deposit was priced off the generous side");
    }

    #[test]
    fn deposit_then_withdraw_never_returns_more_than_it_put_in() {
        // The round trip must not be a way to print tokens.
        let (rb, rq, supply) = (5_000_000u64, 3_000_000u64, 3_872_983u64);
        let lp = liquidity_for_deposit(500_000, 300_000, rb, rq, supply).unwrap();
        let (base, quote) =
            withdraw_amounts(lp, rb + 500_000, rq + 300_000, supply + lp).unwrap();
        assert!(base <= 500_000, "withdrew {base} base for 500000 in");
        assert!(quote <= 300_000, "withdrew {quote} quote for 300000 in");
    }

    #[test]
    fn withdrawing_everything_cannot_exceed_the_reserves() {
        let (base, quote) = withdraw_amounts(1_000, 12_345, 67_890, 1_000).unwrap();
        assert_eq!((base, quote), (12_345, 67_890));
    }

    #[test]
    fn withdrawing_more_lp_than_exists_is_refused() {
        assert!(withdraw_amounts(1_001, 100, 100, 1_000).is_err());
    }

    #[test]
    fn a_round_trip_swap_loses_the_fee_and_never_gains() {
        // Swap in and straight back out. The trader must end down by roughly
        // two fees, never up — a profitable round trip is free money.
        let (mut x, mut y) = (10_000_000u64, 10_000_000u64);
        let dx = 100_000u64;
        let dy = swap_output(dx, x, y, FEE_BPS).unwrap();
        x += dx;
        y -= dy;
        let back = swap_output(dy, y, x, FEE_BPS).unwrap();
        assert!(back < dx, "round trip returned {back} for {dx} — free money");
    }
}
