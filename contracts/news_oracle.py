# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
NewsOracle — a GenLayer Intelligent Contract that produces
multi-validator AI consensus analyses of crypto / Web3 news articles.

Each `analyze()` call:
  1. Has every validator independently run an LLM over the same article.
  2. Reaches consensus via the equivalence principle (sentiment label and
     category must match exactly; the score must be within a tolerance).
  3. Persists the consensus verdict on-chain forever, keyed by article id.
"""

from genlayer import *

import json
import hashlib
import typing


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


# Validators reach consensus when these conditions are jointly satisfied.
# Loose enough to absorb LLM variance, tight enough that bad-faith leaders
# can't slip distorted analyses past honest validators.
EQUIVALENCE_PRINCIPLE = (
    "`sentiment`, `risk_level`, and `category` fields MUST match exactly. "
    "`sentiment_score` values must be within 20 points of each other. "
    "`key_points` and `entities` lists must cover substantially the same "
    "themes / names (order and wording may differ). "
    "`summary`, `market_impact`, and `tldr` may be phrased differently but "
    "must convey the same overall conclusion."
)


def _article_id(title: str, content: str) -> str:
    """Stable id from the article text — lets clients dedupe cheaply."""
    h = hashlib.sha256()
    h.update(title.strip().encode("utf-8"))
    h.update(b"\x00")
    h.update(content.strip().encode("utf-8"))
    return h.hexdigest()[:24]


class NewsOracle(gl.Contract):
    # article_id -> JSON-encoded consensus analysis
    analyses: TreeMap[str, str]
    # rolling log of analyzed article ids, newest last
    history: DynArray[str]

    def __init__(self):
        pass

    # -- Reads --------------------------------------------------------------

    @gl.public.view
    def get_analysis(self, article_id: str) -> str:
        if article_id in self.analyses:
            return self.analyses[article_id]
        return ""

    @gl.public.view
    def has_analysis(self, title: str, content: str) -> bool:
        return _article_id(title, content) in self.analyses

    @gl.public.view
    def get_recent(self) -> list[str]:
        items = list(self.history)
        items.reverse()
        return items[:50]

    # -- Writes -------------------------------------------------------------

    @gl.public.write
    def analyze(self, title: str, content: str) -> typing.Any:
        """
        Reach multi-validator consensus on the analysis of a single article
        and persist the verdict on-chain.
        """
        if not title:
            raise Exception("title is required")

        article_id = _article_id(title, content)

        # Idempotent: serve cached consensus if we've already analysed this.
        if article_id in self.analyses:
            cached = json.loads(self.analyses[article_id])
            cached["cached"] = True
            return cached

        # Trim aggressively — every byte the leader returns has to be agreed
        # upon and stored on-chain.
        body = (content or title)[:3000]
        text = f"Title: {title}\n\nContent: {body}"

        def leader_and_validator() -> str:
            # Each validator independently asks its own LLM the same question.
            prompt = f"{SYSTEM_PROMPT}\n\n=== Article ===\n{text}\n=== End ==="
            raw = gl.nondet.exec_prompt(prompt)
            cleaned = raw.replace("```json", "").replace("```", "").strip()
            # Tolerate a model that wraps JSON in extra prose.
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start == -1 or end == -1 or end <= start:
                raise Exception(f"LLM did not return JSON: {raw[:200]}")
            parsed = json.loads(cleaned[start : end + 1])

            # Schema validation — reject obvious garbage early so a bad
            # leader can't poison state.
            for field in (
                "sentiment",
                "sentiment_score",
                "summary",
                "key_points",
                "market_impact",
                "risk_level",
                "category",
                "entities",
                "tldr",
            ):
                if field not in parsed:
                    raise Exception(f"missing field in LLM response: {field}")

            score = int(parsed["sentiment_score"])
            if score < 0 or score > 100:
                raise Exception(f"sentiment_score out of range: {score}")
            parsed["sentiment_score"] = score
            parsed["sentiment"] = str(parsed["sentiment"]).lower()
            parsed["risk_level"] = str(parsed["risk_level"]).lower()

            # Canonical ordering so validator string-comparison is stable.
            return json.dumps(parsed, sort_keys=True)

        verdict_json = gl.eq_principle.prompt_comparative(
            leader_and_validator,
            principle=EQUIVALENCE_PRINCIPLE,
        )

        verdict = json.loads(verdict_json)
        verdict["article_id"] = article_id
        verdict["title"] = title
        verdict["cached"] = False

        stored = json.dumps(verdict, sort_keys=True)
        self.analyses[article_id] = stored
        self.history.append(article_id)

        return verdict
