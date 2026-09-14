// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IYieldSource} from "./IYieldSource.sol";

/**
 * @title MockYieldSource
 * @notice A predictable {IYieldSource} for tests and for Demo Day (sub-spec 24, D183).
 *
 * @dev Why this exists at all. A season measured in days cannot be shown in five
 *      minutes, so the demo needs interest that visibly accrues on stage — and a
 *      demo that depends on somebody else's contract behaving is a demo that can
 *      fail in front of judges. {setRate} takes a per-second rate, so the same
 *      contract serves a realistic test and a deliberately absurd demo rate.
 *
 * @dev It cannot invent native value. Accrual is paid out of {fund}ed budget and
 *      is **capped at what the budget actually holds**, so an over-set rate yields
 *      less interest rather than reverting a season's refunds. This is the whole
 *      point: a yield source failing to earn must never be able to block a deposit
 *      coming back.
 */
contract MockYieldSource is IYieldSource {
    uint256 private constant RATE_DENOM = 1e18;

    address public owner;

    /// @notice Per-season principal, still staked.
    mapping(bytes32 => uint256) public principalOf;
    /// @notice When the season's principal was staked, for accrual.
    mapping(bytes32 => uint256) public stakedAt;

    /// @notice Interest is paid from here, never minted. Topped up by {fund}.
    uint256 public budget;
    /// @notice Interest per wei of principal per second, scaled by 1e18.
    uint256 public ratePerSecond;

    event Staked(bytes32 indexed seasonId, uint256 amount);
    event Redeemed(bytes32 indexed seasonId, uint256 principal, uint256 interest);
    event Funded(address indexed from, uint256 amount);
    event RateSet(uint256 ratePerSecond);

    error NotOwner();
    error NothingStaked();
    error AlreadyStaked();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 _ratePerSecond) payable {
        owner = msg.sender;
        ratePerSecond = _ratePerSecond;
        budget = msg.value;
        emit RateSet(_ratePerSecond);
    }

    /// @notice Add to the pot interest is paid from. Anyone may top it up.
    function fund() external payable {
        budget += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    function setRate(uint256 _ratePerSecond) external onlyOwner {
        ratePerSecond = _ratePerSecond;
        emit RateSet(_ratePerSecond);
    }

    function stake(bytes32 seasonId) external payable {
        if (principalOf[seasonId] != 0) revert AlreadyStaked();
        principalOf[seasonId] = msg.value;
        stakedAt[seasonId] = block.timestamp;
        emit Staked(seasonId, msg.value);
    }

    /// @dev Accrual is per season and never touches another season's principal.
    function accrued(bytes32 seasonId) public view returns (uint256) {
        uint256 principal = principalOf[seasonId];
        if (principal == 0) return 0;
        uint256 elapsed = block.timestamp - stakedAt[seasonId];
        uint256 interest = (principal * ratePerSecond * elapsed) / RATE_DENOM;
        return interest > budget ? budget : interest; // cannot invent native value
    }

    function balanceOf(bytes32 seasonId) external view returns (uint256) {
        return principalOf[seasonId] + accrued(seasonId);
    }

    function redeem(bytes32 seasonId) external returns (uint256 returned) {
        uint256 principal = principalOf[seasonId];
        if (principal == 0) revert NothingStaked();

        uint256 interest = accrued(seasonId);
        principalOf[seasonId] = 0;
        stakedAt[seasonId] = 0;
        budget -= interest;

        returned = principal + interest;
        (bool ok,) = msg.sender.call{value: returned}("");
        if (!ok) revert TransferFailed();

        emit Redeemed(seasonId, principal, interest);
    }

    receive() external payable {
        budget += msg.value;
        emit Funded(msg.sender, msg.value);
    }
}
