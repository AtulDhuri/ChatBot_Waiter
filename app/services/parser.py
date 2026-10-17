"""PDF menu parsing via Docling, with a graceful plain-text fallback.

Docling is heavy; if it is unavailable at runtime (or parsing fails) we fall
back to a lightweight extractor so the system stays plug-and-play.
"""
from __future__ import annotations

import logging
import re
from typing import List

logger = logging.getLogger(__name__)


def parse_pdf_to_markdown(pdf_path: str) -> str:
    """Return menu text extracted from the PDF.

    Tries a chain of extractors from best to simplest, so the system works
    plug-and-play regardless of how the PDF was produced:
        1. Docling      — rich layout-aware parsing (optional heavy dep)
        2. pypdf        — fast text-layer extraction
        3. pdfminer.six — alternate text-layer extractor (catches more)
        4. OCR          — pytesseract on rendered pages, for scanned/image PDFs
    The first extractor that yields non-trivial text wins.
    """
    extractors = [
        ("pymupdf", _extract_pymupdf),
        ("docling", _extract_docling),
        ("pypdf", _extract_pypdf),
        # Vision model reads scanned/image menus (needs OPENAI_API_KEY).
        ("vision", _extract_vision),
    ]
    for name, fn in extractors:
        try:
            text = fn(pdf_path)
        except Exception as exc:  # pragma: no cover - optional deps
            logger.warning("%s extractor unavailable/failed: %s", name, exc)
            continue
        if text and len(text.strip()) >= 10:
            logger.info("PDF text extracted via '%s' (%d chars).", name, len(text))
            return text
        logger.info("Extractor '%s' produced no usable text; trying next.", name)
    return ""


def _extract_pymupdf(pdf_path: str) -> str:
    """Primary extractor: fast, layout-aware, prebuilt wheels, tiny install."""
    import fitz  # PyMuPDF

    parts: List[str] = []
    with fitz.open(pdf_path) as doc:
        for page in doc:
            # "text" preserves reading order well for menus (columns, sections).
            parts.append(page.get_text("text"))
    return "\n\n".join(parts)


def _extract_docling(pdf_path: str) -> str:
    from docling.document_converter import DocumentConverter

    result = DocumentConverter().convert(pdf_path)
    return result.document.export_to_markdown() or ""


def _extract_pypdf(pdf_path: str) -> str:
    from pypdf import PdfReader

    reader = PdfReader(pdf_path)
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages)


def _extract_vision(pdf_path: str) -> str:
    """Read scanned/image-only menus with a vision LLM (GPT-4o).

    PyMuPDF renders each page to a PNG (no native deps), then the image is
    sent to OpenAI which transcribes the menu as plain text. Only reached when
    the text extractors find nothing, so text PDFs never incur this cost.
    Requires OPENAI_API_KEY; otherwise returns "" and the chain gives up.
    """
    import base64

    import fitz  # PyMuPDF

    from app.config import settings

    if not settings.llm_enabled:
        logger.info("Vision extractor skipped: no OPENAI_API_KEY set.")
        return ""

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key)
    prompt = (
        "This is a photo/scan of a restaurant menu. Transcribe ALL of it as "
        "plain text. Preserve section headings (e.g. Starters, Mains, Drinks) "
        "on their own lines, and put each item on one line as "
        "'Item name - optional description .... price'. Keep prices exactly as "
        "shown. Do not add commentary."
    )

    parts: List[str] = []
    with fitz.open(pdf_path) as doc:
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2.2, 2.2))  # ~160 DPI
            b64 = base64.b64encode(pix.tobytes("png")).decode()
            resp = client.chat.completions.create(
                model=settings.chat_model,
                temperature=0,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{b64}"
                                },
                            },
                        ],
                    }
                ],
            )
            parts.append(resp.choices[0].message.content or "")
    return "\n\n".join(parts).strip()


def chunk_text(
    text: str, chunk_size: int = 800, overlap: int = 120
) -> List[str]:
    """Split text into overlapping, paragraph-aware chunks.

    We first split on blank lines to keep logical menu sections together,
    then pack paragraphs up to ``chunk_size`` characters with ``overlap``
    characters carried over between consecutive chunks.
    """
    if not text or not text.strip():
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: List[str] = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 1 <= chunk_size:
            current = f"{current}\n{para}".strip()
        else:
            if current:
                chunks.append(current)
            if len(para) <= chunk_size:
                current = para
            else:
                # Hard-split an oversized paragraph.
                for i in range(0, len(para), chunk_size - overlap):
                    chunks.append(para[i : i + chunk_size])
                current = ""
    if current:
        chunks.append(current)

    # Apply overlap between adjacent chunks for retrieval continuity.
    if overlap > 0 and len(chunks) > 1:
        overlapped: List[str] = [chunks[0]]
        for prev, nxt in zip(chunks, chunks[1:]):
            tail = prev[-overlap:]
            overlapped.append(f"{tail}\n{nxt}".strip())
        chunks = overlapped

    return chunks
