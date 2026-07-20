// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DamnitsEscrow} from "../src/DamnitsEscrow.sol";

/**
 * DamnitsEscrow test suite (T12 DoD, FR-6.5).
 *
 * The four required cases — pot accumulation, mismatched reveal, double
 * settlement, and a reentrancy attack — plus the access-control and
 * commit-ordering properties the fairness argument depends on.
 */
contract DamnitsEscrowTest is Test {
    DamnitsEscrow internal escrow;

    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    bytes32 internal constant SESSION = keccak256("sess_test_1");
    uint256 internal constant FEE = 0.01 ether;
    bytes32 internal constant SEED = keccak256("the-secret-seed");
    bytes32 internal constant RESULT = keccak256("event-log-hash");

    function setUp() public {
        escrow = new DamnitsEscrow(operator);
        for (uint256 i = 0; i < 4; i++) {
            vm.deal(_player(i), 1 ether);
        }
        vm.prank(operator);
        escrow.openSession(SESSION, FEE);
    }

    function _player(uint256 i) internal view returns (address) {
        if (i == 0) return alice;
        if (i == 1) return bob;
        if (i == 2) return carol;
        return dave;
    }

    function _commitHash(bytes32 seed) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed));
    }

    function _seatAll() internal {
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(_player(i));
            escrow.payEntryFee{value: FEE}(SESSION);
        }
    }

    // ---- pot accumulation ----------------------------------------------------

    function test_PotAccumulatesAcrossFourPlayers() public {
        _seatAll();

        (address[] memory players,, uint256 pot,,,,) = escrow.getSession(SESSION);
        assertEq(players.length, 4, "four seats");
        assertEq(pot, FEE * 4, "pot is the sum of entry fees");
        assertEq(address(escrow).balance, FEE * 4, "contract holds the pot");
        assertEq(escrow.playerCount(SESSION), 4);
    }

    function test_RejectsWrongEntryFee() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DamnitsEscrow.WrongEntryFee.selector, FEE, FEE / 2));
        escrow.payEntryFee{value: FEE / 2}(SESSION);
    }

    function test_RejectsDoublePaymentBySamePlayer() public {
        vm.startPrank(alice);
        escrow.payEntryFee{value: FEE}(SESSION);
        vm.expectRevert(DamnitsEscrow.AlreadyPaid.selector);
        escrow.payEntryFee{value: FEE}(SESSION);
        vm.stopPrank();
    }

    function test_RejectsPaymentBeforeFeeIsSet() public {
        bytes32 unopened = keccak256("sess_never_opened");
        vm.prank(alice);
        vm.expectRevert(DamnitsEscrow.EntryFeeNotSet.selector);
        escrow.payEntryFee{value: FEE}(unopened);
    }

    // ---- commit-reveal -------------------------------------------------------

    function test_CommitThenSettlePaysWinner() public {
        _seatAll();

        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        uint256 before = alice.balance;
        vm.prank(operator);
        escrow.settle(SESSION, alice, RESULT, SEED);

        assertEq(alice.balance, before + FEE * 4, "winner receives the whole pot");
        assertEq(address(escrow).balance, 0, "escrow is drained");

        (,, uint256 pot,, bytes32 resultHash, DamnitsEscrow.SessionState state, address winner) =
            escrow.getSession(SESSION);
        assertEq(pot, 0);
        assertEq(resultHash, RESULT);
        assertEq(uint256(state), uint256(DamnitsEscrow.SessionState.Settled));
        assertEq(winner, alice);
    }

    /// The core fairness property: a seed that does not match the commitment is rejected.
    function test_RejectsSettleWithMismatchedReveal() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.SeedRevealMismatch.selector);
        escrow.settle(SESSION, alice, RESULT, keccak256("a-different-seed"));

        // Nothing moved.
        assertEq(address(escrow).balance, FEE * 4, "pot untouched after a failed settle");
    }

    function test_RejectsDoubleSettlement() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        vm.prank(operator);
        escrow.settle(SESSION, alice, RESULT, SEED);

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.SessionNotCommitted.selector);
        escrow.settle(SESSION, bob, RESULT, SEED);
    }

    function test_RejectsSecondCommitForSameSession() public {
        _seatAll();
        vm.startPrank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));
        // Re-committing after the deal would defeat the whole scheme.
        vm.expectRevert(DamnitsEscrow.AlreadyCommitted.selector);
        escrow.commitSeed(SESSION, _commitHash(keccak256("second-thoughts")));
        vm.stopPrank();
    }

    function test_EntryFeesRejectedOnceCommitted() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        // The pot must be fixed before the seed is, or a late payment changes the
        // stakes of a game whose deal is already determined.
        vm.deal(address(0xBEEF), 1 ether);
        vm.prank(address(0xBEEF));
        vm.expectRevert(DamnitsEscrow.SessionNotOpen.selector);
        escrow.payEntryFee{value: FEE}(SESSION);
    }

    function test_SettleRequiresCommitFirst() public {
        _seatAll();
        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.SessionNotCommitted.selector);
        escrow.settle(SESSION, alice, RESULT, SEED);
    }

    function test_RejectsWinnerWhoNeverPaid() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.WinnerNotInSession.selector);
        escrow.settle(SESSION, address(0xDEAD), RESULT, SEED);
    }

    function test_AnyoneCanVerifyTheRevealIndependently() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        assertTrue(escrow.verifySeed(SESSION, SEED), "true reveal verifies");
        assertFalse(escrow.verifySeed(SESSION, keccak256("wrong")), "false reveal does not");
    }

    // ---- access control ------------------------------------------------------

    function test_OnlyOperatorCanCommit() public {
        vm.prank(alice);
        vm.expectRevert(DamnitsEscrow.NotOperator.selector);
        escrow.commitSeed(SESSION, _commitHash(SEED));
    }

    function test_OnlyOperatorCanSettle() public {
        _seatAll();
        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        vm.prank(alice);
        vm.expectRevert(DamnitsEscrow.NotOperator.selector);
        escrow.settle(SESSION, alice, RESULT, SEED);
    }

    function test_OperatorCanBeTransferred() public {
        address next = makeAddr("next-operator");
        vm.prank(operator);
        escrow.transferOperator(next);
        assertEq(escrow.operator(), next);

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.NotOperator.selector);
        escrow.commitSeed(SESSION, _commitHash(SEED));
    }

    function test_ConstructorRejectsZeroOperator() public {
        vm.expectRevert(DamnitsEscrow.ZeroAddress.selector);
        new DamnitsEscrow(address(0));
    }

    // ---- reentrancy ----------------------------------------------------------

    /**
     * A malicious winner re-enters {settle} from its receive hook. It must fail:
     * the session is already marked Settled and the pot zeroed before the payout
     * (checks-effects-interactions), and `nonReentrant` blocks the re-entry
     * outright. Either way the attacker cannot drain more than its own winnings.
     */
    function test_ReentrantWinnerCannotDrainTheEscrow() public {
        ReentrantWinner attacker = new ReentrantWinner(escrow, SESSION, RESULT, SEED);
        vm.deal(address(attacker), 1 ether);

        // The attacker legitimately buys a seat, then three others join.
        attacker.payFee{value: 0}(FEE);
        vm.prank(bob);
        escrow.payEntryFee{value: FEE}(SESSION);
        vm.prank(carol);
        escrow.payEntryFee{value: FEE}(SESSION);
        vm.prank(dave);
        escrow.payEntryFee{value: FEE}(SESSION);

        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        uint256 potBefore = address(escrow).balance;
        assertEq(potBefore, FEE * 4);

        // Settling to the attacker triggers its receive(), which re-enters.
        vm.prank(operator);
        escrow.settle(SESSION, address(attacker), RESULT, SEED);

        assertTrue(attacker.reentryAttempted(), "the attacker did try to re-enter");
        assertFalse(attacker.reentrySucceeded(), "re-entry must fail");
        // It received exactly the pot it won, and the escrow is empty — not negative.
        assertEq(address(attacker).balance, 1 ether - FEE + potBefore);
        assertEq(address(escrow).balance, 0);
    }

    /// A winner that always reverts on receive blocks its own payout (documented push-payout tradeoff).
    function test_RevertingWinnerCausesPayoutFailure() public {
        RejectingWinner rejector = new RejectingWinner();
        vm.deal(address(rejector), 1 ether);
        rejector.payFee(escrow, SESSION, FEE);

        vm.prank(bob);
        escrow.payEntryFee{value: FEE}(SESSION);

        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(SEED));

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.PayoutFailed.selector);
        escrow.settle(SESSION, address(rejector), RESULT, SEED);
    }

    // ---- fuzz ----------------------------------------------------------------

    function testFuzz_OnlyTheCommittedSeedSettles(bytes32 seed, bytes32 attempt) public {
        vm.assume(seed != attempt);
        _seatAll();

        vm.prank(operator);
        escrow.commitSeed(SESSION, _commitHash(seed));

        vm.prank(operator);
        vm.expectRevert(DamnitsEscrow.SeedRevealMismatch.selector);
        escrow.settle(SESSION, alice, RESULT, attempt);

        vm.prank(operator);
        escrow.settle(SESSION, alice, RESULT, seed);
        (,,,,, DamnitsEscrow.SessionState state,) = escrow.getSession(SESSION);
        assertEq(uint256(state), uint256(DamnitsEscrow.SessionState.Settled));
    }
}

/// Re-enters {settle} the moment it is paid.
contract ReentrantWinner {
    DamnitsEscrow private immutable escrow;
    bytes32 private immutable sessionId;
    bytes32 private immutable resultHash;
    bytes32 private immutable seed;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(DamnitsEscrow _escrow, bytes32 _sessionId, bytes32 _resultHash, bytes32 _seed) {
        escrow = _escrow;
        sessionId = _sessionId;
        resultHash = _resultHash;
        seed = _seed;
    }

    function payFee(uint256 fee) external payable {
        escrow.payEntryFee{value: fee}(sessionId);
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        try escrow.settle(sessionId, address(this), resultHash, seed) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}

/// Refuses every payment, to exercise the push-payout failure path.
contract RejectingWinner {
    function payFee(DamnitsEscrow escrow, bytes32 sessionId, uint256 fee) external {
        escrow.payEntryFee{value: fee}(sessionId);
    }

    receive() external payable {
        revert("no thanks");
    }
}
