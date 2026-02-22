# Grin-Earn-
block chain based smile and earn project. 
 ── FLOW ────────────────────────────────────────────────────────────────────
 *  1. User smiles → face-api.js scores happiness → backend oracle maps to stars.
 *  2. Stars < 2  → SmileRejected event, nothing stored, no ETH locked.
 *  3. Stars >= 2 → oracle calls recordSmile() → Smile stored as PENDING,
                    reward ETH is locked inside the contract.
 *  4. User connects MetaMask, sees pending smiles, clicks "Claim" on one.
 *  5. User signs claimSmile(smileId) from their own wallet (they pay gas).
 *  6. Contract validates msg.sender == smile.user, pushes ETH to them.
