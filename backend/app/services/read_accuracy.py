"""How good the reading is, measured on what people approved (GET /analytics/read-accuracy).

The measure: for a finalized report, every field the reading filled in counts once; it is "kept as read" when
the approved value equals the first reading (`reports.original_fields`). A report is "approved as read" when all
of its read fields were kept. The goal is 99% of fields. Same rules as the Home figure (services/home_summary.py),
which this extends with a weekly trend and a breakdown, so the two never disagree.

Translations are measured the same way: an accepted translation is "kept as read" when the reviewer accepted the
model's text with no edit. The edits themselves are listed as before / after phrase pairs, which is where a wrong
technical term ("laser direction") shows up.

Three more cuts help find what to fix. `filled_by_hand`: fields the reading left empty that a person then filled in
(not part of the percentage, which counts only what was read). `by_confidence`: the share kept per confidence band
(the same 0.70 / 0.85 cut-offs the screens use), which says whether the confidence can be trusted. `by_prompt`:
the share kept per prompt hash and model, recorded on the extract job, so a prompt change shows up as a number.
"""
from __future__ import annotations

import difflib
import json
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models, schemas
from app.services.read_compare import blank as _blank
from app.services.read_compare import is_free_text, same_value

GOAL = 0.99
BANDS = (("below_0.70", 0.0), ("0.70_to_0.85", 0.70), ("0.85_and_up", 0.85))
UNKNOWN = "unknown"


def _band(confidence: object) -> str | None:
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return None
    name = BANDS[0][0]
    for label, low in BANDS:
        if confidence >= low:
            name = label
    return name


def _latest_reads(db: Session, report_ids: list[uuid.UUID]) -> dict[uuid.UUID, models.ExtractionJob]:
    """The latest succeeded extract job of each report (the one whose reading became `original_fields`)."""
    if not report_ids:
        return {}
    jobs = db.execute(
        select(models.Attachment.report_id, models.ExtractionJob)
        .join(models.ExtractionJob, models.ExtractionJob.attachment_id == models.Attachment.id)
        .where(
            models.Attachment.report_id.in_(report_ids),
            models.ExtractionJob.kind == models.ExtractionJobKind.extract,
            models.ExtractionJob.status == models.ExtractionJobStatus.succeeded,
        )
        .order_by(models.ExtractionJob.completed_at.asc())
    ).all()
    return {report_id: job for report_id, job in jobs}  # later (newer) rows win
MAX_CORRECTIONS = 60
MAX_TRANSLATION_EDITS = 30
MAX_SHOWN = 160
MAX_FULL = 4000  # the full read / approved text offered one click away, per correction


def _show(value: object, limit: int = MAX_SHOWN) -> str:
    """A field value as one short line of text, for the corrections list and the prompt."""
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = " ".join(value.split())
    elif isinstance(value, bool):
        text = "yes" if value else "no"
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _template_name(template: models.ReportTemplate | None) -> str:
    if template is None:
        return "No form"
    kind = template.report_type.value.replace("_", " ")
    kind = kind[:1].upper() + kind[1:]
    return f"{kind}, {template.model}" if template.model else f"{kind}, any model"


def _instrument_name(report: models.Report) -> str | None:
    instrument = report.instrument
    if instrument is None:
        return None
    return f"{instrument.name} ({instrument.model})" if instrument.name and instrument.name != instrument.model else instrument.model


def _translation_of(report: models.Report) -> models.Translation | None:
    for attachment in report.attachments:
        for t in reversed(attachment.translations):
            if t.status == models.TranslationStatus.accepted:
                return t
    return None


def phrase_changes(before: str, after: str, limit: int = 8) -> list[tuple[str, str]]:
    """The words a reviewer changed, as (before, after) pairs; pure insertions and deletions included. A single
    changed word takes the word before it along ("Laser direction" → "Laser alignment", not "direction" →
    "alignment"): a technical term is usually two words, and a lone word is too broad to be a technical term."""
    a, b = before.split(), after.split()
    pairs: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace" and i2 - i1 == 1 and j2 - j1 == 1 and i1 > 0 and j1 > 0:
            i1, j1 = i1 - 1, j1 - 1
        pairs.append((" ".join(a[i1:i2]), " ".join(b[j1:j2])))
        if len(pairs) >= limit:
            break
    return pairs


def read_accuracy(db: Session, today: date, days: int | None) -> schemas.ReadAccuracyOut:
    stmt = (
        select(models.Report)
        .where(models.Report.status == models.ReportStatus.finalized, models.Report.original_fields.is_not(None))
        .options(
            selectinload(models.Report.template),
            selectinload(models.Report.instrument),
            selectinload(models.Report.attachments).selectinload(models.Attachment.translations),
        )
        .order_by(models.Report.finalized_at.desc())
    )
    if days:
        stmt = stmt.where(models.Report.finalized_at >= datetime.combine(today - timedelta(days=days), time.min, tzinfo=timezone.utc))
    rows = db.scalars(stmt).all()

    total = {"fields": 0, "unchanged": 0, "reports": 0, "untouched": 0}
    weeks: dict[date, dict] = defaultdict(lambda: {"fields": 0, "unchanged": 0, "reports": 0, "untouched": 0})
    by_field: dict[str, dict] = defaultdict(lambda: {"fields": 0, "unchanged": 0})
    by_form: dict[str, dict] = {}
    by_source: dict[str, dict] = defaultdict(lambda: {"fields": 0, "unchanged": 0, "reports": 0, "untouched": 0})
    corrections: list[schemas.ReadCorrectionOut] = []
    by_band: dict[str, dict] = {label: {"fields": 0, "unchanged": 0} for label, _ in BANDS}
    by_prompt: dict[tuple[str, str, str], dict] = {}
    hand = {"empty": 0, "filled": 0}
    by_kind: dict[str, dict] = {"structured": {"fields": 0, "unchanged": 0}, "free_text": {"fields": 0, "unchanged": 0}}
    from_reread = 0
    latest = _latest_reads(db, [r.id for r in rows])
    tr = {"accepted": 0, "unchanged": 0}
    tr_edits: list[schemas.TranslationEditOut] = []

    for report in rows:
        original = report.original_fields or {}
        kept = report.extracted_fields or {}
        translation = _translation_of(report)
        source = "translated" if translation is not None else "original"
        counted = same = 0
        job = latest.get(report.id)
        confidences = (job.field_confidences or {}) if job is not None else {}
        params = (job.params or {}) if job is not None else {}
        prompt_key = (str(params.get("prompt_hash") or UNKNOWN), str(params.get("model") or UNKNOWN))
        for key, read in original.items():
            if _blank(read):
                hand["empty"] += 1
                if not _blank(kept.get(key)):
                    hand["filled"] += 1
                continue
            counted += 1
            kind = by_kind["free_text" if is_free_text(key) else "structured"]
            kind["fields"] += 1
            kind["unchanged"] += int(same_value(key, read, kept.get(key)))
            band = _band(confidences.get(key))
            if band is not None:
                by_band[band]["fields"] += 1
                by_band[band]["unchanged"] += int(same_value(key, read, kept.get(key)))
            by_field[key]["fields"] += 1
            if same_value(key, read, kept.get(key)):
                same += 1
                by_field[key]["unchanged"] += 1
            elif len(corrections) < MAX_CORRECTIONS:
                corrections.append(
                    schemas.ReadCorrectionOut(
                        read_full=_show(read, MAX_FULL),
                        kept_full=_show(kept.get(key), MAX_FULL),
                        changes=[
                            schemas.PhraseChangeOut(before=b, after=a)
                            for b, a in phrase_changes(read, kept.get(key) or "")
                        ]
                        if isinstance(read, str) and isinstance(kept.get(key) or "", str)
                        else [],
                        report_id=report.id,
                        finalized_at=report.finalized_at,
                        instrument=_instrument_name(report),
                        form=_template_name(report.template),
                        field=key,
                        read=_show(read),
                        kept=_show(kept.get(key)),
                        translated=translation is not None,
                    )
                )
        if translation is not None and translation.accepted_at is not None:
            tr["accepted"] += 1
            model_text = translation.model_text or ""
            accepted = translation.accepted_text if translation.accepted_text is not None else model_text
            if accepted.split() == model_text.split():
                tr["unchanged"] += 1
            elif len(tr_edits) < MAX_TRANSLATION_EDITS:
                tr_edits.append(
                    schemas.TranslationEditOut(
                        report_id=report.id,
                        finalized_at=report.finalized_at,
                        instrument=_instrument_name(report),
                        changes=[schemas.PhraseChangeOut(before=b, after=a) for b, a in phrase_changes(model_text, accepted)],
                    )
                )
        if not counted:
            continue
        untouched = int(same == counted)
        from_reread += int(params.get("baseline") == "reread")
        prompt = by_prompt.setdefault((*prompt_key, _template_name(report.template)), {"fields": 0, "unchanged": 0, "reports": 0})
        prompt["fields"] += counted
        prompt["unchanged"] += same
        prompt["reports"] += 1
        for bucket in (total, by_source[source]):
            bucket["fields"] += counted
            bucket["unchanged"] += same
            bucket["reports"] += 1
            bucket["untouched"] += untouched
        if report.finalized_at is not None:
            week = weeks[_week_start(report.finalized_at.date())]
            week["fields"] += counted
            week["unchanged"] += same
            week["reports"] += 1
            week["untouched"] += untouched
        form_key = str(report.template_id) if report.template_id else "none"
        form = by_form.setdefault(form_key, {"template_id": report.template_id, "form": _template_name(report.template), "fields": 0, "unchanged": 0, "reports": 0, "untouched": 0})
        form["fields"] += counted
        form["unchanged"] += same
        form["reports"] += 1
        form["untouched"] += untouched

    def worst_first(item: dict) -> tuple:
        return (item["unchanged"] / item["fields"] if item["fields"] else 1.0, -item["fields"])

    return schemas.ReadAccuracyOut(
        days=days,
        goal=GOAL,
        fields=total["fields"],
        unchanged=total["unchanged"],
        reports=total["reports"],
        reports_untouched=total["untouched"],
        weeks=[schemas.ReadAccuracyWeekOut(week_start=w, **v) for w, v in sorted(weeks.items())],
        by_field=sorted((schemas.ReadAccuracyFieldOut(field=k, **v) for k, v in by_field.items()), key=lambda r: worst_first(r.model_dump())),
        by_form=sorted((schemas.ReadAccuracyFormOut(**v) for v in by_form.values()), key=lambda r: worst_first(r.model_dump())),
        by_source=[schemas.ReadAccuracySourceOut(source=k, **v) for k, v in sorted(by_source.items())],
        by_confidence=[schemas.ReadAccuracyConfidenceOut(band=label, **by_band[label]) for label, _ in BANDS],
        by_prompt=[
            schemas.ReadAccuracyPromptOut(prompt_hash=h, model=m, form=f, **v)
            for (h, m, f), v in sorted(by_prompt.items(), key=lambda kv: (kv[0][2], -kv[1]["reports"], kv[0][0]))
        ],
        by_kind=[schemas.ReadAccuracyKindOut(kind=k, **v) for k, v in by_kind.items()],
        from_reread=from_reread,
        filled_by_hand=schemas.FilledByHandOut(**hand),
        corrections=corrections,
        translations=schemas.TranslationAccuracyOut(accepted=tr["accepted"], unchanged=tr["unchanged"], edits=tr_edits),
    )
