// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VenusYieldSource, IVBNB} from "../src/VenusYieldSource.sol";
import {DamnitsVault} from "../src/DamnitsVault.sol";

/**
 * A stand-in for Venus's vBNB, faithful in the one way that matters: **redeem
 * reports failure by RETURNING a number, not by reverting.** `failWith` forces a
 * non-zero code so the adapter's check can be proven rather than assumed.
 */
contract FakeVBNB is IVBNB {
    uint256 public exchangeRate = 1e18;
    uint256 public failWith;
    mapping(address => uint256) private vTokens;

    function setFailWith(uint256 code) external {
        failWith = code;
    }

    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }

    function mint() external payable {
        vTokens[msg.sender] += (msg.value * 1e18) / exchangeRate;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        if (failWith != 0) return failWith; // NOT a revert — this is the whole point
        vTokens[msg.sender] -= redeemTokens;
        uint256 give = (redeemTokens * exchangeRate) / 1e18;
        (bool ok,) = msg.sender.call{value: give}("");
        require(ok, "send failed");
        return 0;
    }

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256) {
        if (failWith != 0) return failWith;
        vTokens[msg.sender] -= (redeemAmount * 1e18) / exchangeRate;
        (bool ok,) = msg.sender.call{value: redeemAmount}("");
        require(ok, "send failed");
        return 0;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return vTokens[owner];
    }

    function exchangeRateStored() external view returns (uint256) {
        return exchangeRate;
    }

    /// Interest arrives as value someone else supplied; the market cannot mint it.
    receive() external payable {}
}

contract VenusYieldSourceTest is Test {
    FakeVBNB internal vbnb;
    VenusYieldSource internal src;
    DamnitsVault internal vault;

    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant SEASON = keccak256("comp_venus_1");
    uint256 internal constant DEPOSIT = 0.001 ether;
    bytes32 internal constant ROOT = keccak256("root");

    function setUp() public {
        vbnb = new FakeVBNB();
        vault = new DamnitsVault(operator, treasury);
        src = new VenusYieldSource(address(vbnb), address(vault));
        vm.deal(address(vbnb), 10 ether); // the market's own liquidity
        vm.deal(stranger, 10 ether);
        for (uint256 i = 0; i < 4; i++) {
            vm.deal(_agent(i), 1 ether);
        }
    }

    function _agent(uint256 i) internal returns (address) {
        return makeAddr(string.concat("agent", vm.toString(i)));
    }

    function _openAndStake(uint256 count) internal {
        vm.prank(operator);
        vault.openSeason(
            SEASON, DEPOSIT, block.timestamp + 1 days, block.timestamp + 7 days, address(src)
        );
        for (uint256 i = 0; i < count; i++) {
            vm.prank(_agent(i));
            vault.deposit{value: DEPOSIT}(SEASON);
        }
        vm.prank(operator);
        vault.closeRegistration(SEASON);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(VenusYieldSource.ZeroAddress.selector);
        new VenusYieldSource(address(0), address(vault));
        vm.expectRevert(VenusYieldSource.ZeroAddress.selector);
        new VenusYieldSource(address(vbnb), address(0));
    }

    /// Only the vault may stake, or a stranger could distort a season's principal.
    function test_onlyTheVaultCanStakeOrRedeem() public {
        vm.prank(stranger);
        vm.expectRevert(VenusYieldSource.NotVault.selector);
        src.stake{value: 1 ether}(SEASON);

        vm.prank(stranger);
        vm.expectRevert(VenusYieldSource.NotVault.selector);
        src.redeem(SEASON);
    }

    function test_stakeAndRedeemRoundTripsToTheWei() public {
        _openAndStake(3);
        assertEq(address(vbnb).balance, 10 ether + DEPOSIT * 3, "the market took the money");

        vm.warp(block.timestamp + 1 days);
        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vault.resolve(SEASON, winners, amounts, ROOT);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(vault.owed(_agent(i)), DEPOSIT, "every deposit came back whole");
        }
    }

    /**
     * D184, proven rather than read. Venus returns 1 (UNAUTHORIZED) instead of
     * reverting; without the check the vault would credit refunds out of money
     * that never arrived.
     */
    function test_aNonZeroErrorCodeRevertsInsteadOfSilentlySucceeding() public {
        _openAndStake(2);
        vbnb.setFailWith(1);

        vm.warp(block.timestamp + 1 days);
        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(VenusYieldSource.VenusError.selector, uint256(1)));
        vault.resolve(SEASON, winners, amounts, ROOT);
    }

    /// Any non-zero code, not just the one we happened to test.
    function testFuzz_everyNonZeroCodeReverts(uint256 code) public {
        vm.assume(code != 0);
        _openAndStake(1);
        vbnb.setFailWith(code);

        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(VenusYieldSource.VenusError.selector, code));
        src.redeem(SEASON);
    }

    /**
     * The money is not lost when Venus refuses — it is still in the market, and a
     * later redeem still works. This is why the vault reverts rather than
     * recording a shortfall: nothing has actually gone wrong yet.
     */
    function test_afterAFailedRedeemTheMoneyIsStillThereAndStillRetrievable() public {
        _openAndStake(2);
        vbnb.setFailWith(1);

        vm.prank(address(vault));
        vm.expectRevert();
        src.redeem(SEASON);

        vbnb.setFailWith(0);
        vm.warp(block.timestamp + 1 days);
        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vault.resolve(SEASON, winners, amounts, ROOT);

        assertEq(vault.owed(_agent(0)), DEPOSIT);
        assertEq(vault.owed(_agent(1)), DEPOSIT);
    }

    /// Interest shows up as a rising exchange rate, and it reaches the treasury.
    function test_interestReachesTheTreasuryAndNotTheDepositors() public {
        _openAndStake(4);
        vbnb.setExchangeRate(1.1e18); // the position is now worth 10% more

        vm.warp(block.timestamp + 1 days);
        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        vm.prank(operator);
        vault.resolve(SEASON, winners, amounts, ROOT);

        uint256 staked = DEPOSIT * 4;
        for (uint256 i = 0; i < 4; i++) {
            assertEq(vault.owed(_agent(i)), DEPOSIT, "a depositor gets its stake, never the yield");
        }
        assertEq(vault.owed(treasury), staked / 10, "100% of the interest swept");
    }

    /// The view reads the position, and never claims more than it can pay.
    function test_balanceOfTracksTheExchangeRate() public {
        _openAndStake(2);
        assertEq(src.balanceOf(SEASON), DEPOSIT * 2);

        vbnb.setExchangeRate(1.5e18);
        assertEq(src.balanceOf(SEASON), (DEPOSIT * 2 * 3) / 2);

        assertEq(src.balanceOf(keccak256("never-staked")), 0);
    }

    function test_redeemingAnUnstakedSeasonReverts() public {
        vm.prank(address(vault));
        vm.expectRevert(VenusYieldSource.NothingStaked.selector);
        src.redeem(keccak256("never-staked"));
    }
}
