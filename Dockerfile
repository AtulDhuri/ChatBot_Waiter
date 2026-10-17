# ---- Chatbot Waiter backend image ----
# Python slim base. System libs are needed by WeasyPrint (PDF invoices) and by
# Docling's parsing stack. Everything else is plug-and-play.
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

# System dependencies:
#   - libpango/cairo/gdk-pixbuf: WeasyPrint HTML->PDF rendering
#   - libgl1/poppler-utils: Docling PDF parsing
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
        libcairo2 libffi-dev \
        poppler-utils libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app
COPY static ./static

EXPOSE 8000

# Honor the platform-provided $PORT (Render sets it); default to 8000 locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
