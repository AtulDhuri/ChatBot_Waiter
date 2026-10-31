"""FastAPI application entrypoint."""
from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, RedirectResponse, FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db.database import dispose_db, init_db, AsyncSessionLocal
from app.routes.deps import get_db
from app.routes import (
    ask_routes,
    auth_routes,
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
    staff_routes,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("waiter")

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await init_db()
        logger.info("Database schema ready.")
    except Exception:
        # Never serve an application with a partially-created security schema.
        # Startup DDL runs in a transaction; failing fast makes the migration
        # error visible instead of allowing requests against missing tables.
        logger.exception("DB init failed at startup; refusing to start.")
        raise
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

@app.middleware("http")
async def protect_admin_pages(request: Request, call_next):
    protected = {"dashboard.html", "setup.html", "menu.html", "subscription.html", "billing.html", "admin.html", "manager.html", "kitchen.html", "sales.html", "reports.html", "dishes.html", "categories.html", "tables.html", "settings.html", "staff.html", "availability.html", "qr.html"}
    clean_aliases = {"dashboard", "setup", "subscription", "billing", "admin", "manager", "kitchen", "sales", "reports", "dishes", "categories", "tables", "settings", "staff", "availability", "qr"}
    page = request.url.path.rsplit("/", 1)[-1]
    page_key = page if page.endswith(".html") else (page + ".html" if page in clean_aliases else None)
    if page_key in protected:
        from app.services.auth import decode_token, token_from_request
        token = token_from_request(request)
        try:
            if not token:
                raise ValueError("no token")
            payload = decode_token(token)
            async with AsyncSessionLocal() as auth_db:
                try:
                    current = (await auth_db.execute(text("""SELECT u.active,u.status,u.role,u.tenant_id,u.outlet_id,
                        r.subscription_status, u.tenant_id AS outlet_tenant_id
                        FROM users u JOIN restaurants r ON r.id=u.outlet_id
                        WHERE u.id=:uid"""), {"uid": payload.get("userId")})).mappings().first()
                except Exception as db_exc:
                    import logging as _log
                    _log.getLogger("waiter.guard").error("Page guard DB error: %s", db_exc)
                    current = None
            if not current:
                raise ValueError("user not found")
            if not current["active"] or current.get("status", "ACTIVE") != "ACTIVE":
                raise ValueError("inactive account")
            if current.get("subscription_status") in {"EXPIRED", "SUSPENDED"}:
                raise ValueError("inactive subscription")
            if int(current["tenant_id"]) != int(payload.get("tenantId", -1)) or int(current["outlet_id"]) != int(payload.get("outletId", -1)):
                raise ValueError("tenant mismatch")
            role = current["role"]
            allowed = {
                "admin.html": {"admin"},
                "manager.html": {"admin", "manager"},
                "reports.html": {"admin", "manager"},
                "kitchen.html": {"admin", "manager", "kitchen"},
                "availability.html": {"admin", "manager"},
                "qr.html": {"admin", "manager"},
                "dishes.html": {"admin", "manager"},
                "categories.html": {"admin", "manager"},
                "tables.html": {"admin", "manager"},
                "settings.html": {"admin"},
                "staff.html": {"admin"},
                "sales.html": {"admin", "manager"},
            }
            if role not in allowed.get(page_key, {"admin"}):
                return RedirectResponse(url="/kitchen.html" if role == "kitchen" else "/login.html", status_code=302)
        except Exception as guard_exc:
            import logging as _log
            _log.getLogger("waiter.guard").warning("Page guard blocked %s: %s", page_key, guard_exc)
            return RedirectResponse(url="/login.html", status_code=302)
    return await call_next(request)

app.include_router(session_routes.router)
app.include_router(auth_routes.router)
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
app.include_router(staff_routes.router)

@app.get("/login", include_in_schema=False)
async def login_page_alias():
    return RedirectResponse(url="/login.html")

@app.get("/forgot-password", include_in_schema=False)
async def forgot_password_page():
    return FileResponse(os.path.join(STATIC_DIR, "forgot-password.html"))

@app.get("/reset-password", include_in_schema=False)
async def reset_password_page():
    return FileResponse(os.path.join(STATIC_DIR, "reset-password.html"))

@app.get("/manager-login", include_in_schema=False)
@app.get("/manager-login.html", include_in_schema=False)
async def manager_login_page():
    return FileResponse(os.path.join(STATIC_DIR, "manager-login.html"))

@app.get("/kitchen-login", include_in_schema=False)
@app.get("/kitchen-login.html", include_in_schema=False)
async def kitchen_login_page():
    return FileResponse(os.path.join(STATIC_DIR, "kitchen-login.html"))


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok", "llm_enabled": settings.llm_enabled}


@app.get("/config.js", tags=["meta"])
async def widget_config(request: Request, db: AsyncSession = Depends(get_db)):
    """Expose public widget config and resolve a slug to its display name."""
    display_name = settings.restaurant_name
    slug = (request.query_params.get("r") or "").strip().lower()
    if slug:
        rest = await repo.get_restaurant_by_slug(db, slug)
        if rest:
            display_name = rest.get("name") or display_name
    body = "window.WAITER_CONFIG = " + json.dumps({
        "apiBase": "", "restaurant": slug or "demo", "currency": settings.currency,
        "name": display_name,
    }) + ";"
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
