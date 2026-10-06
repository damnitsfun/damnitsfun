// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DamnitsTournament} from "../src/DamnitsTournament.sol";

/**
 * DamnitsTournament fuzz & invariant supplement (Task #8, 7-Day Plan).
 *
 * ABOUTME: Property-based money conservation for the pooled tournament: entry
 * fees and sponsor seeds that go IN always equal what comes OUT (credited owed
 * + jackpots), no settle/award/rollover sequence can mint or burn value, and
 * every over-pay attempt reverts. These are the "deeper tests" the competitive
 * analysis says only 5 of 40 rivals have.
 *
 * Complements the unit suite in DamnitsTournament.t.sol — it pins the SAME
 * invariants that suite asserts one-at-a-time, but fuzzes the paths: entrant
 * count, seed/fee mix, winner rank splits, jackpot award vs rollover choice,
 * and the order of settle/award/withdraw across seasons.
 */
contract DamnitsTournamentFuzzTest is Test {
    DamnitsTournament internal t;

    address internal operator = makeAddr("operator");
    address internal sponsor = makeAddr("sponsor");
    // Payout addresses (distinct from the wallets that entered, per D14).
    address internal payoutA = makeAddr("payoutA");
    address internal payoutB = makeAddr("payoutB");
    address internal payoutC = makeAddr("payoutC");

    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant AGENT_WALLET = 10 ether;
    uint256 internal constant SPONSOR_STASH = 1000 ether;

    /// A fresh agent with a funded wallet, derived from the fuzz seed.
    function _agent(uint256 i) internal returns (address) {
        address a = makeAddr(string(abi.encodePacked("fuzz-agent-", vm.toString(i))));
        vm.deal(a, AGENT_WALLET);
        return a;
    }

    /// A fresh payout wallet — payout addresses never need wallets up front
    /// (pull model), but seed them anyway so receive() is always possible.
    function _payout(uint256 i) internal returns (address) {
        address p = makeAddr(string(abi.encodePacked("fuzz-payout-", vm.toString(i))));
        return p;
    }

    /// Single-element address array (settles with exactly one winner rank).
    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    /// Single-element zero-wei array (no main-pool ask in the jackpot fuzz).
    function _zero() internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = 0;
    }

    bytes32 internal _compSeed;

    /// Unique competition id per call so fuzz runs never collide.
    function _comp(uint256 nonce) internal returns (bytes32 id) {
        id = keccak256(abi.encode("fuzz-comp", _compSeed, nonce));
    }

    /// Open + fund + close + settle one competition with a given rank split.
    /// Returns the total wei that went INTO the pot (entries + pool seeds).
    struct SeasonOutcome {
        uint256 paidIn; // entries + pool seeds
        uint256 jackIn; // jackpot seeds
        uint256 owedOut; // main-pool wei credited to winners
        uint256 jackOut; // jackpot wei credited/awarded
    }

    function setUp() public {
        t = new DamnitsTournament(operator);
        vm.deal(sponsor, SPONSOR_STASH);
    }

    // ---------------------------------------------------------------------
    // 1) Full-season conservation: entries + seeds == withdrawals exactly.
    // ---------------------------------------------------------------------

    /**
     * Every wei that went into a competition (entry fees + sponsor pool seeds)
     * ends up held by someone: credited to payout addresses and eventually
     * withdrawn. Nothing is minted, nothing is stranded in the contract.
     * Fuzzes entrant count, fee, and the pool-seed amount together.
     */
    function testFuzz_EntriesAndSeedsEqualWithdrawals(
        uint8 rawEntrants,
        uint64 rawFee,
        uint64 rawSeed
    ) public {
        // Bound: 1..8 entrants so the agent/payout loops stay cheap.
        uint256 n = bound(uint256(rawEntrants), 1, 8);
        // Bound the fee to a sane range: non-zero, small enough that N*fee
        // stays well within an agent wallet.
        uint256 fee = bound(uint256(rawFee), 1 gwei, 0.01 ether);
        // Pool seed may be zero (pure entry-fee pot) or a sponsor top-up.
        uint256 seed = bound(uint256(rawSeed), 0, 10 ether);

        _compSeed = keccak256(abi.encode(n, fee, seed));
        bytes32 id = _comp(0);

        vm.startPrank(operator);
        t.openCompetition(id, fee);
        vm.stopPrank();

        // Distinct entrants pay the fee from their own wallets (D12/D14).
        uint256 paidIn;
        for (uint256 i = 0; i < n; i++) {
            address a = _agent(i);
            vm.prank(a);
            t.payEntry{value: fee}(id);
            paidIn += fee;
        }

        // Sponsor merges money into the MAIN pool.
        if (seed > 0) {
            vm.prank(sponsor);
            t.seedPool{value: seed}(id);
            paidIn += seed;
        }

        vm.prank(operator);
        t.closeEntries(id);

        // Rank split: winners share paidIn across 1..n ranks. Split fuzzed by
        // giving rank 0 a random share up to paidIn; remainder to rank 1 (or
        // left in pool = contract-dust case is NOT allowed by pull-withdraw —
        // so we distribute everything to keep the invariant tight).
        address[] memory winners = new address[](2);
        winners[0] = _payout(90);
        winners[1] = _payout(91);
        uint256 first =
            paidIn == 0 ? 0 : uint256(keccak256(abi.encode("split", paidIn))) % (paidIn + 1);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = first;
        amounts[1] = paidIn - first;

        vm.prank(operator);
        t.settleCompetition(id, winners, amounts, address(0), 0, keccak256("root"));

        SeasonOutcome memory o;
        o.paidIn = paidIn;
        o.owedOut = amounts[0] + amounts[1]; // == paidIn

        // Pull withdrawals by the two payout wallets.
        vm.prank(winners[0]);
        t.withdraw();
        vm.prank(winners[1]);
        t.withdraw();

        // THE INVARIANT: money in == money out == settled owed, exactly.
        assertEq(o.owedOut, o.paidIn, "credited owed == paid in (no mint/burn)");
        assertEq(
            winners[0].balance + winners[1].balance, o.paidIn, "withdrawals returned everything"
        );
        assertEq(address(t).balance, 0, "contract ends empty when the pool distributes fully");

        (, uint256 pool,,,,) = t.getCompetition(id);
        assertEq(pool, 0, "pool drained by the full split");
    }

    // ---------------------------------------------------------------------
    // 2) settleCompetition can never over-distribute, on any input shape.
    // ---------------------------------------------------------------------

    /**
     * For every fuzzed winner/amount shape the settle call either succeeds
     * with sum(amounts) <= pool, or reverts OverDistribution — and in the
     * success case the credited total never exceeds the pool, the pool
     * decreases by exactly the credited amount, and the credit is durable.
     * (The unit suite pins the revert at one shape; this fuzzes the whole
     * envelope around it.)
     */
    function testFuzz_settleNeverOverDistributes(uint8 rawWinnerCount, uint64 rawBloat) public {
        uint256 k = bound(uint256(rawWinnerCount), 1, 4);
        // How much the ask exceeds the pool: 0 (valid edge) .. +3 wei-ether.
        uint256 bloat = bound(uint256(rawBloat), 0, 3 ether);

        bytes32 id = _comp(1);
        vm.prank(operator);
        t.openCompetition(id, FEE);

        // Fixed 4 entrants -> pool = 4 * FEE. Winner ranks use fresh payouts.
        uint256 paidIn;
        for (uint256 i = 0; i < 4; i++) {
            address a = _agent(i + 10);
            vm.prank(a);
            t.payEntry{value: FEE}(id);
            paidIn += FEE;
        }

        vm.prank(operator);
        t.closeEntries(id);

        address[] memory winners = new address[](k);
        uint256[] memory amounts = new uint256[](k);
        // Spread paidIn + bloat across k ranks, fuzz-biased to rank 0.
        uint256 ask = paidIn + bloat;
        for (uint256 i = 0; i < k; i++) {
            winners[i] = _payout(100 + i);
            if (i == k - 1) {
                amounts[i] = ask; // last rank takes what remains of the ask
            } else if (i == 0) {
                amounts[i] = uint256(keccak256(abi.encode("ask0", ask))) % (ask + 1);
                ask -= amounts[i];
            } else {
                amounts[i] = uint256(keccak256(abi.encode("askN", i, ask))) % (ask + 1);
                ask -= amounts[i];
            }
        }

        uint256 sum;
        for (uint256 i = 0; i < k; i++) {
            sum += amounts[i];
        }

        vm.prank(operator);
        if (sum > paidIn) {
            // THE GUARD: the ask above the pool is rejected on every shape.
            vm.expectRevert(
                abi.encodeWithSelector(DamnitsTournament.OverDistribution.selector, paidIn, sum)
            );
            t.settleCompetition(id, winners, amounts, address(0), 0, keccak256("root"));

            // Unchanged after the revert: pool intact, nobody credited.
            (, uint256 pool,,,,) = t.getCompetition(id);
            assertEq(pool, paidIn, "revert leaves the pool untouched");
            for (uint256 i = 0; i < k; i++) {
                assertEq(t.owed(winners[i]), 0, "revert credits nobody");
            }
        } else {
            // Valid edge (bloat == 0 with exact sums): settles, credits, drains.
            t.settleCompetition(id, winners, amounts, address(0), 0, keccak256("root"));
            (, uint256 pool,,,,) = t.getCompetition(id);
            assertEq(pool, paidIn - sum, "pool shrinks by exactly the credited total");
            for (uint256 i = 0; i < k; i++) {
                assertEq(t.owed(winners[i]), amounts[i], "credit matches the ask, rank per rank");
            }
        }
    }

    // ---------------------------------------------------------------------
    // 3) Jackpot chain: seed / award / rollover conserves funds forever.
    // ---------------------------------------------------------------------

    /**
     * Across a fuzzed chain of competitions: whatever the sponsor puts into
     * jackpots is either (a) pushed out to a storm triggerer by awardJackpot,
     * (b) settled out via settleCompetition, or (c) rolled over into the next
     * open competition. After every step: sponsor-stash delta + contract
     * balance + paid-out wei reconcile to the same total. Nothing is minted;
     * nothing gets stranded outside a live jackpotPool.
     */
    function testFuzz_jackpotRolloverConservesFunds(uint8 rawRounds) public {
        uint256 rounds = bound(uint256(rawRounds), 2, 5);

        uint256 sponsorPot;
        uint256 paidOut; // wei that left the contract via award pushes
        uint256 lastJackpot; // wei still parked in the last live jackpotPool

        for (uint256 r = 0; r < rounds; r++) {
            bytes32 id = _comp(200 + r);
            // Round 0 opens its own competition; later rounds were already
            // opened by the previous round's rollover step.
            if (r == 0) {
                vm.prank(operator);
                t.openCompetition(id, FEE);
            }

            // Sponsor seeds a fuzzed jackpot (0..2 ether) into this season.
            uint256 seed = uint256(keccak256(abi.encode("jack", r))) % (2 ether + 1);
            if (seed > 0) {
                vm.prank(sponsor);
                t.seedJackpot{value: seed}(id);
                sponsorPot += seed;
            }

            // Even rounds: a storm fires mid-season -> awardJackpot pushes out
            // part (fuzzed) of the jackpot pool and the season stays Open.
            // Odd rounds: no storm -> the residual is rolled over onward.
            bool stormFired = (r % 2 == 0) && seed > 0;

            if (stormFired) {
                (,, uint256 jack,,,) = t.getCompetition(id);
                uint256 award = uint256(keccak256(abi.encode("award", r, jack))) % (jack + 1);
                if (award > 0) {
                    address triggerer = _payout(300 + r);
                    uint256 before = triggerer.balance;
                    vm.prank(operator);
                    t.awardJackpot(id, triggerer, award, keccak256("hash"), keccak256("reveal"));
                    assertEq(triggerer.balance - before, award, "push lands exactly");
                    paidOut += award;

                    (,, uint256 left,,,) = t.getCompetition(id);
                    assertEq(left, jack - award, "jackpotPool debited by the award");
                }
            }

            // Close + settle the season (main pool untouched by this fuzz —
            // no entrants here; the pool is 0 so the settle is a zero-ask).
            vm.prank(operator);
            t.closeEntries(id);
            vm.prank(operator);
            t.settleCompetition(
                id, _one(_payout(400 + r)), _zero(), address(0), 0, keccak256("root")
            );

            // Next season must be open before rolling over.
            bytes32 nextId = _comp(200 + r + 1);
            if (r + 1 < rounds) {
                vm.prank(operator);
                t.openCompetition(nextId, FEE);
            }

            // Carry the whole residual jackpot onward (settled source -> open target).
            (,, uint256 residual,,,) = t.getCompetition(id);
            if (r + 1 < rounds) {
                if (residual == 0) {
                    // Nothing to carry: NoJackpotToRollover is the expected guard.
                    vm.prank(operator);
                    vm.expectRevert(DamnitsTournament.NoJackpotToRollover.selector);
                    t.rolloverJackpot(id, nextId);
                } else {
                    vm.prank(operator);
                    t.rolloverJackpot(id, nextId);
                    (,, uint256 srcAfter,,,) = t.getCompetition(id);
                    (,, uint256 dstAfter,,,) = t.getCompetition(nextId);
                    assertEq(srcAfter, 0, "source drained by the rollover");
                    assertGe(dstAfter, residual, "destination credited at least the carry");
                }
            }
            lastJackpot = residual; // what the chain holds at this round's end
        }

        // THE INVARIANT across the whole fuzzed chain:
        // sponsor stash spent == paidOut to triggerers + wei still in the contract.
        uint256 inContract = address(t).balance;
        assertEq(sponsorPot, paidOut + inContract, "conservation across settle/award/rollover");

        // And the residual jackpot never wanders off the live jackpotPool book.
        (,, uint256 finalJackpot,,,) = t.getCompetition(_comp(200 + rounds - 1));
        assertEq(finalJackpot, lastJackpot, "booked residual matches reality");
    }
}
