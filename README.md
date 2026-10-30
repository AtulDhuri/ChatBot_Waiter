# DineOS

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

## Building the embeddable widget

The chat widget shipped at `static/widget.js` is a **generated bundle**. Do not
edit it by hand. The source lives as small ES modules under `src/widget/` and is
bundled into a single self-contained IIFE (no dependencies) by
[esbuild](https://esbuild.github.io/), so the embed stays plug-and-play:

```html
<script src="https://your-host/widget.js" data-restaurant="slug"></script>
```

### One-time setup

```powershell
npm install
```

### Build after editing `src/widget/*.js`

```powershell
npm run build          # production: minified static/widget.js + widget.js.map
npm run watch          # readable rebuild on change while developing
npm run build:dev      # one-off readable (un-minified) build
```

`npm run build` ships a **minified** `static/widget.js` (~38KB vs ~63KB) plus a
`static/widget.js.map` sourcemap. The sourcemap embeds the original module
source (`sourcesContent`), so you can debug the real `src/widget/` code in the
browser even though only the bundle and map are deployed. Both files are
committed and served; `src/`, `scripts/`, `test/`, and the bundler are excluded
from the Docker image.

### Module layout (`src/widget/`)

| Module            | Responsibility                                            |
| ----------------- | --------------------------------------------------------- |
| `config.js`       | Script/URL config, tenant identity, device id, `api/money`|
| `state.js`        | Shared runtime state, `ui` refs, session persistence      |
| `dom.js`          | `el`, `_guard`, `addMessage` helpers                      |
| `styles.js`       | Injected CSS                                              |
| `api.js`          | All network calls, QR-token resolve, transparent re-auth  |
| `cart.js`         | Cart state + the `updateCartBadge` sync orchestrator      |
| `availability.js` | Live sold-out / re-price polling with backoff             |
| `status.js`       | Live order-status tracking (Paid → Preparing → Served)    |
| `nlorder.js`      | Natural-language order parsing / dish matching            |
| `flows.js`        | Menu, cart, payment, bill flows and the chat handler      |
| `render.js`       | Panel, chat, prompts, quick chips, FAB, toggle            |
| `index.js`        | Boot wiring + `window.ChatbotWaiter` entry point          |

The FastAPI server serves the built file as-is at `/widget.js`, so after any
source change run `npm run build` before testing in the browser.

### Testing the widget

```powershell
npm test
```

This rebuilds the bundle (`pretest`) and runs a jsdom browser-runtime test
(`test/widget.runtime.test.mjs`) that loads the real `static/widget.js`, mocks
the backend, and drives the full flow — open panel, start a session, render the
menu, add items, view the cart, and fetch the bill — asserting the DOM updates
correctly. It needs no server or database.

### Guarding against bundle drift

Because `static/widget.js` is generated, it can fall out of sync with
`src/widget/` if someone edits a module but forgets to rebuild (or hand-edits
the bundle). The drift guard catches this:

```powershell
npm run check:bundle   # fails if static/widget.js != a fresh build of the source
npm run check          # drift guard + full test suite (use this in CI / pre-push)
```

`check:bundle` rebuilds the source in-memory with the exact production options
and compares byte-for-byte against the committed bundle. If they differ it exits
non-zero with a reminder to run `npm run build` and commit the result. Wire
`npm run check` into CI or a pre-push hook so a stale bundle never reaches
production.
