// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DamnitsVault} from "../src/DamnitsVault.sol";
import {MockYieldSource} from "../src/MockYieldSource.sol";

/**
 * Deploy DamnitsVault (+ optionally MockYieldSource) to BNB Smart Chain Testnet,
 * sub-spec 24 (T132).
 *
 * Separate from the other two deploy scripts for the reason D185 gives: the live
 * escrow and tournament addresses have tens of thousands of settled tables
 * pointing at them and must come out of this byte-identical. New money gets a new
 * contract; nothing here touches the old ones.
 *
 * Run (from packages/contracts, with .env populated at the repo root):
 *
 *   forge script script/DeployVault.s.sol:DeployVault \
 *     --rpc-url "$BSC_TESTNET_RPC_URL" \
 *     --broadcast \
 *     --verify
 *
 * `--verify` needs ETHERSCAN_API_KEY and verifies at deploy time rather than
 * later, so the contract is readable the first time a stranger looks (D170).
 *
 * Environment:
 *   OPERATOR_PRIVATE_KEY  required — the deployer becomes the operator.
 *   TREASURY_ADDRESS      optional — where the interest is swept. Defaults to the
 *                         operator, which is fine on testnet and should be an
 *                         address the operator does not also play from on mainnet.
 *   DEPLOY_MOCK_YIELD     optional — "true" also deploys MockYieldSource and funds
 *                         it from MOCK_YIELD_BUDGET_WEI, so a demo can show
 *                         interest accruing without waiting for a real protocol.
 *   MOCK_YIELD_RATE       optional — interest per wei of principal per second,
 *                         scaled by 1e18. Default 1e12 is visible in minutes.
 *   MOCK_YIELD_BUDGET_WEI optional — what the mock may pay out as interest. It
 *                         cannot invent value, so this bounds the whole demo.
 */
contract DeployVault is Script {
    function run() external returns (DamnitsVault vault, MockYieldSource mock) {
        uint256 deployerKey = _readOperatorKey();
        address operator = vm.addr(deployerKey);
        address treasury = vm.envOr("TREASURY_ADDRESS", operator);
        bool withMock = vm.envOr("DEPLOY_MOCK_YIELD", false);
        uint256 rate = vm.envOr("MOCK_YIELD_RATE", uint256(1e12));
        uint256 budget = vm.envOr("MOCK_YIELD_BUDGET_WEI", uint256(0));

        console.log("Deploying DamnitsVault");
        console.log("  chain id :", block.chainid);
        console.log("  operator :", operator);
        console.log("  treasury :", treasury);
        console.log("  balance  :", operator.balance);

        require(operator.balance > 0, "operator has no testnet BNB - fund it from the faucet first");
        require(operator.balance > budget, "operator balance cannot cover the mock yield budget");

        vm.startBroadcast(deployerKey);
        vault = new DamnitsVault(operator, treasury);
        if (withMock) {
            mock = new MockYieldSource{value: budget}(rate);
        }
        vm.stopBroadcast();

        console.log("");
        console.log("DamnitsVault deployed at:", address(vault));
        console.log("Put this in .env as VAULT_CONTRACT_ADDRESS");
        if (withMock) {
            console.log("MockYieldSource deployed at:", address(mock));
            console.log("  funded with (wei):", budget);
            console.log("Put this in .env as YIELD_SOURCE_ADDRESS");
        } else {
            console.log("No yield source deployed. Leaving YIELD_SOURCE_ADDRESS unset is a");
            console.log("working deployment: the vault holds deposits itself and earns nothing.");
        }
    }

    /// Read the operator key, accepting it with or without the `0x` prefix.
    function _readOperatorKey() internal view returns (uint256) {
        string memory raw = vm.envString("OPERATOR_PRIVATE_KEY");
        if (bytes(raw).length == 64) {
            raw = string.concat("0x", raw);
        }
        return uint256(vm.parseBytes32(raw));
    }
}
