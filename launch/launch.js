import "dotenv/config";
import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config ----
const DRY_RUN = process.env.DRY_RUN === "true";
const RPC_URL = process.env.RPC_URL;
const DEV_BUY_SOL = parseFloat(process.env.DEV_BUY_SOL || "0");

const TOKEN_NAME = process.env.TOKEN_NAME || "YO";
const TOKEN_TICKER = process.env.TOKEN_TICKER || "YO";
const TOKEN_DESCRIPTION = process.env.TOKEN_DESCRIPTION || "";
const TOKEN_IMAGE_PATH = process.env.TOKEN_IMAGE_PATH;
const TOKEN_WEBSITE = process.env.TOKEN_WEBSITE || "";
const TOKEN_TWITTER = process.env.TOKEN_TWITTER || "";
const TOKEN_TELEGRAM = process.env.TOKEN_TELEGRAM || "";

// ---- load keys ----
function loadKeypair(envKey) {
  const p = process.env[envKey];
  if (!p) throw new Error(`${envKey} not set`);
  const resolved = path.resolve(__dirname, p);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const deployer = loadKeypair("DEPLOYER_KEY_PATH");
const mintKp = loadKeypair("MINT_KEY_PATH");

// ---- pump.fun constants ----
const PUMP_API = "https://pump.fun/api";
const PUMP_PORTAL_API = "https://pumpportal.fun/api";

// ---- helpers ----
function sol(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

async function uploadMetadata() {
  const imgPath = path.resolve(__dirname, TOKEN_IMAGE_PATH);
  if (!fs.existsSync(imgPath)) throw new Error(`Image not found: ${imgPath}`);

  const formData = new FormData();
  const imgBlob = new Blob([fs.readFileSync(imgPath)], { type: "image/png" });
  formData.append("file", imgBlob, "yo-logo.png");
  formData.append("name", TOKEN_NAME);
  formData.append("symbol", TOKEN_TICKER);
  formData.append("description", TOKEN_DESCRIPTION);
  formData.append("twitter", TOKEN_TWITTER);
  formData.append("telegram", TOKEN_TELEGRAM);
  formData.append("website", TOKEN_WEBSITE);
  formData.append("showName", "true");

  console.log("  uploading metadata to pump.fun IPFS...");
  const res = await fetch("https://pump.fun/api/ipfs", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IPFS upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log("  metadata URI:", data.metadataUri);
  return data.metadataUri;
}

async function createTokenTx(metadataUri) {
  const payload = {
    publicKey: deployer.publicKey.toBase58(),
    action: "create",
    tokenMetadata: {
      name: TOKEN_NAME,
      symbol: TOKEN_TICKER,
      uri: metadataUri,
    },
    mint: mintKp.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: 0,
    slippage: 15,
    priorityFee: 0.001,
    pool: "pump",
  };

  console.log("  requesting create transaction from PumpPortal...");
  const res = await fetch(`${PUMP_PORTAL_API}/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpPortal create failed (${res.status}): ${text}`);
  }

  return await res.arrayBuffer();
}

async function devBuyTx() {
  const payload = {
    publicKey: deployer.publicKey.toBase58(),
    action: "buy",
    mint: mintKp.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: DEV_BUY_SOL,
    slippage: 15,
    priorityFee: 0.001,
    pool: "pump",
  };

  console.log("  requesting dev buy transaction from PumpPortal...");
  const res = await fetch(`${PUMP_PORTAL_API}/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpPortal buy failed (${res.status}): ${text}`);
  }

  return await res.arrayBuffer();
}

// ---- main ----
async function main() {
  console.log("\n=== YO TOKEN LAUNCH ===\n");
  console.log(`  mode:       ${DRY_RUN ? "DRY RUN (no tx sent)" : "🔴 LIVE — WILL SEND TX"}`);
  console.log(`  deployer:   ${deployer.publicKey.toBase58()}`);
  console.log(`  mint (CA):  ${mintKp.publicKey.toBase58()}`);
  console.log(`  dev buy:    ${DEV_BUY_SOL} SOL`);
  console.log(`  token:      ${TOKEN_NAME} ($${TOKEN_TICKER})`);
  console.log(`  website:    ${TOKEN_WEBSITE}`);
  console.log(`  twitter:    ${TOKEN_TWITTER}`);
  console.log(`  telegram:   ${TOKEN_TELEGRAM}`);
  console.log(`  description: ${TOKEN_DESCRIPTION.slice(0, 80)}...`);
  console.log();

  // pump.fun supply is always 1,000,000,000 (1B) with 6 decimals
  const TOTAL_SUPPLY = 1_000_000_000;

  if (!RPC_URL || RPC_URL.includes("YOUR_HELIUS_KEY")) {
    console.log("  ⚠  RPC_URL not configured — set your Helius key in .env");
    if (!DRY_RUN) process.exit(1);
  }

  // Check deployer balance
  if (RPC_URL && !RPC_URL.includes("YOUR_HELIUS_KEY")) {
    const connection = new Connection(RPC_URL, "confirmed");
    const balance = await connection.getBalance(deployer.publicKey);
    const needed = (DEV_BUY_SOL + 0.05) * LAMPORTS_PER_SOL; // ~0.05 for fees
    console.log(`  deployer balance: ${sol(balance)} SOL`);
    console.log(`  estimated cost:   ~${(DEV_BUY_SOL + 0.05).toFixed(3)} SOL (${DEV_BUY_SOL} buy + ~0.05 fees)`);

    if (balance < needed) {
      console.log(`  ⚠  INSUFFICIENT — need ${sol(needed)} SOL, have ${sol(balance)}`);
      console.log(`  send at least ${sol(needed - balance)} more SOL to ${deployer.publicKey.toBase58()}`);
    } else {
      console.log("  ✓  balance sufficient");
    }
    console.log();
  }

  // Estimate dev buy allocation
  // pump.fun bonding curve: initial virtual SOL = 30, initial virtual tokens = 1,073,000,191
  // At launch (0 real SOL in), price per token ≈ 30/1,073,000,191 SOL
  // Buying X SOL gives: tokens = virtualTokens - (virtualSOL * virtualTokens) / (virtualSOL + X)
  const VIRTUAL_SOL = 30;
  const VIRTUAL_TOKENS = 1_073_000_191;
  const tokensFromBuy = VIRTUAL_TOKENS - (VIRTUAL_SOL * VIRTUAL_TOKENS) / (VIRTUAL_SOL + DEV_BUY_SOL);
  const supplyPct = ((tokensFromBuy / TOTAL_SUPPLY) * 100).toFixed(2);

  console.log("  === DEV BUY ESTIMATE ===");
  console.log(`  buy amount:     ${DEV_BUY_SOL} SOL`);
  console.log(`  tokens received: ~${Math.floor(tokensFromBuy).toLocaleString()}`);
  console.log(`  supply %:       ~${supplyPct}%`);
  console.log(`  total supply:   ${TOTAL_SUPPLY.toLocaleString()} (pump.fun fixed)`);
  console.log();

  if (DRY_RUN) {
    console.log("  === DRY RUN COMPLETE ===");
    console.log("  everything looks good. to launch for real:");
    console.log("  1. set RPC_URL in .env (Helius mainnet)");
    console.log("  2. fund deployer with ~0.6 SOL");
    console.log("  3. set DRY_RUN=false");
    console.log("  4. run: node launch.js");
    console.log();
    return;
  }

  // ---- LIVE LAUNCH ----
  const connection = new Connection(RPC_URL, "confirmed");

  // Step 1: Upload metadata
  console.log("  uploading metadata...");
  const metadataUri = await uploadMetadata();

  // Step 2: Create token (no buy)
  console.log("  building create transaction...");
  const createData = await createTokenTx(metadataUri);
  const createTx = VersionedTransaction.deserialize(new Uint8Array(createData));
  createTx.sign([deployer, mintKp]);

  console.log("  sending create transaction...");
  const createSig = await connection.sendRawTransaction(createTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`  ✓  CREATE TX: ${createSig}`);

  console.log("  waiting for create confirmation...");
  const createConfirm = await connection.confirmTransaction(createSig, "confirmed");
  if (createConfirm.value.err) {
    console.error("  ✗  CREATE FAILED:", createConfirm.value.err);
    process.exit(1);
  }
  console.log("  ✓  TOKEN CREATED");
  console.log(`  pump.fun:   https://pump.fun/coin/${mintKp.publicKey.toBase58()}`);
  console.log(`  CA:         ${mintKp.publicKey.toBase58()}`);
  console.log();

  // Step 3: Dev buy (separate tx)
  if (DEV_BUY_SOL > 0) {
    console.log(`  buying ${DEV_BUY_SOL} SOL worth...`);
    const buyData = await devBuyTx();
    const buyTx = VersionedTransaction.deserialize(new Uint8Array(buyData));
    buyTx.sign([deployer]);

    const buySig = await connection.sendRawTransaction(buyTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log(`  ✓  BUY TX: ${buySig}`);

    console.log("  waiting for buy confirmation...");
    const buyConfirm = await connection.confirmTransaction(buySig, "confirmed");
    if (buyConfirm.value.err) {
      console.error("  ✗  BUY FAILED:", buyConfirm.value.err);
      console.log("  token is created but dev buy failed. you can buy manually.");
    } else {
      console.log("  ✓  DEV BUY CONFIRMED");
    }
    console.log(`  solscan:    https://solscan.io/tx/${buySig}`);
  }

  console.log("\n  ✓  LAUNCH COMPLETE — $Yo is live!");
  console.log(`  CA: ${mintKp.publicKey.toBase58()}\n`);
}

main().catch((err) => {
  console.error("\n  ✗  LAUNCH ERROR:", err.message);
  process.exit(1);
});
