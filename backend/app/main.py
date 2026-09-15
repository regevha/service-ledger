from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import seed_instruments, seed_templates
from app.db import SessionLocal
from app.routers import attachments, instruments, report_templates, reports


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
    title="Calibration Ledger API",
    description="Implements the API surface in CL-ARCH-001 §9 — see the architecture spec for the full design rationale.",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(instruments.router)
app.include_router(report_templates.router)
app.include_router(reports.router)
app.include_router(attachments.router)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}
