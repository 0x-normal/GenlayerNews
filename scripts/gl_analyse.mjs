/**
 * gl_analyse.mjs — submits an `analyze(title, content)` write transaction
 * to the deployed NewsOracle Intelligent Contract on GenLayer Testnet
 * Bradbury, waits for finality, and prints the consensus verdict to
 * stdout as JSON.
 *
 * Reads a single JSON object `{ "title": "...", "content": "..." }` from
 * stdin. Outputs `{ "tx_hash": "0x..", "analysis": {...} }` on success or
 * `{ "error": "..." }` on failure (exit code 1).
 *
 * Env:
 *   NEWS_ORACLE_ADDRESS   address of the deployed NewsOracle contract
 *   GENLAYER_PRIVATE_KEY  hex private key for a Bradbury-funded account
 *   GENLAYER_NETWORK      optional, "testnetBradbury" (default) or
 *                         "testnetAsimov" / "studionet" / "localnet"
 */

import { createClient, createAccount } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus, ExecutionResult } from "genlayer-js/types";
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
const title = payload?.title || "";
const content = payload?.content || "";
if (!title) fail("title is required");

try {
  const account = createAccount(PRIV);
  const client = createClient({ chain, account });
  const aid = articleId(title, content);

  // Step 0 — cheap, free read-only check. If this article has already been
  // analysed in any prior tx (by us or anyone else), skip the write and
  // hydrate from contract storage. Saves gas, sidesteps Bradbury sequencer
  // outages, and makes repeat clicks instant.
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
          tx_hash: "",
          cached: true,
          contract: ADDRESS,
          analysis: parsed,
        }),
      );
      process.exit(0);
    }
  } catch (e) {
    // Read failure shouldn't block the write path — log to stderr and
    // proceed to consensus. Common cause: brand-new article (storage miss
    // returns "" not an error, but some SDK paths throw on empty state).
    process.stderr.write(`[gl_analyse] cache-read miss: ${e.message}\n`);
  }

  const txHash = await client.writeContract({
    account,
    address: ADDRESS,
    functionName: "analyze",
    args: [title, content],
    value: 0,
  });

  // Wait for COMMITTING (status 3) — this is the earliest point where the
  // leader has published its execution result. Waiting for ACCEPTED (5) or
  // FINALIZED (7) is unnecessary: the verdict is already deterministic and
  // visible on-chain at COMMITTING. We're literally racing to grab the
  // value as soon as it appears, so the user doesn't sit through the full
  // reveal+accept cycle (often 60–120s of extra latency on Bradbury).
  // Bradbury can take several minutes to move a tx from PENDING -> COMMITTING
  // depending on validator availability. Wait patiently — viem's default
  // 60s timeout is far too short. We poll every 4s for up to 12 minutes.
  process.stderr.write(
    `[gl_analyse] waiting for COMMITTING on ${txHash} (up to 12 min)…\n`,
  );
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.COMMITTING,
    fullTransaction: true, // we need consensusData / leaderReceipt
    timeout: 12 * 60 * 1000, // 12 minutes
    pollingInterval: 4_000,
    retryCount: 0,
  });

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

  let analysis = extractReturnValue(receipt);

  // Fallback: ask the contract for the canonical stored verdict. Use
  // stateStatus "finalized" first, then "accepted", then no override — the
  // SDK exposes whichever level of finality is currently live.
  if (analysis == null) {
    for (const stateStatus of ["finalized", "accepted", undefined]) {
      try {
        const raw = await client.readContract({
          address: ADDRESS,
          functionName: "get_analysis",
          args: [aid],
          ...(stateStatus ? { stateStatus } : {}),
        });
        if (typeof raw === "string" && raw.length > 0) {
          analysis = raw;
          break;
        }
      } catch (e) {
        process.stderr.write(
          `[gl_analyse] read fallback (${stateStatus || "default"}) failed: ${e.message}\n`,
        );
      }
    }
  }

  if (analysis == null) {
    let dump;
    try {
      dump = safeStringify(receipt, 2);
    } catch (e) {
      dump = `<could not stringify receipt: ${e.message}> keys=${Object.keys(receipt || {}).join(",")}`;
    }
    process.stderr.write(
      `[gl_analyse] receipt dump for ${txHash}:\n${(dump || "").slice(0, 6000)}\n`,
    );
    fail(
      `Tx ${txHash} reached COMMITTING but neither the receipt nor ` +
        `get_analysis(${aid}) yielded a verdict. See app.py logs for the receipt dump.`,
    );
  }

  if (typeof analysis === "string") {
    try {
      analysis = JSON.parse(analysis);
    } catch (e) {
      fail(`Verdict was not valid JSON: ${analysis.slice(0, 200)}`);
    }
  }

  if (typeof analysis !== "object" || analysis === null) {
    fail(`Verdict had unexpected shape: ${JSON.stringify(analysis)}`);
  }

  process.stdout.write(
    safeStringify({
      tx_hash: txHash,
      cached: false,
      contract: ADDRESS,
      analysis,
    }),
  );
  process.exit(0);
} catch (e) {
  fail(e?.message || String(e));
}
