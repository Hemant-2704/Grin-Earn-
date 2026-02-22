// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  GrinAndEarn
 * @notice Smile-to-earn ETH reward system on Ethereum Sepolia.
 *
 * ── FLOW ────────────────────────────────────────────────────────────────────
 *  1. User smiles → face-api.js scores happiness → backend oracle maps to stars.
 *  2. Stars < 2  → SmileRejected event, nothing stored, no ETH locked.
 *  3. Stars >= 2 → oracle calls recordSmile() → Smile stored as PENDING,
 *                  reward ETH is locked inside the contract.
 *  4. User connects MetaMask, sees pending smiles, clicks "Claim" on one.
 *  5. User signs claimSmile(smileId) from their own wallet (they pay gas).
 *  6. Contract validates msg.sender == smile.user, pushes ETH to them.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────
 *  - Stars < 2       : rejected, nothing stored
 *  - Each smile is   : one individual claim (not accumulated)
 *  - Only the wallet : registered on the smile can claim it
 *  - Daily cap       : max N qualifying smiles per user per UTC day
 *  - Pending ETH     : locked and cannot be withdrawn by owner
 * ────────────────────────────────────────────────────────────────────────────
 */
contract GrinAndEarn {

    // ─── Errors ──────────────────────────────────────────────────────────────
    error NotOwner();
    error NotOracle();
    error ZeroAddress();
    error InvalidStarRating(uint8 given);
    error DailyCapReached(address user, uint256 cap);
    error SmileNotFound(uint256 smileId);
    error AlreadyClaimed(uint256 smileId);
    error NotSmileOwner(uint256 smileId, address caller);
    error InsufficientBalance(uint256 needed, uint256 available);
    error TransferFailed();
    error WithdrawFailed();

    // ─── Types ───────────────────────────────────────────────────────────────
    enum SmileStatus { Pending, Claimed, Rejected }

    struct Smile {
        address     user;       // wallet address registered for this smile
        uint8       stars;      // 2–5 (only qualifying smiles are stored)
        uint256     rewardWei;  // ETH locked for this smile
        uint256     timestamp;  // block time of recording
        SmileStatus status;     // Pending | Claimed
        bytes32     ref;        // off-chain session reference
    }

    // ─── Constants ───────────────────────────────────────────────────────────
    uint8 public constant MIN_STARS = 2;
    uint8 public constant MAX_STARS = 5;

    // ─── State ───────────────────────────────────────────────────────────────
    address public owner;
    mapping(address => bool) public isOracle;

    uint256[6] private _rewardPerStar; // slot 0 unused; slots 1–5 = star rewards

    uint256 public dailyCap;
    uint256 private _nextSmileId;

    mapping(uint256 => Smile)    private _smiles;
    mapping(address => uint256[]) private _userSmileIds;
    mapping(address => mapping(uint256 => uint256)) private _dailyCount;

    uint256 public totalPendingWei;  // ETH locked in unclaimed smiles
    uint256 public totalClaimedWei;  // ETH ever paid out

    // ─── Events ──────────────────────────────────────────────────────────────
    event SmileRecorded(
        uint256 indexed smileId,
        address indexed user,
        uint8           stars,
        uint256         rewardWei,
        bytes32         ref,
        uint256         timestamp
    );
    event SmileRejected(
        address indexed user,
        uint8           stars,
        uint256         timestamp
    );
    event SmileClaimed(
        uint256 indexed smileId,
        address indexed user,
        uint8           stars,
        uint256         rewardWei,
        uint256         timestamp
    );
    event OracleSet(address indexed oracle, bool authorized);
    event RewardTableUpdated(uint256[6] table);
    event DailyCapUpdated(uint256 newCap);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ─── Modifiers ───────────────────────────────────────────────────────────
    modifier onlyOwner()  { if (msg.sender != owner)           revert NotOwner();  _; }
    modifier onlyOracle() { if (!isOracle[msg.sender])         revert NotOracle(); _; }

    // ─── Constructor ─────────────────────────────────────────────────────────
    /**
     * @param rewardsWei 5-element array: wei reward for stars 1–5.
     *                   Star 1 is stored but never used (below MIN_STARS).
     * @param _dailyCap  Max qualifying smiles recorded per user per day.
     */
    constructor(uint256[5] memory rewardsWei, uint256 _dailyCap) payable {
        owner    = msg.sender;
        dailyCap = _dailyCap;
        isOracle[msg.sender] = true;

        for (uint8 i = 0; i < 5; i++) {
            _rewardPerStar[i + 1] = rewardsWei[i];
        }

        emit RewardTableUpdated(_rewardPerStar);
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  ORACLE  ─  Record smile (PENDING, no ETH transfer yet)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /**
     * @notice Called by oracle after ML smile detection.
     *         Stars < MIN_STARS → emits SmileRejected, returns 0.
     *         Stars >= MIN_STARS → stores Smile as Pending, returns smileId.
     *
     * @param user  The wallet address the user entered on the frontend.
     * @param stars Smile intensity 1–5.
     * @param ref   Off-chain session ID for audit trail.
     */
    function recordSmile(
        address user,
        uint8   stars,
        bytes32 ref
    ) external onlyOracle returns (uint256 smileId) {
        if (user == address(0))             revert ZeroAddress();
        if (stars < 1 || stars > MAX_STARS) revert InvalidStarRating(stars);

        // ── Reject below threshold ────────────────────────────────────────
        if (stars < MIN_STARS) {
            emit SmileRejected(user, stars, block.timestamp);
            return 0;
        }

        // ── Daily cap (only counts qualifying smiles) ─────────────────────
        uint256 dayId = block.timestamp / 1 days;
        if (_dailyCount[user][dayId] >= dailyCap)
            revert DailyCapReached(user, dailyCap);

        // ── Ensure free balance covers this reward ─────────────────────────
        uint256 reward = _rewardPerStar[stars];
        uint256 free   = address(this).balance > totalPendingWei
                         ? address(this).balance - totalPendingWei : 0;
        if (free < reward)
            revert InsufficientBalance(reward, free);

        // ── Store smile ────────────────────────────────────────────────────
        smileId = _nextSmileId++;

        _smiles[smileId] = Smile({
            user:      user,
            stars:     stars,
            rewardWei: reward,
            timestamp: block.timestamp,
            status:    SmileStatus.Pending,
            ref:       ref
        });

        _userSmileIds[user].push(smileId);
        _dailyCount[user][dayId]++;
        totalPendingWei += reward;

        emit SmileRecorded(smileId, user, stars, reward, ref, block.timestamp);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  USER  ─  Claim individual smile (user signs, user pays gas)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /**
     * @notice User calls this to claim ETH for one specific smile.
     *         msg.sender must be the wallet registered on the smile.
     *         User signs the transaction and pays gas fees.
     *
     * @param smileId The smile ID shown in the frontend.
     */
    function claimSmile(uint256 smileId) external {
        Smile storage s = _smiles[smileId];

        if (s.user == address(0))            revert SmileNotFound(smileId);
        if (s.status == SmileStatus.Claimed) revert AlreadyClaimed(smileId);
        if (s.user != msg.sender)            revert NotSmileOwner(smileId, msg.sender);

        uint256 reward = s.rewardWei;
        if (address(this).balance < reward)
            revert InsufficientBalance(reward, address(this).balance);

        // ── Effects before interaction (CEI pattern) ───────────────────────
        s.status         = SmileStatus.Claimed;
        totalPendingWei -= reward;
        totalClaimedWei += reward;

        // ── Transfer ETH to user ───────────────────────────────────────────
        (bool ok, ) = payable(msg.sender).call{value: reward}("");
        if (!ok) revert TransferFailed();

        emit SmileClaimed(smileId, msg.sender, s.stars, reward, block.timestamp);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  VIEW FUNCTIONS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    function getSmile(uint256 smileId) external view returns (Smile memory) {
        if (_smiles[smileId].user == address(0)) revert SmileNotFound(smileId);
        return _smiles[smileId];
    }

    /// @notice All smiles (pending + claimed) for a user
    function getUserSmiles(address user)
        external view
        returns (Smile[] memory smiles, uint256[] memory ids)
    {
        ids    = _userSmileIds[user];
        smiles = new Smile[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            smiles[i] = _smiles[ids[i]];
        }
    }

    /// @notice Only PENDING (claimable) smiles for a user
    function getPendingSmiles(address user)
        external view
        returns (Smile[] memory smiles, uint256[] memory ids)
    {
        uint256[] memory all = _userSmileIds[user];
        uint256 cnt;
        for (uint256 i = 0; i < all.length; i++) {
            if (_smiles[all[i]].status == SmileStatus.Pending) cnt++;
        }
        smiles = new Smile[](cnt);
        ids    = new uint256[](cnt);
        uint256 j;
        for (uint256 i = 0; i < all.length; i++) {
            if (_smiles[all[i]].status == SmileStatus.Pending) {
                smiles[j] = _smiles[all[i]];
                ids[j]    = all[i];
                j++;
            }
        }
    }

    function getRewardForStar(uint8 star) external view returns (uint256) {
        if (star < 1 || star > 5) revert InvalidStarRating(star);
        return _rewardPerStar[star];
    }

    function getRewardTable() external view returns (uint256[6] memory) {
        return _rewardPerStar;
    }

    function getTodayCount(address user) external view returns (uint256) {
        return _dailyCount[user][block.timestamp / 1 days];
    }

    function getRemainingToday(address user) external view returns (uint256) {
        uint256 used = _dailyCount[user][block.timestamp / 1 days];
        return used >= dailyCap ? 0 : dailyCap - used;
    }

    function contractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Balance not locked in pending smiles — available to pay new smiles
    function freeBalance() external view returns (uint256) {
        return address(this).balance > totalPendingWei
            ? address(this).balance - totalPendingWei : 0;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  ADMIN
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    function setOracle(address oracle, bool authorized) external onlyOwner {
        if (oracle == address(0)) revert ZeroAddress();
        isOracle[oracle] = authorized;
        emit OracleSet(oracle, authorized);
    }

    function updateRewardTable(uint256[5] memory rewardsWei) external onlyOwner {
        for (uint8 i = 0; i < 5; i++) {
            _rewardPerStar[i + 1] = rewardsWei[i];
        }
        emit RewardTableUpdated(_rewardPerStar);
    }

    function updateDailyCap(uint256 newCap) external onlyOwner {
        dailyCap = newCap;
        emit DailyCapUpdated(newCap);
    }

    /// @notice Only free (non-pending) ETH can be withdrawn
    function withdrawFunds(uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = address(this).balance > totalPendingWei
                       ? address(this).balance - totalPendingWei : 0;
        if (amount > free) revert InsufficientBalance(amount, free);
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}
