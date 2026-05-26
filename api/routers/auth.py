from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

import config
from api.auth_service import (
    auth_required,
    create_session_token,
    validate_session_token,
    verify_admin_login,
)
from api.security import enforce_rate_limit


router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=80)
    password: str = Field(..., min_length=1, max_length=512)


def _session_cookie_args() -> dict:
    return {
        "key": config.SESSION_COOKIE_NAME,
        "httponly": True,
        "secure": config.is_production(),
        "samesite": "lax",
        "path": "/",
    }


@router.get("/session")
def get_session(request: Request):
    session = validate_session_token(request.cookies.get(config.SESSION_COOKIE_NAME))
    return {
        "authenticated": bool(session),
        "auth_required": auth_required(),
        "username": session.get("sub") if session else None,
        "expires_at": session.get("exp") if session else None,
    }


@router.post("/login")
def login(request: Request, response: Response, body: LoginRequest):
    enforce_rate_limit(request, bucket="auth-login", limit=8, window_sec=300)
    if not auth_required():
        raise HTTPException(status_code=400, detail="Authentication is not enabled.")
    if not verify_admin_login(body.username, body.password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_session_token(config.ADMIN_USERNAME)
    response.set_cookie(
        value=token,
        max_age=config.SESSION_TTL_SECONDS,
        **_session_cookie_args(),
    )
    return {
        "authenticated": True,
        "username": body.username,
        "expires_in": config.SESSION_TTL_SECONDS,
    }


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(**_session_cookie_args())
    return {"authenticated": False}
