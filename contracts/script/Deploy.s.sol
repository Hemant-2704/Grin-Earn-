// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/GrinAndEarn.sol";

contract DeployGrinAndEarn is Script {
    uint256[5] REWARDS_WEI = [
        0.001 ether,   // ⭐   (stored but never paid)
        0.002 ether,   // ⭐⭐
        0.005 ether,   // ⭐⭐⭐
        0.010 ether,   // ⭐⭐⭐⭐
        0.020 ether    // ⭐⭐⭐⭐⭐
    ];

    uint256 DAILY_CAP    = 10;
    uint256 INITIAL_FUND = 0.5 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address oracleAddr  = vm.envAddress("ORACLE_ADDRESS");

        vm.startBroadcast(deployerKey);

        GrinAndEarn grin = new GrinAndEarn{value: INITIAL_FUND}(REWARDS_WEI, DAILY_CAP);
        grin.setOracle(oracleAddr, true);

        vm.stopBroadcast();

        console.log("========================================");
        console.log("  Grin & Earn  deployed to Sepolia");
        console.log("========================================");
        console.log("Contract  :", address(grin));
        console.log("Owner     :", grin.owner());
        console.log("Oracle    :", oracleAddr);
        console.log("Balance   :", grin.contractBalance(), "wei");
        console.log("DailyCap  :", grin.dailyCap());
    }
}
