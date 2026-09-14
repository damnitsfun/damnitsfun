// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VenusYieldSource} from "../src/VenusYieldSource.sol";
import {DamnitsVault} from "../src/DamnitsVault.sol";

/**
 * T131 — the adapter against the REAL Venus, on a pinned chain-97 fork.
 *
 * Rule 6 applied to somebody else's code. {VenusYieldSourceTest} proves the
 * adapter agrees with a mock we wrote, which only proves it agrees with our
 * assumptions. This drives the actual vBNB contract — 39,686 characters of
 * Compound-derived Solidity nobody here wrote — and finds out whether those
 * assumptions were right.
 *
 * **On pinning.** A pinned block is the right default for a fork test — a subject
 * that moves fails for reasons unrelated to the code. It is not available here:
 * BNB Chain's public testnet RPCs are **not archive nodes** and prune old state,
 * so forking even a day back returns `missing trie node`. Measured, not assumed —
 * block 130,705,041 (which holds T126's real deposit) was already unreachable
 * hours later.
 *
 * So this forks the **head** by default, and `VENUS_FORK_BLOCK` pins it for anyone
 * with an archive endpoint. The trade is stated rather than hidden: at the head
 * this proves the adapter works against Venus *today*, which is the property that
 * actually matters, and it can drift for reasons outside the repo.
 *
 * **Skips itself, loudly, when BSC_TESTNET_RPC_URL is unset** — a fork test needs
 * network access, and `yarn test` from a clean install must not depend on it.
 *
 *   BSC_TESTNET_RPC_URL=https://... forge test --match-contract VenusForkTest -vv
 */
contract VenusForkTest is Test {
    address internal constant VBNB = 0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c;

    DamnitsVault internal vault;
    VenusYieldSource internal src;

    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant SEASON = keccak256("comp_fork_1");
    uint256 internal constant DEPOSIT = 0.001 ether;
    bytes32 internal constant ROOT = keccak256("root");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        // Pin only if asked, because the public RPCs cannot serve old state.
        uint256 pinned = vm.envOr("VENUS_FORK_BLOCK", uint256(0));
        if (pinned == 0) {
            try vm.createSelectFork(rpc) {
                forked = true;
            } catch {
                return; // an unreachable RPC skips, it does not fail the suite
            }
        } else {
            try vm.createSelectFork(rpc, pinned) {
                forked = true;
            } catch {
                return;
            }
        }

        vault = new DamnitsVault(operator, treasury);
        src = new VenusYieldSource(VBNB, address(vault));
    }

    modifier onlyForked() {
        if (!forked) {
            console.log("SKIPPED - set BSC_TESTNET_RPC_URL to run the Venus fork test");
            return;
        }
        _;
    }

    function _openAndStake(uint256 count) internal {
        vm.prank(operator);
        vault.openSeason(
            SEASON, DEPOSIT, block.timestamp + 1 days, block.timestamp + 7 days, address(src)
        );
        for (uint256 i = 0; i < count; i++) {
            address who = makeAddr(string.concat("agent", vm.toString(i)));
            vm.deal(who, 1 ether);
            vm.prank(who);
            vault.deposit{value: DEPOSIT}(SEASON);
        }
        vm.prank(operator);
        vault.closeRegistration(SEASON);
    }

    /// The market is real, has code, and holds liquidity.
    function test_venusIsRealOnChain97() public onlyForked {
        // 19,842 BYTES — the "39,686 characters" in the spec is the hex string,
        // which is two characters per byte. Measured here, so the number in the
        // docs is checkable rather than merely quoted.
        assertGt(VBNB.code.length, 15_000, "vBNB should be a large Compound-style contract");
        assertGt(VBNB.balance, 0, "the market should hold BNB");
        console.log("vBNB code size (bytes):", VBNB.code.length);
        console.log("vBNB balance     (wei):", VBNB.balance);
    }

    /**
     * A finding this fork test exists to produce, and the mock could never have
     * shown: **immediately after staking, the position reads marginally BELOW what
     * went in.** Two causes, both inherent to Compound-style markets:
     *
     *   - `mint` converts value to vTokens by integer division, losing dust;
     *   - `exchangeRateStored` does not accrue, so it lags until someone touches
     *     the market.
     *
     * Measured at the head: 0.003 tBNB in reads back as 0.002999994125297471 —
     * about **2 parts per million** light. It recovers the moment any interest
     * accrues, which is why {test_aRealRoundTripReturnsEveryDeposit} still gets
     * every deposit back in full after time passes.
     *
     * The practical consequence is narrow but worth naming: a season that staked
     * and resolved within the same block could record a rounding-sized shortfall.
     * The vault handles that correctly — pro-rata refunds, never blocked, and
     * `topUp` open to anyone — so this is a documented edge, not a defect.
     */
    function test_theViewReadsMarginallyLowImmediatelyAfterStaking() public onlyForked {
        _openAndStake(3);
        uint256 staked = DEPOSIT * 3;
        uint256 seen = src.balanceOf(SEASON);

        assertLe(seen, staked, "the view must never overstate what it can pay");
        // Within 0.01% — dust and a stale rate, not a loss.
        assertGe(seen, staked - (staked / 10_000), "but only by rounding");
        console.log("staked (wei) :", staked);
        console.log("reads  (wei) :", seen);
        console.log("short  (wei) :", staked - seen);
    }

    /**
     * The one that matters: real deposits, real withdrawal, deposits come back.
     * If the real contract behaves differently from our mock, it fails here rather
     * than on production.
     */
    function test_aRealRoundTripReturnsEveryDeposit() public onlyForked {
        _openAndStake(3);

        uint256 staked = DEPOSIT * 3;
        assertEq(src.principalOf(SEASON), staked, "principal recorded");

        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 28_800);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vault.resolve(SEASON, winners, amounts, ROOT);

        for (uint256 i = 0; i < 3; i++) {
            address who = makeAddr(string.concat("agent", vm.toString(i)));
            assertEq(vault.owed(who), DEPOSIT, "real Venus returned this deposit in full");
        }
        console.log("swept to treasury (wei):", vault.owed(treasury));
    }

    /// A depositor can actually take the money out, not merely be owed it.
    function test_aDepositorCanWithdrawAfterARealRedeem() public onlyForked {
        _openAndStake(2);
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 28_800);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vault.resolve(SEASON, winners, amounts, ROOT);

        address who = makeAddr("agent0");
        uint256 before = who.balance;
        vm.prank(who);
        vault.withdraw();
        assertEq(who.balance - before, DEPOSIT, "refunded to the wei, from real Venus");
    }

    /**
     * The public exit works against the real protocol too. It is the promise this
     * whole spec rests on, so it is proven where the money actually is.
     */
    function test_exitStaleUnwindsRealVenusForANonOperator() public onlyForked {
        _openAndStake(2);
        vm.warp(block.timestamp + 8 days);
        vm.roll(block.number + 230_400);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.exitStale(SEASON);

        assertEq(vault.owed(makeAddr("agent0")), DEPOSIT);
        assertEq(vault.owed(makeAddr("agent1")), DEPOSIT);
    }
}
