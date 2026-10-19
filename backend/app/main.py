import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import schemas, seed_instruments, seed_templates
from app.config import get_settings
from app.db import SessionLocal
from app.services.instrument_types import ensure_default_types
from app.routers import (
    analytics,
    attachments,
    instrument_types,
    instruments,
    report_templates,
    reports,
    saved_filters,
    field_aliases,
    translations,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Convenience for a fresh dev database: seed the fixed instrument fleet
    # (§1) and the six report_templates rows (§5) if they're not there yet.
    # Idempotent — safe to run on every startup.
    with SessionLocal() as db:
        ensure_default_types(db)
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
CORS_ORIGINS = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("app.main")


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """An exception no route handled used to reach the browser as a bare 500
    with no CORS headers (Starlette's error middleware sits outside the CORS
    middleware), which the browser reports as a network failure, and the screen
    said "Could not reach the backend" for what was a server bug. This answers
    with a JSON message the screen can show, and the CORS header the browser
    needs to let the page read it. The traceback is still logged by Starlette,
    which re-raises after this handler."""
    logger.error("Unhandled error on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin")
    headers = {}
    if "*" in CORS_ORIGINS:
        headers["Access-Control-Allow-Origin"] = "*"
    elif origin in CORS_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong on the server. See the server log for the cause."},
        headers=headers,
    )


app.include_router(instrument_types.router)
app.include_router(instruments.router)
app.include_router(report_templates.router)
app.include_router(reports.router)
app.include_router(saved_filters.router)
app.include_router(field_aliases.router)
app.include_router(attachments.router)
app.include_router(translations.router)
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
