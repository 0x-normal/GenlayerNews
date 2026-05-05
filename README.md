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

4. **Deploy the contract**:

   ```powershell
   genlayer deploy --contract contracts/news_oracle.py
   ```

   Copy the printed contract address.

5. **Fill `.env`**:

   ```env
   NEWS_ORACLE_ADDRESS=0x...
   GENLAYER_PRIVATE_KEY=0x...
   GENLAYER_NETWORK=testnetBradbury
   ```

6. **Verify on the explorer.** Every analysis the UI marks as "Verified" links to its tx on **GenScope** (<https://genscope.vercel.app>).

### 3. Start the server

```powershell
python app.py
```

Open <http://localhost:5002>.

## Project layout

| Path | Purpose |
| --- | --- |
| `contracts/news_oracle.py` | The on-chain GenLayer Intelligent Contract. |
| `scripts/gl_analyse.mjs` | Node helper that uses `genlayer-js` to write to NewsOracle on Bradbury. |
| `package.json` | Pins the `genlayer-js` dependency for the helper. |
| `app.py` | Flask backend: news proxies + GenLayer / preview analyse endpoint. |
| `static/index.html` | Single-file frontend — feed, search, dark mode, consensus panel. |
| `.env.example` | All configuration knobs. |

## API surface (unchanged from OpenNews)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/news` | ChainCatcher news-flash proxy. |
| `GET` | `/api/newsapi` | NewsAPI.org proxy with per-tab topic mapping. |
| `POST` | `/api/analyse` | `{ title, content }` → `{ analysis, tx_hash, model }`. |

## Why this is a real GenLayer build

- The analysis isn't produced by a single trusted backend — it's the consensus of several independent AI validators that each see the same article and have to agree according to a public, natural-language equivalence principle.
- The verdict (sentiment, score, summary, key points, risk, entities) is persisted **on-chain** keyed by article hash, so anyone can independently fetch the same JSON without trusting this Flask server.
- The same UX you'd get from a centralized "AI news" SaaS — but every "Verified" pill is backed by an actual on-chain consensus tx, not a logo.

## Credits

UI/design adapted from the original OpenNews project. Analysis layer rebuilt from scratch on top of GenLayer's Intelligent Contracts and equivalence-principle consensus.
