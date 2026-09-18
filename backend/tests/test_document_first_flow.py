"""End-to-end tests of the document-first pipeline (spec §4/§5/§6/§9).

Two flows are covered, matching the two branches Fig. 4 draws in the spec:
a confident classification that resolves straight through, and an uncertain
one that falls back to a manual template pick before extraction can run.
"""
from __future__ import annotations


def _get_instrument_id(client, model: str) -> str:
    resp = client.get("/instruments")
    assert resp.status_code == 200
    match = next(i for i in resp.json() if i["model"] == model)
    return match["id"]


def _get_template_id(client, report_type: str, model: str | None = None) -> str:
    params = {"report_type": report_type}
    if model:
        params["model"] = model
    resp = client.get("/report-templates", params=params)
    assert resp.status_code == 200
    templates = resp.json()
    assert templates, f"No template resolved for {report_type}/{model}"
    return templates[0]["id"]


def test_confident_classification_resolves_straight_through(client, run_worker):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    assert report["status"] == "draft"
    assert report["instrument_id"] is None and report["template_id"] is None

    upload = client.post(
        "/reports/{}/attachments".format(report["id"]),
        files={"file": ("aria_pm_2026.pdf", b"%PDF-1.4 fake pm scan", "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()

    # §3/§9: classify only enqueues a job now — nothing runs until the
    # worker (simulated here by run_worker) picks it up.
    submitted = client.post(f"/attachments/{attachment['id']}/classify")
    assert submitted.status_code == 202
    assert submitted.json()["status"] == "pending"
    assert submitted.json()["kind"] == "classify"
    run_worker()

    result = client.get(f"/extraction-jobs/{submitted.json()['id']}").json()
    assert result["status"] == "succeeded"
    classification = result["classification"]
    assert classification["instrument"]["confidence"] >= 0.85
    assert classification["report_type"]["confidence"] >= 0.85
    assert classification["resolved_template_id"] is not None
    assert classification["resolved_instrument_id"] is not None

    refreshed = client.get(f"/reports/{report['id']}").json()
    assert refreshed["status"] == "classified"
    assert refreshed["instrument_id"] == classification["resolved_instrument_id"]
    assert refreshed["template_id"] == classification["resolved_template_id"]

    extraction = client.post(f"/attachments/{attachment['id']}/extract")
    assert extraction.status_code == 202
    assert extraction.json()["kind"] == "extract"
    run_worker()

    job = client.get(f"/extraction-jobs/{extraction.json()['id']}").json()
    assert job["status"] == "succeeded"
    assert job["field_confidences"]

    extracted_report = client.get(f"/reports/{report['id']}").json()
    assert extracted_report["status"] == "extracted"
    assert extracted_report["extracted_fields"]


def test_uncertain_report_type_falls_back_to_manual_pick_then_finalizes(client, run_worker):
    """Reproduces the real BD Care Work Order case from spec §4: instrument
    ID is a confident read, report type is a borderline guess that must be
    confirmed manually before extraction can run against the right template."""
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    upload = client.post(
        "/reports/{}/attachments".format(report["id"]),
        files={"file": ("WO-04587090_sample.pdf", b"%PDF-1.4 fake work order scan", "application/pdf")},
    )
    attachment = upload.json()

    submitted = client.post(f"/attachments/{attachment['id']}/classify")
    assert submitted.status_code == 202
    run_worker()
    result = client.get(f"/extraction-jobs/{submitted.json()['id']}").json()["classification"]
    assert result["instrument"]["value"] == "LSRFortessa"
    assert result["instrument"]["confidence"] >= 0.85
    assert result["report_type"]["value"] == "repair"
    assert result["report_type"]["confidence"] < 0.85  # the whole point: below threshold
    assert result["resolved_template_id"] is None  # not auto-resolved

    still_draft = client.get(f"/reports/{report['id']}").json()
    assert still_draft["status"] == "draft"
    assert still_draft["instrument_id"] is None

    # Manual fallback (§4): confirm the guess was actually right anyway.
    instrument_id = _get_instrument_id(client, "LSRFortessa")
    template_id = _get_template_id(client, "repair")
    confirm = client.patch(
        f"/reports/{report['id']}/template",
        json={"instrument_id": instrument_id, "template_id": template_id},
    )
    assert confirm.status_code == 200
    confirmed = confirm.json()
    assert confirmed["status"] == "classified"
    assert confirmed["instrument_id"] == instrument_id

    extraction = client.post(f"/attachments/{attachment['id']}/extract")
    assert extraction.status_code == 202
    run_worker()
    job = client.get(f"/extraction-jobs/{extraction.json()['id']}").json()
    assert job["status"] == "succeeded"

    extracted = client.get(f"/reports/{report['id']}").json()
    assert extracted["status"] == "extracted"
    # Real values from the sample document (§5), reproduced by the stub.
    assert "fluidics path" in extracted["extracted_fields"]["work_performed"]
    assert extracted["extracted_fields"]["fault_category"] == "fluidics"
    assert extracted["extracted_fields"]["root_cause"] == ""  # genuinely blank on the real form

    # Root cause came back blank at low confidence (§5) — a human fills it in.
    correction = client.patch(
        f"/reports/{report['id']}/fields",
        json={"extracted_fields": {"root_cause": "Sample injector O-ring degraded"}},
    )
    assert correction.status_code == 200
    assert correction.json()["status"] == "in_review"

    finalized = client.post(f"/reports/{report['id']}/finalize")
    assert finalized.status_code == 200
    body = finalized.json()
    assert body["status"] == "finalized"
    assert body["finalized_at"] is not None
    assert body["extracted_fields"]["root_cause"] == "Sample injector O-ring degraded"


def test_cannot_finalize_a_bare_draft(client):
    report = client.post("/reports", json={}).json()
    resp = client.post(f"/reports/{report['id']}/finalize")
    assert resp.status_code == 409


def test_overriding_template_discards_prior_extraction(client, run_worker):
    report = client.post("/reports", json={}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    attachment = upload.json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()

    extracted = client.get(f"/reports/{report['id']}").json()
    assert extracted["extracted_fields"]  # something was extracted

    # "scan.pdf" has no marker (§4's stub), so the auto-classification above
    # is a stable hash of the attachment's storage path — which embeds a
    # fresh uuid4 per upload (see upload_attachment), so it can land on any
    # of the 3 models x 3 report types. There are only 4 distinct template
    # rows in the whole system (§5: calibration splits CS&T/spectral, repair
    # and PM are each one shared row) — picking a *fixed* override target
    # (e.g. always "FACSDiscover S8" / calibration) would flake whenever the
    # random classification already resolved to that same template_id
    # (calibration alone has two models sharing one row), so nothing would
    # actually change and extracted_fields would never get cleared. Instead,
    # pick any template that's guaranteed different from the one just
    # resolved — PATCH .../template doesn't cross-validate instrument vs.
    # template model (see schemas.TemplateConfirmation), so the two only need
    # to each be independently valid.
    all_templates = client.get("/report-templates").json()
    other_template = next(t for t in all_templates if t["id"] != extracted["template_id"])
    other_model = other_template["model"] or "FACSAria III"  # a NULL-model row applies to any non-S8 model
    other_instrument_id = _get_instrument_id(client, other_model)
    overridden = client.patch(
        f"/reports/{report['id']}/template",
        json={"instrument_id": other_instrument_id, "template_id": other_template["id"]},
    ).json()
    assert overridden["status"] == "classified"
    assert overridden["extracted_fields"] == {}  # discarded, per §4/§6
