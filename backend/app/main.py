from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import schemas, seed_instruments, seed_templates
from app.config import get_settings
from app.db import SessionLocal
from app.routers import analytics, attachments, instruments, report_templates, reports


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Convenience for a fresh dev database: seed the fixed instrument fleet
    # (§1) and the six report_templates rows (§5) if they're not there yet.
    # Idempotent — safe to run on every startup.
    with SessionLocal() as db:
        seed_instruments.seed(db)
        seed_templates.seed(db)
    yield


app = FastAPI(
    title="ServiceLedger API",
    description="Implements the API surface in SL-ARCH-001 §9 — see the architecture spec for the full design rationale.",
    version="0.1.0",
    lifespan=lifespan,
)

# Single-user dev/eval scope (§1) — the frontend build is a standalone static
# HTML file that may be opened from file:// or served from a different port,
# so it needs a permissive dev CORS policy to reach this API at all. Tighten
# this to a real allowlist before this system has more than one evaluator (§1).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
