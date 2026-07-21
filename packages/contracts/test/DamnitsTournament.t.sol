// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DamnitsTournament} from "../src/DamnitsTournament.sol";

/**
 * DamnitsTournament test suite (T21 DoD, sub-spec 08 / FR-6.5).
 *
 * Covers the money invariants the pooled model depends on: pool accumulation
 * across many entries, sponsor seeding merging into the pool, over-distribution
 * rejected, double-settle rejected, pull-withdraw (incl. a reverting recipient
 * that does NOT block others), jackpot rollover with its state guards, and a
 * reentrancy attack on {withdraw}.
 */
contract DamnitsTournamentTest is Test {
    DamnitsTournament internal t;

    address internal operator = makeAddr("operator");
    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    // Payout addresses (distinct from the wallets that entered, per D14).
    address internal payoutA = makeAddr("payoutA");
    address internal payoutB = makeAddr("payoutB");

    bytes32 internal constant COMP = keccak256("comp_test_1");
    bytes32 internal constant NEXT = keccak256("comp_test_2");
    uint256 internal constant FEE = 0.01 ether;
    bytes32 internal constant ROOT = keccak256("final-leaderboard-hash");

    function setUp() public {
        t = new DamnitsTournament(operator);
        vm.deal(sponsor, 100 ether);
        for (uint256 i = 0; i < 4; i++) {
            vm.deal(_agent(i), 1 ether);
        }
        vm.prank(operator);
        t.openCompetition(COMP, FEE);
    }

    function _agent(uint256 i) internal view returns (address) {
        if (i == 0) return alice;
        if (i == 1) return bob;
        if (i == 2) return carol;
        return dave;
    }

    function _enterAll() internal {
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(_agent(i));
            t.payEntry{value: FEE}(COMP);
        }
    }

    function _addrs(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _wei(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    // ---- entries + pool ------------------------------------------------------

    function test_PoolAccumulatesAcrossEntries() public {
        _enterAll();
        (, uint256 pool,, uint256 entrants,, DamnitsTournament.CompetitionState state) =
            t.getCompetition(COMP);
        assertEq(pool, FEE * 4, "pool is the sum of buy-ins");
        assertEq(entrants, 4);
        assertEq(uint256(state), uint256(DamnitsTournament.CompetitionState.Open));
        assertEq(address(t).balance, FEE * 4);
    }

    function test_SponsorSeedMergesIntoPool() public {
        _enterAll();
        vm.prank(sponsor);
        t.seedPool{value: 1 ether}(COMP);

        (, uint256 pool,,,,) = t.getCompetition(COMP);
        assertEq(pool, FEE * 4 + 1 ether, "sponsor money merges with fees");
    }

    function test_RejectsWrongEntryFee() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(DamnitsTournament.WrongEntryFee.selector, FEE, FEE / 2)
        );
        t.payEntry{value: FEE / 2}(COMP);
    }

    function test_RejectsDoubleEntry() public {
        vm.startPrank(alice);
        t.payEntry{value: FEE}(COMP);
        vm.expectRevert(DamnitsTournament.AlreadyEntered.selector);
        t.payEntry{value: FEE}(COMP);
        vm.stopPrank();
    }

    function test_RejectsEntryToUnopenedCompetition() public {
        vm.prank(alice);
        vm.expectRevert(DamnitsTournament.CompetitionNotOpen.selector);
        t.payEntry{value: FEE}(keccak256("never_opened"));
    }

    function test_RejectsSecondOpenOfSameCompetition() public {
        vm.prank(operator);
        vm.expectRevert(DamnitsTournament.CompetitionExists.selector);
        t.openCompetition(COMP, FEE * 2);
    }

    function test_EntriesRejectedOnceClosed() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);

        vm.deal(address(0xBEEF), 1 ether);
        vm.prank(address(0xBEEF));
        vm.expectRevert(DamnitsTournament.CompetitionNotOpen.selector);
        t.payEntry{value: FEE}(COMP);
    }

    // ---- settlement (rank-based, pull) ---------------------------------------

    function test_SettleCreditsWinnersAndTheyWithdraw() public {
        _enterAll(); // pool = 4 * FEE
        vm.prank(operator);
        t.closeEntries(COMP);

        // Two paid ranks: 0.03 to 1st, 0.01 to 2nd (sums to the pool).
        address[] memory winners = new address[](2);
        winners[0] = payoutA;
        winners[1] = payoutB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0.03 ether;
        amounts[1] = 0.01 ether;

        vm.prank(operator);
        t.settleCompetition(COMP, winners, amounts, address(0), 0, ROOT);

        assertEq(t.owed(payoutA), 0.03 ether);
        assertEq(t.owed(payoutB), 0.01 ether);
        (, uint256 pool,,, bytes32 root, DamnitsTournament.CompetitionState state) =
            t.getCompetition(COMP);
        assertEq(pool, 0, "pool fully distributed");
        assertEq(root, ROOT);
        assertEq(uint256(state), uint256(DamnitsTournament.CompetitionState.Settled));

        uint256 before = payoutA.balance;
        vm.prank(payoutA);
        t.withdraw();
        assertEq(payoutA.balance, before + 0.03 ether);
        assertEq(t.owed(payoutA), 0);
    }

    function test_RejectsOverDistribution() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);

        // Ask to pay out more than the pool holds.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(DamnitsTournament.OverDistribution.selector, FEE * 4, FEE * 5)
        );
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 5), address(0), 0, ROOT);
    }

    function test_RejectsSettleBeforeClose() public {
        _enterAll();
        vm.prank(operator);
        vm.expectRevert(DamnitsTournament.CompetitionNotClosed.selector);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE), address(0), 0, ROOT);
    }

    function test_RejectsDoubleSettle() public {
        _enterAll();
        vm.startPrank(operator);
        t.closeEntries(COMP);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), address(0), 0, ROOT);
        vm.expectRevert(DamnitsTournament.CompetitionNotClosed.selector);
        t.settleCompetition(COMP, _addrs(payoutB), _wei(0), address(0), 0, ROOT);
        vm.stopPrank();
    }

    function test_RejectsLengthMismatch() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);

        address[] memory winners = new address[](2);
        winners[0] = payoutA;
        winners[1] = payoutB;
        vm.prank(operator);
        vm.expectRevert(DamnitsTournament.LengthMismatch.selector);
        t.settleCompetition(COMP, winners, _wei(FEE), address(0), 0, ROOT);
    }

    function test_RejectsJackpotWinnerZeroWithAmount() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);
        vm.prank(operator);
        vm.expectRevert(DamnitsTournament.InvalidJackpotWinner.selector);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE), address(0), 1, ROOT);
    }

    function test_NothingOwedRevertsOnWithdraw() public {
        vm.prank(payoutA);
        vm.expectRevert(DamnitsTournament.NothingOwed.selector);
        t.withdraw();
    }

    // ---- jackpot -------------------------------------------------------------

    function test_JackpotPaidToTriggerer() public {
        _enterAll();
        vm.prank(sponsor);
        t.seedJackpot{value: 0.05 ether}(COMP);

        vm.prank(operator);
        t.closeEntries(COMP);

        // payoutA wins the main pool; payoutB triggered the storm.
        vm.prank(operator);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), payoutB, 0.05 ether, ROOT);

        assertEq(t.owed(payoutB), 0.05 ether, "storm triggerer owed the jackpot");
        (,, uint256 jackpotPool,,,) = t.getCompetition(COMP);
        assertEq(jackpotPool, 0);
    }

    function test_UntriggeredJackpotRollsOverOnChain() public {
        _enterAll();
        vm.prank(sponsor);
        t.seedJackpot{value: 0.05 ether}(COMP);

        vm.startPrank(operator);
        t.closeEntries(COMP);
        // No storm: jackpotWinner = 0, jackpotAmount = 0.
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), address(0), 0, ROOT);

        // Residual jackpot stays until rolled into the next open competition.
        t.openCompetition(NEXT, FEE);
        t.rolloverJackpot(COMP, NEXT);
        vm.stopPrank();

        (,, uint256 fromJackpot,,,) = t.getCompetition(COMP);
        (,, uint256 toJackpot,,,) = t.getCompetition(NEXT);
        assertEq(fromJackpot, 0, "residual moved out");
        assertEq(toJackpot, 0.05 ether, "carried into the next season");
    }

    function test_RolloverRejectsUnsettledSource() public {
        vm.prank(sponsor);
        t.seedJackpot{value: 0.05 ether}(COMP);

        vm.startPrank(operator);
        t.openCompetition(NEXT, FEE);
        // COMP is still Open (never settled) → cannot be a rollover source.
        vm.expectRevert(DamnitsTournament.CompetitionNotSettled.selector);
        t.rolloverJackpot(COMP, NEXT);
        vm.stopPrank();
    }

    function test_RolloverRejectsNonOpenTarget() public {
        _enterAll();
        vm.startPrank(operator);
        t.closeEntries(COMP);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), address(0), 0, ROOT);
        // NEXT was never opened → not Open.
        vm.expectRevert(DamnitsTournament.CompetitionNotOpen.selector);
        t.rolloverJackpot(COMP, NEXT);
        vm.stopPrank();
    }

    function test_RolloverRejectsWhenNothingToCarry() public {
        _enterAll();
        vm.startPrank(operator);
        t.closeEntries(COMP);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), address(0), 0, ROOT);
        t.openCompetition(NEXT, FEE);
        vm.expectRevert(DamnitsTournament.NoJackpotToRollover.selector);
        t.rolloverJackpot(COMP, NEXT);
        vm.stopPrank();
    }

    // ---- access control ------------------------------------------------------

    function test_OnlyOperatorCanOpen() public {
        vm.prank(alice);
        vm.expectRevert(DamnitsTournament.NotOperator.selector);
        t.openCompetition(keccak256("x"), FEE);
    }

    function test_OnlyOperatorCanSettle() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);
        vm.prank(alice);
        vm.expectRevert(DamnitsTournament.NotOperator.selector);
        t.settleCompetition(COMP, _addrs(payoutA), _wei(FEE * 4), address(0), 0, ROOT);
    }

    function test_ConstructorRejectsZeroOperator() public {
        vm.expectRevert(DamnitsTournament.ZeroAddress.selector);
        new DamnitsTournament(address(0));
    }

    // ---- withdraw safety -----------------------------------------------------

    /// A reverting recipient blocks only its OWN withdraw, never anyone else's (the pull-payment win).
    function test_RevertingRecipientDoesNotBlockOthers() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);

        RejectingRecipient rejector = new RejectingRecipient();
        address[] memory winners = new address[](2);
        winners[0] = address(rejector);
        winners[1] = payoutB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0.02 ether;
        amounts[1] = 0.02 ether;

        vm.prank(operator);
        t.settleCompetition(COMP, winners, amounts, address(0), 0, ROOT);

        // The good recipient withdraws fine.
        vm.prank(payoutB);
        t.withdraw();
        assertEq(payoutB.balance, 0.02 ether);

        // The bad recipient's own withdraw reverts — but it never touched payoutB.
        vm.prank(address(rejector));
        vm.expectRevert(DamnitsTournament.WithdrawFailed.selector);
        t.withdraw();
    }

    /// A reentrant winner cannot withdraw twice: owed is zeroed before the call, and nonReentrant blocks re-entry.
    function test_ReentrantWithdrawCannotDrain() public {
        _enterAll();
        vm.prank(operator);
        t.closeEntries(COMP);

        ReentrantWinner attacker = new ReentrantWinner(t);
        vm.prank(operator);
        t.settleCompetition(COMP, _addrs(address(attacker)), _wei(0.02 ether), address(0), 0, ROOT);

        attacker.attack();
        assertTrue(attacker.reentryAttempted(), "attacker tried to re-enter");
        assertEq(address(attacker).balance, 0.02 ether, "got exactly its winnings, no more");
        assertEq(t.owed(address(attacker)), 0);
    }
}

/// Refuses payments, to exercise the pull-payment isolation property.
contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }
}

/// Re-enters {withdraw} from its receive hook.
contract ReentrantWinner {
    DamnitsTournament private immutable tournament;
    bool public reentryAttempted;

    constructor(DamnitsTournament _t) {
        tournament = _t;
    }

    function attack() external {
        tournament.withdraw();
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        try tournament.withdraw() {
        // Should never reach here: owed is already zero and nonReentrant guards it.
        }
            catch {
            // Expected.
        }
    }
}
