#  Grin & Earn v3 — Smile · Earn · Claim

> Smile at the camera → get rated 1–5 stars → if ≥ ⭐⭐, reward is stored on-chain →
> enter your wallet → connect MetaMask → click **Claim** → ETH sent to you.

---

## 🔄 Complete Flow

```
User smiles at webcam
       │
       ▼
face-api.js (TinyFaceDetector)
   happiness score 0.0–1.0
       │
       ▼ POST /submit-smile { walletAddress, happyScore }
       │
ORACLE BACKEND (Node.js)
   score → stars (1–5)
   stars < 2 → reject, return message (NO blockchain call)
   stars ≥ 2 → call recordSmile(wallet, stars, ref) on Sepolia
       │
       ▼
SMART CONTRACT — recordSmile()
   ✓ validates oracle role
   ✓ checks daily cap
   ✓ locks rewardWei in totalPendingWei
   ✓ stores Smile{user, stars, rewardWei, status=Pending}
   ✓ emits SmileRecorded(smileId, user, stars, rewardWei)
       │
FRONTEND polls /smiles/:wallet
   shows pending smiles with "Claim" button per smile
       │
User clicks Claim on a smile
       │
       ▼ MetaMask popup — user signs
SMART CONTRACT — claimSmile(smileId)
   msg.sender must == smile.user
   sets status = Claimed
   totalPendingWei -= reward
   transfers ETH to msg.sender
   emits SmileClaimed(smileId, user, stars, rewardWei)
       │
       ▼
ETH lands in user wallet ✅
```

---

## 📁 Structure

```
grin-earn-v3/
├── contracts/
│   ├── src/GrinAndEarn.sol       ← Smart contract
│   ├── test/GrinAndEarn.t.sol    ← Foundry tests (~30 tests + fuzz)
│   ├── script/Deploy.s.sol       ← Deploy script
│   └── foundry.toml
├── backend/
│   ├── server.js                 ← Oracle: recordSmile only (no ETH transfer)
│   ├── package.json
│   └── .env.example
└── frontend/
    ├── src/App.jsx               ← React: wallet input, camera, pending list, MetaMask claim
    ├── public/models/            ← face-api.js model weights (download below)
    ├── package.json
    ├── vite.config.js
    └── .env.example
```

---

## ⭐ Reward Table

| Stars | Score Range | Reward     | Stored? | Claimable? |
|-------|-------------|------------|---------|------------|
| ⭐     | 0–20%       | 0.001 ETH  | ❌      | ❌         |
| ⭐⭐   | 20–40%      | 0.002 ETH  | ✅      | ✅         |
| ⭐⭐⭐  | 40–60%      | 0.005 ETH  | ✅      | ✅         |
| ⭐⭐⭐⭐ | 60–80%      | 0.010 ETH  | ✅      | ✅         |
| ⭐⭐⭐⭐⭐| 80–100%    | 0.020 ETH  | ✅      | ✅         |

## 🛡️ Security

| Concern | Solution |
|---|---|
| Fake smile scores | Oracle controls all `recordSmile()` calls |
| Wrong wallet claims | `claimSmile()` checks `msg.sender == smile.user` |
| Double-claiming | `AlreadyClaimed` error if status == Claimed |
| Oracle draining funds | Can only `recordSmile`, cannot withdraw |
| Owner stealing pending | `withdrawFunds` only touches `freeBalance` (non-pending) |
| Reentrancy | CEI pattern — status set before ETH transfer |
| Farming | Daily cap per user per UTC day |
