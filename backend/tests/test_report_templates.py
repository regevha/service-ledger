"""Coverage for the template-management endpoints in
app/routers/report_templates.py (GET .../all, GET .../{id}, POST, PATCH,
DELETE) and the validation in app/schemas.py's TemplateFieldIn/
TemplateCreate/TemplateUpdate — none of this existed before the structured
field editor (the frontend's Templates tab): the only prior coverage was
the single resolve_template()-backed GET /report-templates endpoint,
already exercised indirectly by test_document_first_flow.py.
"""
from __future__ import annotations

import uuid

from sqlalchemy.exc import IntegrityError

from app.models import Report, ReportStatus, ReportTemplate, ReportType

MIN_FIELDS = [{"name": "notes", "type": "text"}]


def test_create_report_template(client):
    resp = client.post(
        "/report-templates",
        json={"report_type": "repair", "model": "TestModel-9000", "fields": MIN_FIELDS},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["report_type"] == "repair"
    assert body["model"] == "TestModel-9000"
    assert body["field_schema"]["fields"] == [
        {"name": "notes", "type": "text", "unit": None, "notes": None}
    ]


def test_create_report_template_defaults_model_to_any(client):
    # No `model` key at all — distinct from the empty-string/whitespace case
    # below, which is normalized to the same None. A non-"facs" instrument
    # type sidesteps seed_templates.py's own None-model calibration row,
    # which would otherwise collide on the "any model" slot this is testing.
    resp = client.post(
        "/report-templates", json={"instrument_type": "other", "report_type": "calibration", "fields": MIN_FIELDS}
    )
    assert resp.status_code == 201
    assert resp.json()["model"] is None


def test_create_report_template_blank_model_normalizes_to_any(client):
    resp = client.post(
        "/report-templates",
        json={"instrument_type": "other", "report_type": "calibration", "model": "   ", "fields": MIN_FIELDS},
    )
    assert resp.status_code == 201
    assert resp.json()["model"] is None


def test_create_report_template_rejects_empty_field_list(client):
    resp = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": []})
    assert resp.status_code == 422


def test_create_report_template_rejects_duplicate_field_names(client):
    resp = client.post(
        "/report-templates",
        json={
            "report_type": "repair",
            "model": "X",
            "fields": [{"name": "dup", "type": "text"}, {"name": "dup", "type": "number"}],
        },
    )
    assert resp.status_code == 422


def test_create_report_template_rejects_blank_field_name(client):
    resp = client.post(
        "/report-templates", json={"report_type": "repair", "model": "X", "fields": [{"name": "  ", "type": "text"}]}
    )
    assert resp.status_code == 422


def test_enum_field_requires_options(client):
    resp = client.post(
        "/report-templates",
        json={"report_type": "repair", "model": "X", "fields": [{"name": "f", "type": "enum"}]},
    )
    assert resp.status_code == 422


def test_leaf_field_rejects_options(client):
    resp = client.post(
        "/report-templates",
        json={"report_type": "repair", "model": "X", "fields": [{"name": "f", "type": "text", "options": ["a"]}]},
    )
    assert resp.status_code == 422


def test_enum_field_with_options_round_trips(client):
    resp = client.post(
        "/report-templates",
        json={
            "report_type": "repair",
            "model": "X",
            "fields": [{"name": "fault_category", "type": "enum", "options": ["fluidics", "optics"]}],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["field_schema"]["fields"][0]["options"] == ["fluidics", "optics"]


def test_object_list_field_requires_item_schema(client):
    resp = client.post(
        "/report-templates",
        json={"report_type": "repair", "model": "X", "fields": [{"name": "parts", "type": "object[]"}]},
    )
    assert resp.status_code == 422


def test_object_list_field_rejects_non_leaf_item_schema_column(client):
    resp = client.post(
        "/report-templates",
        json={
            "report_type": "repair",
            "model": "X",
            "fields": [
                {
                    "name": "parts",
                    "type": "object[]",
                    "item_schema": {"part_name": "text", "nested": "object[]"},
                }
            ],
        },
    )
    assert resp.status_code == 422


def test_object_list_field_with_item_schema_round_trips(client):
    resp = client.post(
        "/report-templates",
        json={
            "report_type": "repair",
            "model": "X",
            "fields": [
                {
                    "name": "components_replaced",
                    "type": "object[]",
                    "item_schema": {"part_name": "text", "qty": "number"},
                }
            ],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["field_schema"]["fields"][0]["item_schema"] == {"part_name": "text", "qty": "number"}


def test_create_report_template_conflicts_on_duplicate_type_model(client):
    payload = {"report_type": "repair", "model": "TestModel-9000", "fields": MIN_FIELDS}
    first = client.post("/report-templates", json=payload)
    assert first.status_code == 201
    second = client.post("/report-templates", json=payload)
    assert second.status_code == 409


def test_create_report_template_conflicts_on_duplicate_null_model(client, seeded):
    # seed_templates.py already seeded a model=None calibration row — a
    # second one for the same (instrument_type, report_type) must collide
    # too, since resolve_template()'s NULL-model fallback has to be unique.
    resp = client.post("/report-templates", json={"report_type": "calibration", "fields": MIN_FIELDS})
    assert resp.status_code == 409


def test_database_itself_rejects_duplicate_null_model_rows(seeded):
    # Bypasses the app-level pre-check entirely (direct ORM insert) to prove
    # migration 6b5fc4e1c3ca's unique index — not just routers/
    # report_templates.py's own check — is what actually closes the
    # concurrent-request race window.
    dup = ReportTemplate(instrument_type="facs", report_type=ReportType.calibration, model=None, field_schema={"fields": MIN_FIELDS})
    seeded.add(dup)
    try:
        seeded.commit()
        assert False, "expected the DB's unique index to reject this row"
    except IntegrityError:
        seeded.rollback()


def test_list_all_report_templates_returns_every_row_unresolved(client, seeded):
    # seed_templates.py seeds 4 rows (§5, v0.12) — unlike GET
    # /report-templates (resolve_template()'s one-per-report_type pick),
    # /all must return every one of them.
    resp = client.get("/report-templates/all")
    assert resp.status_code == 200
    assert len(resp.json()) == 4


def test_get_report_template_by_id(client):
    created = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": MIN_FIELDS}).json()
    resp = client.get(f"/report-templates/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["id"] == created["id"]


def test_get_report_template_404(client):
    resp = client.get(f"/report-templates/{uuid.uuid4()}")
    assert resp.status_code == 404


def test_update_report_template_fields(client):
    created = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": MIN_FIELDS}).json()
    resp = client.patch(
        f"/report-templates/{created['id']}",
        json={"fields": [{"name": "new_field", "type": "number", "unit": "hours"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["field_schema"]["fields"] == [{"name": "new_field", "type": "number", "unit": "hours", "notes": None}]
    # report_type/model untouched — exclude_unset, not a full overwrite.
    assert body["report_type"] == "repair"
    assert body["model"] == "X"


def test_update_report_template_null_fields_rejected(client):
    created = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": MIN_FIELDS}).json()
    resp = client.patch(f"/report-templates/{created['id']}", json={"fields": None})
    assert resp.status_code == 422


def test_update_report_template_can_null_out_model(client):
    # instrument_type="other" so nulling the model doesn't collide with
    # seed_templates.py's own None-model "facs"/repair row.
    created = client.post(
        "/report-templates", json={"instrument_type": "other", "report_type": "repair", "model": "X", "fields": MIN_FIELDS}
    ).json()
    resp = client.patch(f"/report-templates/{created['id']}", json={"model": None})
    assert resp.status_code == 200
    assert resp.json()["model"] is None


def test_update_report_template_omitted_model_leaves_it_unchanged(client):
    created = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": MIN_FIELDS}).json()
    resp = client.patch(f"/report-templates/{created['id']}", json={"fields": MIN_FIELDS})
    assert resp.status_code == 200
    assert resp.json()["model"] == "X"


def test_update_report_template_conflicts_when_moved_onto_an_existing_row(client):
    a = client.post("/report-templates", json={"report_type": "repair", "model": "A", "fields": MIN_FIELDS}).json()
    client.post("/report-templates", json={"report_type": "repair", "model": "B", "fields": MIN_FIELDS})
    resp = client.patch(f"/report-templates/{a['id']}", json={"model": "B"})
    assert resp.status_code == 409
    # And the row wasn't half-mutated by the failed attempt.
    assert client.get(f"/report-templates/{a['id']}").json()["model"] == "A"


def test_update_report_template_404(client):
    resp = client.patch(f"/report-templates/{uuid.uuid4()}", json={"fields": MIN_FIELDS})
    assert resp.status_code == 404


def test_delete_report_template(client):
    created = client.post("/report-templates", json={"report_type": "repair", "model": "X", "fields": MIN_FIELDS}).json()
    resp = client.delete(f"/report-templates/{created['id']}")
    assert resp.status_code == 204
    assert client.get(f"/report-templates/{created['id']}").status_code == 404


def test_delete_report_template_404(client):
    resp = client.delete(f"/report-templates/{uuid.uuid4()}")
    assert resp.status_code == 404


def test_delete_report_template_conflicts_when_reports_reference_it(client, seeded):
    template = seeded.query(ReportTemplate).filter(ReportTemplate.report_type == ReportType.repair).one()
    report = Report(template_id=template.id, status=ReportStatus.draft, extracted_fields={})
    seeded.add(report)
    seeded.commit()

    resp = client.delete(f"/report-templates/{template.id}")
    assert resp.status_code == 409
    # Guarded, not just caught — the row must still exist afterwards.
    assert client.get(f"/report-templates/{template.id}").status_code == 200
