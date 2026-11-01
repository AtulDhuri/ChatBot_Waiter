from datetime import datetime, timedelta, timezone
import hashlib
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.config import settings
from app.routes.deps import get_db, require_staff
from app.services.auth import audit, create_reset_token, decode_token, hash_password, issue_realtime_token, issue_token, token_from_request, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)
    restaurant: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)

class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str

class KitchenLoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str

class ForgotPasswordIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=254)

class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=10, max_length=128)

def _cookie(response: Response, token: str) -> None:
    response.set_cookie(settings.auth_cookie_name, token, httponly=True, secure=settings.is_production, samesite="lax", max_age=settings.auth_token_ttl_seconds, path="/")

@router.post("/register")
async def register(body: RegisterIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    existing = await repo.get_restaurant_by_slug(db, body.restaurant)
    if existing:
        raise HTTPException(status_code=409, detail="Restaurant slug is already in use.")
    rid = await repo.get_or_create_restaurant(db, body.restaurant, body.name)
    try:
        row = (await db.execute(text("INSERT INTO users (email,password_hash,tenant_id,outlet_id,name,username,role,status) VALUES (:email,:hash,:tid,:oid,:name,'admin','admin','ACTIVE') RETURNING id"), {
            "email": body.email.lower(), "hash": hash_password(body.password), "tid": rid, "oid": rid, "name": body.name
        })).first()
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Email is already registered.") from exc
    token = issue_token(user_id=row[0], tenant_id=rid, outlet_id=rid, role="admin", subscription_status="TRIAL", restaurant_slug=body.restaurant)
    _cookie(response, token)
    await audit(db, "USER_CREATED", user_id=row[0], tenant_id=rid, request=request)
    await audit(db, "LOGIN", user_id=row[0], tenant_id=rid, request=request)
    return {"ok": True, "role": "admin", "subscriptionStatus": "TRIAL"}

@router.get("/check-slug")
async def check_slug(slug: str, db: AsyncSession = Depends(get_db)):
    """Availability check for merchant setup; the unique DB index remains authoritative."""
    normalized = slug.strip().lower()
    available = bool(normalized) and await repo.get_restaurant_by_slug(db, normalized) is None
    return {"slug": normalized, "available": available}

@router.get("/login", include_in_schema=False)
async def login_page_alias():
    return RedirectResponse(url="/login.html")

@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(text("SELECT id,email,password_hash,tenant_id,outlet_id,role,active,status FROM users WHERE lower(email)=:identifier OR lower(username)=:identifier"), {"identifier": body.email.strip().lower()})).mappings().first()
    if not row or not row["active"] or row.get("status", "ACTIVE") != "ACTIVE" or not verify_password(body.password, row["password_hash"]):
        await audit(db, "FAILED_LOGIN", request=request, detail={"email": body.email.lower()})
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    if row["role"] != "admin":
        await audit(db, "FAILED_LOGIN", request=request, detail={"email": body.email.lower(), "reason": "wrong_portal"})
        raise HTTPException(status_code=403, detail="Use the Manager Portal or Kitchen Portal login.")
    await db.execute(text("UPDATE users SET last_login = now() WHERE id = :id"), {"id": row["id"]})
    tenant = await repo.get_restaurant_by_id(db, row["outlet_id"])
    subscription = (tenant or {}).get("subscription_status", "TRIAL")
    token = issue_token(user_id=row["id"], tenant_id=row["tenant_id"], outlet_id=row["outlet_id"], role=row["role"], subscription_status=subscription, restaurant_slug=(tenant or {}).get("slug", ""))
    _cookie(response, token)
    await audit(db, "LOGIN", user_id=row["id"], tenant_id=row["tenant_id"], request=request)
    return {"ok": True, "role": row["role"], "subscriptionStatus": subscription, "redirect": "/admin.html?r=" + (tenant or {}).get("slug", "")}

@router.post("/forgot-password", status_code=202)
async def forgot_password(body: ForgotPasswordIn, request: Request, db: AsyncSession = Depends(get_db)):
    """Start a reset without revealing whether an account exists.

    Development returns the one-time token so local deployments can test the
    flow without an email provider. Production must connect this endpoint to
    an email delivery service before exposing reset links to users.
    """
    identifier = body.identifier.strip().lower()
    row = (await db.execute(text("""SELECT id,tenant_id FROM users
        WHERE lower(email)=:identifier OR lower(username)=:identifier"""), {"identifier": identifier})).mappings().first()
    response = {"ok": True, "message": "If the account exists, reset instructions have been sent."}
    if row:
        raw, token_hash = create_reset_token()
        await db.execute(text("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=:uid AND used_at IS NULL"), {"uid": row["id"]})
        await db.execute(text("""INSERT INTO password_reset_tokens (user_id,token_hash,expires_at)
            VALUES (:uid,:hash,now() + interval '15 minutes')"""), {"uid": row["id"], "hash": token_hash})
        await audit(db, "PASSWORD_RESET_REQUEST", user_id=row["id"], tenant_id=row["tenant_id"], request=request)
        if not settings.is_production:
            response["reset_token"] = raw
            response["reset_url"] = "/reset-password?token=" + raw
    else:
        await audit(db, "PASSWORD_RESET_REQUEST", request=request, detail={"unknown_identifier": True})
    return response

@router.post("/reset-password")
async def reset_password(body: ResetPasswordIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    row = (await db.execute(text("""SELECT pr.id,pr.user_id,u.tenant_id FROM password_reset_tokens pr
        JOIN users u ON u.id=pr.user_id
        WHERE pr.token_hash=:hash AND pr.used_at IS NULL AND pr.expires_at > now()"""), {"hash": token_hash})).mappings().first()
    if not row:
        raise HTTPException(status_code=400, detail="Reset link is invalid or expired.")
    await db.execute(text("UPDATE users SET password_hash=:password WHERE id=:id"), {"password": hash_password(body.password), "id": row["user_id"]})
    await db.execute(text("UPDATE password_reset_tokens SET used_at=now() WHERE id=:id"), {"id": row["id"]})
    await audit(db, "PASSWORD_RESET", user_id=row["user_id"], tenant_id=row["tenant_id"], request=request)
    response.delete_cookie(settings.auth_cookie_name, path="/")
    return {"ok": True, "message": "Password reset successfully. Please sign in."}

async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = token_from_request(request)
    if token:
        try:
            payload = decode_token(token)
            await audit(db, "LOGOUT", user_id=payload.get("userId"), tenant_id=payload.get("tenantId"), request=request)
        except HTTPException:
            pass
    response.delete_cookie(settings.auth_cookie_name, path="/")
    return {"ok": True}

@router.get("/me")
async def me(request: Request, db: AsyncSession = Depends(get_db)):
    token = token_from_request(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")
    payload = decode_token(token)
    # The slug is embedded in the JWT at issue time — no DB needed in the
    # common case.  Only fall back to a DB lookup for old tokens that were
    # issued before the restaurantSlug claim was added.
    slug = payload.get("restaurantSlug") or payload.get("outletSlug")
    if not slug:
        outlet = await repo.get_restaurant_by_id(db, payload.get("outletId"))
        slug = (outlet or {}).get("slug")
    payload["outletSlug"] = slug
    return payload

@router.get("/realtime-token")
async def realtime_token(principal: dict = Depends(require_staff)):
    if not settings.resolved_supabase_url or not settings.supabase_anon_key or not settings.supabase_jwt_secret:
        raise HTTPException(status_code=404, detail="Supabase Realtime is not configured.")
    return {
        "url": settings.resolved_supabase_url,
        "anonKey": settings.supabase_anon_key,
        "accessToken": issue_realtime_token(
            user_id=principal["userId"], tenant_id=principal["tenantId"],
            outlet_id=principal["outletId"], role=principal["role"]
        ),
        "outletId": principal["outletId"],
    }

@router.post("/kitchen-login")
async def kitchen_login(body: KitchenLoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(text("""SELECT id,tenant_id,outlet_id,role,password_hash,status,active
        FROM users WHERE lower(username)=:identifier OR lower(email)=:identifier"""), {"identifier": body.username.strip().lower()})).mappings().first()
    if not row or row["role"] != "kitchen" or row.get("status", "ACTIVE") != "ACTIVE" or not row["active"] or not verify_password(body.password, row["password_hash"]):
        await audit(db, "FAILED_LOGIN", request=request, detail={"username": body.username.strip()})
        raise HTTPException(status_code=401, detail="Invalid kitchen username or password.")
    await db.execute(text("UPDATE users SET last_login=now() WHERE id=:id"), {"id": row["id"]})
    tenant = await repo.get_restaurant_by_id(db, row["outlet_id"])
    subscription = (tenant or {}).get("subscription_status", "TRIAL")
    token = issue_token(user_id=row["id"], tenant_id=row["tenant_id"], outlet_id=row["outlet_id"], role="kitchen", subscription_status=subscription, restaurant_slug=(tenant or {}).get("slug", ""))
    _cookie(response, token)
    await audit(db, "LOGIN", user_id=row["id"], tenant_id=row["tenant_id"], request=request)
    return {"ok": True, "role": "kitchen", "redirect": "/kitchen.html?r=" + (tenant or {}).get("slug", "")}

@router.post("/manager-login")
async def manager_login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(text("""SELECT id,tenant_id,outlet_id,role,password_hash,status,active
        FROM users WHERE lower(email)=:email"""), {"email": body.email.lower()})).mappings().first()
    if not row or row["role"] != "manager" or row.get("status", "ACTIVE") != "ACTIVE" or not row["active"] or not verify_password(body.password, row["password_hash"]):
        await audit(db, "FAILED_LOGIN", request=request, detail={"email": body.email.lower(), "portal": "manager"})
        raise HTTPException(status_code=401, detail="Invalid manager email or password.")
    await db.execute(text("UPDATE users SET last_login=now() WHERE id=:id"), {"id": row["id"]})
    tenant = await repo.get_restaurant_by_id(db, row["outlet_id"])
    subscription = (tenant or {}).get("subscription_status", "TRIAL")
    token = issue_token(user_id=row["id"], tenant_id=row["tenant_id"], outlet_id=row["outlet_id"], role="manager", subscription_status=subscription, restaurant_slug=(tenant or {}).get("slug", ""))
    _cookie(response, token)
    await audit(db, "LOGIN", user_id=row["id"], tenant_id=row["tenant_id"], request=request, detail={"portal": "manager"})
    return {"ok": True, "role": "manager", "redirect": "/manager.html?r=" + (tenant or {}).get("slug", "")}
