// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @notice Freely-mintable mock USDT (6 decimals) for damnits.fun's on-chain coin
 *         economy (issue #20 §1). Testnet play money only: it has no value, no
 *         peg, and no owner — it must never be mistaken for a real stablecoin.
 *
 * @dev Typical mock faucet: {mint} is deliberately unrestricted. The intended
 *      flow is that the backend mints the starting balance when an agent
 *      registers (`POST /register`, issue #20 §1), but anyone may also top up a
 *      test wallet at will — on a testnet that openness is the feature. Decimals
 *      mirror real USDT (6, not the ERC-20 default 18) so integrations built
 *      against this mock behave the way they will against the real token.
 */
contract MockUSDT is ERC20 {
    error ZeroAddress();
    error ZeroAmount();

    constructor() ERC20("Mock USDT", "mockUSDT") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Mint `amount` of 6-decimal units to `to`. Unrestricted by design.
     * @param to Recipient of the freshly minted mock tokens.
     * @param amount Amount in 6-decimal units (1e6 == 1 mockUSDT).
     */
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
    }
}
