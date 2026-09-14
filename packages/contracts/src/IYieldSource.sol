// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IYieldSource
 * @notice The one seam between {DamnitsVault} and whatever protocol holds a
 *         season's deposits while it runs (sub-spec 24, D183).
 *
 * @dev The vault knows this interface and nothing else. Three things implement it:
 *      `address(0)` (off — the vault holds the money itself and earns nothing),
 *      {MockYieldSource} (predictable, with a fast demo rate), and a live adapter
 *      such as Venus over vBNB. Swapping providers is a constructor argument to
 *      {DamnitsVault.openSeason} and a deploy; no other layer knows which protocol
 *      is behind it.
 *
 * @dev Selection criterion, recorded here because it is easy to mistake for a
 *      hard-coded preference: **exit speed first, rate second**. A season pays its
 *      winners the moment it resolves, and {DamnitsVault.exitStale} must be able to
 *      return every deposit the second the deadline passes — so a protocol with a
 *      multi-day unstake is unusable here at any rate, on any network.
 *
 * @dev Implementations MUST send native value back to the caller during {redeem}
 *      (the vault measures its own balance delta rather than trusting the return
 *      value), and MUST NOT reduce a season's principal by a fee.
 */
interface IYieldSource {
    /// @notice Take `msg.value` and hold it under `seasonId` until {redeem}.
    function stake(bytes32 seasonId) external payable;

    /**
     * @notice Return everything held for `seasonId` — principal plus whatever it
     *         earned — to the caller as native value.
     * @return returned The amount sent back, as the source accounts for it. The
     *         vault treats this as a claim and verifies it against its own balance
     *         delta, so a source that over-reports cannot inflate a refund.
     */
    function redeem(bytes32 seasonId) external returns (uint256 returned);

    /// @notice What {redeem} would return right now, for display and tests.
    function balanceOf(bytes32 seasonId) external view returns (uint256);
}
