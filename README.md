# Chatbot Waiter

A FastAPI backend + embeddable chat widget for a restaurant "AI waiter": menu
ingestion (PDF), retrieval-augmented Q&A, ordering, billing, UPI payment QR, and
kitchen/reports/admin pages.

## Requirements

- Python 3.13 (a virtual environment already exists at `.venv`)
- A reachable Postgres database (Supabase + pgvector) via `DATABASE_URL`
- (Optional) OpenAI API key for LLM answers and embeddings

## Setup

### 1. Create / activate the virtual environment

The repo already ships a `.venv`. Activate it (PowerShell on Windows):

```powershell
.\.venv\Scripts\Activate.ps1
```

If activation is blocked by execution policy, allow it for the current session first:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1
```

To create the venv from scratch instead:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install dependencies

For local Windows development use the lightweight set (skips heavy native deps
like `docling`/`weasyprint`; PDF parsing falls back to `pypdf`, invoices fall
back to HTML):

```powershell
python -m pip install --upgrade pip
pip install -r requirements-local.txt
```

For the full feature set (Docker / Linux host) use:

```powershell
pip install -r requirements.txt
```

### 3. Configure environment

Copy the example env file and fill in your values (at minimum `DATABASE_URL`;
add `OPENAI_API_KEY` to enable LLM features):

```powershell
Copy-Item .env.example .env
```

## Run the app (inside the venv)

With the venv activated:

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Or without activating the venv (call the interpreter directly):

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Then open:

- App / demo widget: http://localhost:8000/
- Health check: http://localhost:8000/health
- API docs (Swagger): http://localhost:8000/docs

## Deactivate the venv

```powershell
deactivate
```
