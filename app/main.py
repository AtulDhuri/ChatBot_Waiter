"""FastAPI application entrypoint."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db.database import dispose_db, init_db
from app.routes import (
    ask_routes,
    bill_routes,
    crawl_routes,
    manager_routes,
    menu_routes,
    order_routes,
    pay_routes,
    postpaid_routes,
    qr_routes,
    report_routes,
    session_routes,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("waiter")

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await init_db()
        logger.info("Database schema ready.")
    except Exception as exc:  # don't crash the app if DB is briefly unavailable
        logger.error("DB init failed at startup: %s", exc)
    yield
    await dispose_db()


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers
app.include_router(session_routes.router)
app.include_router(qr_routes.router)
app.include_router(crawl_routes.router)
app.include_router(menu_routes.router)
app.include_router(ask_routes.router)
app.include_router(bill_routes.router)
app.include_router(pay_routes.router)
app.include_router(postpaid_routes.router)
app.include_router(order_routes.router)
app.include_router(report_routes.router)
app.include_router(manager_routes.router)


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok", "llm_enabled": settings.llm_enabled}


@app.get("/config.js", tags=["meta"])
async def widget_config():
    """Expose minimal, public config the widget reads at load time."""
    body = (
        "window.WAITER_CONFIG = {"
        'apiBase: "", restaurant: "demo", '
        f'currency: "{settings.currency}", '
        f'name: "{settings.restaurant_name}"'
        "};"
    )
    return Response(content=body, media_type="application/javascript")


@app.get("/widget.js", tags=["meta"])
async def widget_js():
    """Serve the widget with no-cache headers.

    The embeddable widget changes often and must never be stale in a guest's
    browser, so we disable caching here instead of relying on StaticFiles
    (which sends cacheable responses).
    """
    path = os.path.join(STATIC_DIR, "widget.js")
    if not os.path.isfile(path):
        return Response(status_code=404)
    with open(path, "r", encoding="utf-8") as fh:
        body = fh.read()
    return Response(
        content=body,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# Serve the embeddable widget + demo pages (mounted last so API wins).
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
