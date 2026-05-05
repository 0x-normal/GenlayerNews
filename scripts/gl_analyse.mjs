/**
 * gl_analyse.mjs — two-phase helper for the NewsOracle contract on
 * GenLayer Testnet Bradbury. Designed for managed-host deployment where
 * synchronous HTTP requests are capped at ~60s by the edge proxy.
 *
 * Reads a single JSON command on stdin and writes a JSON result on stdout.
 *
 *   { action: "submit", title, content }
 *     -> Cache check; if miss, broadcasts analyze(title, content). Returns
 *        immediately with { status, tx_hash, article_id, analysis? }.
 *        status is "ready" on cache hit, "pending" once the tx is broadcast.
 *
 *   { action: "status", tx_hash, article_id }
 *     -> Quick check: fetches the tx state and tries to extract the verdict.
 *        Returns { status: "pending"|"ready", analysis?, tx_status? }.
 *        Designed to complete in <10s so frontend polling never hits a
 *        proxy timeout.
 *
 * Env:
 *   NEWS_ORACLE_ADDRESS   address of the deployed NewsOracle contract
 *   GENLAYER_PRIVATE_KEY  hex private key for a Bradbury-funded account
 *   GENLAYER_NETWORK      optional, "testnetBradbury" (default) or
 *                         "testnetAsimov" / "studionet" / "localnet"
 */

import { createClient, createAccount } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { createHash } from "node:crypto";

/**
 * Mirrors the article-id hashing inside contracts/news_oracle.py so a
 * subsequent get_analysis(article_id) read lines up with what the write
 * just stored.
 */
function articleId(title, content) {
  const h = createHash("sha256");
  h.update((title || "").trim(), "utf8");
  h.update(Buffer.from([0x00]));
  h.update((content || "").trim(), "utf8");
  return h.digest("hex").slice(0, 24);
}

/**
 * JSON.stringify replacer that survives BigInts and other non-JSON
 * primitives the GenLayer SDK / viem occasionally hand back inside
 * receipts (block numbers, gas, etc.).
 */
function jsonSafeReplacer(_k, v) {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return "0x" + Buffer.from(v).toString("hex");
  return v;
}

function safeStringify(v, indent) {
  return JSON.stringify(v, jsonSafeReplacer, indent);
}

function fail(msg) {
  process.stdout.write(safeStringify({ error: String(msg) }));
  process.exit(1);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

const ADDRESS = process.env.NEWS_ORACLE_ADDRESS;
const PRIV = process.env.GENLAYER_PRIVATE_KEY;
const NETWORK = process.env.GENLAYER_NETWORK || "testnetBradbury";

if (!ADDRESS) fail("NEWS_ORACLE_ADDRESS env var is required");
if (!PRIV) fail("GENLAYER_PRIVATE_KEY env var is required");

const chain = chains[NETWORK];
if (!chain) fail(`Unknown GENLAYER_NETWORK: ${NETWORK}`);

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch (e) {
  fail(`Could not parse stdin JSON: ${e.message}`);
}

const action = payload?.action || "submit";

try {
  const account = createAccount(PRIV);
  const client = createClient({ chain, account });

  if (action === "submit") {
    await runSubmit(client);
  } else if (action === "status") {
    await runStatus(client);
  } else {
    fail(`Unknown action: ${action}. Expected "submit" or "status".`);
  }
} catch (e) {
  fail(e?.message || String(e));
}

// ───────────────────────── Phase 1: submit ──────────────────────────────
//
// Sends the analyze() tx if there isn't already a stored verdict for this
// article. Returns immediately — does NOT wait for consensus. The frontend
// will poll the status endpoint instead.

async function runSubmit(client) {
  const title = payload?.title || "";
  const content = payload?.content || "";
  if (!title) fail("title is required");
  const aid = articleId(title, content);

  // Step 0 — free read-only cache check. If this article has been analysed
  // before (by us or anyone), reuse the stored verdict. Saves gas and is
  // instant for repeat clicks.
  try {
    const cached = await client.readContract({
      address: ADDRESS,
      functionName: "get_analysis",
      args: [aid],
      stateStatus: "accepted",
    });
    if (typeof cached === "string" && cached.length > 0) {
      const parsed = JSON.parse(cached);
      process.stdout.write(
        safeStringify({
          status: "ready",
          tx_hash: "",
          article_id: aid,
          cached: true,
          contract: ADDRESS,
          analysis: parsed,
        }),
      );
      process.exit(0);
    }
  } catch (e) {
    process.stderr.write(`[gl_analyse] cache-read miss: ${e.message}\n`);
  }

  // No cache hit — broadcast the write tx and return its hash without
  // waiting for consensus. The frontend will poll /api/analyse/status.
  const txHash = await client.writeContract({
    account: client.account,
    address: ADDRESS,
    functionName: "analyze",
    args: [title, content],
    value: 0,
  });

  process.stderr.write(`[gl_analyse] submitted ${txHash} for ${aid}\n`);
  process.stdout.write(
    safeStringify({
      status: "pending",
      tx_hash: txHash,
      article_id: aid,
      cached: false,
      contract: ADDRESS,
    }),
  );
  process.exit(0);
}

// ───────────────────────── Phase 2: status ──────────────────────────────
//
// Quick poll: fetch the tx receipt and extract the verdict if available.
// Designed to complete in <10s so the frontend can call this on a 5s
// interval without ever hitting a proxy timeout.

async function runStatus(client) {
  const txHash = payload?.tx_hash;
  const aid = payload?.article_id;
  if (!txHash) fail("tx_hash is required for status action");
  if (!aid) fail("article_id is required for status action");

  // First, try the contract storage — if the verdict is already stored at
  // accepted/finalized state, this is the cheapest path.
  for (const stateStatus of ["finalized", "accepted"]) {
    try {
      const raw = await client.readContract({
        address: ADDRESS,
        functionName: "get_analysis",
        args: [aid],
        stateStatus,
      });
      if (typeof raw === "string" && raw.length > 0) {
        const parsed = JSON.parse(raw);
        process.stdout.write(
          safeStringify({
            status: "ready",
            tx_hash: txHash,
            article_id: aid,
            tx_status: stateStatus,
            analysis: parsed,
          }),
        );
        process.exit(0);
      }
    } catch (e) {
      // Empty storage often throws — keep trying.
    }
  }

  // Storage miss. Try to grab a receipt directly. Different networks reach
  // different terminal states first (Bradbury exposes COMMITTING for many
  // seconds before ACCEPTED; Studio jumps straight to ACCEPTED). We try
  // each in order of usefulness and accept whichever the SDK can deliver.
  let receipt = null;
  let lastErr = null;
  const targets = [
    TransactionStatus.ACCEPTED,
    TransactionStatus.COMMITTING,
    TransactionStatus.FINALIZED,
  ].filter((t) => t !== undefined);
  for (const status of targets) {
    try {
      receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status,
        fullTransaction: true,
        timeout: 4_000, // short per attempt — total <12s for all three
        pollingInterval: 1_000,
        retryCount: 0,
      });
      if (receipt) break;
    } catch (e) {
      lastErr = e;
      // Keep trying the next status target.
    }
  }
  // Last-ditch: ask for the bare tx without status gating. Some SDK builds
  // expose `getTransaction`; not all do.
  if (!receipt && typeof client.getTransaction === "function") {
    try {
      receipt = await client.getTransaction({ hash: txHash });
    } catch (e) {
      lastErr = e;
    }
  }
  if (!receipt) {
    const m = (lastErr?.message || "").match(/current status: (\d+)/i);
    const currentStatus = m ? Number(m[1]) : null;
    process.stdout.write(
      safeStringify({
        status: "pending",
        tx_hash: txHash,
        article_id: aid,
        tx_status: currentStatus,
      }),
    );
    process.exit(0);
  }

  // Note: at COMMITTING, receipt.txExecutionResultName is often "NOT_VOTED"
  // because the *aggregate* result only finalizes after the REVEAL phase.
  // The leader's individual receipt — which contains the verdict — is
  // already populated, so we go straight to extraction without gating on
  // the aggregate field. We'll only complain if we genuinely can't find
  // the verdict anywhere.

  /**
   * Walk every plausible path for the leader's return value. The verdict
   * is a JSON string the contract returned; some SDK shapes wrap it as
   * { value: ... } or { data: ... }, others store it as a plain string.
   * If we find an object that already looks like our schema, we accept it
   * directly. Recursively descends into nested receipt structures as a
   * last resort.
   */
  function looksLikeVerdict(o) {
    return (
      o &&
      typeof o === "object" &&
      !Array.isArray(o) &&
      "sentiment" in o &&
      "summary" in o
    );
  }

  /**
   * On Bradbury, the leader's verdict is RLP-encoded inside the receipt's
   * `eqBlocksOutputs` (and similar) hex blobs. Strategy: hex-decode the
   * blob to a Buffer, then scan it as Latin-1 text for the first balanced
   * `{...}` block that parses as JSON and looks like our verdict schema.
   */
  function findVerdictInHex(hex) {
    if (typeof hex !== "string") return null;
    let h = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (h.length % 2 !== 0) return null;
    let buf;
    try {
      buf = Buffer.from(h, "hex");
    } catch {
      return null;
    }
    const text = buf.toString("latin1");
    // Walk every '{' and try to parse the substring up to its matching '}'.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (inStr) {
          if (escape) escape = false;
          else if (ch === "\\") escape = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            try {
              const parsed = JSON.parse(candidate);
              if (looksLikeVerdict(parsed)) return parsed;
            } catch {}
            break; // try next '{'
          }
        }
      }
    }
    return null;
  }

  function extractReturnValue(r) {
    if (!r) return null;
    const direct = [
      r.result,
      r.executionResult,
      r.returnValue,
      r.return_value,
      r?.consensusData?.leaderReceipt?.[0]?.result,
      r?.consensusData?.leaderReceipt?.[0]?.executionResult,
      r?.consensusData?.leaderReceipt?.[0]?.returnValue,
      r?.consensusData?.leader_receipt?.[0]?.result,
      r?.consensus_data?.leader_receipt?.[0]?.result,
    ];
    for (const c of direct) {
      const v = unwrap(c);
      if (v != null) return v;
    }

    // Hex-blob paths (Bradbury stores the leader's eq-block output here).
    const hexFields = [
      r.eqBlocksOutputs,
      r.eq_blocks_outputs,
      r?.consensusData?.leaderReceipt?.[0]?.eqBlocksOutputs,
      r?.consensusData?.leaderReceipt?.[0]?.eq_blocks_outputs,
    ];
    for (const hx of hexFields) {
      const v = findVerdictInHex(hx);
      if (v) return v;
    }

    // Last-resort: walk every nested object/array looking for either a
    // verdict-shaped object, a JSON string, or a hex blob containing one.
    const seen = new WeakSet();
    function walk(node) {
      if (node == null) return null;
      if (typeof node === "string") {
        const s = node.trim();
        if (s.startsWith("{") && s.endsWith("}")) {
          try {
            const parsed = JSON.parse(s);
            if (looksLikeVerdict(parsed)) return parsed;
          } catch {}
        }
        if (s.startsWith("0x") && s.length > 100) {
          const hit = findVerdictInHex(s);
          if (hit) return hit;
        }
        return null;
      }
      if (typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);
      if (looksLikeVerdict(node)) return node;
      for (const v of Object.values(node)) {
        const hit = walk(v);
        if (hit) return hit;
      }
      return null;
    }
    return walk(r);
  }

  function unwrap(c) {
    if (c == null) return null;
    if (typeof c === "string") return c.length ? c : null;
    if (typeof c === "object") {
      if (typeof c.value === "string" && c.value.length) return c.value;
      if (typeof c.data === "string" && c.data.length) return c.data;
      if (looksLikeVerdict(c)) return c;
    }
    return null;
  }

  // Tx reached COMMITTING — extract the verdict from the receipt.
  let analysis = extractReturnValue(receipt);

  if (analysis == null) {
    // Receipt available but verdict not yet extractable. Dump the receipt
    // shape to stderr so Fly logs show us where the verdict actually lives
    // on whichever network we're on. Truncated to keep logs manageable.
    try {
      const dump = safeStringify(receipt).slice(0, 4000);
      const keys = receipt && typeof receipt === "object" ? Object.keys(receipt) : [];
      process.stderr.write(
        `[gl_analyse] no verdict in receipt. status_name=${receipt?.status_name ?? receipt?.status ?? "?"} ` +
          `keys=${keys.join(",")} dump=${dump}\n`,
      );
    } catch {}
    process.stdout.write(
      safeStringify({
        status: "pending",
        tx_hash: txHash,
        article_id: aid,
        tx_status: receipt?.status_name ?? receipt?.status ?? null,
        note: "receipt has no verdict yet",
      }),
    );
    process.exit(0);
  }

  if (typeof analysis === "string") {
    try {
      analysis = JSON.parse(analysis);
    } catch (e) {
      fail(`Verdict was not valid JSON: ${analysis.slice(0, 200)}`);
    }
  }

  if (typeof analysis !== "object" || analysis === null) {
    fail(`Verdict had unexpected shape: ${safeStringify(analysis)}`);
  }

  process.stdout.write(
    safeStringify({
      status: "ready",
      tx_hash: txHash,
      article_id: aid,
      tx_status: receipt?.status ?? null,
      analysis,
    }),
  );
  process.exit(0);
}
