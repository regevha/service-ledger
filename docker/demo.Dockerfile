# The whole app in one image, for `docker compose up` (see docker-compose.yml).
#
# backend/Dockerfile is the deployment image and expects the frontend to be
# built on the host first (frontend/dist). This one builds the frontend itself,
# so a new visitor needs nothing installed but Docker. The result is the same:
# the API (default command), the worker (python -m app.worker) and the built
# page, served by the API on one address.
#
# Build from the repository root (the context). Docker reads
# docker/demo.Dockerfile.dockerignore for this file, not the root .dockerignore,
# which leaves the frontend sources out.
#   docker build -f docker/demo.Dockerfile -t service-ledger .

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# An empty API address: the page calls the API at the address it was loaded from.
RUN VITE_API_BASE_URL= npm run build

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

COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY --from=web /web/dist ./web

RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /data/attachments \
 && chown -R app /data /app
USER app

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
