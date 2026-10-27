import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import schemas, seed_instruments, seed_templates
from app.config import get_settings
from app.db import SessionLocal
from app.debug_claude_log import announce_debug_log
from app.frontend_static import mount_frontend
from app.request_trace import RequestTraceMiddleware
from app.shared_password import SharedPasswordMiddleware
from app.trace import configure_logging
from app.services.instrument_types import ensure_default_types
from app.services.places import PlaceTextError
from app.routers import (
    analytics,
    attachments,
    instrument_models,
    places,
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
    announce_debug_log()
    with SessionLocal() as db:
        ensure_default_types(db)
        seed_instruments.seed(db)
        seed_templates.seed(db)
    yield


configure_logging("api")

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

# Added after CORS, so it is the outermost layer: nothing, not even a preflight
# or an error page, is answered before the password check (except /health).
app.add_middleware(SharedPasswordMiddleware)
# Outermost of all: every request gets an id and a log line, including a refused one.
app.add_middleware(RequestTraceMiddleware)

logger = logging.getLogger("app.main")


@app.exception_handler(PlaceTextError)
async def place_text_error(request: Request, exc: PlaceTextError) -> JSONResponse:
    """An institution and room that cannot name one place (see services/places.py):
    the edit is refused, with the reason in plain words."""
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """An exception no route handled used to reach the browser as a bare 500
    with no CORS headers (Starlette's error middleware sits outside the CORS
    middleware), which the browser reports as a network failure, and the screen
    said "Could not reach the backend" for what was a server bug. This answers
    with a JSON message the screen can show, and the CORS header the browser
    needs to let the page read it. The traceback is still logged by Starlette,
    which re-raises after this handler."""
    request_id = request.scope.get("request_id", "-")
    logger.error("Unhandled error on %s %s (request %s)", request.method, request.url.path, request_id)
    origin = request.headers.get("origin")
    headers = {"X-Request-ID": request_id}
    if "*" in CORS_ORIGINS:
        headers["Access-Control-Allow-Origin"] = "*"
    elif origin in CORS_ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=500,
        content={"detail": f"Something went wrong on the server. See the server log for the cause (reference {request_id})."},
        headers=headers,
    )


app.include_router(instrument_types.router)
app.include_router(instrument_models.router)
app.include_router(places.router)
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


# Last, so the API routes above take precedence over files of the same name.
if get_settings().frontend_dist_dir:
    mount_frontend(app, get_settings().frontend_dist_dir)
