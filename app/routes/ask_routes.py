"""/ask — RAG question answering grounded in the stored menu."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.routes.deps import get_db, resolve_session
from app.schemas import AskRequest, AskResponse
from app.services.retrieval import answer_question

router = APIRouter(prefix="/ask", tags=["ask"])


@router.post("", response_model=AskResponse)
async def ask(
    body: AskRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    # Validate the session (ties the request to a table + device/UA).
    row = await resolve_session(body.session_id, db, request)
    result = await answer_question(db, row["restaurant_id"], body.question)
    return AskResponse(answer=result["answer"], sources=result["sources"])
