"""An accuracy baseline from reports that are already finalized (SL-69).

Reports finalized before the first reading was kept (`reports.original_fields`) cannot be measured by the
accuracy page. This script reads the stored document of such a report again with the current extraction and
compares the result with the values that were approved, using the same "kept as read" rule and the same
confidence bands as the page. It is an estimate: a model can answer a little differently on a second read.

    python -m scripts.reread_baseline                    # counts only, no Claude call
    python -m scripts.reread_baseline --run --limit 20   # re-read the 20 newest (at most 60 per run)
    python -m scripts.reread_baseline --run --save       # also store each re-read as the report's first reading

Run it from backend/ on your own machine, against your own database. A live run needs USE_LIVE_CLAUDE=true and
your own key in the environment (never written to a file). In stub mode the numbers are not real.
Writes nothing to the database unless --save is given (live runs only: a stub reading is invented and must never
be stored). --save fills `original_fields` of a report that has none, never replaces one, and adds an extract job
row marked `params.baseline = "reread"`, so the accuracy page shows the report and says it comes from a re-read.
The output has counts and field names only: no value, report name,
technician, file name or path (the app's own log lines are switched off for the run, since they print file names).
"""
from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.db import SessionLocal
from app.services.extraction import extract, prompt_fingerprint
from app.services.read_accuracy import BANDS, _band
from app.services.read_compare import blank as _blank
from app.services.read_compare import same_value

MAX_PER_RUN = 60
DEFAULT_LIMIT = 20


def unmeasured_reports(db: Session) -> list[models.Report]:
    """Finalized reports with no first reading, newest first."""
    return list(
        db.scalars(
            select(models.Report)
            .where(models.Report.status == models.ReportStatus.finalized, models.Report.original_fields.is_(None))
            .order_by(models.Report.finalized_at.desc())
        )
    )


def _attachment_to_read(db: Session, report: models.Report) -> models.Attachment | None:
    """The attachment of the report's latest succeeded extract job, else its first attachment."""
    job = db.scalars(
        select(models.ExtractionJob)
        .join(models.Attachment, models.ExtractionJob.attachment_id == models.Attachment.id)
        .where(
            models.Attachment.report_id == report.id,
            models.ExtractionJob.kind == models.ExtractionJobKind.extract,
            models.ExtractionJob.status == models.ExtractionJobStatus.succeeded,
        )
        .order_by(models.ExtractionJob.completed_at.desc())
    ).first()
    if job is not None:
        return db.get(models.Attachment, job.attachment_id)
    return db.scalars(select(models.Attachment).where(models.Attachment.report_id == report.id).order_by(models.Attachment.created_at)).first()


Row = list[tuple[str, bool, float | None]]


class Reading(NamedTuple):
    rows: Row
    values: dict
    confidences: dict
    attachment_id: object


def _error_kind(error: BaseException) -> str:
    """Class names only (the app's error and the library error behind it): safe to print, a message may hold a path."""
    cause = error.__cause__ or error.__context__
    return type(error).__name__ + (f" <- {type(cause).__name__}" if cause is not None else "")


def reread(db: Session, report: models.Report) -> Reading | str:
    """(field name, same as approved, confidence) for every field the new reading filled in; a short reason
    when the report cannot be read again."""
    template = db.get(models.ReportTemplate, report.template_id) if report.template_id else None
    attachment = _attachment_to_read(db, report)
    if template is None:
        return "no template"
    if attachment is None:
        return "no document"
    try:
        result = extract(attachment, template)
    except Exception as error:  # noqa: BLE001 - one unreadable report must not stop the run; its message may hold a path
        return _error_kind(error)
    kept = report.extracted_fields or {}
    rows = [
        (name, same_value(name, value, kept.get(name)), _confidence(result.field_confidences.get(name)))
        for name, value in result.extracted_fields.items()
        if not _blank(value)
    ]
    return Reading(rows, dict(result.extracted_fields), dict(result.field_confidences), attachment.id)


def save_reading(db: Session, report: models.Report, reading: Reading) -> bool:
    """Store a re-read as the report's first reading (one transaction). False when the report already has one."""
    db.refresh(report, with_for_update=True)
    if report.original_fields is not None:
        db.rollback()
        return False
    template = db.get(models.ReportTemplate, report.template_id)
    now = datetime.now(timezone.utc)
    report.original_fields = reading.values
    db.add(
        models.ExtractionJob(
            attachment_id=reading.attachment_id,
            kind=models.ExtractionJobKind.extract,
            status=models.ExtractionJobStatus.succeeded,
            field_confidences=reading.confidences,
            params={"baseline": "reread", **(prompt_fingerprint(template) if template is not None else {})},
            started_at=now,
            completed_at=now,
        )
    )
    db.commit()
    return True


def _confidence(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def summarize(rows: list[Row | str]) -> str:
    """The text a run prints, built from counts, field names and error class names only."""
    done = [r for r in rows if not isinstance(r, str)]
    skipped = Counter(r for r in rows if isinstance(r, str))
    fields = [f for r in done for f in r]
    kept = sum(1 for _, same, _ in fields if same)
    lines = [f"Re-read {len(done)} reports ({sum(skipped.values())} skipped)."]
    if skipped:
        lines.append("Skipped because: " + ", ".join(f"{why} x{n}" for why, n in skipped.most_common()))
    if not fields:
        return "\n".join(lines + ["No fields were read."])
    lines.append(f"Fields read {len(fields)}; same as the approved value {kept} ({kept / len(fields):.1%}). Goal 99%.")
    by_band: dict[str, list[int]] = {label: [0, 0] for label, _ in BANDS}
    by_field: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for name, same, confidence in fields:
        by_field[name][0] += 1
        by_field[name][1] += int(same)
        band = _band(confidence)
        if band is not None:
            by_band[band][0] += 1
            by_band[band][1] += int(same)
    lines.append("By confidence:")
    lines += [f"  {label}: {n} fields, {k} same ({k / n:.1%})" if n else f"  {label}: none" for label, (n, k) in by_band.items()]
    lines.append("By field, worst first:")
    for name, (n, k) in sorted(by_field.items(), key=lambda kv: (kv[1][1] / kv[1][0], -kv[1][0])):
        lines.append(f"  {name}: {n} fields, {k} same ({k / n:.1%})")
    lines.append("An estimate: a second read can differ from the first without either being wrong.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="store_true", help="re-read documents (one Claude call each in a live run); without it only counts are printed")
    parser.add_argument("--save", action="store_true", help="with --run: store each re-read as the report's first reading, marked as a re-read (live runs only)")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"reports to re-read, newest first (default {DEFAULT_LIMIT}, at most {MAX_PER_RUN})")
    args = parser.parse_args(argv)
    limit = max(0, min(args.limit, MAX_PER_RUN))
    if args.save and not args.run:
        parser.error("--save needs --run")
    if args.save and not get_settings().use_live_claude:
        print("--save is refused: USE_LIVE_CLAUDE is not true, so the reading is invented and must not be stored.", file=sys.stderr)
        return 2

    with SessionLocal() as db:
        todo = unmeasured_reports(db)
        measured = db.query(models.Report).filter(models.Report.status == models.ReportStatus.finalized, models.Report.original_fields.is_not(None)).count()
        print(f"Finalized reports with a first reading (measured by the accuracy page): {measured}")
        print(f"Finalized reports without one: {len(todo)}")
        batch = todo[:limit]
        if not args.run:
            print(f"A run with --limit {limit} would re-read {len(batch)} reports: {len(batch)} Claude calls in a live run. Add --run to do it.")
            return 0
        if not get_settings().use_live_claude:
            print("USE_LIVE_CLAUDE is not true: this is the stub reading, the numbers below are not real.", file=sys.stderr)
        # The app's own logging prints the file name (and a stack trace) of a document that fails; those names can
        # hold a person's name. Nothing but this script's summary may reach the terminal.
        logging.disable(logging.CRITICAL)
        try:
            readings = [reread(db, report) for report in batch]
            saved = (
                sum(save_reading(db, report, r) for report, r in zip(batch, readings) if isinstance(r, Reading))
                if args.save
                else 0
            )
        finally:
            logging.disable(logging.NOTSET)
        print(summarize([r.rows if isinstance(r, Reading) else r for r in readings]))
        if args.save:
            print(f"Saved {saved} re-reads as first readings (marked as re-reads). The accuracy page now counts them.")
        elif any(isinstance(r, Reading) for r in readings):
            print("Nothing was stored. Add --save to store these as first readings, so the accuracy page shows them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
