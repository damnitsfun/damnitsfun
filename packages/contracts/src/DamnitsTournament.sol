// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DamnitsTournament
 * @notice Competition-scoped prize pool, sponsor-seeded jackpot side-pool, and
 *         rank-based settlement for damnits.fun's pooled tournaments (sub-spec 08,
 *         decisions D1/D2/D7/D13/D14/D15).
 *
 * @dev How this differs from {DamnitsEscrow}. The escrow keys money on a single
 *      table (a per-session pot paid to that table's winner). This contract keys
 *      money on a whole *competition*: entry buy-ins and sponsor money accumulate
 *      into one pool, play runs across many free tables, and at season close the
 *      operator distributes the pool to the top of the off-chain openskill
 *      leaderboard. The two contracts coexist — {DamnitsEscrow} still anchors each
 *      table's commit-reveal (run at a zero entry fee, so it pays nothing and is a
 *      pure fairness log), and this contract holds the season's money.
 *
 * @dev Entries stay open the whole season (D9). {payEntry}, {seedPool} and
 *      {seedJackpot} are all callable while a competition is `Open`; a single
 *      {closeEntries} call ends the season. The backend snapshots the final pool
 *      and the final ranking at the same instant, so the pot cannot move after
 *      results are known without freezing entries early.
 *
 * @dev Payout model: PULL (D7). {settleCompetition} only credits `owed[winner]`;
 *      each winner calls {withdraw}. With many recipients this is safer than push —
 *      one winner whose address reverts on receive cannot block everyone else's
 *      payout, which a push loop would allow.
 *
 * @dev Trust boundary. The operator (the arena backend) is trusted to pass a
 *      correct `winners`/`amounts` distribution derived from the public event log,
 *      exactly as {DamnitsEscrow.settle} trusts it to name the winner. The contract
 *      does NOT recompute the ranking; it enforces the money invariants that make
 *      the operator unable to over-pay (sum(amounts) <= pool, jackpotAmount <=
 *      jackpotPool) and publishes `resultRoot` so anyone can recompute the ranking
 *      from the event log and check the order. Winners are payout addresses, which
 *      may differ from the wallet that entered, so entry is not required of them.
 */
contract DamnitsTournament is ReentrancyGuard {
    enum CompetitionState {
        None, // default: never opened
        Open, // accepting entries, pool + jackpot seeding
        EntriesClosed, // season over, awaiting settlement
        Settled // distributed to owed[]
    }

    struct Competition {
        uint256 entryFeeWei;
        uint256 pool; // buy-ins + sponsor seed, still to distribute
        uint256 jackpotPool; // sponsor-seeded side-pool, still to distribute
        uint256 entrantCount;
        bytes32 resultRoot; // hash of the final leaderboard (set at settle)
        CompetitionState state;
    }

    /// @notice Keyed by the off-chain competitionId, hashed to bytes32.
    mapping(bytes32 => Competition) private competitions;
    /// @notice One buy-in per address per competition (D12).
    mapping(bytes32 => mapping(address => bool)) public hasEntered;
    /// @notice Pull-payment ledger, global per address across all competitions.
    mapping(address => uint256) public owed;

    /// @notice The arena backend's settlement-authorised address.
    address public operator;

    event CompetitionOpened(bytes32 indexed competitionId, uint256 entryFeeWei);
    event EntryPaid(bytes32 indexed competitionId, address indexed player, uint256 amount);
    event PoolSeeded(bytes32 indexed competitionId, address indexed from, uint256 amount);
    event JackpotSeeded(bytes32 indexed competitionId, address indexed from, uint256 amount);
    event EntriesClosedEvent(bytes32 indexed competitionId, uint256 pool, uint256 jackpotPool);
    event CompetitionSettled(
        bytes32 indexed competitionId,
        bytes32 resultRoot,
        uint256 distributed,
        address jackpotWinner,
        uint256 jackpotAmount
    );
    event JackpotAwarded(
        bytes32 indexed competitionId,
        address indexed winner,
        uint256 amount,
        bytes32 resultHash,
        bytes32 seedReveal
    );
    event JackpotRolledOver(
        bytes32 indexed fromCompetitionId, bytes32 indexed toCompetitionId, uint256 amount
    );
    event Withdrawn(address indexed to, uint256 amount);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);

    error NotOperator();
    error ZeroAddress();
    error CompetitionExists();
    error CompetitionNotOpen();
    error CompetitionNotClosed();
    error CompetitionNotSettled();
    error AlreadyEntered();
    error WrongEntryFee(uint256 expected, uint256 provided);
    error ZeroValue();
    error LengthMismatch();
    error OverDistribution(uint256 pool, uint256 requested);
    error JackpotOverDistribution(uint256 jackpotPool, uint256 requested);
    error InvalidJackpotWinner();
    error NoJackpotToRollover();
    error NothingOwed();
    error WithdrawFailed();
    error JackpotPayoutFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorTransferred(address(0), _operator);
    }

    // ---- lifecycle -----------------------------------------------------------

    /**
     * @notice Open a competition and fix its buy-in. One-shot per id: a competition
     *         can only be opened once, so its fee cannot be changed after entries.
     */
    function openCompetition(bytes32 competitionId, uint256 entryFeeWei) external onlyOperator {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.None) revert CompetitionExists();
        c.entryFeeWei = entryFeeWei;
        c.state = CompetitionState.Open;
        emit CompetitionOpened(competitionId, entryFeeWei);
    }

    /**
     * @notice Pay this competition's buy-in and join its pool. Open the entire
     *         season (D9) — an agent may enter mid-tournament. One entry per
     *         address (D12); pay from your own wallet, the arena never holds keys.
     */
    function payEntry(bytes32 competitionId) external payable nonReentrant {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.Open) revert CompetitionNotOpen();
        if (msg.value != c.entryFeeWei) revert WrongEntryFee(c.entryFeeWei, msg.value);
        if (hasEntered[competitionId][msg.sender]) revert AlreadyEntered();

        hasEntered[competitionId][msg.sender] = true;
        c.entrantCount += 1;
        c.pool += msg.value;

        emit EntryPaid(competitionId, msg.sender, msg.value);
    }

    /**
     * @notice Add sponsor money to the MAIN prize pool — it merges with entry fees
     *         into one pot (this is dev.fun's "$X sponsored by …"). Callable by
     *         anyone while the season is Open, so a sponsor can top up mid-run.
     */
    function seedPool(bytes32 competitionId) external payable {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.Open) revert CompetitionNotOpen();
        if (msg.value == 0) revert ZeroValue();
        c.pool += msg.value;
        emit PoolSeeded(competitionId, msg.sender, msg.value);
    }

    /**
     * @notice Add sponsor money to the separate JACKPOT side-pool (D2). Isolated
     *         from the fee/prize math; paid to the season's first Rainbow Storm
     *         triggerer, or rolled over via {rolloverJackpot} if untriggered.
     */
    function seedJackpot(bytes32 competitionId) external payable {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.Open) revert CompetitionNotOpen();
        if (msg.value == 0) revert ZeroValue();
        c.jackpotPool += msg.value;
        emit JackpotSeeded(competitionId, msg.sender, msg.value);
    }

    /**
     * @notice End the season. The single boundary that stops entries and seeding;
     *         the backend snapshots pool + ranking together right after this.
     */
    function closeEntries(bytes32 competitionId) external onlyOperator {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.Open) revert CompetitionNotOpen();
        c.state = CompetitionState.EntriesClosed;
        emit EntriesClosedEvent(competitionId, c.pool, c.jackpotPool);
    }

    /**
     * @notice Distribute the pool to the ranked winners and the jackpot to its
     *         triggerer. Pull payment: this only credits `owed`.
     * @param winners Payout addresses, ranked (index 0 = 1st place).
     * @param amounts Wei to each winner; must line up with `winners`.
     * @param jackpotWinner Payout address of the storm triggerer, or the zero
     *        address if no storm fired (then `jackpotAmount` must be 0 and the
     *        jackpot stays for {rolloverJackpot}).
     * @param jackpotAmount Wei from the jackpot pool to `jackpotWinner`.
     * @param resultRoot Hash of the final leaderboard, anchoring the payout order.
     *
     * @dev Effects-before-interactions is trivially satisfied: there is no external
     *      call here at all (pull model), so settlement cannot be reentered.
     */
    function settleCompetition(
        bytes32 competitionId,
        address[] calldata winners,
        uint256[] calldata amounts,
        address jackpotWinner,
        uint256 jackpotAmount,
        bytes32 resultRoot
    ) external onlyOperator nonReentrant {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.EntriesClosed) revert CompetitionNotClosed();
        if (winners.length != amounts.length) revert LengthMismatch();
        if (jackpotWinner == address(0) && jackpotAmount != 0) revert InvalidJackpotWinner();

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (total > c.pool) revert OverDistribution(c.pool, total);
        if (jackpotAmount > c.jackpotPool) {
            revert JackpotOverDistribution(c.jackpotPool, jackpotAmount);
        }

        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == address(0)) revert ZeroAddress();
            owed[winners[i]] += amounts[i];
        }
        c.pool -= total;

        if (jackpotWinner != address(0) && jackpotAmount > 0) {
            owed[jackpotWinner] += jackpotAmount;
            c.jackpotPool -= jackpotAmount;
        }

        c.resultRoot = resultRoot;
        c.state = CompetitionState.Settled;

        emit CompetitionSettled(competitionId, resultRoot, total, jackpotWinner, jackpotAmount);
    }

    /**
     * @notice Immediately pay a capped amount from the jackpot side-pool to a single
     *         winner, WITHOUT closing the competition (sub-spec 14, D65/D66). This is
     *         the playground's Rainbow-Storm jackpot: an always-on `classic` season
     *         stays `Open` and can award again from whatever pool remains, so no
     *         season-close/settlement step is needed to pay a storm the instant it
     *         fires. Distinct from {settleCompetition} (which distributes the main
     *         pool at season close and moves the competition to `Settled`).
     * @param winner The storm triggerer's wallet — a server-generated custodial EOA
     *        (no code), so a push transfer cannot be used to reenter; `nonReentrant`
     *        plus effects-before-interaction guard it regardless.
     * @param amount Wei from the jackpot pool; must be `<= jackpotPool`.
     * @param resultHash / seedReveal The settling session's result hash and revealed
     *        seed, emitted so the payout is auditable against the provably-fair,
     *        commit-revealed storm. The contract does not re-verify the seed (the
     *        playground season has no per-session commit here) — the event is the trail.
     */
    function awardJackpot(
        bytes32 competitionId,
        address winner,
        uint256 amount,
        bytes32 resultHash,
        bytes32 seedReveal
    ) external onlyOperator nonReentrant {
        Competition storage c = competitions[competitionId];
        if (c.state != CompetitionState.Open) revert CompetitionNotOpen();
        if (winner == address(0)) revert InvalidJackpotWinner();
        if (amount == 0) revert ZeroValue();
        if (amount > c.jackpotPool) revert JackpotOverDistribution(c.jackpotPool, amount);

        c.jackpotPool -= amount; // effects before interaction

        (bool ok,) = winner.call{value: amount}("");
        if (!ok) revert JackpotPayoutFailed();

        emit JackpotAwarded(competitionId, winner, amount, resultHash, seedReveal);
    }

    /**
     * @notice Carry an untriggered/residual jackpot from a settled competition into
     *         an open one (D15). Funds never leave the contract.
     */
    function rolloverJackpot(bytes32 fromCompetitionId, bytes32 toCompetitionId)
        external
        onlyOperator
    {
        Competition storage from = competitions[fromCompetitionId];
        Competition storage to = competitions[toCompetitionId];
        if (from.state != CompetitionState.Settled) revert CompetitionNotSettled();
        if (to.state != CompetitionState.Open) revert CompetitionNotOpen();

        uint256 amount = from.jackpotPool;
        if (amount == 0) revert NoJackpotToRollover();

        from.jackpotPool = 0;
        to.jackpotPool += amount;

        emit JackpotRolledOver(fromCompetitionId, toCompetitionId, amount);
    }

    /**
     * @notice Withdraw everything owed to the caller across all settled
     *         competitions. Checks-effects-interactions + `nonReentrant`.
     */
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();

        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();

        emit Withdrawn(msg.sender, amount);
    }

    function transferOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorTransferred(operator, newOperator);
        operator = newOperator;
    }

    // ---- views ---------------------------------------------------------------

    function getCompetition(bytes32 competitionId)
        external
        view
        returns (
            uint256 entryFeeWei,
            uint256 pool,
            uint256 jackpotPool,
            uint256 entrantCount,
            bytes32 resultRoot,
            CompetitionState state
        )
    {
        Competition storage c = competitions[competitionId];
        return (c.entryFeeWei, c.pool, c.jackpotPool, c.entrantCount, c.resultRoot, c.state);
    }
}
