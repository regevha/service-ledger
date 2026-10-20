# Backend image for ServiceLedger: one image, two commands.
#   API:     the default command (uvicorn app.main:app on port 8000)
#   Worker:  python -m app.worker
#   Migrate: alembic upgrade head   (run once against a new or old database)
# Everything is configured by environment variables (DATABASE_URL,
# ATTACHMENT_STORAGE_DIR, USE_LIVE_CLAUDE, ANTHROPIC_API_KEY, ...); none is
# baked in. Build from the backend/ folder:  docker build -t service-ledger backend
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ATTACHMENT_STORAGE_DIR=/data/attachments

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY requirements.txt .
RUN python -m pip install -r requirements.txt

# alembic.ini and alembic/ must sit in the working directory: the migration
# command is run from here.
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

# Run as a normal user, with a place for uploaded files that it owns. In
# deployment the attachments folder is a mounted share at /data.
RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /data/attachments \
 && chown -R app /data /app
USER app

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
