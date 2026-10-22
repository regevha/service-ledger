# Backend image for ServiceLedger: one image, two commands.
#   API:     the default command (uvicorn app.main:app on port 8000)
#   Worker:  python -m app.worker
#   Migrate: alembic upgrade head   (run once against a new or old database)
# The image also carries the built frontend (frontend/dist, from `npm run build`
# with VITE_API_BASE_URL set to an empty string) and the API serves it, so the
# page and the API share one address and one password prompt.
# Everything is configured by environment variables (DATABASE_URL,
# ATTACHMENT_STORAGE_DIR, SHARED_PASSWORD, USE_LIVE_CLAUDE, ANTHROPIC_API_KEY,
# ...); none is baked in. Build from the repository root:
#   (cd frontend && VITE_API_BASE_URL= npm run build)
#   docker build -f backend/Dockerfile -t service-ledger .
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ATTACHMENT_STORAGE_DIR=/data/attachments \
    FRONTEND_DIST_DIR=/app/web

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY backend/requirements.txt .
RUN python -m pip install -r requirements.txt

# alembic.ini and alembic/ must sit in the working directory: the migration
# command is run from here.
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY frontend/dist ./web

# Run as a normal user, with a place for uploaded files that it owns. In
# deployment the attachments folder is a mounted share at /data.
RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /data/attachments \
 && chown -R app /data /app
USER app

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
