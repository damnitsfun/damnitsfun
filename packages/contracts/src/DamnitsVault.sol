// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IYieldSource} from "./IYieldSource.sol";

/**
 * @title DamnitsVault
 * @notice The refundable season (sub-spec 24, D185-D189). A player deposits to
 *         enter, the deposit is parked in a yield source while the season runs,
 *         and the **deposit comes back in full** at the end. Sponsor money funds
 *         the prizes; the interest goes to the treasury.
 *
 * @dev Why a new contract. {DamnitsEscrow} and {DamnitsTournament} cannot be
 *      upgraded — no proxy, no pause, no admin rescue — and tens of thousands of
 *      settled tables point at their addresses. New money gets a new contract
 *      (D185); the fee tournament keeps running beside this, untouched (D191).
 *
 * @dev **There is no code path that reduces a recorded deposit.** Not a fee, not a
 *      rake, not rounding. That is the product, so it is enforced here rather than
 *      promised in copy.
 *
 * @dev The deadlines are on chain and the exit is public (D186). `openSeason`
 *      writes `registrationCloseAt` and `resolveBy` before anyone deposits, both
 *      readable on BscScan. Once `resolveBy` passes with nothing resolved, **anyone
 *      at all** may call {exitStale} and refund the whole field — no operator key.
 *      This deliberately reverses D9's operator-decides-when-it-ends, because in
 *      production a funded season once sat open and unwinnable for months, and
 *      "the operator will close it eventually" is not something you can put next to
 *      the word *refundable*.
 *
 * @dev Payout is pull (D7, inherited): {resolve} credits `owed` and each recipient
 *      calls {withdraw}, so one address that refuses payment cannot block anyone
 *      else's refund. One `owed` map serves refunds, prizes and the treasury sweep
 *      alike, because after D181 all three are the same asset.
 *
 * @dev Only deposits are staked. The prize pot stays in this contract for the whole
 *      season, so a yield source that misbehaves can never put the prize at risk.
 *
 * @dev Nothing here is unreachable (D188). Every wei is a recorded deposit, the
 *      prize pot, sweepable interest, or — for value nobody accounted for — visible
 *      to {sweepUnaccounted}. {DamnitsTournament} has a bucket nothing can read once
 *      a season settles; this one does not.
 */
contract DamnitsVault is ReentrancyGuard {
    enum SeasonState {
        None, // default: never opened
        Registration, // taking deposits
        Staked, // registration closed, deposits parked in the yield source
        Resolved // refunds (and usually prizes) credited to owed[]
    }

    struct Season {
        uint256 depositWei; // fixed per-wallet stake, set at open
        uint256 depositTotal; // sum of deposits taken
        uint256 prizePot; // sponsor money; never staked, never refundable
        uint256 shortfall; // deposits the yield source failed to return
        uint256 registrationCloseAt;
        uint256 resolveBy;
        address yieldSource; // address(0) = hold it here, earn nothing
        bytes32 resultRoot;
        SeasonState state;
        address[] depositors;
    }

    mapping(bytes32 => Season) private seasons;
    /// @notice One deposit per wallet per season (D187).
    mapping(bytes32 => mapping(address => uint256)) public depositOf;
    /// @notice Pull-payment ledger, global per address across all seasons.
    mapping(address => uint256) public owed;

    /// @notice The arena backend's authorised address.
    address public operator;
    /// @notice Where the interest goes. Fixed at construction (D182).
    address public immutable treasury;

    /**
     * @notice Native value this contract has accounted for. Anything the balance
     *         holds beyond this arrived unbidden and is sweepable to the treasury.
     */
    uint256 public reserved;

    event SeasonOpened(
        bytes32 indexed seasonId,
        uint256 depositWei,
        uint256 registrationCloseAt,
        uint256 resolveBy,
        address yieldSource
    );
    event Deposited(bytes32 indexed seasonId, address indexed player, uint256 amount);
    event PotSeeded(bytes32 indexed seasonId, address indexed from, uint256 amount);
    event SeasonStaked(bytes32 indexed seasonId, address indexed yieldSource, uint256 amount);
    event Resolved(
        bytes32 indexed seasonId, bytes32 resultRoot, uint256 refunded, uint256 distributed
    );
    event ExitedStale(bytes32 indexed seasonId, address indexed caller, uint256 refunded);
    event Refunded(bytes32 indexed seasonId, address indexed player, uint256 amount);
    event ShortfallRecorded(bytes32 indexed seasonId, uint256 expected, uint256 returnedAmount);
    event ToppedUp(bytes32 indexed seasonId, address indexed from, uint256 amount);
    event YieldSwept(bytes32 indexed seasonId, address indexed to, uint256 amount);
    event PrizesAwarded(bytes32 indexed seasonId, uint256 distributed);
    event Withdrawn(address indexed to, uint256 amount);
    event UnaccountedSwept(address indexed to, uint256 amount);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);

    error NotOperator();
    error ZeroAddress();
    error SeasonExists();
    error NotRegistering();
    error NotResolvable();
    error NotResolved();
    error RegistrationClosed();
    error DeadlinesOutOfOrder();
    error AlreadyDeposited();
    error WrongDeposit(uint256 expected, uint256 provided);
    error ZeroValue();
    error LengthMismatch();
    error OverDistribution(uint256 pot, uint256 requested);
    error TooEarly(uint256 resolveBy);
    error NoShortfall();
    error NothingOwed();
    error WithdrawFailed();
    error YieldSourceShortChanged(uint256 claimed, uint256 delivered);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _operator, address _treasury) {
        if (_operator == address(0) || _treasury == address(0)) revert ZeroAddress();
        operator = _operator;
        treasury = _treasury;
        emit OperatorTransferred(address(0), _operator);
    }

    // ---- lifecycle -----------------------------------------------------------

    /**
     * @notice Open a season and fix its terms. One-shot per id, so the deposit
     *         amount, both deadlines and the yield source cannot be changed once a
     *         single player has paid — which is what makes the deadlines a promise
     *         rather than a setting.
     */
    function openSeason(
        bytes32 seasonId,
        uint256 depositWei,
        uint256 registrationCloseAt,
        uint256 resolveBy,
        address yieldSource
    ) external onlyOperator {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.None) revert SeasonExists();
        if (depositWei == 0) revert ZeroValue();
        if (registrationCloseAt <= block.timestamp || resolveBy <= registrationCloseAt) {
            revert DeadlinesOutOfOrder();
        }

        s.depositWei = depositWei;
        s.registrationCloseAt = registrationCloseAt;
        s.resolveBy = resolveBy;
        s.yieldSource = yieldSource;
        s.state = SeasonState.Registration;

        emit SeasonOpened(seasonId, depositWei, registrationCloseAt, resolveBy, yieldSource);
    }

    /**
     * @notice Stake this season's deposit and enter. Refunded in full at resolve,
     *         to **this wallet** — money returns where it came from, while prizes
     *         go to the agent's payout address (D187).
     * @dev The timestamp check is the belt to the state check's braces: an operator
     *      who forgets to close registration still cannot take a late deposit.
     */
    function deposit(bytes32 seasonId) external payable nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Registration) revert NotRegistering();
        if (block.timestamp >= s.registrationCloseAt) revert RegistrationClosed();
        if (msg.value != s.depositWei) revert WrongDeposit(s.depositWei, msg.value);
        if (depositOf[seasonId][msg.sender] != 0) revert AlreadyDeposited();

        depositOf[seasonId][msg.sender] = msg.value;
        s.depositors.push(msg.sender);
        s.depositTotal += msg.value;
        reserved += msg.value;

        emit Deposited(seasonId, msg.sender, msg.value);
    }

    /**
     * @notice Add sponsor money to this season's prize pot. Open to anyone, any
     *         time before the season resolves — the prize is sponsor money end to
     *         end, because a player's deposit earns nothing for that player (D182).
     */
    function seedPot(bytes32 seasonId) external payable {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Registration && s.state != SeasonState.Staked) {
            revert NotRegistering();
        }
        if (msg.value == 0) revert ZeroValue();

        s.prizePot += msg.value;
        reserved += msg.value;

        emit PotSeeded(seasonId, msg.sender, msg.value);
    }

    /**
     * @notice Close registration and park the deposits in the yield source, in one
     *         transaction so the money is never idle in an in-between state.
     * @dev With `yieldSource == address(0)` the deposits simply stay here and earn
     *      nothing. That is the degradation path, and refunds still work (DoD 8).
     */
    function closeRegistration(bytes32 seasonId) external onlyOperator nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Registration) revert NotRegistering();

        s.state = SeasonState.Staked;

        uint256 amount = s.depositTotal;
        if (s.yieldSource != address(0) && amount > 0) {
            reserved -= amount;
            IYieldSource(s.yieldSource).stake{value: amount}(seasonId);
        }

        emit SeasonStaked(seasonId, s.yieldSource, amount);
    }

    /**
     * @notice End the season: pull the money back, refund every depositor, pay the
     *         winners from the prize pot, and sweep the interest to the treasury.
     *         One transaction, four effects (D188).
     * @param winners Payout addresses, ranked (index 0 = 1st place).
     * @param amounts Wei to each winner, from the prize pot only.
     * @param resultRoot Hash of the final leaderboard, anchoring the payout order.
     *
     * @dev Being eligible gates **prizes only, never refunds**. An idle agent that
     *      deposits and plays nothing gets 100% of its deposit back and cannot touch
     *      the prize.
     */
    function resolve(
        bytes32 seasonId,
        address[] calldata winners,
        uint256[] calldata amounts,
        bytes32 resultRoot
    ) external onlyOperator nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Registration && s.state != SeasonState.Staked) {
            revert NotResolvable();
        }
        if (winners.length != amounts.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (total > s.prizePot) revert OverDistribution(s.prizePot, total);

        uint256 refunded = _unwindAndRefund(seasonId, s);

        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == address(0)) revert ZeroAddress();
            owed[winners[i]] += amounts[i];
        }
        s.prizePot -= total;

        s.resultRoot = resultRoot;
        s.state = SeasonState.Resolved;

        emit Resolved(seasonId, resultRoot, refunded, total);
    }

    /**
     * @notice Refund everyone, callable by **anyone**, once `resolveBy` has passed
     *         with the season unresolved (D186). No operator key required.
     * @dev The prize pot is deliberately untouched — the operator can still pay it
     *      with {awardPrizes} afterwards. What nobody can ever do is hold deposits
     *      hostage.
     */
    function exitStale(bytes32 seasonId) external nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Registration && s.state != SeasonState.Staked) {
            revert NotResolvable();
        }
        if (block.timestamp < s.resolveBy) revert TooEarly(s.resolveBy);

        uint256 refunded = _unwindAndRefund(seasonId, s);
        s.state = SeasonState.Resolved;

        emit ExitedStale(seasonId, msg.sender, refunded);
    }

    /**
     * @notice Pay the prize pot after an {exitStale} already returned the deposits.
     * @dev Without this the pot would be stranded the moment a season timed out —
     *      the exact "money nothing can ever read again" defect D188 exists to avoid
     *      repeating.
     */
    function awardPrizes(
        bytes32 seasonId,
        address[] calldata winners,
        uint256[] calldata amounts,
        bytes32 resultRoot
    ) external onlyOperator nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.state != SeasonState.Resolved) revert NotResolved();
        if (winners.length != amounts.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (total > s.prizePot) revert OverDistribution(s.prizePot, total);

        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == address(0)) revert ZeroAddress();
            owed[winners[i]] += amounts[i];
        }
        s.prizePot -= total;
        if (s.resultRoot == bytes32(0)) s.resultRoot = resultRoot;

        emit PrizesAwarded(seasonId, total);
    }

    /**
     * @notice Make up a shortfall. Payable and **open to anyone** — the operator, a
     *         sponsor, a stranger — before or after depositors have withdrawn (D189).
     * @dev Refunds are never blocked waiting for this. A contract must never have a
     *      state whose only exit is an act of goodwill, which is precisely the
     *      failure {exitStale} exists to prevent.
     */
    function topUp(bytes32 seasonId) external payable nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.shortfall == 0) revert NoShortfall();
        if (msg.value == 0) revert ZeroValue();

        uint256 amount = msg.value > s.shortfall ? s.shortfall : msg.value;
        reserved += msg.value;
        s.shortfall -= amount;

        uint256 credited = _creditProRata(seasonId, s, amount);
        // Rounding dust, plus anything sent beyond the shortfall, goes to the
        // treasury rather than becoming a wei nothing can ever read (D188).
        uint256 leftover = msg.value - credited;
        if (leftover > 0) {
            owed[treasury] += leftover;
            emit YieldSwept(seasonId, treasury, leftover);
        }

        emit ToppedUp(seasonId, msg.sender, amount);
    }

    /// @notice Withdraw everything owed to the caller, across every season.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();

        owed[msg.sender] = 0;
        reserved -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Send value nobody accounted for to the treasury, so it is never stuck.
    function sweepUnaccounted() external onlyOperator nonReentrant {
        uint256 stray = address(this).balance - reserved;
        if (stray == 0) revert ZeroValue();

        owed[treasury] += stray;
        reserved += stray;

        emit UnaccountedSwept(treasury, stray);
    }

    function transferOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorTransferred(operator, newOperator);
        operator = newOperator;
    }

    // ---- internals -----------------------------------------------------------

    /**
     * @dev Pull the deposits back out of the yield source, credit every depositor,
     *      record any shortfall, and sweep the interest. Shared by {resolve} and
     *      {exitStale} so the two can never diverge.
     */
    function _unwindAndRefund(bytes32 seasonId, Season storage s) private returns (uint256) {
        uint256 expected = s.depositTotal;
        uint256 returnedAmount = expected;

        if (s.state == SeasonState.Staked && s.yieldSource != address(0) && expected > 0) {
            uint256 before = address(this).balance;
            uint256 claimed = IYieldSource(s.yieldSource).redeem(seasonId);
            returnedAmount = address(this).balance - before;
            // Trust the balance, not the claim: a source that over-reports must not
            // be able to inflate a refund it did not fund.
            if (claimed > returnedAmount) revert YieldSourceShortChanged(claimed, returnedAmount);
            reserved += returnedAmount;
        }

        uint256 refundPool = returnedAmount > expected ? expected : returnedAmount;
        if (refundPool < expected) {
            s.shortfall = expected - refundPool;
            emit ShortfallRecorded(seasonId, expected, refundPool);
        }

        uint256 credited = _creditProRata(seasonId, s, refundPool);

        // Everything that came back and was not credited to a depositor is the
        // interest plus rounding dust. Both go to the treasury (D182, D188) — there
        // is no third place for a wei to end up.
        uint256 sweep = returnedAmount - credited;
        if (sweep > 0) {
            owed[treasury] += sweep;
            emit YieldSwept(seasonId, treasury, sweep);
        }

        // `depositTotal` is deliberately NOT cleared: it is the basis every later
        // {topUp} divides by, and the season's permanent record of what was taken.
        return credited;
    }

    /**
     * @dev Credit `pool` across the season's depositors in proportion to what each
     *      paid in. Used for the refund itself and for every later {topUp}.
     *
     * ponytail: O(depositors) in one transaction — fine for a field of tens, which
     * is what a season holds. If a season ever needs thousands of seats, switch to
     * a claim-side pro-rata (store the ratio, credit on withdraw) rather than
     * raising the gas ceiling here.
     */
    function _creditProRata(bytes32 seasonId, Season storage s, uint256 pool)
        private
        returns (uint256 credited)
    {
        uint256 basis = s.depositTotal; // what was taken in, never cleared
        if (basis == 0 || pool == 0) return 0;

        address[] storage list = s.depositors;
        for (uint256 i = 0; i < list.length; i++) {
            address who = list[i];
            uint256 share = (depositOf[seasonId][who] * pool) / basis;
            if (share == 0) continue;
            owed[who] += share;
            credited += share;
            emit Refunded(seasonId, who, share);
        }
        // Integer-division dust (< depositors wei) stays here and is sweepable.
    }

    // ---- views ---------------------------------------------------------------

    function getSeason(bytes32 seasonId)
        external
        view
        returns (
            uint256 depositWei,
            uint256 depositTotal,
            uint256 prizePot,
            uint256 shortfall,
            uint256 registrationCloseAt,
            uint256 resolveBy,
            address yieldSource,
            bytes32 resultRoot,
            SeasonState state,
            uint256 entrantCount
        )
    {
        Season storage s = seasons[seasonId];
        return (
            s.depositWei,
            s.depositTotal,
            s.prizePot,
            s.shortfall,
            s.registrationCloseAt,
            s.resolveBy,
            s.yieldSource,
            s.resultRoot,
            s.state,
            s.depositors.length
        );
    }

    function depositorsOf(bytes32 seasonId) external view returns (address[] memory) {
        return seasons[seasonId].depositors;
    }

    /// @dev The yield source sends native value back during {redeem}.
    receive() external payable {}
}
