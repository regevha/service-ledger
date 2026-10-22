"""Troubleshooting trace: one log format for the API and the worker, and ids that
tie the lines of one piece of work together.

Three ids appear in every log line when they are known:
  req  the request id (also sent back to the caller in the X-Request-ID header,
       and shown in the message of a 500 so a tester can quote it)
  job  the extraction job being worked (set by the worker for the whole job,
       so the Claude call line and any warning inside it carry it)
  The enqueueing request logs "Queued ... job <id>", which is how a request is
  followed to the worker's lines for that job.

Plain text, one line per event, to the console: Azure Container Apps collects the
console into Log Analytics, where the ids can be searched. Nothing here records
document text, extracted values or query strings.
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import os
import sys
import time
import uuid
from typing import Iterator

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")
job_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("job_id", default="-")
report_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("report_id", default="-")
attachment_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("attachment_id", default="-")

_HANDLER_MARK = "_service_ledger_trace_handler"
FORMAT = "%(asctime)sZ %(levelname)s %(role)s [req=%(request_id)s job=%(job_id)s] %(name)s: %(message)s"


def utc_formatter() -> logging.Formatter:
    """Times are UTC (marked with a trailing Z), like the debug log, whatever the
    machine's time zone is."""
    formatter = logging.Formatter(FORMAT)
    formatter.converter = time.gmtime
    return formatter


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


class _ContextFilter(logging.Filter):
    def __init__(self, role: str) -> None:
        super().__init__()
        self.role = role

    def filter(self, record: logging.LogRecord) -> bool:
        record.role = self.role
        record.request_id = request_id_var.get()
        record.job_id = job_id_var.get()
        return True


def configure_logging(role: str) -> None:
    """Give the process one console handler with the trace format. `role` is
    "api" or "worker". Safe to call twice (it never adds a second handler). The
    level comes from LOG_LEVEL (default INFO)."""
    root = logging.getLogger()
    level = getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO)
    root.setLevel(level)
    for handler in root.handlers:
        if getattr(handler, _HANDLER_MARK, False):
            handler.filters = [f for f in handler.filters if not isinstance(f, _ContextFilter)]
            handler.addFilter(_ContextFilter(role))
            return
    handler = logging.StreamHandler(sys.stderr)
    setattr(handler, _HANDLER_MARK, True)
    handler.setFormatter(utc_formatter())
    handler.addFilter(_ContextFilter(role))
    root.addHandler(handler)


@contextlib.contextmanager
def bound_job(job_id: object, report_id: object = None, attachment_id: object = None) -> Iterator[None]:
    """For the length of one job, every log line (and debug-log record) carries
    the job, report and attachment ids."""
    tokens = [
        (job_id_var, job_id_var.set(str(job_id))),
        (report_id_var, report_id_var.set(str(report_id) if report_id else "-")),
        (attachment_id_var, attachment_id_var.set(str(attachment_id) if attachment_id else "-")),
    ]
    try:
        yield
    finally:
        for var, token in reversed(tokens):
            var.reset(token)
