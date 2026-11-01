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

# ---- JS build (minify admin scripts + widget) ----
# Install Node only for the build step; the final image keeps it small because
# node_modules are dev-only and the output goes into static/js/dist/.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY src ./src
COPY static ./static
COPY scripts ./scripts

RUN npm ci --include=dev && npm run build && npm prune --production

EXPOSE 8000

# Honor the platform-provided $PORT (Render sets it); default to 8000 locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
