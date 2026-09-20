"""Exports the FastAPI app's OpenAPI schema to stdout as JSON.

This is the fix for a hardcoding finding: frontend/src/api.ts used to hand-
type InstrumentStatus, ReportType, ReportStatus, ExtractionJobStatus, and
ExtractionJobKind as string-literal unions that duplicated app/models.py's
real enum classes, with nothing keeping the two in sync but discipline —
despite SL-ARCH-001 §3 explicitly citing OpenAPI codegen as the reason this
project is split into a separate frontend/backend in the first place
("FastAPI's automatic OpenAPI schema also gives the React client typed
request/response shapes for free via codegen"). That promise was never
actually wired up until now.

frontend/package.json's `npm run codegen` script pipes this script's output
into openapi-typescript, which turns FastAPI's generated schema components
(one per Enum class referenced by a Pydantic response model, e.g.
components.schemas.ReportType) into real TypeScript union types — see
frontend/src/generated/api-schema.ts (generated, but committed so the
frontend build doesn't require Python/a backend checkout) and how
frontend/src/api.ts derives its exported enum types from it.

Doesn't need a running server or a live database: FastAPI computes its
OpenAPI schema from the already-imported app object (its routes and their
declared response_model= Pydantic classes), so this just imports app.main
and serializes app.openapi(). Run it from backend/ with its own venv active:

    python -m scripts.export_openapi > ../frontend/openapi.json

though in practice you'll just run `npm run codegen` from frontend/, which
does that (plus the openapi-typescript step) in one line — see the
"Regenerating frontend API types" section of this repo's README.
"""
import json

from app.main import app

if __name__ == "__main__":
    print(json.dumps(app.openapi(), indent=2))
