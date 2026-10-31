from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.routes.deps import get_db, require_staff, tenant_matches
from app.services.auth import audit, hash_password

router = APIRouter(prefix="/staff", tags=["staff"])

class StaffCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=3, max_length=254, pattern=r"^[A-Za-z0-9_.@+-]+$")
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=128)
    role: str = Field(default="kitchen", pattern="^(manager|kitchen)$")

class PasswordChange(BaseModel):
    password: str = Field(min_length=10, max_length=128)

class StatusChange(BaseModel):
    status: str = Field(pattern="^(ACTIVE|DISABLED)$")

async def _target(db: AsyncSession, user_id: int, principal: Dict[str, Any]):
    row = (await db.execute(text("SELECT id,tenant_id,outlet_id,name,username,email,role,status,created_at,last_login FROM users WHERE id=:id"), {"id": user_id})).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found.")
    if not tenant_matches(principal, row["outlet_id"]):
        raise HTTPException(status_code=403, detail="User is outside your tenant.")
    return row

@router.get("")
async def list_staff(db: AsyncSession = Depends(get_db), principal: Dict[str, Any] = Depends(require_staff)):
    rows = (await db.execute(text("""SELECT id,name,username,email,role,status,created_at,last_login
        FROM users WHERE tenant_id=:tid AND outlet_id=:oid ORDER BY created_at"""), {"tid": principal["tenantId"], "oid": principal["outletId"]})).mappings().all()
    return {"users": [dict(row) for row in rows]}

@router.post("")
async def create_staff(body: StaffCreate, db: AsyncSession = Depends(get_db), principal: Dict[str, Any] = Depends(require_staff)):
    email = body.email.strip().lower()
    try:
        row = (await db.execute(text("""INSERT INTO users
            (tenant_id,outlet_id,name,username,email,password_hash,role,status)
            VALUES (:tid,:oid,:name,:username,:email,:hash,:role,'ACTIVE') RETURNING id"""), {
                "tid": principal["tenantId"], "oid": principal["outletId"], "name": body.name.strip(),
                "username": body.username.strip(), "email": email, "hash": hash_password(body.password), "role": body.role.lower()
            })).first()
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Username or email is already in use.") from exc
    await audit(db, "USER_CREATED", user_id=row[0], tenant_id=principal["tenantId"], detail={"role": body.role.lower()})
    return {"id": row[0], "name": body.name.strip(), "username": body.username.strip(), "role": body.role.lower(), "status": "ACTIVE"}

@router.post("/{user_id}/reset-password")
async def reset_password(user_id: int, body: PasswordChange, db: AsyncSession = Depends(get_db), principal: Dict[str, Any] = Depends(require_staff)):
    target = await _target(db, user_id, principal)
    if target["role"] == "admin":
        raise HTTPException(status_code=403, detail="Administrator passwords cannot be reset here.")
    await db.execute(text("UPDATE users SET password_hash=:hash WHERE id=:id"), {"hash": hash_password(body.password), "id": user_id})
    await audit(db, "PASSWORD_RESET", user_id=user_id, tenant_id=principal["tenantId"])
    return {"ok": True}

@router.patch("/{user_id}/status")
async def change_status(user_id: int, body: StatusChange, db: AsyncSession = Depends(get_db), principal: Dict[str, Any] = Depends(require_staff)):
    target = await _target(db, user_id, principal)
    if target["role"] == "admin":
        raise HTTPException(status_code=403, detail="Administrator status cannot be changed here.")
    await db.execute(text("UPDATE users SET status=:status, active=:active WHERE id=:id"), {"status": body.status, "active": body.status == "ACTIVE", "id": user_id})
    await audit(db, "USER_ENABLED" if body.status == "ACTIVE" else "USER_DISABLED", user_id=user_id, tenant_id=principal["tenantId"])
    return {"id": user_id, "status": body.status}

@router.patch("/{user_id}/password")
async def change_password(user_id: int, body: PasswordChange, db: AsyncSession = Depends(get_db), principal: Dict[str, Any] = Depends(require_staff)):
    await _target(db, user_id, principal)
    await db.execute(text("UPDATE users SET password_hash=:hash WHERE id=:id"), {"hash": hash_password(body.password), "id": user_id})
    await audit(db, "PASSWORD_CHANGED", user_id=user_id, tenant_id=principal["tenantId"])
    return {"ok": True}
