// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/GrinAndEarn.sol";

contract GrinAndEarnTest is Test {
    GrinAndEarn public g;

    address owner  = address(this);
    address oracle = makeAddr("oracle");
    address user1  = makeAddr("user1");
    address user2  = makeAddr("user2");
    address hacker = makeAddr("hacker");

    uint256[5] REWARDS = [
        0.001 ether,   // ⭐   stored, never paid
        0.002 ether,   // ⭐⭐
        0.005 ether,   // ⭐⭐⭐
        0.010 ether,   // ⭐⭐⭐⭐
        0.020 ether    // ⭐⭐⭐⭐⭐
    ];

    uint256 DAILY_CAP = 5;
    bytes32 REF       = keccak256("test-session");

    event SmileRecorded(uint256 indexed smileId, address indexed user, uint8 stars, uint256 rewardWei, bytes32 ref, uint256 timestamp);
    event SmileRejected(address indexed user, uint8 stars, uint256 timestamp);
    event SmileClaimed(uint256 indexed smileId, address indexed user, uint8 stars, uint256 rewardWei, uint256 timestamp);

    function setUp() public {
        g = new GrinAndEarn{value: 10 ether}(REWARDS, DAILY_CAP);
        g.setOracle(oracle, true);
        vm.deal(user1, 1 ether);
        vm.deal(user2, 1 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DEPLOYMENT
    // ═══════════════════════════════════════════════════════════════════════

    function test_Deploy_Owner() public view {
        assertEq(g.owner(), owner);
    }

    function test_Deploy_Funded() public view {
        assertEq(g.contractBalance(), 10 ether);
    }

    function test_Deploy_RewardTable() public view {
        assertEq(g.getRewardForStar(1), 0.001 ether);
        assertEq(g.getRewardForStar(2), 0.002 ether);
        assertEq(g.getRewardForStar(3), 0.005 ether);
        assertEq(g.getRewardForStar(4), 0.010 ether);
        assertEq(g.getRewardForStar(5), 0.020 ether);
    }

    function test_Deploy_DailyCap() public view {
        assertEq(g.dailyCap(), DAILY_CAP);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  recordSmile — REJECTION path (stars < 2)
    // ═══════════════════════════════════════════════════════════════════════

    function test_Record_1Star_Rejected_Returns0() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 1, REF);
        assertEq(id, 0);
    }

    function test_Record_1Star_NoEthLocked() public {
        vm.prank(oracle);
        g.recordSmile(user1, 1, REF);
        assertEq(g.totalPendingWei(), 0);
        assertEq(g.contractBalance(), 10 ether); // unchanged
    }

    function test_Record_1Star_EmitsRejected() public {
        vm.prank(oracle);
        vm.expectEmit(true, false, false, true);
        emit SmileRejected(user1, 1, block.timestamp);
        g.recordSmile(user1, 1, REF);
    }

    function test_Record_1Star_NotStoredInUserList() public {
        vm.prank(oracle);
        g.recordSmile(user1, 1, REF);
        (,uint256[] memory ids) = g.getUserSmiles(user1);
        assertEq(ids.length, 0);
    }

    function test_Record_1Star_NotCountedTowardDailyCap() public {
        vm.startPrank(oracle);
        // Fill cap with rejections
        for (uint i = 0; i < DAILY_CAP; i++) g.recordSmile(user1, 1, REF);
        // Should still be able to record qualifying smile
        uint256 id = g.recordSmile(user1, 3, REF);
        vm.stopPrank();
        assertTrue(id > 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  recordSmile — SUCCESS path (stars >= 2)
    // ═══════════════════════════════════════════════════════════════════════

    function test_Record_2Star_StoresPending() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 2, REF);
        GrinAndEarn.Smile memory s = g.getSmile(id);
        assertEq(s.user,      user1);
        assertEq(s.stars,     2);
        assertEq(s.rewardWei, 0.002 ether);
        assertEq(uint8(s.status), uint8(GrinAndEarn.SmileStatus.Pending));
    }

    function test_Record_LocksETHInPending() public {
        vm.prank(oracle);
        g.recordSmile(user1, 5, REF);
        assertEq(g.totalPendingWei(), 0.020 ether);
        assertEq(g.freeBalance(), 10 ether - 0.020 ether);
    }

    function test_Record_EmitsSmileRecorded() public {
        vm.prank(oracle);
        vm.expectEmit(true, true, false, false);
        emit SmileRecorded(0, user1, 4, 0.010 ether, REF, block.timestamp);
        g.recordSmile(user1, 4, REF);
    }

    function test_Record_AppearsInUserSmileList() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 3, REF);
        (,uint256[] memory ids) = g.getUserSmiles(user1);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }

    function test_Record_CountsTowardDailyCap() public {
        vm.prank(oracle);
        g.recordSmile(user1, 2, REF);
        assertEq(g.getTodayCount(user1), 1);
        assertEq(g.getRemainingToday(user1), DAILY_CAP - 1);
    }

    function test_Record_MultipleSmiles_IncrementingIds() public {
        vm.startPrank(oracle);
        uint256 id0 = g.recordSmile(user1, 2, REF);
        uint256 id1 = g.recordSmile(user1, 3, REF);
        uint256 id2 = g.recordSmile(user1, 5, REF);
        vm.stopPrank();
        assertEq(id1, id0 + 1);
        assertEq(id2, id0 + 2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  recordSmile — ACCESS CONTROL
    // ═══════════════════════════════════════════════════════════════════════

    function test_Record_RevertIf_NotOracle() public {
        vm.prank(hacker);
        vm.expectRevert(GrinAndEarn.NotOracle.selector);
        g.recordSmile(user1, 3, REF);
    }

    function test_Record_RevertIf_ZeroAddress() public {
        vm.prank(oracle);
        vm.expectRevert(GrinAndEarn.ZeroAddress.selector);
        g.recordSmile(address(0), 3, REF);
    }

    function test_Record_RevertIf_StarZero() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.InvalidStarRating.selector, 0));
        g.recordSmile(user1, 0, REF);
    }

    function test_Record_RevertIf_Star6() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.InvalidStarRating.selector, 6));
        g.recordSmile(user1, 6, REF);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Daily Cap
    // ═══════════════════════════════════════════════════════════════════════

    function test_DailyCap_Enforced() public {
        vm.startPrank(oracle);
        for (uint i = 0; i < DAILY_CAP; i++) g.recordSmile(user1, 2, REF);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.DailyCapReached.selector, user1, DAILY_CAP));
        g.recordSmile(user1, 2, REF);
        vm.stopPrank();
    }

    function test_DailyCap_ResetsNextDay() public {
        vm.startPrank(oracle);
        for (uint i = 0; i < DAILY_CAP; i++) g.recordSmile(user1, 2, REF);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 3, REF); // should succeed
        assertTrue(id > 0);
    }

    function test_DailyCap_IndependentPerUser() public {
        vm.startPrank(oracle);
        for (uint i = 0; i < DAILY_CAP; i++) g.recordSmile(user1, 2, REF);
        // user2 untouched
        uint256 id = g.recordSmile(user2, 5, REF);
        vm.stopPrank();
        assertTrue(id > 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  claimSmile — SUCCESS
    // ═══════════════════════════════════════════════════════════════════════

    function test_Claim_TransfersETH() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 4, REF); // 0.010 ETH

        uint256 balBefore = user1.balance;
        vm.prank(user1);
        g.claimSmile(id);
        assertEq(user1.balance, balBefore + 0.010 ether);
    }

    function test_Claim_UpdatesStatus() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 3, REF);

        vm.prank(user1);
        g.claimSmile(id);

        GrinAndEarn.Smile memory s = g.getSmile(id);
        assertEq(uint8(s.status), uint8(GrinAndEarn.SmileStatus.Claimed));
    }

    function test_Claim_ReducesPendingWei() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 5, REF); // 0.020 ETH
        assertEq(g.totalPendingWei(), 0.020 ether);

        vm.prank(user1);
        g.claimSmile(id);
        assertEq(g.totalPendingWei(), 0);
    }

    function test_Claim_UpdatesTotalClaimedWei() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 5, REF);

        vm.prank(user1);
        g.claimSmile(id);
        assertEq(g.totalClaimedWei(), 0.020 ether);
    }

    function test_Claim_EmitsEvent() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 2, REF);

        vm.prank(user1);
        vm.expectEmit(true, true, false, true);
        emit SmileClaimed(id, user1, 2, 0.002 ether, block.timestamp);
        g.claimSmile(id);
    }

    function test_Claim_EachSmileIndividually() public {
        vm.startPrank(oracle);
        uint256 id1 = g.recordSmile(user1, 2, REF);
        uint256 id2 = g.recordSmile(user1, 5, REF);
        vm.stopPrank();

        // Claim only first
        vm.prank(user1);
        g.claimSmile(id1);

        // Second still pending
        GrinAndEarn.Smile memory s2 = g.getSmile(id2);
        assertEq(uint8(s2.status), uint8(GrinAndEarn.SmileStatus.Pending));
        assertEq(g.totalPendingWei(), 0.020 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  claimSmile — REVERTS
    // ═══════════════════════════════════════════════════════════════════════

    function test_Claim_RevertIf_WrongUser() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 3, REF);

        vm.prank(user2);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.NotSmileOwner.selector, id, user2));
        g.claimSmile(id);
    }

    function test_Claim_RevertIf_AlreadyClaimed() public {
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, 3, REF);

        vm.prank(user1);
        g.claimSmile(id);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.AlreadyClaimed.selector, id));
        g.claimSmile(id);
    }

    function test_Claim_RevertIf_InvalidId() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.SmileNotFound.selector, 999));
        g.claimSmile(999);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  getPendingSmiles
    // ═══════════════════════════════════════════════════════════════════════

    function test_GetPendingSmiles_ReturnsPending() public {
        vm.startPrank(oracle);
        uint256 id1 = g.recordSmile(user1, 2, REF);
        uint256 id2 = g.recordSmile(user1, 4, REF);
        uint256 id3 = g.recordSmile(user1, 5, REF);
        vm.stopPrank();

        // Claim one
        vm.prank(user1);
        g.claimSmile(id2);

        // Only id1 and id3 should be pending
        (,uint256[] memory pendingIds) = g.getPendingSmiles(user1);
        assertEq(pendingIds.length, 2);
        assertEq(pendingIds[0], id1);
        assertEq(pendingIds[1], id3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  freeBalance — Owner cannot withdraw pending ETH
    // ═══════════════════════════════════════════════════════════════════════

    function test_FreeBalance_ExcludesPending() public {
        vm.prank(oracle);
        g.recordSmile(user1, 5, REF); // 0.020 ETH locked
        assertEq(g.freeBalance(), 10 ether - 0.020 ether);
    }

    function test_WithdrawFunds_CannotTouchPending() public {
        vm.prank(oracle);
        g.recordSmile(user1, 5, REF); // 0.020 ETH locked
        uint256 free = g.freeBalance();
        // Trying to withdraw more than free should revert
        vm.expectRevert(abi.encodeWithSelector(GrinAndEarn.InsufficientBalance.selector, free + 1, free));
        g.withdrawFunds(free + 1, owner);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function test_SetOracle_Revoke() public {
        g.setOracle(oracle, false);
        vm.prank(oracle);
        vm.expectRevert(GrinAndEarn.NotOracle.selector);
        g.recordSmile(user1, 3, REF);
    }

    function test_UpdateRewardTable() public {
        uint256[5] memory newR = [uint256(0.002 ether), 0.004 ether, 0.008 ether, 0.016 ether, 0.032 ether];
        g.updateRewardTable(newR);
        assertEq(g.getRewardForStar(5), 0.032 ether);
    }

    function test_UpdateRewardTable_RevertIf_NotOwner() public {
        uint256[5] memory newR = [uint256(1), 2, 3, 4, 5];
        vm.prank(hacker);
        vm.expectRevert(GrinAndEarn.NotOwner.selector);
        g.updateRewardTable(newR);
    }

    function test_Withdraw_Success() public {
        uint256 before = owner.balance;
        g.withdrawFunds(1 ether, owner);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_Withdraw_RevertIf_NotOwner() public {
        vm.prank(hacker);
        vm.expectRevert(GrinAndEarn.NotOwner.selector);
        g.withdrawFunds(1 ether, hacker);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FUZZ
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_Record_ValidStars(uint8 star) public {
        vm.assume(star >= 2 && star <= 5);
        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, star, REF);
        GrinAndEarn.Smile memory s = g.getSmile(id);
        assertEq(s.stars, star);
        assertEq(s.rewardWei, g.getRewardForStar(star));
        assertEq(uint8(s.status), uint8(GrinAndEarn.SmileStatus.Pending));
    }

    function testFuzz_Record_Star1_AlwaysRejected(address randomUser) public {
        vm.assume(randomUser != address(0));
        vm.prank(oracle);
        uint256 id = g.recordSmile(randomUser, 1, REF);
        assertEq(id, 0);
        assertEq(g.totalPendingWei(), 0);
    }

    function testFuzz_Claim_CorrectAmount(uint8 star) public {
        vm.assume(star >= 2 && star <= 5);
        uint256 expected = g.getRewardForStar(star);

        vm.prank(oracle);
        uint256 id = g.recordSmile(user1, star, REF);

        uint256 balBefore = user1.balance;
        vm.prank(user1);
        g.claimSmile(id);

        assertEq(user1.balance, balBefore + expected);
    }

    receive() external payable {}
}
