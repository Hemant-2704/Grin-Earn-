import { useState, useRef, useEffect, useCallback } from "react";
import * as faceapi from "face-api.js";

const ORACLE_URL  = import.meta.env.VITE_ORACLE_URL || "http://localhost:3001";
const MODEL_PATH  = "/models";
const SEPOLIA_ID  = "0xaa36a7"; // chain ID 11155111 in hex

// Contract ABI — only claimSmile() needed from frontend
const CLAIM_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "smileId", type: "uint256" }],
    name: "claimSmile",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt  = (eth) => parseFloat(eth).toFixed(4);
const addr = (a)   => a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "";
const STAR_LABEL = { 1:"Slight", 2:"Mild", 3:"Clear", 4:"Big", 5:"Beaming!" };
const STAR_COLOR = { 1:"#64748b", 2:"#22c55e", 3:"#10b981", 4:"#3b82f6", 5:"#a855f7" };

// ─── Styles ──────────────────────────────────────────────────────────────────
const css = {
  app: { minHeight:"100vh", background:"#080810", color:"#e2e8f0", fontFamily:"'Inter',system-ui,sans-serif" },
  header: {
    display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"16px 36px", borderBottom:"1px solid rgba(255,255,255,0.06)",
    background:"rgba(8,8,16,0.9)", backdropFilter:"blur(12px)",
    position:"sticky", top:0, zIndex:100,
  },
  logo: {
    fontSize:"1.35rem", fontWeight:900,
    background:"linear-gradient(135deg,#a855f7,#fbbf24)",
    WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
  },
  pill: (color="#a855f7", bg="rgba(168,85,247,0.12)") => ({
    background:bg, border:`1px solid ${color}40`,
    color, borderRadius:20, padding:"4px 14px",
    fontSize:"0.75rem", fontWeight:600,
  }),
  main: { maxWidth:1020, margin:"0 auto", padding:"36px 20px" },
  grid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:22 },
  card: {
    background:"rgba(255,255,255,0.025)",
    border:"1px solid rgba(255,255,255,0.07)",
    borderRadius:18, padding:26,
  },
  sectionTitle: {
    fontSize:"0.68rem", fontWeight:700, letterSpacing:"0.12em",
    textTransform:"uppercase", color:"#475569",
    marginBottom:18, display:"flex", alignItems:"center", gap:8,
  },
  input: {
    width:"100%", padding:"13px 15px",
    background:"rgba(255,255,255,0.04)",
    border:"1px solid rgba(255,255,255,0.09)",
    borderRadius:11, color:"#e2e8f0",
    fontSize:"0.9rem", fontFamily:"monospace",
    outline:"none", boxSizing:"border-box", transition:"border 0.2s",
  },
  label: { display:"block", fontSize:"0.8rem", color:"#64748b", marginBottom:7 },
  btn: (grad, disabled=false) => ({
    width:"100%", padding:"13px", border:"none",
    borderRadius:12, fontSize:"0.95rem", fontWeight:700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.42 : 1,
    background: grad, color:"white",
    transition:"all 0.18s", marginTop:10,
  }),
  camBox: {
    position:"relative", width:"100%", aspectRatio:"4/3",
    borderRadius:12, overflow:"hidden", background:"#0c0c18",
    border:"1px solid rgba(255,255,255,0.07)", marginBottom:12,
    display:"flex", alignItems:"center", justifyContent:"center",
  },
  overlay: (color) => ({
    position:"absolute", inset:0, display:"flex",
    alignItems:"center", justifyContent:"center",
    flexDirection:"column", gap:8,
    background:`rgba(${color},0.12)`,
  }),
  smileCard: (stars) => ({
    background:"rgba(255,255,255,0.03)",
    border:`1px solid ${STAR_COLOR[stars] || "#334155"}40`,
    borderRadius:13, padding:"14px 16px", marginBottom:10,
    display:"flex", alignItems:"center", gap:14,
  }),
  claimBtn: (loading) => ({
    padding:"8px 18px", border:"none", borderRadius:9,
    fontSize:"0.82rem", fontWeight:700, cursor: loading?"not-allowed":"pointer",
    opacity: loading ? 0.5 : 1,
    background:"linear-gradient(135deg,#7c3aed,#a855f7)",
    color:"white", whiteSpace:"nowrap", flexShrink:0,
    transition:"all 0.18s",
  }),
};

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // Step 1 — wallet input
  const [walletInput, setWalletInput] = useState("");
  const [walletErr,   setWalletErr]   = useState("");

  // Step 2 — camera / ML
  const [mlReady,   setMlReady]   = useState(false);
  const [camOn,     setCamOn]     = useState(false);
  const [scanning,  setScanning]  = useState(false);
  const [submitting,setSubmitting]= useState(false);
  const videoRef  = useRef(null);
  const streamRef = useRef(null);

  // Scan result
  const [lastScan, setLastScan] = useState(null); // { stars, score, recorded, smileId, rewardEth, txUrl, reason }

  // Step 3 — MetaMask
  const [mmAccount,  setMmAccount]  = useState(null); // connected MetaMask wallet
  const [mmChainOk,  setMmChainOk]  = useState(false);
  const [claimingId, setClaimingId] = useState(null); // smileId being claimed
  const [claimTxUrl, setClaimTxUrl] = useState(null);

  // Pending smiles
  const [pendingSmiles, setPendingSmiles] = useState([]);  // from /smiles/:addr
  const [loadingSmiles, setLoadingSmiles] = useState(false);

  // UI
  const [rewards,    setRewards]    = useState(null);
  const [liveEvents, setLiveEvents] = useState([]);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type="info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4500);
  };

  // ── Load face-api.js models ────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_PATH),
          faceapi.nets.faceExpressionNet.loadFromUri(MODEL_PATH),
        ]);
        setMlReady(true);
      } catch (e) { console.error("ML load failed:", e); }
    })();
  }, []);

  // ── Fetch reward table ─────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${ORACLE_URL}/reward-table`).then(r => r.json()).then(d => setRewards(d.rewards)).catch(() => {});
  }, []);

  // ── SSE live events ────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(`${ORACLE_URL}/events`);
    const push = (type, data) =>
      setLiveEvents(p => [{ type, ...JSON.parse(data), id: Date.now() }, ...p.slice(0, 7)]);
    es.addEventListener("SmileRecorded", e => push("recorded", e.data));
    es.addEventListener("SmileClaimed",  e => push("claimed",  e.data));
    es.addEventListener("SmileRejected", e => push("rejected", e.data));
    return () => es.close();
  }, []);

  // ── Fetch pending smiles for a wallet ─────────────────────────────────
  const fetchSmiles = useCallback(async (address) => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    setLoadingSmiles(true);
    try {
      const r = await fetch(`${ORACLE_URL}/smiles/${address}`);
      const d = await r.json();
      if (d.pending) setPendingSmiles(d.pending);
    } catch {}
    setLoadingSmiles(false);
  }, []);

  useEffect(() => {
    if (/^0x[0-9a-fA-F]{40}$/.test(walletInput)) fetchSmiles(walletInput);
  }, [walletInput, fetchSmiles]);

  // ── Camera controls ────────────────────────────────────────────────────
  const startCam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCamOn(true);
    } catch (e) { showToast("Camera blocked: " + e.message, "error"); }
  };

  const stopCam = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCamOn(false);
  };

  // ── Smile scan ─────────────────────────────────────────────────────────
  const runScan = async () => {
    if (!walletInput) { setWalletErr("Enter your wallet address first"); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletInput)) { setWalletErr("Not a valid Ethereum address"); return; }
    setWalletErr("");
    setScanning(true);
    setLastScan(null);
    setClaimTxUrl(null);

    // Sample detections over 2.5s
    let samples = [];
    await new Promise(resolve => {
      let elapsed = 0;
      const iv = setInterval(async () => {
        elapsed += 300;
        const det = await faceapi
          .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
          .withFaceExpressions();
        if (det) samples.push(det.expressions.happy);
        if (elapsed >= 2500) { clearInterval(iv); resolve(); }
      }, 300);
    });

    setScanning(false);

    if (!samples.length) {
      showToast("No face detected! Position your face clearly.", "error");
      return;
    }

    const avgScore = samples.reduce((a, b) => a + b, 0) / samples.length;
    setSubmitting(true);

    try {
      const res = await fetch(`${ORACLE_URL}/submit-smile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: walletInput,
          happyScore: avgScore,
          sessionId: crypto.randomUUID(),
        }),
      });
      const data = await res.json();

      let stars = 1;
      if (avgScore >= 0.80) stars = 5;
      else if (avgScore >= 0.60) stars = 4;
      else if (avgScore >= 0.40) stars = 3;
      else if (avgScore >= 0.20) stars = 2;

      setLastScan({ stars, score: avgScore, ...data });

      if (data.recorded) {
        showToast(`⭐${stars} smile recorded! Connect MetaMask to claim.`, "success");
        await fetchSmiles(walletInput); // refresh pending list
      } else {
        showToast(`Smile too low — need ⭐⭐ or higher`, "error");
      }
    } catch (e) {
      showToast("Submission error: " + e.message, "error");
    }
    setSubmitting(false);
  };

  // ── MetaMask: connect & ensure Sepolia ────────────────────────────────
  const connectMetaMask = async () => {
    if (!window.ethereum) { showToast("MetaMask not found! Install it first.", "error"); return; }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setMmAccount(accounts[0]);
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      setMmChainOk(chainId === SEPOLIA_ID);
      if (chainId !== SEPOLIA_ID) showToast("Please switch MetaMask to Sepolia testnet", "error");
      window.ethereum.on("accountsChanged", a => setMmAccount(a[0] || null));
      window.ethereum.on("chainChanged",    c => setMmChainOk(c === SEPOLIA_ID));
    } catch (e) { showToast("MetaMask error: " + e.message, "error"); }
  };

  const switchToSepolia = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_ID }],
      });
    } catch (e) { showToast("Could not switch network: " + e.message, "error"); }
  };

  // ── Claim a smile via MetaMask ─────────────────────────────────────────
  const claimSmile = async (smileId) => {
    if (!mmAccount) { showToast("Connect MetaMask first", "error"); return; }
    if (!mmChainOk) { showToast("Switch to Sepolia in MetaMask", "error"); return; }

    const contractAddr = import.meta.env.VITE_CONTRACT_ADDRESS;
    if (!contractAddr) { showToast("Set VITE_CONTRACT_ADDRESS in .env", "error"); return; }

    setClaimingId(smileId);
    try {
      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer   = await provider.getSigner();
      const grin     = new ethers.Contract(contractAddr, CLAIM_ABI, signer);

      showToast("Check MetaMask to confirm transaction…", "info");
      const tx = await grin.claimSmile(BigInt(smileId));
      showToast("Transaction sent! Waiting for confirmation…", "info");

      const receipt = await tx.wait();
      const txUrl   = `https://sepolia.etherscan.io/tx/${receipt.hash}`;
      setClaimTxUrl(txUrl);

      showToast("✅ ETH claimed successfully!", "success");
      await fetchSmiles(walletInput); // refresh list — smile becomes claimed
    } catch (e) {
      const msg = e?.reason || e?.message || "Unknown error";
      if (msg.includes("AlreadyClaimed")) showToast("Already claimed!", "error");
      else if (msg.includes("NotSmileOwner")) showToast("Wrong wallet — use the registered address", "error");
      else showToast("Claim failed: " + msg, "error");
    }
    setClaimingId(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────────
  const validWallet = /^0x[0-9a-fA-F]{40}$/.test(walletInput);
  const scanDisabled = !camOn || !mlReady || scanning || submitting;

  return (
    <div style={css.app}>
      {/* ── Header ── */}
      <header style={css.header}>
        <div style={css.logo}>😁 Grin & Earn</div>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
          <span style={css.pill("#a855f7")}>Sepolia</span>
          <span style={css.pill(mlReady ? "#10b981" : "#f59e0b",
            mlReady ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)")}>
            {mlReady ? "✓ ML Ready" : "⏳ Loading ML"}
          </span>
          {mmAccount
            ? <span style={css.pill(mmChainOk ? "#10b981" : "#ef4444")}>{addr(mmAccount)}</span>
            : <button
                onClick={connectMetaMask}
                style={{ ...css.btn("linear-gradient(135deg,#7c3aed,#a855f7)"), width:"auto", padding:"8px 20px", marginTop:0 }}>
                Connect MetaMask
              </button>
          }
        </div>
      </header>

      <main style={css.main}>
        {/* Hero */}
        <div style={{ textAlign:"center", marginBottom:38 }}>
          <h1 style={{ fontSize:"2.4rem", fontWeight:900, background:"linear-gradient(135deg,#fff 0%,#a855f7 55%,#fbbf24 100%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", marginBottom:10 }}>
            Smile → Earn ETH on Sepolia
          </h1>
          <p style={{ color:"#475569", fontSize:"1rem" }}>
            Smile ≥ ⭐⭐ to earn · reward stored on-chain · connect MetaMask · click Claim
          </p>
        </div>

        {/* ── Step badges ── */}
        <div style={{ display:"flex", gap:10, justifyContent:"center", marginBottom:32, flexWrap:"wrap" }}>
          {[
            ["1","Enter Wallet", validWallet],
            ["2","Smile + Scan", !!lastScan?.recorded],
            ["3","Connect MetaMask", !!mmAccount],
            ["4","Claim ETH", !!claimTxUrl],
          ].map(([n, label, done]) => (
            <div key={n} style={{
              display:"flex", alignItems:"center", gap:7, padding:"7px 16px",
              borderRadius:20, fontSize:"0.8rem", fontWeight:600,
              background: done ? "rgba(16,185,129,0.12)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${done ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.08)"}`,
              color: done ? "#10b981" : "#64748b",
            }}>
              <span style={{ width:20, height:20, borderRadius:"50%", background: done ? "#10b981" : "#1e293b", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.72rem", color:"white" }}>
                {done ? "✓" : n}
              </span>
              {label}
            </div>
          ))}
        </div>

        <div style={css.grid}>
          {/* LEFT — Wallet + Camera + Scan */}
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

            {/* Wallet Input */}
            <div style={css.card}>
              <div style={css.sectionTitle}>👛 Step 1 — Your Wallet Address</div>
              <label style={css.label}>Enter the Ethereum wallet where ETH will land</label>
              <input
                style={{ ...css.input, borderColor: walletErr ? "#ef4444" : undefined }}
                placeholder="0x..."
                value={walletInput}
                onChange={e => { setWalletInput(e.target.value); setWalletErr(""); }}
              />
              {walletErr && <div style={{ color:"#ef4444", fontSize:"0.78rem", marginTop:5 }}>{walletErr}</div>}
              {validWallet && (
                <div style={{ marginTop:8, fontSize:"0.78rem", color:"#10b981" }}>
                  ✓ Valid address · {pendingSmiles.length} pending smile{pendingSmiles.length !== 1 ? "s" : ""} found
                </div>
              )}
            </div>

            {/* Camera */}
            <div style={css.card}>
              <div style={css.sectionTitle}>📷 Step 2 — Smile Detection</div>
              <div style={css.camBox}>
                {camOn
                  ? <video ref={videoRef} autoPlay muted playsInline style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                  : <div style={{ textAlign:"center", color:"#334155" }}>
                      <div style={{ fontSize:"2.8rem", marginBottom:8 }}>📷</div>
                      <div style={{ fontSize:"0.85rem" }}>Camera not started</div>
                    </div>
                }
                {scanning && (
                  <div style={css.overlay("168,85,247")}>
                    <div style={{ fontSize:"2rem" }}>🔍</div>
                    <div style={{ color:"#a855f7", fontWeight:700, fontSize:"0.9rem" }}>Reading smile...</div>
                  </div>
                )}
                {submitting && (
                  <div style={css.overlay("59,130,246")}>
                    <div style={{ fontSize:"2rem" }}>⛓️</div>
                    <div style={{ color:"#60a5fa", fontWeight:700, fontSize:"0.9rem" }}>Recording on-chain...</div>
                  </div>
                )}
              </div>
              <button
                style={css.btn(camOn ? "rgba(255,255,255,0.07)" : "linear-gradient(135deg,#7c3aed,#a855f7)")}
                onClick={camOn ? stopCam : startCam}>
                {camOn ? "⏹ Stop Camera" : "📷 Start Camera"}
              </button>
              <button
                style={css.btn("linear-gradient(135deg,#7c3aed,#a855f7)", scanDisabled)}
                onClick={runScan} disabled={scanDisabled}>
                {scanning ? "🔍 Scanning..." : submitting ? "⛓️ Recording..." : !mlReady ? "⏳ Loading ML..." : !camOn ? "Start camera first" : "😁 Scan My Smile"}
              </button>
            </div>

            {/* Last scan result */}
            {lastScan && (
              <div style={css.card}>
                <div style={css.sectionTitle}>📊 Scan Result</div>
                <div style={{ textAlign:"center", padding:"10px 0" }}>
                  <div style={{ fontSize:"3rem", marginBottom:6 }}>
                    {["","🙂","😊","😄","😁","🤩"][lastScan.stars]}
                  </div>
                  <div style={{ display:"flex", justifyContent:"center", gap:5, marginBottom:10 }}>
                    {[1,2,3,4,5].map(s => (
                      <span key={s} style={{ fontSize:"1.4rem", opacity: s <= lastScan.stars ? 1 : 0.18 }}>⭐</span>
                    ))}
                  </div>
                  <div style={{ color:"#64748b", fontSize:"0.85rem", marginBottom:4 }}>
                    Happiness: <strong style={{ color:"#a855f7" }}>{(lastScan.score * 100).toFixed(1)}%</strong>
                  </div>

                  {lastScan.recorded ? (
                    <div style={{ background:"rgba(16,185,129,0.1)", border:"1px solid rgba(16,185,129,0.25)", borderRadius:10, padding:"12px 14px", marginTop:12 }}>
                      <div style={{ color:"#10b981", fontWeight:700, marginBottom:4 }}>✅ Smile Recorded!</div>
                      <div style={{ color:"#94a3b8", fontSize:"0.82rem" }}>
                        Smile ID: <strong style={{ color:"#fff", fontFamily:"monospace" }}>#{lastScan.smileId}</strong>
                        &nbsp;· Reward: <strong style={{ color:"#fbbf24" }}>{lastScan.rewardEth} ETH</strong>
                      </div>
                      <div style={{ color:"#64748b", fontSize:"0.78rem", marginTop:6 }}>
                        Now connect MetaMask below and claim ↓
                      </div>
                      {lastScan.recordTxUrl && (
                        <a href={lastScan.recordTxUrl} target="_blank" rel="noreferrer"
                          style={{ color:"#a855f7", fontSize:"0.78rem", display:"inline-block", marginTop:6 }}>
                          View record tx ↗
                        </a>
                      )}
                    </div>
                  ) : (
                    <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:10, padding:"12px 14px", marginTop:12 }}>
                      <div style={{ color:"#ef4444", fontWeight:700, marginBottom:4 }}>❌ Not Recorded</div>
                      <div style={{ color:"#94a3b8", fontSize:"0.82rem" }}>{lastScan.reason || "Need ⭐⭐ or higher"}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — Pending smiles + Claim + Reward table */}
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

            {/* MetaMask + Claim panel */}
            <div style={css.card}>
              <div style={css.sectionTitle}>🦊 Step 3 & 4 — Connect & Claim</div>

              {!mmAccount ? (
                <>
                  <p style={{ color:"#64748b", fontSize:"0.85rem", marginBottom:12 }}>
                    Connect MetaMask to sign the claim transaction. You pay gas, ETH goes directly to your wallet.
                  </p>
                  <button
                    style={css.btn("linear-gradient(135deg,#f59e0b,#fbbf24)")}
                    onClick={connectMetaMask}>
                    🦊 Connect MetaMask
                  </button>
                </>
              ) : !mmChainOk ? (
                <>
                  <p style={{ color:"#ef4444", fontSize:"0.85rem", marginBottom:12 }}>
                    Wrong network. Please switch to Sepolia testnet.
                  </p>
                  <button style={css.btn("linear-gradient(135deg,#ef4444,#f87171)")} onClick={switchToSepolia}>
                    Switch to Sepolia
                  </button>
                </>
              ) : (
                <>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14,
                    padding:"8px 12px", borderRadius:10, background:"rgba(16,185,129,0.08)" }}>
                    <span style={{ width:8, height:8, borderRadius:"50%", background:"#10b981" }} />
                    <span style={{ fontSize:"0.82rem", color:"#10b981" }}>Connected: {addr(mmAccount)}</span>
                    <button onClick={() => { setMmAccount(null); setMmChainOk(false); }}
                      style={{ marginLeft:"auto", background:"none", border:"none", color:"#64748b", cursor:"pointer", fontSize:"0.75rem" }}>
                      Disconnect
                    </button>
                  </div>

                  {/* Pending smile list */}
                  {loadingSmiles ? (
                    <div style={{ textAlign:"center", color:"#475569", padding:20 }}>Loading smiles...</div>
                  ) : pendingSmiles.length === 0 ? (
                    <div style={{ textAlign:"center", color:"#334155", padding:"20px", fontSize:"0.85rem" }}>
                      <div style={{ fontSize:"2rem", marginBottom:8 }}>🪙</div>
                      No pending smiles yet.<br />Scan your smile above to earn!
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize:"0.8rem", color:"#64748b", marginBottom:10 }}>
                        {pendingSmiles.length} claimable smile{pendingSmiles.length !== 1 ? "s" : ""} — click Claim on each:
                      </div>
                      {pendingSmiles.map(smile => (
                        <div key={smile.smileId} style={css.smileCard(smile.stars)}>
                          <div style={{ fontSize:"1.8rem" }}>
                            {["","🙂","😊","😄","😁","🤩"][smile.stars]}
                          </div>
                          <div style={{ flex:1 }}>
                            <div style={{ fontWeight:700, fontSize:"0.9rem" }}>
                              {"⭐".repeat(smile.stars)} {STAR_LABEL[smile.stars]}
                            </div>
                            <div style={{ color:"#fbbf24", fontSize:"0.82rem", fontFamily:"monospace" }}>
                              {smile.rewardEth} ETH
                            </div>
                            <div style={{ color:"#475569", fontSize:"0.72rem" }}>
                              ID #{smile.smileId} · {new Date(smile.timestamp * 1000).toLocaleTimeString()}
                            </div>
                          </div>
                          <button
                            style={css.claimBtn(claimingId === smile.smileId)}
                            disabled={!!claimingId}
                            onClick={() => claimSmile(smile.smileId)}>
                            {claimingId === smile.smileId ? "Claiming..." : "Claim"}
                          </button>
                        </div>
                      ))}
                    </>
                  )}

                  {claimTxUrl && (
                    <div style={{ marginTop:14, padding:"10px 14px", borderRadius:10, background:"rgba(16,185,129,0.08)", border:"1px solid rgba(16,185,129,0.2)" }}>
                      <div style={{ color:"#10b981", fontWeight:700, fontSize:"0.85rem", marginBottom:4 }}>✅ ETH Claimed!</div>
                      <a href={claimTxUrl} target="_blank" rel="noreferrer"
                        style={{ color:"#a855f7", fontSize:"0.78rem" }}>View claim tx on Etherscan ↗</a>
                    </div>
                  )}

                  <button
                    style={{ ...css.btn("rgba(255,255,255,0.05)"), marginTop:14 }}
                    onClick={() => fetchSmiles(walletInput)}>
                    🔄 Refresh Smiles
                  </button>
                </>
              )}
            </div>

            {/* Reward Table */}
            <div style={css.card}>
              <div style={css.sectionTitle}>💰 Reward Table</div>
              {rewards && Object.entries(rewards).map(([star, info]) => (
                <div key={star} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"9px 12px", borderRadius:9, marginBottom:5,
                  background:`rgba(${info.paid?"168,85,247":"100,116,139"},0.06)`,
                  border:`1px solid rgba(${info.paid?"168,85,247":"100,116,139"},0.12)`,
                  opacity: info.paid ? 1 : 0.5,
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:"1rem" }}>{"⭐".repeat(Number(star))}</span>
                    <span style={{ color:"#94a3b8", fontSize:"0.82rem" }}>{info.label}</span>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontFamily:"monospace", color: info.paid ? "#fbbf24" : "#475569", fontWeight:700, fontSize:"0.85rem" }}>
                      {info.eth} ETH
                    </span>
                    <span style={{
                      padding:"2px 8px", borderRadius:20, fontSize:"0.68rem", fontWeight:700,
                      background: info.paid ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                      color: info.paid ? "#10b981" : "#ef4444",
                    }}>
                      {info.paid ? "✓" : "❌ Rejected"}
                    </span>
                  </div>
                </div>
              ))}
              <div style={{ fontSize:"0.72rem", color:"#334155", marginTop:8, padding:"7px 10px", background:"rgba(239,68,68,0.05)", borderRadius:8 }}>
                ⚠️ Smiles rated ⭐ (1 star) are rejected — nothing is stored on-chain.
              </div>
            </div>
          </div>
        </div>

        {/* Live Events */}
        {liveEvents.length > 0 && (
          <div style={{ ...css.card, marginTop:22 }}>
            <div style={css.sectionTitle}>⚡ Live On-Chain Events</div>
            {liveEvents.map(ev => (
              <div key={ev.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0",
                borderBottom:"1px solid rgba(255,255,255,0.04)", fontSize:"0.82rem" }}>
                <span>{ev.type==="recorded"?"🟡":ev.type==="claimed"?"🟢":"🔴"}</span>
                <span style={{ fontFamily:"monospace", color:"#64748b" }}>{addr(ev.user)}</span>
                <span style={{ color:"#94a3b8" }}>
                  {ev.type==="recorded" ? `smile #${ev.smileId} recorded (${ev.stars}⭐ → ${ev.rewardEth} ETH pending)` :
                   ev.type==="claimed"  ? `smile #${ev.smileId} claimed! ${ev.rewardEth} ETH sent` :
                   `${ev.stars}⭐ rejected`}
                </span>
                {ev.txUrl && (
                  <a href={ev.txUrl} target="_blank" rel="noreferrer" style={{ color:"#a855f7", marginLeft:"auto", whiteSpace:"nowrap" }}>↗</a>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div style={{
          position:"fixed", bottom:28, right:28, zIndex:9999,
          padding:"13px 20px", borderRadius:13, maxWidth:340,
          background: toast.type==="success"?"rgba(16,185,129,0.15)":toast.type==="error"?"rgba(239,68,68,0.15)":"rgba(59,130,246,0.15)",
          border:`1px solid ${toast.type==="success"?"rgba(16,185,129,0.3)":toast.type==="error"?"rgba(239,68,68,0.3)":"rgba(59,130,246,0.3)"}`,
          color: toast.type==="success"?"#10b981":toast.type==="error"?"#ef4444":"#60a5fa",
          fontWeight:600, fontSize:"0.88rem",
          animation:"slideIn 0.25s ease",
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { transform: translateX(60px); opacity: 0; } to { transform: none; opacity: 1; } }
        input:focus { border-color: #7c3aed !important; box-shadow: 0 0 0 3px rgba(124,58,237,0.15); }
        button:not(:disabled):hover { filter: brightness(1.1); transform: translateY(-1px); }
      `}</style>
    </div>
  );
}
