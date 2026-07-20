// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DamnitsEscrow
 * @notice Entry-fee escrow, commit-reveal fairness record, and prize settlement
 *         for damnits.fun matches (parent spec §8, Requirements FR-6.1–6.5).
 *
 * @dev Fairness model — commit-reveal, not VRF (FR-6.4):
 *
 *      1. The operator generates a random seed off-chain and publishes only
 *         `keccak256(seed)` via {commitSeed}, BEFORE any card is dealt.
 *      2. That exact seed drives the deck shuffle off-chain, so the deal is fully
 *         determined by a value that was committed before anyone saw a card.
 *      3. At settlement the operator reveals the seed. This contract recomputes
 *         the hash and rejects any mismatch, so the operator cannot swap the seed
 *         after seeing the hands.
 *
 *      Anyone can then re-run the published event log against the revealed seed
 *      and confirm the shuffle was not tampered with. The chain does not verify
 *      the game itself — it anchors the two values that make the off-chain record
 *      falsifiable.
 *
 * @dev Payout model: push (the winner is paid inside {settle}). Pull-payment is
 *      the known upgrade — it removes the griefing vector where a winner whose
 *      address reverts on receive blocks its own settlement. Push is accepted for
 *      MVP per FR-6.5; the reentrancy guard plus checks-effects-interactions
 *      ordering below make it safe against the classic attack.
 */
contract DamnitsEscrow is ReentrancyGuard {
    enum SessionState {
        Open, // accepting entry fees
        Committed, // seed hash published, play under way
        Settled // winner paid, seed revealed
    }

    struct Session {
        address[] players;
        uint256 entryFeeWei;
        uint256 pot;
        bytes32 seedCommitHash;
        bytes32 resultHash;
        SessionState state;
        address winner;
    }

    /// @notice Keyed by the off-chain sessionId, hashed to bytes32.
    mapping(bytes32 => Session) private sessions;
    /// @notice Guards against one player funding a session twice.
    mapping(bytes32 => mapping(address => bool)) public hasPaid;

    /// @notice The arena backend's settlement-authorised address.
    address public operator;

    event EntryFeePaid(bytes32 indexed sessionId, address indexed player, uint256 amount);
    event SeedCommitted(bytes32 indexed sessionId, bytes32 seedCommitHash);
    event SessionSettled(
        bytes32 indexed sessionId, address indexed winner, bytes32 resultHash, bytes32 seedReveal
    );
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);

    error NotOperator();
    error ZeroAddress();
    error SessionNotOpen();
    error SessionNotCommitted();
    error AlreadyCommitted();
    error AlreadyPaid();
    error WrongEntryFee(uint256 expected, uint256 provided);
    error EntryFeeNotSet();
    error SeedRevealMismatch();
    error WinnerNotInSession();
    error PayoutFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorTransferred(address(0), _operator);
    }

    /**
     * @notice Open a session and fix its entry fee. Idempotent per session: the
     *         fee is set once, by the first call, so a later caller cannot change
     *         the price out from under players who already paid.
     */
    function openSession(bytes32 sessionId, uint256 entryFeeWei) external onlyOperator {
        Session storage session = sessions[sessionId];
        if (session.state != SessionState.Open) revert SessionNotOpen();
        if (session.entryFeeWei != 0) revert AlreadyPaid();
        session.entryFeeWei = entryFeeWei;
    }

    /**
     * @notice Pay this session's entry fee and join its pot.
     * @dev Anyone may pay for their own seat; the arena verifies the txHash
     *      off-chain before seating them. Players pay from their own wallet — the
     *      arena never handles their keys.
     */
    function payEntryFee(bytes32 sessionId) external payable nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.state != SessionState.Open) revert SessionNotOpen();
        if (session.entryFeeWei == 0) revert EntryFeeNotSet();
        if (msg.value != session.entryFeeWei) {
            revert WrongEntryFee(session.entryFeeWei, msg.value);
        }
        if (hasPaid[sessionId][msg.sender]) revert AlreadyPaid();

        hasPaid[sessionId][msg.sender] = true;
        session.players.push(msg.sender);
        session.pot += msg.value;

        emit EntryFeePaid(sessionId, msg.sender, msg.value);
    }

    /**
     * @notice Publish the shuffle commitment before play begins.
     * @dev Must happen before the deal. Once committed the session stops accepting
     *      entry fees, so the pot cannot change after the seed is fixed. A session
     *      may only be committed once — otherwise the operator could re-commit
     *      after seeing the hands, which is exactly what this scheme prevents.
     */
    function commitSeed(bytes32 sessionId, bytes32 seedCommitHash) external onlyOperator {
        Session storage session = sessions[sessionId];
        if (session.state == SessionState.Committed) revert AlreadyCommitted();
        if (session.state != SessionState.Open) revert SessionNotOpen();
        if (seedCommitHash == bytes32(0)) revert SeedRevealMismatch();

        session.seedCommitHash = seedCommitHash;
        session.state = SessionState.Committed;

        emit SeedCommitted(sessionId, seedCommitHash);
    }

    /**
     * @notice Settle a finished session: verify the reveal, record the result, pay
     *         the winner.
     * @param seedReveal The seed committed earlier; `keccak256(seedReveal)` must
     *        equal the stored commitment or the call reverts.
     * @param resultHash Hash of the off-chain event log, anchoring the record that
     *        the reveal is checked against.
     *
     * @dev Checks-effects-interactions: every state change (including marking the
     *      session Settled and zeroing the pot) happens before the payout call, so
     *      a reentrant winner re-enters a session that is already Settled and is
     *      rejected by the state check. `nonReentrant` is the belt to that braces.
     */
    function settle(bytes32 sessionId, address winner, bytes32 resultHash, bytes32 seedReveal)
        external
        onlyOperator
        nonReentrant
    {
        Session storage session = sessions[sessionId];
        if (session.state != SessionState.Committed) revert SessionNotCommitted();
        if (keccak256(abi.encodePacked(seedReveal)) != session.seedCommitHash) {
            revert SeedRevealMismatch();
        }
        if (winner != address(0) && !hasPaid[sessionId][winner]) revert WinnerNotInSession();

        // --- effects (all before the external call) ---
        uint256 payout = session.pot;
        session.pot = 0;
        session.state = SessionState.Settled;
        session.winner = winner;
        session.resultHash = resultHash;

        emit SessionSettled(sessionId, winner, resultHash, seedReveal);

        // --- interaction ---
        if (payout > 0 && winner != address(0)) {
            (bool ok,) = winner.call{value: payout}("");
            if (!ok) revert PayoutFailed();
        }
    }

    function transferOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorTransferred(operator, newOperator);
        operator = newOperator;
    }

    // ---- views ---------------------------------------------------------------

    function getSession(bytes32 sessionId)
        external
        view
        returns (
            address[] memory players,
            uint256 entryFeeWei,
            uint256 pot,
            bytes32 seedCommitHash,
            bytes32 resultHash,
            SessionState state,
            address winner
        )
    {
        Session storage s = sessions[sessionId];
        return (s.players, s.entryFeeWei, s.pot, s.seedCommitHash, s.resultHash, s.state, s.winner);
    }

    function playerCount(bytes32 sessionId) external view returns (uint256) {
        return sessions[sessionId].players.length;
    }

    /**
     * @notice Check a reveal against a session's commitment without settling.
     * @dev Lets anyone verify the published seed independently.
     */
    function verifySeed(bytes32 sessionId, bytes32 seedReveal) external view returns (bool) {
        return keccak256(abi.encodePacked(seedReveal)) == sessions[sessionId].seedCommitHash;
    }
}
