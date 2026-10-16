"""Who may call what. Every endpoint is listed here with the least-privileged
role allowed to use it; the tests fail for a route missing from the table (a
new endpoint must be given a role on purpose) and check the rule both as data
(`required_role`) and against the live API for each role.
"""
from __future__ import annotations

import uuid

import pytest

from app import auth
from app.main import app
from app.models import UserRole

V, T, A = UserRole.viewer, UserRole.technician, UserRole.admin
PUBLIC = None

EXPECTED = {
    ("GET", "/health"): PUBLIC,
    ("GET", "/config"): PUBLIC,
    ("POST", "/auth/login"): PUBLIC,
    ("POST", "/auth/logout"): PUBLIC,
    ("GET", "/auth/me"): V,
    ("GET", "/users"): A,
    ("POST", "/users"): A,
    ("PATCH", "/users/{user_id}"): A,
    ("GET", "/analytics/fleet"): V,
    ("GET", "/analytics/models"): V,
    ("GET", "/analytics/models/trend"): V,
    ("GET", "/instruments"): V,
    ("GET", "/instruments/{instrument_id}"): V,
    ("GET", "/instruments/{instrument_id}/trend"): V,
    ("GET", "/instruments/{instrument_id}/trend-fields"): V,
    ("POST", "/instruments"): T,
    ("PATCH", "/instruments/{instrument_id}"): A,
    ("DELETE", "/instruments/{instrument_id}"): A,
    ("GET", "/instrument-types"): V,
    ("POST", "/instrument-types"): A,
    ("GET", "/saved-report-filters"): V,
    ("POST", "/saved-report-filters"): T,
    ("DELETE", "/saved-report-filters/{filter_id}"): T,
    ("GET", "/attachments/{attachment_id}/translation"): V,
    ("GET", "/attachments/{attachment_id}/translations"): V,
    ("POST", "/attachments/{attachment_id}/translate"): T,
    ("POST", "/translations/{translation_id}/accept"): T,
    ("POST", "/translations/{translation_id}/discard"): T,
    ("GET", "/report-templates/usage"): V,
    ("GET", "/report-templates"): V,
    ("GET", "/report-templates/all"): V,
    ("GET", "/report-templates/{template_id}"): V,
    ("POST", "/report-templates"): A,
    ("PATCH", "/report-templates/{template_id}"): A,
    ("DELETE", "/report-templates/{template_id}"): A,
    ("GET", "/reports"): V,
    ("GET", "/reports/export"): V,
    ("GET", "/reports/{report_id}"): V,
    ("GET", "/reports/{report_id}/pdf"): V,
    ("GET", "/reports/{report_id}/duplicates"): V,
    ("GET", "/attachments/{attachment_id}/file"): V,
    ("GET", "/extraction-jobs/{job_id}"): V,
    ("POST", "/reports"): T,
    ("PATCH", "/reports/{report_id}/fields"): T,
    ("PATCH", "/reports/{report_id}/template"): T,
    ("POST", "/reports/{report_id}/finalize"): T,
    ("POST", "/reports/{report_id}/attachments"): T,
    ("POST", "/attachments/{attachment_id}/classify"): T,
    ("POST", "/attachments/{attachment_id}/extract"): T,
    ("DELETE", "/reports/{report_id}"): A,
}


def _routes() -> list[tuple[str, str]]:
    return [(m.upper(), p) for p, ops in app.openapi()["paths"].items() for m in ops]


def test_every_route_has_an_expected_role_and_nothing_extra():
    assert sorted(_routes()) == sorted(EXPECTED)


@pytest.mark.parametrize("method,path", sorted(EXPECTED))
def test_required_role_matches_the_table(method, path):
    assert auth.required_role(method, path) == EXPECTED[(method, path)]


_RANK = {V: 0, T: 1, A: 2}


def _call(client, method, path):
    url = path
    for name in ("user_id", "instrument_id", "template_id", "report_id", "attachment_id", "job_id", "filter_id", "translation_id"):
        url = url.replace("{" + name + "}", str(uuid.uuid4()))
    return client.request(method, url)


def test_the_live_api_enforces_the_table_for_every_role(client_as, anon_client):
    clients = {V: client_as("viewer"), T: client_as("technician"), A: client_as("admin")}
    wrong = []
    for (method, path), needed in sorted(EXPECTED.items()):
        if needed is PUBLIC or path == "/auth/logout":
            continue  # public: nothing to deny
        status = _call(anon_client, method, path).status_code
        if status != 401:
            wrong.append(f"anonymous {method} {path} -> {status}")
        for role, signed_in in clients.items():
            status = _call(signed_in, method, path).status_code
            allowed = _RANK[role] >= _RANK[needed]
            if allowed and status in (401, 403):
                wrong.append(f"{role.value} {method} {path} -> {status} (should be allowed)")
            if not allowed and status != 403:
                wrong.append(f"{role.value} {method} {path} -> {status} (should be 403)")
    assert wrong == []


def test_public_endpoints_need_no_sign_in(anon_client):
    assert anon_client.get("/health").status_code == 200
    assert anon_client.get("/config").status_code == 200
