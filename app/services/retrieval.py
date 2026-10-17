"""Retrieval-augmented answering: embed query, search pgvector, call LLM."""
from __future__ import annotations

from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.services import llm


async def answer_question(
    session: AsyncSession, restaurant_id: int, question: str
) -> Dict[str, Any]:
    query_embedding = await llm.embed_query(question)
    results = await repo.similarity_search(
        session, restaurant_id, query_embedding, settings.top_k
    )
    chunks: List[str] = [r["content"] for r in results]
    answer = await llm.generate_answer(question, chunks)
    sources = [
        {"score": round(float(r["score"]), 4), "metadata": r["metadata"]}
        for r in results
    ]
    return {"answer": answer, "sources": sources}
