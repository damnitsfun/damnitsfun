// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DamnitsVault} from "../src/DamnitsVault.sol";
import {MockYieldSource} from "../src/MockYieldSource.sol";
import {IYieldSource} from "../src/IYieldSource.sol";

/// @dev A source that quietly hands back less than it took — the shortfall case.
contract LossyYieldSource is IYieldSource {
    mapping(bytes32 => uint256) public held;
    uint256 public lossBps;

    constructor(uint256 _lossBps) {
        lossBps = _lossBps;
    }

    function stake(bytes32 seasonId) external payable {
        held[seasonId] += msg.value;
    }

    function balanceOf(bytes32 seasonId) external view returns (uint256) {
        return held[seasonId] - (held[seasonId] * lossBps) / 10_000;
    }

    function redeem(bytes32 seasonId) external returns (uint256) {
        uint256 amount = held[seasonId];
        held[seasonId] = 0;
        uint256 give = amount - (amount * lossBps) / 10_000;
        (bool ok,) = msg.sender.call{value: give}("");
        require(ok, "send failed");
        return give;
    }
}

/// @dev Claims more than it delivers. The vault must believe its own balance.
contract LyingYieldSource is IYieldSource {
    mapping(bytes32 => uint256) public held;

    function stake(bytes32 seasonId) external payable {
        held[seasonId] += msg.value;
    }

    function balanceOf(bytes32 seasonId) external view returns (uint256) {
        return held[seasonId];
    }

    function redeem(bytes32 seasonId) external returns (uint256) {
        uint256 amount = held[seasonId];
        held[seasonId] = 0;
        (bool ok,) = msg.sender.call{value: amount / 2}("");
        require(ok, "send failed");
        return amount; // claims the lot, delivered half
    }
}

/// @dev Refuses payment, to prove one bad address cannot block anyone else.
contract RefusingRecipient {
    receive() external payable {
        revert("no thanks");
    }

    function tryWithdraw(DamnitsVault v) external {
        v.withdraw();
    }
}

/**
 * DamnitsVault test suite (T130, sub-spec 24).
 *
 * The ones that matter, in the spec's own words: every transition rejected in
 * every wrong state; a deposit after `registrationCloseAt` reverts even while the
 * state is still Registration; {exitStale} works from both Registration and Staked
 * after the deadline, reverts before it, and **succeeds when a non-operator calls
 * it**; pro-rata refund on a shortfall with {topUp} making it whole afterwards;
 * over-distribution rejected; and the invariant, fuzzed over a whole season:
 * `sum(deposits in) == sum(refunds) + treasury sweep + bounded dust`.
 */
contract DamnitsVaultTest is Test {
    DamnitsVault internal v;
    MockYieldSource internal src;

    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal sponsor = makeAddr("sponsor");
    address internal stranger = makeAddr("stranger");
    address internal payoutA = makeAddr("payoutA");
    address internal payoutB = makeAddr("payoutB");

    bytes32 internal constant SEASON = keccak256("comp_staked_1");
    bytes32 internal constant OTHER = keccak256("comp_staked_2");
    uint256 internal constant DEPOSIT = 0.001 ether;
    bytes32 internal constant ROOT = keccak256("final-leaderboard");

    uint256 internal closeAt;
    uint256 internal resolveBy;

    function setUp() public {
        v = new DamnitsVault(operator, treasury);
        // 1e12 per wei per second ≈ 0.0001%/s: visible in a test, absurd in a year.
        src = new MockYieldSource{value: 10 ether}(1e12);

        closeAt = block.timestamp + 1 days;
        resolveBy = block.timestamp + 7 days;

        vm.deal(sponsor, 100 ether);
        vm.deal(stranger, 10 ether);
        for (uint256 i = 0; i < 8; i++) {
            vm.deal(_agent(i), 1 ether);
        }

        vm.prank(operator);
        v.openSeason(SEASON, DEPOSIT, closeAt, resolveBy, address(src));
    }

    function _agent(uint256 i) internal returns (address) {
        return makeAddr(string.concat("agent", vm.toString(i)));
    }

    function _depositAll(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(SEASON);
        }
    }

    // ---- opening -------------------------------------------------------------

    function test_openSeason_isOneShot() public {
        vm.prank(operator);
        vm.expectRevert(DamnitsVault.SeasonExists.selector);
        v.openSeason(SEASON, DEPOSIT, closeAt, resolveBy, address(src));
    }

    function test_openSeason_rejectsDeadlinesOutOfOrder() public {
        vm.startPrank(operator);
        vm.expectRevert(DamnitsVault.DeadlinesOutOfOrder.selector);
        v.openSeason(OTHER, DEPOSIT, closeAt, closeAt, address(src));

        vm.expectRevert(DamnitsVault.DeadlinesOutOfOrder.selector);
        v.openSeason(OTHER, DEPOSIT, block.timestamp, resolveBy, address(src));
        vm.stopPrank();
    }

    function test_openSeason_onlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(DamnitsVault.NotOperator.selector);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(src));
    }

    function test_deadlinesAreReadableBeforeAnyoneDeposits() public view {
        (,,,, uint256 regClose, uint256 by,,,,) = v.getSeason(SEASON);
        assertEq(regClose, closeAt);
        assertEq(by, resolveBy);
    }

    // ---- deposits ------------------------------------------------------------

    function test_deposit_exactAmountOncePerWallet() public {
        vm.prank(_agent(0));
        v.deposit{value: DEPOSIT}(SEASON);

        vm.prank(_agent(0));
        vm.expectRevert(DamnitsVault.AlreadyDeposited.selector);
        v.deposit{value: DEPOSIT}(SEASON);

        vm.prank(_agent(1));
        vm.expectRevert(
            abi.encodeWithSelector(DamnitsVault.WrongDeposit.selector, DEPOSIT, DEPOSIT + 1)
        );
        v.deposit{value: DEPOSIT + 1}(SEASON);
    }

    /// The time check is the belt to the state check's braces (D187).
    function test_deposit_revertsAfterDeadlineEvenWhileStillRegistration() public {
        vm.warp(closeAt);
        (,,,,,,,, DamnitsVault.SeasonState state,) = v.getSeason(SEASON);
        assertEq(uint256(state), uint256(DamnitsVault.SeasonState.Registration));

        vm.prank(_agent(0));
        vm.expectRevert(DamnitsVault.RegistrationClosed.selector);
        v.deposit{value: DEPOSIT}(SEASON);
    }

    function test_deposit_revertsOnceStaked() public {
        _depositAll(2);
        vm.prank(operator);
        v.closeRegistration(SEASON);

        vm.prank(_agent(3));
        vm.expectRevert(DamnitsVault.NotRegistering.selector);
        v.deposit{value: DEPOSIT}(SEASON);
    }

    // ---- the product promise -------------------------------------------------

    /// The headline: play nothing, get everything back.
    function test_zeroTableDepositorIsRefundedInFull() public {
        _depositAll(3);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(block.timestamp + 2 days);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(SEASON, winners, amounts, ROOT);

        address idle = _agent(2);
        assertEq(v.owed(idle), DEPOSIT, "idle depositor must be owed its full stake");

        uint256 before = idle.balance;
        vm.prank(idle);
        v.withdraw();
        assertEq(idle.balance - before, DEPOSIT, "refunded to the wei");
    }

    function test_interestSweepsToTreasuryAndDepositsAreUntouched() public {
        _depositAll(4);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(block.timestamp + 3 days);

        uint256 staked = DEPOSIT * 4;
        uint256 expectedInterest = src.balanceOf(SEASON) - staked;
        assertGt(expectedInterest, 0, "mock must actually earn something");

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(SEASON, winners, amounts, ROOT);

        assertEq(v.owed(treasury), expectedInterest, "100% of interest to the treasury");
        for (uint256 i = 0; i < 4; i++) {
            assertEq(v.owed(_agent(i)), DEPOSIT, "no deposit is reduced by the interest");
        }
    }

    function test_prizesComeFromTheSponsorPotNotTheDeposits() public {
        _depositAll(3);
        vm.prank(sponsor);
        v.seedPot{value: 1 ether}(SEASON);
        vm.prank(operator);
        v.closeRegistration(SEASON);

        address[] memory winners = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        winners[0] = payoutA;
        winners[1] = payoutB;
        amounts[0] = 0.7 ether;
        amounts[1] = 0.3 ether;

        vm.prank(operator);
        v.resolve(SEASON, winners, amounts, ROOT);

        assertEq(v.owed(payoutA), 0.7 ether);
        assertEq(v.owed(payoutB), 0.3 ether);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(v.owed(_agent(i)), DEPOSIT, "prizes never come out of a deposit");
        }
    }

    function test_overDistributionRejected() public {
        _depositAll(3);
        vm.prank(sponsor);
        v.seedPot{value: 1 ether}(SEASON);
        vm.prank(operator);
        v.closeRegistration(SEASON);

        address[] memory winners = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        winners[0] = payoutA;
        amounts[0] = 1 ether + 1;

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(DamnitsVault.OverDistribution.selector, 1 ether, 1 ether + 1)
        );
        v.resolve(SEASON, winners, amounts, ROOT);
    }

    /// A deposit can never be spent on a prize, even with an empty pot.
    function test_cannotPayPrizesOutOfDepositsWhenPotIsEmpty() public {
        _depositAll(5);
        vm.prank(operator);
        v.closeRegistration(SEASON);

        address[] memory winners = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        winners[0] = payoutA;
        amounts[0] = 1;

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(DamnitsVault.OverDistribution.selector, 0, 1));
        v.resolve(SEASON, winners, amounts, ROOT);
    }

    // ---- the public exit (D186) ---------------------------------------------

    function test_exitStale_succeedsForANonOperatorAfterTheDeadline() public {
        _depositAll(4);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(resolveBy);

        vm.prank(stranger); // not the operator, not even a depositor
        v.exitStale(SEASON);

        for (uint256 i = 0; i < 4; i++) {
            assertEq(v.owed(_agent(i)), DEPOSIT, "a stranger refunded the whole field");
        }
    }

    function test_exitStale_worksFromRegistrationToo() public {
        _depositAll(2);
        vm.warp(resolveBy);

        vm.prank(stranger);
        v.exitStale(SEASON);

        assertEq(v.owed(_agent(0)), DEPOSIT);
        assertEq(v.owed(_agent(1)), DEPOSIT);
    }

    function test_exitStale_revertsBeforeTheDeadline() public {
        _depositAll(2);
        vm.warp(resolveBy - 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DamnitsVault.TooEarly.selector, resolveBy));
        v.exitStale(SEASON);
    }

    function test_exitStale_cannotRunTwice() public {
        _depositAll(2);
        vm.warp(resolveBy);
        vm.prank(stranger);
        v.exitStale(SEASON);

        vm.prank(stranger);
        vm.expectRevert(DamnitsVault.NotResolvable.selector);
        v.exitStale(SEASON);
    }

    /// The prize pot survives the exit, and the operator can still pay it (D188).
    function test_prizePotIsNotStrandedByAnExit() public {
        _depositAll(3);
        vm.prank(sponsor);
        v.seedPot{value: 1 ether}(SEASON);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(resolveBy);

        vm.prank(stranger);
        v.exitStale(SEASON);

        (,, uint256 pot,,,,,,,) = v.getSeason(SEASON);
        assertEq(pot, 1 ether, "the exit must not touch sponsor money");

        address[] memory winners = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        winners[0] = payoutA;
        amounts[0] = 1 ether;

        vm.prank(operator);
        v.awardPrizes(SEASON, winners, amounts, ROOT);
        assertEq(v.owed(payoutA), 1 ether);

        vm.prank(payoutA);
        v.withdraw();
        assertEq(payoutA.balance, 1 ether);
    }

    function test_resolve_rejectedAfterAnExit() public {
        _depositAll(2);
        vm.warp(resolveBy);
        vm.prank(stranger);
        v.exitStale(SEASON);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vm.expectRevert(DamnitsVault.NotResolvable.selector);
        v.resolve(SEASON, winners, amounts, ROOT);
    }

    // ---- shortfall (D189) ----------------------------------------------------

    function test_shortfall_paysProRataAndNeverBlocks() public {
        LossyYieldSource lossy = new LossyYieldSource(1000); // loses 10%
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(lossy));

        for (uint256 i = 0; i < 4; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(OTHER);
        }
        vm.prank(operator);
        v.closeRegistration(OTHER);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(OTHER, winners, amounts, ROOT);

        (,,, uint256 shortfall,,,,,,) = v.getSeason(OTHER);
        assertEq(shortfall, (DEPOSIT * 4) / 10, "shortfall published as a number");

        // Nobody is blocked: everyone can take their 90% right now.
        for (uint256 i = 0; i < 4; i++) {
            assertEq(v.owed(_agent(i)), (DEPOSIT * 9) / 10);
            vm.prank(_agent(i));
            v.withdraw();
        }
    }

    function test_topUp_byAStrangerMakesEveryoneWholeAfterTheyWithdrew() public {
        LossyYieldSource lossy = new LossyYieldSource(1000);
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(lossy));
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(OTHER);
        }
        vm.prank(operator);
        v.closeRegistration(OTHER);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(OTHER, winners, amounts, ROOT);

        // They withdraw the partial refund BEFORE anyone covers the gap.
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(_agent(i));
            v.withdraw();
        }

        uint256 gap = (DEPOSIT * 4) / 10;
        vm.prank(stranger); // not the operator — anyone can make it whole
        v.topUp{value: gap}(OTHER);

        for (uint256 i = 0; i < 4; i++) {
            address who = _agent(i);
            uint256 before = who.balance;
            vm.prank(who);
            v.withdraw();
            assertEq(who.balance - before, DEPOSIT / 10, "the missing tenth arrives later");
        }

        (,,, uint256 shortfall,,,,,,) = v.getSeason(OTHER);
        assertEq(shortfall, 0);
    }

    function test_topUp_revertsWithNoShortfall() public {
        _depositAll(2);
        vm.prank(stranger);
        vm.expectRevert(DamnitsVault.NoShortfall.selector);
        v.topUp{value: 1 ether}(SEASON);
    }

    /// A source that over-reports must not be able to inflate a refund.
    function test_lyingYieldSourceIsCaught() public {
        LyingYieldSource liar = new LyingYieldSource();
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(liar));
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(OTHER);
        }
        vm.prank(operator);
        v.closeRegistration(OTHER);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                DamnitsVault.YieldSourceShortChanged.selector, DEPOSIT * 2, DEPOSIT
            )
        );
        v.resolve(OTHER, winners, amounts, ROOT);
    }

    // ---- degradation (DoD 8) -------------------------------------------------

    function test_worksEntirelyWithoutAYieldSource() public {
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(0));
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(OTHER);
        }
        vm.prank(operator);
        v.closeRegistration(OTHER);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(OTHER, winners, amounts, ROOT);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(v.owed(_agent(i)), DEPOSIT, "full refund, no interest, no errors");
        }
        assertEq(v.owed(treasury), 0);
    }

    // ---- pull payments -------------------------------------------------------

    function test_aRefusingRecipientBlocksNobodyElse() public {
        RefusingRecipient bad = new RefusingRecipient();
        vm.deal(address(bad), 1 ether);

        vm.prank(address(bad));
        v.deposit{value: DEPOSIT}(SEASON);
        _depositAll(2);

        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(resolveBy);
        vm.prank(stranger);
        v.exitStale(SEASON);

        vm.expectRevert(DamnitsVault.WithdrawFailed.selector);
        bad.tryWithdraw(v);

        // Everyone else is unaffected.
        uint256 before = _agent(0).balance;
        vm.prank(_agent(0));
        v.withdraw();
        assertEq(_agent(0).balance - before, DEPOSIT);
    }

    function test_withdrawTwiceReverts() public {
        _depositAll(1);
        vm.warp(resolveBy);
        vm.prank(stranger);
        v.exitStale(SEASON);

        vm.startPrank(_agent(0));
        v.withdraw();
        vm.expectRevert(DamnitsVault.NothingOwed.selector);
        v.withdraw();
        vm.stopPrank();
    }

    // ---- the yield source itself (T127) --------------------------------------

    function test_mockAccrualIsPerSeason() public {
        _depositAll(4);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(block.timestamp + 5 days);

        // A second season stakes now; it must not inherit the first's interest.
        vm.prank(operator);
        v.openSeason(
            OTHER, DEPOSIT, block.timestamp + 1 days, block.timestamp + 7 days, address(src)
        );
        vm.prank(_agent(5));
        v.deposit{value: DEPOSIT}(OTHER);
        vm.prank(operator);
        v.closeRegistration(OTHER);

        assertEq(src.balanceOf(OTHER), DEPOSIT, "a fresh stake has earned nothing yet");
        assertGt(src.balanceOf(SEASON), DEPOSIT * 4, "the older season kept its own");
    }

    function test_mockCannotInventValue() public {
        MockYieldSource poor = new MockYieldSource{value: 1 wei}(1e18);
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(poor));
        vm.prank(_agent(0));
        v.deposit{value: DEPOSIT}(OTHER);
        vm.prank(operator);
        v.closeRegistration(OTHER);
        vm.warp(block.timestamp + 365 days);

        assertEq(poor.balanceOf(OTHER), DEPOSIT + 1, "accrual capped at the funded budget");

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(OTHER, winners, amounts, ROOT);
        assertEq(v.owed(_agent(0)), DEPOSIT, "an over-set rate still refunds in full");
    }

    // ---- the invariant (T130) ------------------------------------------------

    /**
     * Every wei that went in comes back out, to somebody, with dust bounded by the
     * number of depositors. Nothing is created, nothing is stranded.
     */
    function testFuzz_depositsInEqualRefundsPlusSweepPlusDust(uint8 rawCount, uint32 elapsed)
        public
    {
        uint256 count = uint256(rawCount) % 8 + 1;
        vm.prank(operator);
        v.openSeason(OTHER, DEPOSIT, closeAt, resolveBy, address(src));

        for (uint256 i = 0; i < count; i++) {
            vm.prank(_agent(i));
            v.deposit{value: DEPOSIT}(OTHER);
        }
        uint256 paidIn = DEPOSIT * count;

        vm.prank(operator);
        v.closeRegistration(OTHER);
        vm.warp(block.timestamp + (uint256(elapsed) % 5 days) + 1);

        uint256 cameBack = src.balanceOf(OTHER);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        v.resolve(OTHER, winners, amounts, ROOT);

        uint256 refunds;
        for (uint256 i = 0; i < count; i++) {
            refunds += v.owed(_agent(i));
        }
        uint256 sweep = v.owed(treasury);

        assertEq(refunds + sweep, cameBack, "every wei that came back was credited");
        assertGe(refunds, paidIn, "no deposit was ever reduced");
        assertLe(refunds, paidIn, "and none was inflated either");
    }

    /// Nothing the contract holds is unreachable, including stray value (D188).
    function test_strayValueIsSweepableNotStuck() public {
        _depositAll(2);
        vm.prank(stranger);
        (bool ok,) = address(v).call{value: 0.5 ether}("");
        assertTrue(ok);

        vm.prank(operator);
        v.sweepUnaccounted();
        assertEq(v.owed(treasury), 0.5 ether, "value nobody accounted for still has an exit");
    }

    function test_reservedNeverExceedsBalance() public {
        _depositAll(4);
        vm.prank(sponsor);
        v.seedPot{value: 1 ether}(SEASON);
        vm.prank(operator);
        v.closeRegistration(SEASON);
        vm.warp(block.timestamp + 2 days);

        address[] memory winners = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        winners[0] = payoutA;
        amounts[0] = 1 ether;
        vm.prank(operator);
        v.resolve(SEASON, winners, amounts, ROOT);

        assertLe(v.reserved(), address(v).balance, "accounting never claims money it lacks");

        vm.prank(_agent(0));
        v.withdraw();
        vm.prank(payoutA);
        v.withdraw();
        assertLe(v.reserved(), address(v).balance);
    }
}
