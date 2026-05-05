/**
 * gl_deploy.mjs — one-shot deployer for contracts/news_oracle.py.
 *
 * Reads the Python contract source, deploys it to the chosen GenLayer
 * network via genlayer-js, waits for ACCEPTED, and prints the resulting
 * contract address. Intended to be run once per network during setup.
 *
 * Usage (PowerShell):
 *   $env:GENLAYER_PRIVATE_KEY="0x..."
 *   $env:GENLAYER_NETWORK="studionet"            # or testnetBradbury / testnetAsimov
 *   node scripts/gl_deploy.mjs
 *
 * After it prints "deployed at 0x...", set the matching env var on Fly:
 *   fly secrets set ORACLE_ADDR_STUDIONET=0x... -a genlayernews
 */

import { createClient, createAccount } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function fail(msg) {
  process.stderr.write(`[gl_deploy] ERROR: ${msg}\n`);
  process.exit(1);
}

const PRIV = process.env.GENLAYER_PRIVATE_KEY;
const NETWORK = process.env.GENLAYER_NETWORK || "testnetBradbury";

if (!PRIV) fail("GENLAYER_PRIVATE_KEY env var is required");
const chain = chains[NETWORK];
if (!chain) fail(`Unknown GENLAYER_NETWORK: ${NETWORK}. Known chains: ${Object.keys(chains).join(", ")}`);

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(__dirname, "..", "contracts", "news_oracle.py");

let source;
try {
  source = readFileSync(contractPath, "utf8");
} catch (e) {
  fail(`Could not read ${contractPath}: ${e.message}`);
}

const account = createAccount(PRIV);
const client = createClient({ chain, account });

console.log(`[gl_deploy] network         : ${NETWORK}`);
console.log(`[gl_deploy] deployer addr   : ${account.address}`);
console.log(`[gl_deploy] contract source : ${contractPath} (${source.length} bytes)`);
console.log(`[gl_deploy] deploying… (this can take 1–10 minutes on Bradbury)`);

try {
  // genlayer-js exposes deployContract on the client. Args are passed to
  // the contract's __init__; NewsOracle takes none.
  const txHash = await client.deployContract({
    code: source,
    args: [],
    leaderOnly: false,
  });
  console.log(`[gl_deploy] tx submitted    : ${txHash}`);

  // Wait for ACCEPTED so the contract is actually callable. Studio/Asimov
  // are usually fast (<30s); Bradbury can take several minutes.
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    timeout: 12 * 60 * 1000,
    pollingInterval: 4_000,
    retryCount: 0,
  });

  // The deployed address shows up under different keys depending on the
  // SDK / network — Studio puts it under `data.contract_address` and also
  // mirrors it as `recipient`, while Bradbury exposes a top-level field.
  const addr =
    receipt?.data?.contract_address ||
    receipt?.data?.contractAddress ||
    receipt?.contract_address ||
    receipt?.contractAddress ||
    receipt?.deployedContract ||
    receipt?.recipient ||
    receipt?.to_address ||
    receipt?.consensusData?.leaderReceipt?.[0]?.contractAddress ||
    receipt?.consensusData?.leaderReceipt?.[0]?.contract_address ||
    null;

  if (!addr) {
    console.error("[gl_deploy] receipt:", JSON.stringify(receipt, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    fail("Tx accepted but no contract address found in receipt — see dump above.");
  }

  console.log("");
  console.log("=".repeat(64));
  console.log(`✓ Deployed NewsOracle on ${NETWORK}`);
  console.log(`  Address : ${addr}`);
  console.log(`  Tx hash : ${txHash}`);
  console.log("=".repeat(64));
  console.log("");
  console.log("Next steps:");
  const envName = ({
    testnetBradbury: "ORACLE_ADDR_BRADBURY",
    studionet: "ORACLE_ADDR_STUDIONET",
    testnetAsimov: "ORACLE_ADDR_ASIMOV",
  })[NETWORK] || "ORACLE_ADDR_<NETWORK>";
  console.log(`  • Local : add ${envName}=${addr} to your .env`);
  console.log(`  • Fly   : fly secrets set ${envName}=${addr} -a genlayernews`);
  console.log("");
  process.exit(0);
} catch (e) {
  fail(e?.message || String(e));
}
