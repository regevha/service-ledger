"""Serve the built frontend (frontend/dist) from the API, so a deployment is one
address: the page and the API share an origin, which also makes the browser's
password prompt cover both. Mounted last, so every API route wins over a file of
the same name."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles


def mount_frontend(app: FastAPI, dist_dir: str) -> None:
    path = Path(dist_dir)
    if not (path / "index.html").is_file():
        raise RuntimeError(
            f"FRONTEND_DIST_DIR is set to {dist_dir!r} but there is no index.html there. "
            "Run `npm run build` in frontend/ and copy dist/ to that folder."
        )
    app.mount("/", StaticFiles(directory=path, html=True), name="frontend")
