from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import auth, models, schemas, seed_instruments, seed_templates
from app.config import get_settings
from app.db import SessionLocal
from app.routers import analytics, attachments, auth as auth_router, instruments, report_templates, reports, users


def _seed_initial_admin(db) -> None:
    """An empty users table would lock everyone out of a login-required app,
    so create the admin named in INITIAL_ADMIN_USERNAME/PASSWORD, once."""
    settings = get_settings()
    if not (settings.initial_admin_username and settings.initial_admin_password):
        return
    if db.query(models.User).first() is not None:
        return
    from app.create_user import upsert_user

    upsert_user(db, settings.initial_admin_username, settings.initial_admin_password, models.UserRole.admin)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Convenience for a fresh dev database: seed the fixed instrument fleet
    # (§1) and the six report_templates rows (§5) if they're not there yet.
    # Idempotent — safe to run on every startup.
    with SessionLocal() as db:
        seed_instruments.seed(db)
        seed_templates.seed(db)
        _seed_initial_admin(db)
    yield


app = FastAPI(
    title="ServiceLedger API",
    description="Implements the API surface in SL-ARCH-001 §9 — see the architecture spec for the full design rationale.",
    version="0.1.0",
    lifespan=lifespan,
    # Every request is checked against auth.required_role.
    dependencies=[Depends(auth.enforce_policy)],
)

# The browser app calls this API from another port with the session cookie,
# which needs explicit origins (never "*") and allow_credentials. Any
# localhost / 127.0.0.1 port is allowed for development; add real hosts with
# CORS_ALLOWED_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_allowed_origins.split(",") if o.strip()],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(users.router)
app.include_router(instruments.router)
app.include_router(report_templates.router)
app.include_router(reports.router)
app.include_router(attachments.router)
app.include_router(analytics.router)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}


@app.get("/config", response_model=schemas.AppConfigOut, tags=["meta"])
def get_app_config():
    """§4/§12: the two confidence thresholds, so the frontend can read the
    real backend-configured values instead of hardcoding its own copy (see
    schemas.AppConfigOut) — App.tsx used to duplicate these as its own
    literals, silently drifting from a backend .env change."""
    settings = get_settings()
    return schemas.AppConfigOut(
        field_confidence_threshold=settings.field_confidence_threshold,
        classification_confidence_threshold=settings.classification_confidence_threshold,
        live_claude=settings.use_live_claude,
    )
