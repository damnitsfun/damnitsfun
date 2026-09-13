// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IYieldSource} from "./IYieldSource.sol";

/// @dev The slice of Venus's vBNB market this adapter uses. Compound-style.
interface IVBNB {
    /// @notice Supply native value. vBNB's mint takes the value and returns nothing.
    function mint() external payable;
    /// @notice Redeem vTokens for native value. **Returns an error code, 0 = success.**
    function redeem(uint256 redeemTokens) external returns (uint256);
    /// @notice Redeem an exact amount of native value. **Returns an error code, 0 = success.**
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
}

/**
 * @title VenusYieldSource
 * @notice {IYieldSource} over Venus's vBNB market (sub-spec 24, D183/D184).
 *
 * @dev Why Venus and not the one that pays more. Selection is **exit speed first,
 *      rate second**: a season pays its winners the moment it resolves, and
 *      `DamnitsVault.exitStale` must return every deposit the second its deadline
 *      passes — so a protocol with a multi-day unstake is unusable here at any
 *      rate, on any network. Lista pays about seven times more and takes 7 days to
 *      leave; native staking takes 3 days and wants 1 BNB. Venus is instant. On
 *      chain 97 it is also the only one actually deployed and earning.
 *
 * @dev **Venus reports failure by returning a number, not by reverting.** Zero
 *      means it worked; anything else means the money did not move and naive code
 *      carries on believing it did. This was measured, not assumed — T126 ran a
 *      real 0.1 tBNB round trip on chain 97 and both calls returned 0:
 *        mint    0xabb09a6eae6c8e0fdefe473cff9d9faab942cf3d9298f0dd62fe9d003cc626fc
 *        redeem  0xf2fe6f5178e39fd9b1cb3fc99c6a2a9a367dec3a2268612cf72b6527976f6da3
 *      Every call here checks that code and reverts on a non-zero one.
 *
 * @dev The market address is a constructor argument, never a constant. Swapping
 *      protocol is a deploy and a config line; no other layer knows which one is
 *      behind the interface.
 *
 * @dev One vault, one adapter. `stake` is restricted to the vault so a stranger
 *      cannot mix native value into a season's principal and distort a refund.
 */
contract VenusYieldSource is IYieldSource {
    /// @notice Venus's error codes are enum indices; 0 is NO_ERROR.
    uint256 private constant NO_ERROR = 0;

    IVBNB public immutable vbnb;
    /// @notice The only address allowed to stake or redeem — the vault.
    address public immutable vault;

    /// @notice Native value staked per season, as it went in.
    mapping(bytes32 => uint256) public principalOf;

    event Staked(bytes32 indexed seasonId, uint256 amount);
    event Redeemed(bytes32 indexed seasonId, uint256 principal, uint256 returnedAmount);

    error NotVault();
    error ZeroAddress();
    error NothingStaked();
    error AlreadyStaked();
    error VenusError(uint256 code);
    error TransferFailed();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(address _vbnb, address _vault) {
        if (_vbnb == address(0) || _vault == address(0)) revert ZeroAddress();
        vbnb = IVBNB(_vbnb);
        vault = _vault;
    }

    function stake(bytes32 seasonId) external payable onlyVault {
        if (principalOf[seasonId] != 0) revert AlreadyStaked();
        principalOf[seasonId] = msg.value;
        // vBNB's mint is `payable` and returns nothing — it reverts on failure,
        // unlike the redeem pair below. There is no code to check here.
        vbnb.mint{value: msg.value}();
        emit Staked(seasonId, msg.value);
    }

    /**
     * @notice Pull this season's money back out and send it to the vault.
     * @dev Redeems by **vToken balance**, not by underlying amount, so whatever the
     *      position is actually worth comes back — principal and interest together,
     *      with no leftover position and no second call to chase the difference.
     *      The vault measures its own balance delta anyway, so an over-report here
     *      cannot inflate a refund.
     */
    function redeem(bytes32 seasonId) external onlyVault returns (uint256 returned) {
        uint256 principal = principalOf[seasonId];
        if (principal == 0) revert NothingStaked();
        principalOf[seasonId] = 0;

        uint256 before = address(this).balance;
        uint256 vTokens = vbnb.balanceOf(address(this));

        // THE check. A non-zero code means the withdrawal silently did nothing.
        uint256 code = vbnb.redeem(vTokens);
        if (code != NO_ERROR) revert VenusError(code);

        returned = address(this).balance - before;
        (bool ok,) = vault.call{value: returned}("");
        if (!ok) revert TransferFailed();

        emit Redeemed(seasonId, principal, returned);
    }

    /// @notice What this season is worth right now, principal plus interest.
    function balanceOf(bytes32 seasonId) external view returns (uint256) {
        if (principalOf[seasonId] == 0) return 0;
        // Compound's stored rate is scaled by 1e18; it lags until someone accrues,
        // which makes this a floor rather than an overstatement. A view that reads
        // low is safe; one that reads high would promise interest we cannot pay.
        return (vbnb.balanceOf(address(this)) * vbnb.exchangeRateStored()) / 1e18;
    }

    /// @dev Venus sends BNB back here during redeem. Without this it reverts.
    receive() external payable {}
}
