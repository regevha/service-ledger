"""Wake an on-demand worker when a job is queued.

With the always-on worker (WORKER_TRIGGER=none, the default) nothing is needed: it polls
the job table. With the on-demand worker (`python -m app.worker --once`) something has to
start a run each time a job goes to `pending`; the routers call `notify_job_queued()` right
after they commit one.

Rules this module keeps:
- It never raises into a request. A failed trigger is logged and the job stays pending; the
  fallback scheduled run (see deploy/azure/README.md) picks it up.
- It never blocks a request: the call runs on a small background thread.
- Calls closer together than `worker_trigger_min_interval_seconds` are merged. That is safe
  because a run stays alive for at least `worker_idle_exit_seconds` after its last job, and
  a run that is just exiting is covered by the run lock in app/worker.py.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from app.config import get_settings

logger = logging.getLogger("app.worker")

_ARM = "https://management.azure.com"
_ARM_API_VERSION = "2024-03-01"

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="job-trigger")
_lock = threading.Lock()
_last_fired: float | None = None
_children: list[subprocess.Popen] = []


def notify_job_queued() -> None:
    """Start a worker run if the deployment uses on-demand runs. Call after the commit."""
    global _last_fired
    settings = get_settings()
    if settings.worker_trigger == "none":
        return
    with _lock:
        now = time.monotonic()
        if _last_fired is not None and now - _last_fired < settings.worker_trigger_min_interval_seconds:
            return
        _last_fired = now
    try:
        _executor.submit(_fire, settings.worker_trigger)
    except Exception:  # noqa: BLE001 - e.g. the executor is shut down; never fail the request
        logger.exception("Could not schedule the worker trigger.")


def _fire(mode: str) -> None:
    try:
        if mode == "local":
            _start_local_run()
        elif mode == "azure_job":
            _start_azure_job()
    except Exception:  # noqa: BLE001
        logger.exception(
            "Could not start a worker run (WORKER_TRIGGER=%s). The job stays pending until the "
            "next scheduled run.",
            mode,
        )


def _start_local_run() -> None:
    _children[:] = [c for c in _children if c.poll() is None]  # reap finished runs
    backend_dir = Path(__file__).resolve().parents[1]
    child = subprocess.Popen(  # noqa: S603 - fixed command, no user input
        [sys.executable, "-m", "app.worker", "--once"],
        cwd=backend_dir,
        env=os.environ.copy(),
    )
    _children.append(child)
    logger.info("Started a local worker run (pid %s).", child.pid)


def _managed_identity_token(resource: str) -> str:
    """A token for this Container App's managed identity (the platform sets both variables)."""
    endpoint = os.environ.get("IDENTITY_ENDPOINT")
    header = os.environ.get("IDENTITY_HEADER")
    if not endpoint or not header:
        raise RuntimeError(
            "IDENTITY_ENDPOINT / IDENTITY_HEADER are not set: the app has no managed identity enabled."
        )
    response = httpx.get(
        endpoint,
        params={"resource": resource, "api-version": "2019-08-01"},
        headers={"X-IDENTITY-HEADER": header},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def _start_azure_job() -> None:
    job_id = get_settings().azure_worker_job_id.strip().rstrip("/")
    if not job_id.startswith("/subscriptions/"):
        raise RuntimeError("AZURE_WORKER_JOB_ID must be the job's full resource id (/subscriptions/...).")
    token = _managed_identity_token(_ARM + "/")
    response = httpx.post(
        f"{_ARM}{job_id}/start",
        params={"api-version": _ARM_API_VERSION},
        headers={"Authorization": f"Bearer {token}"},
        content=b"",
        timeout=15,
    )
    response.raise_for_status()
    logger.info("Started the Azure worker job (HTTP %s).", response.status_code)
