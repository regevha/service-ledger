"""An accuracy baseline from reports that are already finalized (SL-69).

Reports finalized before the first reading was kept (`reports.original_fields`) cannot be measured by the
accuracy page. This script reads the stored document of such a report again with the current extraction and
compares the result with the values that were approved, using the same "kept as read" rule and the same
confidence bands as the page. It is an estimate: a model can answer a little differently on a second read.

    python -m scripts.reread_baseline                    # counts only, no Claude call
    python -m scripts.reread_baseline --run --limit 20   # re-read the 20 newest (at most 60 per run)

Run it from backend/ on your own machine, against your own database. A live run needs USE_LIVE_CLAUDE=true and
your own key in the environment (never written to a file). In stub mode the numbers are not real.
Writes nothing to the database. The output has counts and field names only: no value, report name,
technician, file name or path.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.db import SessionLocal
from app.services.extraction import extract
from app.services.home_summary import _blank, _same
from app.services.read_accuracy import BANDS, _band

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


def reread(db: Session, report: models.Report) -> list[tuple[str, bool, float | None]] | None:
    """(field name, same as approved, confidence) for every field the new reading filled in; None when
    the report cannot be read again (no template, no document, a refused or failed answer)."""
    template = db.get(models.ReportTemplate, report.template_id) if report.template_id else None
    attachment = _attachment_to_read(db, report)
    if template is None or attachment is None:
        return None
    try:
        result = extract(attachment, template)
    except Exception:  # noqa: BLE001 - one unreadable report must not stop the run; its message may hold a path
        return None
    kept = report.extracted_fields or {}
    return [
        (name, _same(value, kept.get(name)), _confidence(result.field_confidences.get(name)))
        for name, value in result.extracted_fields.items()
        if not _blank(value)
    ]


def _confidence(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def summarize(rows: list[list[tuple[str, bool, float | None]] | None]) -> str:
    """The text a run prints, built from counts and field names only."""
    done = [r for r in rows if r is not None]
    fields = [f for r in done for f in r]
    kept = sum(1 for _, same, _ in fields if same)
    lines = [f"Re-read {len(done)} reports ({len(rows) - len(done)} skipped: no template or document, or no usable answer)."]
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
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"reports to re-read, newest first (default {DEFAULT_LIMIT}, at most {MAX_PER_RUN})")
    args = parser.parse_args(argv)
    limit = max(0, min(args.limit, MAX_PER_RUN))

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
        print(summarize([reread(db, report) for report in batch]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
