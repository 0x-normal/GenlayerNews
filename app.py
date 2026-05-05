"""
GenLayer News — Web3 News Intelligence powered by GenLayer's
multi-validator AI consensus.

Endpoints
---------
GET  /api/news       Proxy for ChainCatcher news-flash (CORS-bypass).
GET  /api/newsapi    Proxy for NewsAPI.org (CORS-bypass).
POST /api/analyse    Submit an article to the GenLayer NewsOracle Intelligent
                     Contract and return the on-chain consensus verdict. Falls
                     back to a single-validator preview via any OpenAI-
                     compatible LLM endpoint when GenLayer is not configured.

Configuration
-------------
See `.env.example`. The two relevant modes are:

  * GenLayer mode  — set NEWS_ORACLE_ADDRESS + GENLAYER_PRIVATE_KEY
                     (default network is Testnet Bradbury)
  * Preview mode   — set OPENAI_API_KEY (any OpenAI-compatible endpoint)
"""

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional in production
    pass


# ───────────────────────── Config ──────────────────────────────────────────

NEWS_ORACLE_ADDRESS = os.environ.get("NEWS_ORACLE_ADDRESS", "").strip()
GENLAYER_PRIVATE_KEY = os.environ.get("GENLAYER_PRIVATE_KEY", "").strip()
GENLAYER_NETWORK = os.environ.get("GENLAYER_NETWORK", "testnetBradbury").strip()
GL_NODE_BIN = os.environ.get("GL_NODE_BIN", "node").strip()
GL_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "gl_analyse.mjs")

GENLAYER_ENABLED = bool(NEWS_ORACLE_ADDRESS and GENLAYER_PRIVATE_KEY)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()

NEWS_API_KEY = (
    os.environ.get("NEWS_API_KEY") or "0da246dfaec44a3da7c3a9c238a76bae"
)


SYSTEM_PROMPT = """You are a professional Web3 / crypto market analyst with deep expertise in blockchain, DeFi, NFTs, and crypto markets.

Analyse the provided news article and respond with ONLY a valid JSON object — no markdown, no explanation, no preamble:

{
  "sentiment": "bullish" | "bearish" | "neutral",
  "sentiment_score": <integer 0-100, where 0=extremely bearish, 50=neutral, 100=extremely bullish>,
  "summary": "<2-3 sentence plain English summary of what happened and why it matters>",
  "key_points": ["<point 1>", "<point 2>", "<point 3>", "<point 4>"],
  "market_impact": "<1-2 sentences on potential short-term market impact>",
  "risk_level": "low" | "medium" | "high",
  "category": "DeFi" | "NFT" | "Layer1" | "Layer2" | "Regulation" | "Macro" | "Exchange" | "AI" | "Infrastructure" | "Other",
  "entities": ["<company/protocol/person>", ...],
  "tldr": "<one punchy sentence, max 15 words>"
}"""


app = Flask(__name__, static_folder="static")
CORS(app)


# ───────────────────────── Banner ──────────────────────────────────────────

print("\n" + "=" * 60)
print("  GenLayer News  ·  Web3 Intelligence on Trustless AI Consensus")
print("=" * 60)
if GENLAYER_ENABLED:
    print(f"  Mode         : GenLayer Testnet ({GENLAYER_NETWORK})")
    print(f"  Oracle addr  : {NEWS_ORACLE_ADDRESS}")
elif OPENAI_API_KEY:
    print(f"  Mode         : Preview (single-validator via {OPENAI_BASE_URL})")
    print(f"  Model        : {OPENAI_MODEL}")
else:
    print("  Mode         : (none configured) — set OPENAI_API_KEY or NEWS_ORACLE_ADDRESS+GENLAYER_PRIVATE_KEY")
print("  Open         : http://localhost:" + os.environ.get("PORT", "5002"))
print("=" * 60 + "\n")


# ───────────────────────── Static / index ──────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/healthz")
def healthz():
    """Lightweight liveness probe used by Fly / load balancers."""
    return jsonify({"ok": True, "mode": "genlayer" if GENLAYER_ENABLED else "preview"}), 200


# ───────────────────────── News proxies ────────────────────────────────────

@app.route("/api/news")
def proxy_news():
    """ChainCatcher news-flash proxy (avoids browser CORS blocks)."""
    params = {
        "lang": request.args.get("lang", "en"),
        "page": request.args.get("page", "1"),
        "size": request.args.get("size", "20"),
    }
    if request.args.get("type"):
        params["type"] = request.args.get("type")

    url = "https://api.chaincatcher.com/v1/open-api/news-flash?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
        return jsonify(data)
    except Exception as e:
        return jsonify({"result": 0, "message": str(e), "data": None}), 500


@app.route("/api/newsapi")
def proxy_newsapi():
    """NewsAPI.org proxy."""
    topic = request.args.get("topic", "crypto OR blockchain OR bitcoin OR ethereum")
    page = request.args.get("page", "1")
    size = request.args.get("size", "20")
    sort = request.args.get("sort", "publishedAt")  # publishedAt | relevancy | popularity

    params = {
        "q": topic,
        "language": "en",
        "sortBy": sort,
        "pageSize": size,
        "page": page,
        "apiKey": NEWS_API_KEY,
    }
    url = "https://newsapi.org/v2/everything?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "GenLayerNews/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
        return jsonify(data)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ───────────────────────── GenLayer client ─────────────────────────────────

def _article_id(title: str, content: str) -> str:
    """Mirrors the contract's hashing scheme so cache lookups line up."""
    h = hashlib.sha256()
    h.update(title.strip().encode("utf-8"))
    h.update(b"\x00")
    h.update(content.strip().encode("utf-8"))
    return h.hexdigest()[:24]


def _run_gl_helper(payload: dict, timeout_s: int) -> dict:
    """Invoke the Node helper with a JSON command on stdin and return its
    parsed JSON response. Raises RuntimeError with a friendly message on
    helper failure."""
    if not os.path.exists(GL_HELPER):
        raise RuntimeError(f"GenLayer helper script missing: {GL_HELPER}")

    env = os.environ.copy()
    env["NEWS_ORACLE_ADDRESS"] = NEWS_ORACLE_ADDRESS
    env["GENLAYER_PRIVATE_KEY"] = GENLAYER_PRIVATE_KEY
    env["GENLAYER_NETWORK"] = GENLAYER_NETWORK

    try:
        proc = subprocess.run(
            [GL_NODE_BIN, GL_HELPER],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=env,
        )
    except FileNotFoundError as e:
        raise RuntimeError(
            "Node.js not found. Install Node 18+ and run `npm install` in the project root."
        ) from e

    if proc.stderr:
        for line in proc.stderr.rstrip().splitlines():
            print(f"[gl_analyse:stderr] {line}")

    if proc.returncode != 0:
        try:
            err = json.loads(proc.stdout or "{}").get("error")
        except Exception:  # noqa: BLE001
            err = None
        raise RuntimeError(
            err or proc.stderr.strip() or f"gl_analyse exited {proc.returncode}"
        )

    try:
        return json.loads(proc.stdout)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            f"Could not parse GenLayer helper output: {e}\nstdout: {proc.stdout[:400]}"
        )


def gl_submit(title: str, content: str) -> dict:
    """Phase 1: broadcast analyze() (or use cached storage) and return
    immediately. Result has either status='ready' (cache hit) or
    status='pending' with a tx_hash to poll."""
    return _run_gl_helper(
        {"action": "submit", "title": title, "content": content},
        timeout_s=60,  # broadcasting only — must be fast
    )


def gl_status(tx_hash: str, article_id: str) -> dict:
    """Phase 2: poll the chain to see if the verdict is ready. Each call is
    designed to complete in <10s."""
    return _run_gl_helper(
        {"action": "status", "tx_hash": tx_hash, "article_id": article_id},
        timeout_s=30,  # short — frontend will retry on the next poll
    )


# ───────────────────────── Preview-mode client ─────────────────────────────

def analyse_via_openai(title: str, content: str) -> dict:
    """
    Single-validator preview: runs the same prompt as the on-chain contract
    against any OpenAI-compatible endpoint. Returns an analysis plus a
    deterministic mock tx hash so the proof UI still renders.
    """
    if not OPENAI_API_KEY:
        missing = []
        if not NEWS_ORACLE_ADDRESS:
            missing.append("NEWS_ORACLE_ADDRESS")
        if not GENLAYER_PRIVATE_KEY:
            missing.append("GENLAYER_PRIVATE_KEY")
        raise RuntimeError(
            "GenLayer mode is not configured: missing env var(s) "
            f"{', '.join(missing) or '(unknown)'}. "
            "Set them in your hosting provider's Secrets / Environment tab. "
            "Alternatively, set OPENAI_API_KEY for preview mode."
        )

    text = f"Title: {title}\n\nContent: {(content or title)[:3000]}"
    body = {
        "model": OPENAI_MODEL,
        "temperature": 0.1,
        "max_tokens": 700,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    }
    r = requests.post(
        f"{OPENAI_BASE_URL}/chat/completions",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    raw = r.json()["choices"][0]["message"]["content"] or ""

    s = raw.strip()
    if "```" in s:
        s = s.split("```")[1].lstrip("json").strip()
    s = s[s.find("{") : s.rfind("}") + 1]
    analysis = json.loads(s)

    # Mock-but-stable tx hash so the UI's proof block displays.
    digest = hashlib.sha256(
        (title + "|" + str(content) + "|" + json.dumps(analysis, sort_keys=True)).encode("utf-8")
    ).hexdigest()
    tx_hash = "0xpreview" + digest[:56]

    return {
        "analysis": analysis,
        "tx_hash": tx_hash,
        "model": f"GenLayer Preview · {OPENAI_MODEL}",
    }


# ───────────────────────── /api/analyse ────────────────────────────────────

# Substrings that indicate a transient Bradbury infra hiccup we should retry
# silently with a longer backoff. These come from the GenLayer SDK / viem
# when the testnet sequencer leader is unreachable or rate-limiting.
_TRANSIENT_HINTS = (
    "sequencer-leader",
    "error sending request for url",
    "internal error",
    "consensus contract",
    "was reverted",
    "fetch failed",
    "econnrefused",
    "etimedout",
    "socket hang up",
)


def _is_transient(msg: str) -> bool:
    m = (msg or "").lower()
    return any(h in m for h in _TRANSIENT_HINTS)


def _friendly_error(msg: str) -> str:
    """Strip viem stack-trace noise into something the UI can show."""
    if not msg:
        return "Unknown error"
    m = msg.strip()
    if "sequencer-leader" in m or "error sending request for url" in m:
        return ("GenLayer Bradbury sequencer is temporarily unreachable. "
                "This is a testnet infrastructure issue — try again in a moment.")
    if "consensus contract" in m and "reverted" in m:
        return ("GenLayer validators couldn't reach consensus on this article "
                "(usually a transient LLM hiccup). Try again.")
    # First non-empty line, capped, so the UI doesn't show a wall of text.
    first = next((ln for ln in m.splitlines() if ln.strip()), m)
    return first[:240]


def _retry(fn, retries=3):
    """Retry `fn` with progressive backoff, longer delays on transient errors."""
    backoffs = [3, 8, 18]  # seconds
    last = None
    for i in range(retries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            transient = _is_transient(str(e))
            tag = "transient" if transient else "hard"
            print(f"[analyse] attempt {i + 1}/{retries} failed ({tag}): {e}")
            if i < retries - 1:
                delay = backoffs[i] if transient else max(1.5, backoffs[i] / 3)
                time.sleep(delay)
    raise last


def _label(cached: bool) -> str:
    return (
        f"GenLayer Storage · {GENLAYER_NETWORK}"
        if cached
        else f"GenLayer Consensus · {GENLAYER_NETWORK}"
    )


@app.route("/api/analyse", methods=["POST", "OPTIONS"])
def analyse_submit():
    """Phase 1 — broadcast the tx (or hit cache) and return quickly.

    Response shape:
      { success, status: 'ready'|'pending', tx_hash, article_id,
        analysis?, model?, cached?, contract? }

    The frontend should poll /api/analyse/status until status='ready'."""
    if request.method == "OPTIONS":
        return jsonify({}), 200

    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or data.get("digest") or "").strip()

    if not title:
        return jsonify({"success": False, "error": "No title provided"}), 400

    print(f"[analyse] {title[:80]}…")

    try:
        if GENLAYER_ENABLED:
            out = gl_submit(title, content)
            tx_hash = out.get("tx_hash") or ""
            aid = out.get("article_id") or _article_id(title, content)
            cached = bool(out.get("cached"))
            status = out.get("status") or "pending"
            resp = {
                "success": True,
                "status": status,
                "tx_hash": tx_hash,
                "payment_hash": tx_hash,  # back-compat
                "article_id": aid,
                "cached": cached,
                "contract": out.get("contract") or NEWS_ORACLE_ADDRESS,
                "model": _label(cached),
            }
            if status == "ready":
                resp["analysis"] = out.get("analysis")
            return jsonify(resp)
        else:
            # Preview / OpenAI mode is synchronous and fast.
            result = _retry(lambda: analyse_via_openai(title, content))
            return jsonify(
                {
                    "success": True,
                    "status": "ready",
                    "analysis": result["analysis"],
                    "tx_hash": result.get("tx_hash") or "",
                    "payment_hash": result.get("tx_hash") or "",
                    "cached": result.get("cached", False),
                    "contract": result.get("contract", ""),
                    "model": result["model"],
                    "article_id": _article_id(title, content),
                }
            )
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        print(f"[analyse:submit] ERROR: {msg}")
        return jsonify({"success": False, "error": _friendly_error(msg)}), 500


@app.route("/api/analyse/status", methods=["GET", "OPTIONS"])
def analyse_status():
    """Phase 2 — poll endpoint. Frontend calls this every few seconds with
    the tx_hash returned from /api/analyse until the verdict is ready."""
    if request.method == "OPTIONS":
        return jsonify({}), 200

    tx_hash = (request.args.get("tx_hash") or "").strip()
    aid = (request.args.get("article_id") or "").strip()
    if not tx_hash:
        return jsonify({"success": False, "error": "tx_hash is required"}), 400
    if not aid:
        return jsonify({"success": False, "error": "article_id is required"}), 400
    if not GENLAYER_ENABLED:
        return jsonify({"success": False, "error": "GenLayer mode not configured"}), 400

    try:
        out = gl_status(tx_hash, aid)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        print(f"[analyse:status] ERROR: {msg}")
        return jsonify({"success": False, "error": _friendly_error(msg)}), 500

    status = out.get("status") or "pending"
    resp = {
        "success": True,
        "status": status,
        "tx_hash": tx_hash,
        "payment_hash": tx_hash,
        "article_id": aid,
        "contract": NEWS_ORACLE_ADDRESS,
        "tx_status": out.get("tx_status"),
        "model": _label(False),
    }
    if status == "ready":
        resp["analysis"] = out.get("analysis")
    return jsonify(resp)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5002))
    app.run(debug=False, host="0.0.0.0", port=port)
