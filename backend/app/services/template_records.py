"""Report template records for the API: the resolved and full lists, usage counts,
suggestions, the two-template comparison, and create / edit / delete.

The router (routers/report_templates.py) only translates HTTP; a request this module
has to refuse raises NotFoundError, ConflictError or InvalidError.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.models import ReportType
from app.services.domain_errors import ConflictError, InvalidError, NotFoundError
from app.services.field_aliases import load_alias_index
from app.services.instrument_types import type_exists
from app.services.template_compare import (
    DIFFERS,
    ONLY_LEFT,
    ONLY_RIGHT,
    POSSIBLE_MATCH,
    SAME,
    compare_templates,
)
from app.services.templates import resolve_template, suggest_templates


def _field_to_dict(field: schemas.TemplateFieldIn) -> dict:
    """Mirrors seed_templates.py's own field-list shape exactly: unit/notes
    always present (even as None), but options/item_schema only present
    when the field type actually uses them — not just `exclude_none`, since
    unit/notes need to survive being None while options/item_schema don't."""
    out: dict = {"name": field.name, "type": field.type.value, "unit": field.unit, "notes": field.notes}
    if field.options is not None:
        out["options"] = field.options
    if field.item_schema is not None:
        # A list, not a dict — see ItemSchemaColumn's docstring (schemas.py):
        # Postgres's JSONB storage doesn't preserve object key order, but it
        # does preserve JSON array element order, so the column order a
        # template author chose survives the round trip through the DB.
        out["item_schema"] = [{"name": col.name, "type": col.type.value} for col in field.item_schema]
    if field.filled_by_person:
        out["filled_by_person"] = True
    if field.optional:
        out["optional"] = True
    if field.source is not None:
        out["source"] = field.source.model_dump()
    return out


def _raise_collision(report_type: ReportType, model: str | None):
    raise ConflictError(f"A template already exists for {report_type.value} / {model or '(any model)'}")


def _check_collision(db: Session, instrument_type: str, report_type: ReportType, model: str | None, exclude_id=None):
    query = db.query(models.ReportTemplate).filter(
        models.ReportTemplate.instrument_type == instrument_type,
        models.ReportTemplate.report_type == report_type,
        models.ReportTemplate.model == model,
    )
    if exclude_id is not None:
        query = query.filter(models.ReportTemplate.id != exclude_id)
    if query.first():
        _raise_collision(report_type, model)


def resolved_templates(db: Session, instrument_type: str, model: str | None, report_type: ReportType | None) -> list[models.ReportTemplate]:
    report_types = [report_type] if report_type else list(ReportType)
    resolved = []
    for rt in report_types:
        template = resolve_template(db, instrument_type=instrument_type, report_type=rt.value, model=model)
        if template:
            resolved.append(template)
    return resolved


def all_templates(db: Session) -> list[models.ReportTemplate]:
    return (
        db.query(models.ReportTemplate)
        .order_by(models.ReportTemplate.report_type, models.ReportTemplate.model)
        .all()
    )


def template_usage(db: Session) -> list[schemas.TemplateUsageOut]:
    finalized = func.count().filter(models.Report.status == models.ReportStatus.finalized)
    rows = (
        db.query(models.Report.template_id, func.count(), finalized)
        .filter(models.Report.template_id.is_not(None))
        .group_by(models.Report.template_id)
        .all()
    )
    return [schemas.TemplateUsageOut(template_id=t, report_count=n, finalized_count=f) for t, n, f in rows]


def suggestions(db: Session, report_type: ReportType, instrument_type: str, model: str | None, limit: int) -> list[schemas.TemplateSuggestionOut]:
    return [
        schemas.TemplateSuggestionOut(
            template=schemas.ReportTemplateOut.model_validate(s.template),
            score=s.score,
            reason=s.reason,
            field_count=s.field_count,
        )
        for s in suggest_templates(
            db, instrument_type=instrument_type, report_type=report_type.value, model=model, limit=limit
        )
    ]


def compare(db: Session, left: uuid.UUID, right: uuid.UUID) -> schemas.TemplateCompareOut:
    left_row = db.get(models.ReportTemplate, left)
    right_row = db.get(models.ReportTemplate, right)
    if left_row is None or right_row is None:
        raise NotFoundError("Template not found")
    if left_row.instrument_type != right_row.instrument_type:
        raise InvalidError("Only templates of the same instrument type can be compared."
        )
    result = compare_templates(left_row, right_row, load_alias_index(db))
    return schemas.TemplateCompareOut(
        left=schemas.ReportTemplateOut.model_validate(left_row),
        right=schemas.ReportTemplateOut.model_validate(right_row),
        summary=schemas.TemplateCompareSummaryOut(
            left_count=result.left_count,
            right_count=result.right_count,
            shared=result.count(SAME) + result.count(DIFFERS),
            same=result.count(SAME),
            differs=result.count(DIFFERS),
            only_left=result.count(ONLY_LEFT),
            only_right=result.count(ONLY_RIGHT),
            possible_match=result.count(POSSIBLE_MATCH),
        ),
        rows=[
            schemas.TemplateCompareRowOut(
                status=r.status,
                name=r.name,
                differences=r.differences,
                left=r.left,
                right=r.right,
                concept=(
                    schemas.AliasConceptOut(id=r.concept.id, label=r.concept.label, names=list(r.concept.names))
                    if r.concept
                    else None
                ),
            )
            for r in result.rows
        ],
    )


def get_template(db: Session, template_id: uuid.UUID) -> models.ReportTemplate:
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise NotFoundError("Template not found")
    return template


def create_template(db: Session, payload: schemas.TemplateCreate) -> models.ReportTemplate:
    if not type_exists(db, payload.instrument_type):
        raise InvalidError(f"Unknown instrument type '{payload.instrument_type}'. Add it first.")
    _check_collision(db, payload.instrument_type, payload.report_type, payload.model)
    template = models.ReportTemplate(
        instrument_type=payload.instrument_type,
        report_type=payload.report_type,
        model=payload.model,
        field_schema={"fields": [_field_to_dict(f) for f in payload.fields]},
    )
    db.add(template)
    try:
        db.commit()
    except IntegrityError:
        # The app-level check above closes the common case; this closes the
        # race window between that check and the commit (two concurrent
        # POSTs for the same instrument_type/report_type/model) — the DB's
        # own unique index (the baseline migration) is what actually stops
        # the duplicate row, this just turns the resulting IntegrityError
        # into the same clean 409 the pre-check gives everyone else.
        db.rollback()
        _raise_collision(payload.report_type, payload.model)
    db.refresh(template)
    return template


def update_template(db: Session, template_id: uuid.UUID, payload: schemas.TemplateUpdate) -> models.ReportTemplate:
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise NotFoundError("Template not found")

    # model_fields_set (not model_dump(exclude_unset=True)) so "which
    # top-level keys did the caller actually send" doesn't get tangled up
    # with pydantic's own recursive exclude_unset behavior on the nested
    # `fields` list — a TemplateFieldIn the caller sent with only
    # name/type set would otherwise lose its unit/notes keys entirely
    # instead of writing them through as None.
    provided = payload.model_fields_set

    if "fields" in provided:
        if payload.fields is None:
            raise InvalidError("fields cannot be null — omit it to leave the schema unchanged.")
        template.field_schema = {"fields": [_field_to_dict(f) for f in payload.fields]}

    if "report_type" in provided and payload.report_type is None:
        # Unlike `model` (nullable in the DB — a null there is a real,
        # meaningful "applies to any model" wildcard, per TemplateUpdate's
        # own docstring), report_type is a NOT NULL column with no such
        # wildcard meaning. An explicit null here used to sail straight
        # through _check_collision (which treats it as "no other row has a
        # null report_type" and finds nothing), then fail the commit with an
        # IntegrityError whose handler calls _raise_collision(None, ...) —
        # `None.value` raised an unhandled AttributeError (a 500) instead of
        # a clean error.
        raise InvalidError("report_type cannot be null — omit it to leave it unchanged.")

    new_report_type = payload.report_type if "report_type" in provided else template.report_type
    new_model = payload.model if "model" in provided else template.model
    if "report_type" in provided or "model" in provided:
        _check_collision(db, template.instrument_type, new_report_type, new_model, exclude_id=template.id)
        template.report_type = new_report_type
        template.model = new_model

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        _raise_collision(new_report_type, new_model)
    db.refresh(template)
    return template


def delete_template(db: Session, template_id: uuid.UUID) -> None:
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise NotFoundError("Template not found")
    in_use = db.query(models.Report).filter(models.Report.template_id == template_id).count()
    if in_use:
        # reports.template_id -> report_templates.id has no ondelete (models.py),
        # so it defaults to RESTRICT — without this check db.delete() would
        # raise a raw, unhandled IntegrityError instead of a clean 409.
        raise ConflictError(f"Cannot delete: {in_use} report(s) reference this template")
    db.delete(template)
    try:
        db.commit()
    except IntegrityError:
        # Closes the race window between the count-check above and this
        # commit — a report can be attached to this template (PATCH
        # /reports/{id}/template, a separate request) in between. With
        # ReportTemplate.reports now passive_deletes=True (models.py), the
        # DB's own RESTRICT constraint catches that race atomically here
        # instead of the ORM silently nulling the newly-attached report's
        # template_id and letting the delete through.
        db.rollback()
        raise ConflictError("Cannot delete: a report was attached to this template just now — try again.") from None
