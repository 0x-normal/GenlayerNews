# GenLayer News

**Trustless Web3 News Intelligence — every analysis is the result of multi-validator AI consensus on the GenLayer protocol.**

This is a port of the OpenNews UI (originally built for OpenGradient TEE) to GenLayer. The frontend, news APIs, and overall design are kept identical; the analysis backend is replaced with a real GenLayer Intelligent Contract that produces an on-chain, consensus-verified verdict for every article.

```
                                       ┌──────────────────────────────────┐
   ChainCatcher / NewsAPI ─── /api/news ─→ Flask ─→ /api/analyse ─→ GenLayer ──┤  NewsOracle.analyze()           │
                                                                  ├─→  validators independently call LLM   │
                                                                  ├─→  equivalence-principle consensus     │
                                                                  └─→  verdict persisted on-chain          │
                                                                       └──────────────────────────────────┘
```

## What's on chain

`contracts/news_oracle.py` is a real GenLayer Intelligent Contract. Each call to `analyze(title, content)`:

1. Hashes the article into a stable `article_id`.
2. Has every validator independently run the same prompt over its own LLM.
3. Reaches consensus via `gl.eq_principle.prompt_comparative` with a strict-but-tolerant principle (sentiment / risk / category must match exactly; score within ±20).
4. Stores the canonical JSON verdict in a `TreeMap` keyed by `article_id`.

That on-chain blob is what the frontend renders.

## Run it

### 1. Install

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

### 2. Pick a mode

#### A. Preview mode (zero setup)

Set `OPENAI_API_KEY` in `.env`. Any OpenAI-compatible endpoint works — OpenRouter is recommended for free Claude/GPT access:

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-v1-...
OPENAI_MODEL=anthropic/claude-3.5-sonnet
```

The backend will run a single-validator preview with a stable mock `tx_hash` so the proof UI still renders. Use this for local UX work.

#### B. GenLayer mode (real consensus on **Testnet Bradbury**)

Writes go through a tiny Node helper (`scripts/gl_analyse.mjs`) that uses the official `genlayer-js` SDK. Python (`app.py`) just spawns it.

1. **Install Node deps** (Node 18+):

   ```powershell
   npm install
   ```

2. **Install the GenLayer CLI** and switch it to Bradbury:

   ```powershell
   npm install -g genlayer
   genlayer network set testnet-bradbury
   genlayer network list   # confirm — bradbury should have a *
   ```

3. **Get a key + tokens.** Generate any EVM-style private key (e.g. via MetaMask) and fund it from the GenLayer faucet:

   <https://testnet-faucet.genlayer.foundation/>

4. **Deploy the contract** to whichever network(s) you want enabled. The
   bundled helper handles signing and waits for ACCEPTED:

   ```powershell
   $env:GENLAYER_PRIVATE_KEY="0x..."
   $env:GENLAYER_NETWORK="testnetBradbury"; node scripts/gl_deploy.mjs
   $env:GENLAYER_NETWORK="studionet";       node scripts/gl_deploy.mjs
   ```

   Each run prints the address it deployed to and the matching `ORACLE_ADDR_*`
   env var to set.

5. **Fill `.env`** with one address per network you want to enable:

   ```env
   GENLAYER_PRIVATE_KEY=0x...
   ORACLE_ADDR_BRADBURY=0x...
   ORACLE_ADDR_STUDIONET=0x...        # optional — enables the Studio toggle
   GENLAYER_NETWORK=testnetBradbury   # default when no per-request override
   ```

   The frontend's network switcher (top-right of the dateline bar) only shows
   networks whose `ORACLE_ADDR_*` is set. Others appear greyed-out as a hint
   to deploy them.

6. **Verify on the explorer.** Every analysis the UI marks as "Verified" links
   to its tx on **GenScope** (<https://genscope.vercel.app>) for Bradbury, or
   the equivalent explorer for whichever network it ran on.

### 3. Start the server

```powershell
python app.py
```

Open <http://localhost:5002>.

## Project layout

| Path | Purpose |
| --- | --- |
| `contracts/news_oracle.py` | The on-chain GenLayer Intelligent Contract. |
| `scripts/gl_analyse.mjs` | Two-phase Node helper: submits the analyze() tx (phase 1) and polls for the verdict (phase 2). |
| `scripts/gl_deploy.mjs` | One-shot deployer for `news_oracle.py` to any GenLayer network. |
| `package.json` | Pins the `genlayer-js` dependency for both helpers. |
| `app.py` | Flask backend: news proxies + GenLayer / preview analyse endpoint. |
| `static/index.html` | Single-file frontend — feed, search, dark mode, consensus panel. |
| `.env.example` | All configuration knobs. |

## API surface (unchanged from OpenNews)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/news` | ChainCatcher news-flash proxy. |
| `GET` | `/api/newsapi` | NewsAPI.org proxy with per-tab topic mapping. |
| `GET` | `/api/networks` | Lists configured GenLayer networks for the picker UI. |
| `POST` | `/api/analyse` | `{ title, content, network? }` → broadcasts the tx and returns `{ status: 'pending'\|'ready', tx_hash, article_id, ... }`. |
| `GET` | `/api/analyse/status` | `?tx_hash=...&article_id=...&network=...` — fast poll endpoint, returns `{ status, analysis? }`. |
| `GET` | `/healthz` | Liveness + lists which networks are currently configured. |

## Why this is a real GenLayer build

- The analysis isn't produced by a single trusted backend — it's the consensus of several independent AI validators that each see the same article and have to agree according to a public, natural-language equivalence principle.
- The verdict (sentiment, score, summary, key points, risk, entities) is persisted **on-chain** keyed by article hash, so anyone can independently fetch the same JSON without trusting this Flask server.
- The same UX you'd get from a centralized "AI news" SaaS — but every "Verified" pill is backed by an actual on-chain consensus tx, not a logo.

## Credits

UI/design adapted from the original OpenNews project. Analysis layer rebuilt from scratch on top of GenLayer's Intelligent Contracts and equivalence-principle consensus.
