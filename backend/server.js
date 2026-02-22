/**
 *
 */

import express      from "express";
import cors         from "cors";
import { Web3 }     from "web3";
import { v4 as uuid } from "uuid";
import dotenv        from "dotenv";
import rateLimit     from "express-rate-limit";
import morgan        from "morgan";

dotenv.config();

// ─── Env validation ──────────────────────────────────────────────────────────
const REQUIRED = ["ORACLE_PRIVATE_KEY", "CONTRACT_ADDRESS", "SEPOLIA_RPC_URL"];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`❌ Missing env: ${k}`); process.exit(1); }
}

const PORT             = process.env.PORT || 3001;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_KEY       = process.env.ORACLE_PRIVATE_KEY;
const RPC_URL          = process.env.SEPOLIA_RPC_URL;

// ─── Smile score → star thresholds ──────────────────────────────────────────
// face-api.js returns expressions.happy as 0.0–1.0
const STAR_THRESHOLDS = [
  { min: 0.00, max: 0.20, stars: 1 },   // slight — REJECTED (< MIN_STARS)
  { min: 0.20, max: 0.40, stars: 2 },   // mild smile
  { min: 0.40, max: 0.60, stars: 3 },   // clear smile
  { min: 0.60, max: 0.80, stars: 4 },   // big smile
  { min: 0.80, max: 1.01, stars: 5 },   // beaming!
];

// ─── Contract ABI ────────────────────────────────────────────────────────────
const ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "user",  "type": "address" },
      { "internalType": "uint8",   "name": "stars", "type": "uint8"   },
      { "internalType": "bytes32", "name": "ref",   "type": "bytes32" }
    ],
    "name": "recordSmile",
    "outputs": [{ "internalType": "uint256", "name": "smileId", "type": "uint256" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getPendingSmiles",
    "outputs": [
      {
        "components": [
          { "internalType": "address",                         "name": "user",      "type": "address" },
          { "internalType": "uint8",                           "name": "stars",     "type": "uint8"   },
          { "internalType": "uint256",                         "name": "rewardWei", "type": "uint256" },
          { "internalType": "uint256",                         "name": "timestamp", "type": "uint256" },
          { "internalType": "enum GrinAndEarn.SmileStatus",   "name": "status",    "type": "uint8"   },
          { "internalType": "bytes32",                         "name": "ref",       "type": "bytes32" }
        ],
        "internalType": "struct GrinAndEarn.Smile[]",
        "name": "smiles",
        "type": "tuple[]"
      },
      { "internalType": "uint256[]", "name": "ids", "type": "uint256[]" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getUserSmiles",
    "outputs": [
      {
        "components": [
          { "internalType": "address",                         "name": "user",      "type": "address" },
          { "internalType": "uint8",                           "name": "stars",     "type": "uint8"   },
          { "internalType": "uint256",                         "name": "rewardWei", "type": "uint256" },
          { "internalType": "uint256",                         "name": "timestamp", "type": "uint256" },
          { "internalType": "enum GrinAndEarn.SmileStatus",   "name": "status",    "type": "uint8"   },
          { "internalType": "bytes32",                         "name": "ref",       "type": "bytes32" }
        ],
        "internalType": "struct GrinAndEarn.Smile[]",
        "name": "smiles",
        "type": "tuple[]"
      },
      { "internalType": "uint256[]", "name": "ids", "type": "uint256[]" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "contractBalance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "freeBalance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getRewardTable",
    "outputs": [{ "internalType": "uint256[6]", "name": "", "type": "uint256[6]" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getTodayCount",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getRemainingToday",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "name": "smileId",   "type": "uint256" },
      { "indexed": true,  "name": "user",       "type": "address" },
      { "indexed": false, "name": "stars",      "type": "uint8"   },
      { "indexed": false, "name": "rewardWei",  "type": "uint256" },
      { "indexed": false, "name": "ref",        "type": "bytes32" },
      { "indexed": false, "name": "timestamp",  "type": "uint256" }
    ],
    "name": "SmileRecorded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "name": "smileId",   "type": "uint256" },
      { "indexed": true,  "name": "user",       "type": "address" },
      { "indexed": false, "name": "stars",      "type": "uint8"   },
      { "indexed": false, "name": "rewardWei",  "type": "uint256" },
      { "indexed": false, "name": "timestamp",  "type": "uint256" }
    ],
    "name": "SmileClaimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "name": "user",      "type": "address" },
      { "indexed": false, "name": "stars",     "type": "uint8"   },
      { "indexed": false, "name": "timestamp", "type": "uint256" }
    ],
    "name": "SmileRejected",
    "type": "event"
  }
];

// ─── Web3 setup ───────────────────────────────────────────────────────────────
const web3    = new Web3(RPC_URL);
const oracle  = web3.eth.accounts.privateKeyToAccount(ORACLE_KEY);
web3.eth.accounts.wallet.add(oracle);
const contract = new web3.eth.Contract(ABI, CONTRACT_ADDRESS);

const toEth = (wei) => web3.utils.fromWei(wei.toString(), "ether");
const sessionToBytes32 = (id) =>
  web3.utils.padLeft(web3.utils.utf8ToHex(id.slice(0, 31)), 64);

function scoreToStars(score) {
  for (const t of STAR_THRESHOLDS) {
    if (score >= t.min && score < t.max) return t.stars;
  }
  return 5;
}

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());
app.use(morgan("dev"));

const smileLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: "Too many requests, slow down 😅" }
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  try {
    const [bal, free] = await Promise.all([
      contract.methods.contractBalance().call(),
      contract.methods.freeBalance().call(),
    ]);
    res.json({
      status: "ok", oracle: oracle.address, contract: CONTRACT_ADDRESS,
      contractBalance: toEth(bal) + " ETH",
      freeBalance: toEth(free) + " ETH",
      network: "Sepolia"
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/reward-table", async (_req, res) => {
  try {
    const table = await contract.methods.getRewardTable().call();
    res.json({
      minStarsRequired: 2,
      rewards: {
        1: { eth: toEth(table[1]), label: "Slight Smile", paid: false },
        2: { eth: toEth(table[2]), label: "Mild Smile",   paid: true  },
        3: { eth: toEth(table[3]), label: "Clear Smile",  paid: true  },
        4: { eth: toEth(table[4]), label: "Big Smile",    paid: true  },
        5: { eth: toEth(table[5]), label: "Beaming!",     paid: true  },
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all smiles (pending + claimed) for a user
app.get("/smiles/:address", async (req, res) => {
  const { address } = req.params;
  if (!web3.utils.isAddress(address))
    return res.status(400).json({ error: "Invalid address" });

  try {
    const [allSmiles, pendingSmiles, todayCount, remaining] = await Promise.all([
      contract.methods.getUserSmiles(address).call(),
      contract.methods.getPendingSmiles(address).call(),
      contract.methods.getTodayCount(address).call(),
      contract.methods.getRemainingToday(address).call(),
    ]);

    const formatSmile = (s, id) => ({
      smileId:    id.toString(),
      stars:      Number(s.stars),
      rewardEth:  toEth(s.rewardWei),
      rewardWei:  s.rewardWei.toString(),
      status:     ["Pending", "Claimed", "Rejected"][Number(s.status)],
      timestamp:  Number(s.timestamp),
      claimable:  Number(s.status) === 0, // Pending
    });

    res.json({
      address,
      todayCount:     todayCount.toString(),
      remainingToday: remaining.toString(),
      pendingCount:   pendingSmiles.ids.length,
      pending: pendingSmiles.smiles.map((s, i) => formatSmile(s, pendingSmiles.ids[i])),
      all:     allSmiles.smiles.map((s, i)     => formatSmile(s, allSmiles.ids[i])),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /submit-smile
 * Called by frontend after face-api.js scores the user's smile.
 * Oracle maps score → stars and calls recordSmile() to store as PENDING.
 * User must connect MetaMask and call claimSmile() to receive ETH.
 *
 * Body: { walletAddress, happyScore, sessionId? }
 */
app.post("/submit-smile", smileLimiter, async (req, res) => {
  const { walletAddress, happyScore, sessionId } = req.body;

  if (!walletAddress || !web3.utils.isAddress(walletAddress))
    return res.status(400).json({ error: "Invalid or missing walletAddress" });

  if (typeof happyScore !== "number" || happyScore < 0 || happyScore > 1)
    return res.status(400).json({ error: "happyScore must be 0–1" });

  const session = sessionId || uuid();
  const stars   = scoreToStars(happyScore);

  console.log(`\n📊 Smile submitted`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log(`   Score : ${(happyScore * 100).toFixed(1)}%  →  ${stars}⭐`);

  // ── Below threshold: no blockchain call at all ───────────────────────────
  if (stars < 2) {
    console.log(`   Result: ❌ Rejected (below MIN_STARS)`);
    return res.json({
      recorded: false, stars, happyScore, session,
      reason: "Smile too low — need ⭐⭐ or higher"
    });
  }

  // ── Record on-chain as PENDING ───────────────────────────────────────────
  try {
    const refBytes = sessionToBytes32(session);

    const gas = await contract.methods
      .recordSmile(walletAddress, stars, refBytes)
      .estimateGas({ from: oracle.address });

    const block       = await web3.eth.getBlock("latest");
    const maxPriority = web3.utils.toWei("1.5", "gwei");
    const maxFee      = (BigInt(block.baseFeePerGas) * 2n + BigInt(maxPriority)).toString();

    const tx = await contract.methods
      .recordSmile(walletAddress, stars, refBytes)
      .send({
        from: oracle.address,
        gas: Math.ceil(Number(gas) * 1.2).toString(),
        maxPriorityFeePerGas: maxPriority,
        maxFeePerGas: maxFee,
      });

    const event   = tx.events?.SmileRecorded;
    const smileId = event?.returnValues?.smileId?.toString() ?? "?";
    const reward  = event?.returnValues?.rewardWei;

    console.log(`   Result: ✅ Recorded smileId=${smileId}`);
    console.log(`   TxHash: ${tx.transactionHash}`);

    res.json({
      recorded:        true,
      smileId,
      stars,
      happyScore,
      rewardEth:       reward ? toEth(reward) : null,
      rewardWei:       reward?.toString(),
      recordTxHash:    tx.transactionHash,
      recordTxUrl:     `https://sepolia.etherscan.io/tx/${tx.transactionHash}`,
      session,
      nextStep:        "Connect MetaMask and click Claim to receive your ETH",
    });

  } catch (err) {
    console.error(`   Error: ${err.message}`);
    let msg = err.message;
    if (msg.includes("DailyCapReached"))         msg = "Daily smile limit reached. Try again tomorrow!";
    if (msg.includes("InsufficientBalance"))     msg = "Contract low on funds. Try again later.";

    res.status(500).json({ error: "Failed to record smile", detail: msg, recorded: false, stars, session });
  }
});

// ─── SSE: live contract events ───────────────────────────────────────────────
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  send("connected", { message: "Listening to GrinAndEarn events on Sepolia" });

  const recSub = contract.events.SmileRecorded()
    .on("data", ev => {
      const { smileId, user, stars, rewardWei } = ev.returnValues;
      send("SmileRecorded", {
        smileId: smileId.toString(), user,
        stars: Number(stars), rewardEth: toEth(rewardWei),
        txHash: ev.transactionHash,
        txUrl: `https://sepolia.etherscan.io/tx/${ev.transactionHash}`
      });
    });

  const claimedSub = contract.events.SmileClaimed()
    .on("data", ev => {
      const { smileId, user, stars, rewardWei } = ev.returnValues;
      send("SmileClaimed", {
        smileId: smileId.toString(), user,
        stars: Number(stars), rewardEth: toEth(rewardWei),
        txHash: ev.transactionHash,
        txUrl: `https://sepolia.etherscan.io/tx/${ev.transactionHash}`
      });
    });

  const rejSub = contract.events.SmileRejected()
    .on("data", ev => {
      const { user, stars } = ev.returnValues;
      send("SmileRejected", { user, stars: Number(stars) });
    });

  req.on("close", () => {
    recSub.unsubscribe?.();
    claimedSub.unsubscribe?.();
    rejSub.unsubscribe?.();
    res.end();
  });
});

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║    Grin & Earn Oracle (v3)           ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  Port     : ${PORT}                      ║`);
  console.log(`║  Network  : Sepolia                  ║`);
  console.log(`║  Oracle   : ${oracle.address.slice(0,14)}...  ║`);
  console.log("╚══════════════════════════════════════╝");
});
