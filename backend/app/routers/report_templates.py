from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.models import ReportType
from app.services.templates import resolve_template

router = APIRouter(tags=["report-templates"])


@router.get("/report-templates", response_model=list[schemas.ReportTemplateOut])
def list_report_templates(
    instrument_type: str = "facs",
    model: str | None = Query(None, description="Resolve to this model's variant when one exists"),
    report_type: ReportType | None = Query(None, description="Limit to one report type"),
    db: Session = Depends(get_db),
):
    report_types = [report_type] if report_type else list(ReportType)
    resolved = []
    for rt in report_types:
        template = resolve_template(db, instrument_type=instrument_type, report_type=rt.value, model=model)
        if template:
            resolved.append(template)
    return resolved


@router.get("/report-templates/all", response_model=list[schemas.ReportTemplateOut])
def list_all_report_templates(db: Session = Depends(get_db)):
    """The template-management screen's list view: every row, unresolved —
    unlike GET /report-templates above, this doesn't pick one row per
    report_type via resolve_template()'s model-fallback logic, since an
    admin editing templates needs to see (and edit) every variant, including
    ones a given model would never actually resolve to. Registered before
    /report-templates/{template_id} below so "all" is never swallowed as a
    template_id path param."""
    return (
        db.query(models.ReportTemplate)
        .order_by(models.ReportTemplate.report_type, models.ReportTemplate.model)
        .all()
    )


@router.get("/report-templates/{template_id}", response_model=schemas.ReportTemplateOut)
def get_report_template(template_id: uuid.UUID, db: Session = Depends(get_db)):
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise HTTPException(404, "Template not found")
    return template


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
    return out


def _raise_collision(report_type: ReportType, model: str | None):
    raise HTTPException(409, f"A template already exists for {report_type.value} / {model or '(any model)'}")


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


@router.post("/report-templates", response_model=schemas.ReportTemplateOut, status_code=201)
def create_report_template(payload: schemas.TemplateCreate, db: Session = Depends(get_db)):
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
        # own unique index (migration 6b5fc4e1c3ca) is what actually stops
        # the duplicate row, this just turns the resulting IntegrityError
        # into the same clean 409 the pre-check gives everyone else.
        db.rollback()
        _raise_collision(payload.report_type, payload.model)
    db.refresh(template)
    return template


@router.patch("/report-templates/{template_id}", response_model=schemas.ReportTemplateOut)
def update_report_template(template_id: uuid.UUID, payload: schemas.TemplateUpdate, db: Session = Depends(get_db)):
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise HTTPException(404, "Template not found")

    # model_fields_set (not model_dump(exclude_unset=True)) so "which
    # top-level keys did the caller actually send" doesn't get tangled up
    # with pydantic's own recursive exclude_unset behavior on the nested
    # `fields` list — a TemplateFieldIn the caller sent with only
    # name/type set would otherwise lose its unit/notes keys entirely
    # instead of writing them through as None.
    provided = payload.model_fields_set

    if "fields" in provided:
        if payload.fields is None:
            raise HTTPException(422, "fields cannot be null — omit it to leave the schema unchanged.")
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
        raise HTTPException(422, "report_type cannot be null — omit it to leave it unchanged.")

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


@router.delete("/report-templates/{template_id}", status_code=204)
def delete_report_template(template_id: uuid.UUID, db: Session = Depends(get_db)):
    template = db.get(models.ReportTemplate, template_id)
    if not template:
        raise HTTPException(404, "Template not found")
    in_use = db.query(models.Report).filter(models.Report.template_id == template_id).count()
    if in_use:
        # reports.template_id -> report_templates.id has no ondelete (models.py),
        # so it defaults to RESTRICT — without this check db.delete() would
        # raise a raw, unhandled IntegrityError instead of a clean 409.
        raise HTTPException(409, f"Cannot delete: {in_use} report(s) reference this template")
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
        raise HTTPException(409, "Cannot delete: a report was attached to this template just now — try again.") from None
