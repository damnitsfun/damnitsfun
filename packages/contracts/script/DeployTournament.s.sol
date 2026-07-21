// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DamnitsTournament} from "../src/DamnitsTournament.sol";

/**
 * Deploy DamnitsTournament to BNB Smart Chain Testnet (chain ID 97), sub-spec 08.
 *
 * Separate from Deploy.s.sol so the already-deployed DamnitsEscrow (the per-table
 * fairness anchor) is not redeployed. The deployer becomes the operator — the only
 * address allowed to open/close/settle competitions and roll jackpots over.
 *
 * Run (from packages/contracts, with .env populated at the repo root):
 *
 *   forge script script/DeployTournament.s.sol:DeployTournament \
 *     --rpc-url "$BSC_TESTNET_RPC_URL" \
 *     --broadcast
 *
 * Then copy the printed address into TOURNAMENT_CONTRACT_ADDRESS in .env.
 */
contract DeployTournament is Script {
    function run() external returns (DamnitsTournament tournament) {
        uint256 deployerKey = _readOperatorKey();
        address operator = vm.addr(deployerKey);

        console.log("Deploying DamnitsTournament");
        console.log("  chain id :", block.chainid);
        console.log("  operator :", operator);
        console.log("  balance  :", operator.balance);

        require(operator.balance > 0, "operator has no testnet BNB - fund it from the faucet first");

        vm.startBroadcast(deployerKey);
        tournament = new DamnitsTournament(operator);
        vm.stopBroadcast();

        console.log("");
        console.log("DamnitsTournament deployed at:", address(tournament));
        console.log("Put this in .env as TOURNAMENT_CONTRACT_ADDRESS");
    }

    /// Read the operator key, accepting it with or without the `0x` prefix (see Deploy.s.sol).
    function _readOperatorKey() internal view returns (uint256) {
        string memory raw = vm.envString("OPERATOR_PRIVATE_KEY");
        if (bytes(raw).length == 64) {
            raw = string.concat("0x", raw);
        }
        return uint256(vm.parseBytes32(raw));
    }
}
