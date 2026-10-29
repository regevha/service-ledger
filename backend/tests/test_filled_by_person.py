"""Template fields a person fills in (`filled_by_person`): fault category,
retest result and verification result are not printed on the form, so the
review screen always asks for them to be checked. Covers the API round trip,
the seed, and the data migration that marks existing templates."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from app import seed_templates

MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0005_filled_by_person.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("m0005", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_create_keeps_filled_by_person_only_when_set(client):
    resp = client.post(
        "/report-templates",
        json={
            "report_type": "repair",
            "model": "PersonField-1",
            "fields": [
                {"name": "summary", "type": "text"},
                {"name": "outcome", "type": "enum", "options": ["pass", "fail"], "filled_by_person": True},
            ],
        },
    )
    assert resp.status_code == 201
    summary, outcome = resp.json()["field_schema"]["fields"]
    assert "filled_by_person" not in summary
    assert outcome["filled_by_person"] is True


def test_update_can_set_and_clear_filled_by_person(client):
    created = client.post(
        "/report-templates",
        json={"report_type": "repair", "model": "PersonField-2", "fields": [{"name": "outcome", "type": "text"}]},
    ).json()
    on = client.patch(
        f"/report-templates/{created['id']}",
        json={"fields": [{"name": "outcome", "type": "text", "filled_by_person": True}]},
    )
    assert on.json()["field_schema"]["fields"][0]["filled_by_person"] is True
    off = client.patch(f"/report-templates/{created['id']}", json={"fields": [{"name": "outcome", "type": "text"}]})
    assert "filled_by_person" not in off.json()["field_schema"]["fields"][0]


def test_seed_marks_every_lab_manager_field_and_nothing_else():
    marked, unmarked_manager_fields = [], []
    for _report_type, _model, fields in seed_templates.TEMPLATE_ROWS:
        for field in fields:
            manager = str(field.get("notes") or "").startswith("lab-manager-assigned")
            if field.get("filled_by_person"):
                assert manager, f"{field['name']} is marked but its notes do not say lab-manager-assigned"
                marked.append(field["name"])
            elif manager:
                unmarked_manager_fields.append(field["name"])
    assert unmarked_manager_fields == []
    assert {"fault_category", "retest_result", "verification_result"} <= set(marked)


def test_migration_marks_and_unmarks_by_the_notes():
    m = _load_migration()
    manager = {"name": "fault_category", "type": "enum", "notes": "Lab-manager-assigned, not on the source form"}
    other = {"name": "labor_hours", "type": "number", "notes": "rounded total"}
    no_notes = {"name": "x", "type": "text", "notes": None}
    assert m._mark(dict(manager))["filled_by_person"] is True
    assert "filled_by_person" not in m._mark(dict(other))
    assert "filled_by_person" not in m._mark(dict(no_notes))
    assert "filled_by_person" not in m._unmark({**manager, "filled_by_person": True})
