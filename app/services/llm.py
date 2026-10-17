"""Embeddings and chat completions.

Wraps OpenAI but degrades gracefully: when no API key is configured we use a
deterministic local hash embedding and a template answer so the demo runs
offline (plug-and-play without external credentials).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
from typing import List

from app.config import settings

logger = logging.getLogger(__name__)

_client = None

# Signals that the last embed_texts call fell back to local embeddings because
# the OpenAI API was unreachable. Callers (e.g. ingest) can surface a warning.
embeddings_degraded: bool = False


def _get_client():
    global _client
    if _client is None and settings.llm_enabled:
        from openai import AsyncOpenAI

        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


# ---- Embeddings ----------------------------------------------------------

async def embed_texts(texts: List[str]) -> List[List[float]]:
    """Embed texts via OpenAI, falling back to local embeddings on failure.

    A transient network/DNS error (e.g. ``getaddrinfo failed``) or any OpenAI
    API error must not crash a menu upload. We log it and degrade to the
    deterministic offline embedding so ingestion still succeeds.
    """
    global embeddings_degraded
    embeddings_degraded = False

    client = _get_client()
    if client is not None:
        try:
            resp = await client.embeddings.create(
                model=settings.embedding_model, input=texts
            )
            return [d.embedding for d in resp.data]
        except Exception as exc:  # noqa: BLE001 - degrade gracefully on any API/network error
            embeddings_degraded = True
            logger.warning(
                "OpenAI embeddings failed (%s: %s); falling back to local "
                "offline embeddings.",
                type(exc).__name__,
                exc,
            )
            return [_fake_embedding(t) for t in texts]
    return [_fake_embedding(t) for t in texts]


async def embed_query(text: str) -> List[float]:
    return (await embed_texts([text]))[0]


def _fake_embedding(text: str, dim: int | None = None) -> List[float]:
    """Deterministic pseudo-embedding for offline/demo use.

    Hashes token n-grams into a fixed-width vector and L2-normalizes. Not
    semantically strong, but stable and good enough to demo retrieval.
    """
    dim = dim or settings.embedding_dim
    vec = [0.0] * dim
    tokens = text.lower().split()
    for tok in tokens:
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


# ---- Chat ----------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a friendly, concise restaurant waiter assistant for "
    "{restaurant}. Answer the guest using ONLY the menu context provided. "
    "If the answer is not in the context, say you are not sure and suggest "
    "they browse the menu. Mention prices when relevant. Keep answers short."
)


async def generate_answer(question: str, context_chunks: List[str]) -> str:
    context = "\n\n---\n\n".join(context_chunks) if context_chunks else "(no menu loaded)"
    client = _get_client()

    if client is not None:
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            temperature=0.2,
            messages=[
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT.format(
                        restaurant=settings.restaurant_name
                    ),
                },
                {
                    "role": "user",
                    "content": f"Menu context:\n{context}\n\nGuest question: {question}",
                },
            ],
        )
        return resp.choices[0].message.content.strip()

    return _fallback_answer(question, context_chunks)


def _fallback_answer(question: str, context_chunks: List[str]) -> str:
    if not context_chunks:
        return (
            "I don't have the menu loaded yet. Please ask the staff to upload "
            "the menu, then I can help you order."
        )
    snippet = context_chunks[0].strip()
    if len(snippet) > 400:
        snippet = snippet[:400] + "..."
    return (
        "Here's what I found on the menu that may help:\n\n"
        f"{snippet}\n\n(LLM answers are disabled in demo mode — set "
        "OPENAI_API_KEY for natural-language replies.)"
    )


# ---- Order parsing (gated LLM fallback) ----------------------------------

_ORDER_SYSTEM_PROMPT = (
    "You convert a restaurant guest's message into structured order lines. "
    "You are given the EXACT list of dish names available. Return ONLY dishes "
    "from that list that the guest clearly wants to order. Match the guest's "
    "wording to the closest dish name, correcting typos. Ignore questions, "
    "greetings, and anything not an order. If nothing is being ordered, return "
    "an empty list.\n"
    "Respond with STRICT JSON of the form: "
    '{\"items\": [{\"name\": \"<exact dish name from the list>\", '
    '\"quantity\": <integer >= 1>}]}. '
    "Use dish names verbatim from the provided list. No commentary."
)


async def parse_order(text: str, menu_names: List[str]) -> List[dict]:
    """Parse a free-text message into ``[{"name", "quantity"}]`` order lines.

    Only called as a fallback when the client-side matcher is unsure, so it is
    cheap in aggregate. Returns an empty list when no LLM is configured, the
    API is unreachable, or nothing orderable is found — callers treat an empty
    result as "could not understand".

    ``name`` values are constrained to the supplied ``menu_names`` (the caller
    re-maps them to real menu items and applies authoritative DB prices; the
    model never sets prices).
    """
    client = _get_client()
    if client is None or not menu_names or not text.strip():
        return []

    menu_block = "\n".join(f"- {n}" for n in menu_names)
    try:
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            temperature=0,
            max_tokens=300,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _ORDER_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Available dishes:\n{menu_block}\n\n"
                        f"Guest message: {text}"
                    ),
                },
            ],
        )
        content = resp.choices[0].message.content or "{}"
        data = json.loads(content)
    except Exception as exc:  # noqa: BLE001 - never let the fallback crash a request
        logger.warning("parse_order failed (%s: %s)", type(exc).__name__, exc)
        return []

    raw_items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw_items, list):
        return []

    # Constrain names to the allowed menu and sanitize quantities.
    allowed = {n.lower(): n for n in menu_names}
    out: List[dict] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        name = allowed.get(str(it.get("name", "")).strip().lower())
        if not name:
            continue
        try:
            qty = int(it.get("quantity", 1))
        except (TypeError, ValueError):
            qty = 1
        qty = max(1, min(qty, 50))  # clamp to a sane range
        out.append({"name": name, "quantity": qty})
    return out
