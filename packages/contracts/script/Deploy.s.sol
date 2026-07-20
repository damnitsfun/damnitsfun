// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DamnitsEscrow} from "../src/DamnitsEscrow.sol";

/**
 * Deploy DamnitsEscrow to BNB Smart Chain Testnet (chain ID 97).
 *
 * The deployer becomes the operator — the only address allowed to commit seeds
 * and settle. The key is read from the environment and never appears in source
 * or in any committed file.
 *
 * Run (from packages/contracts, with .env populated at the repo root):
 *
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url "$BSC_TESTNET_RPC_URL" \
 *     --broadcast
 *
 * Then copy the printed address into ESCROW_CONTRACT_ADDRESS in .env.
 */
contract Deploy is Script {
    function run() external returns (DamnitsEscrow escrow) {
        uint256 deployerKey = _readOperatorKey();
        address operator = vm.addr(deployerKey);

        console.log("Deploying DamnitsEscrow");
        console.log("  chain id :", block.chainid);
        console.log("  operator :", operator);
        console.log("  balance  :", operator.balance);

        require(operator.balance > 0, "operator has no testnet BNB - fund it from the faucet first");

        vm.startBroadcast(deployerKey);
        escrow = new DamnitsEscrow(operator);
        vm.stopBroadcast();

        console.log("");
        console.log("DamnitsEscrow deployed at:", address(escrow));
        console.log("Put this in .env as ESCROW_CONTRACT_ADDRESS");
    }

    /**
     * Read the operator key, accepting it with or without the `0x` prefix.
     *
     * `vm.envUint` rejects a bare 64-char hex string, but that is how most
     * wallets export a key — and the API's own client (packages/api/src/chain.ts)
     * already accepts either form. Normalising here keeps one .env value working
     * for both, instead of failing a deploy over a missing prefix.
     */
    function _readOperatorKey() internal view returns (uint256) {
        string memory raw = vm.envString("OPERATOR_PRIVATE_KEY");
        if (bytes(raw).length == 64) {
            raw = string.concat("0x", raw);
        }
        return uint256(vm.parseBytes32(raw));
    }
}
