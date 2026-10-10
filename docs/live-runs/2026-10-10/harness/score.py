"""Scores saved live runs against reference values.
usage: score.py <results dir> <raw jsonl>
Writes scores.json next to the results dir and prints a plain-text summary.

References:
- Test Set page ("Service Report Test Set") for Fortessa 2024 and its re-scan, Aria intervention form,
  S8 PM, S8 upgrade and Fortessa 2021.
- The printed text of the Aria WO-04215114 report (not on the Test Set page), checked by hand.
Free text passes when it carries the key facts and none of the listed traps.
"""
import json, glob, os, sys, collections, statistics

RES, RAW = sys.argv[1], sys.argv[2]

ARIA_LABOR = round(6.5 + 7.5 + 12 + 5.75, 2)  # Total Rounded Hours printed on the form, travel excluded
S8_TOOLS = [("T-000030", "2025-11-17", "2026-11-17"), ("T-4240-003-01", "2025-03-24", "2026-03-24"),
            ("T-000024", "2025-02-03", "2027-02-03"), ("T-000031", "2025-11-17", "2026-11-17")]


def has(t, *words):
    t = (t or "").lower()
    return all(w.lower() in t for w in words)


def ready(t):
    return has(t, "ready to use") or has(t, "ready for use")


def blob(x):
    return json.dumps(x, ensure_ascii=False).lower()


def ident(r, model, serial, rtype, wo, date):
    cl = r["classify_job"]["classification"]
    rp = r["report_after_extract"]
    return {
        "reader_is_model": cl.get("reader") == "model",
        "model": cl["instrument"]["value"] == model,
        "serial": cl["instrument_serial"]["value"] == serial,
        "serial_matched_fleet": cl["serial_match"] == "matched",
        "type": cl["report_type"]["value"] == rtype,
        "type_from_task_code": cl["report_type_source"] == "task_code",
        "work_order": cl["work_order_number"] == wo,
        "auto_resolved": bool(cl.get("resolved_template_id")),
        "visit_date": rp["report_date"] == date,
    }


def fx(r):
    return r["report_after_extract"]["extracted_fields"]


def s_s8pm(r):
    x = fx(r)
    tools = [(t["tool_id"], t["last_calibration_date"], t["next_calibration_date"]) for t in x.get("calibrated_tools") or []]
    comps = x.get("components_replaced") or []
    wp = x.get("work_performed", "")
    d = ident(r, "FACSDiscover S8", "MP6651580000057", "preventive_maintenance", "WO-04271950", "2026-02-10")
    d.update({
        "labor_hours": x.get("labor_hours") == 6.25,
        "components": len(comps) == 1 and comps[0].get("part_number") == "667009" and comps[0].get("qty") == 1 and has(comps[0].get("part_name"), "pm kit"),
        "calibrated_tools_exact": tools == S8_TOOLS,
        "service_description_key_fact": has(x.get("service_description"), "11 month recurring"),
        "work_performed_key_facts": all(has(wp, w) for w in ("regel", "3 months", "optical", "cs&t", "image calibration", "accudrop")) and ready(wp),
    })
    return d


def s_aria2025(r):
    x = fx(r)
    comps = x.get("components_replaced") or []
    wp = x.get("work_performed", "")
    d = ident(r, "FACSAria III", "P648282B3003", "repair", "WO-04215114", "2025-11-18")
    d.update({
        "labor_hours": x.get("labor_hours") == ARIA_LABOR,
        "components": len(comps) == 1 and comps[0].get("part_number") == "644651" and comps[0].get("qty") == 1,
        "root_cause_key_fact": has(x.get("root_cause"), "stream") and has(x.get("root_cause"), "fsc"),
        "fault_description_key_fact": has(x.get("fault_description"), "stream is unstable"),
        "work_performed_key_facts": all(has(wp, w) for w in ("ball seal", "sheath regulator", "sample regulator", "o-rings", "2.4psi", "baseline and performance")) and ready(wp),
    })
    return d


def s_fortessa2024(r):
    x = fx(r)
    wp = x.get("work_performed", "")
    rc = x.get("root_cause")
    d = ident(r, "LSRFortessa", "R647794E6092", "repair", "WO-03424229", "2024-04-11")
    d.update({
        "labor_hours": x.get("labor_hours") == 3.75,
        "components_empty": (x.get("components_replaced") or []) == [],
        "fault_description_key_fact": has(x.get("fault_description"), "facsflow"),
        "root_cause_key_fact": has(rc, "wet cart") and (has(rc, "sheath") or has(rc, "sheet")),
        "work_performed_key_facts": has(wp, "pumps") and has(wp, "resistance") and has(wp, "probes") and ready(wp),
        "no_calibrated_tools_row": "pressure" not in blob(x) and "gauge" not in blob(x),
    })
    return d


def s_fortessa2021(r):
    x = fx(r)
    wp = x.get("work_performed", "")
    d = ident(r, "LSRFortessa", "R647794E6092", "repair", "WO-01915704", "2021-05-18")
    d.update({
        "labor_hours": x.get("labor_hours") == 1.5,
        "components_empty": (x.get("components_replaced") or []) == [],
        "root_cause_empty": (x.get("root_cause") or "") == "",
        "fault_description_key_fact": has(x.get("fault_description"), "cst"),
        "work_performed_key_facts": has(wp, "optical alignment") and has(wp, "optical cleaning") and has(wp, "cs&t") and ready(wp),
        "no_signoff_in_fields": "zvi" not in blob(x),
    })
    return d


def s_s8upgrade(r):
    x = fx(r)
    wp = x.get("work_performed", "")
    sd = x.get("service_description", "")
    d = ident(r, "FACSDiscover S8", "MP6651580000057", "installation_upgrade", "WO-04482628", "2026-06-16")
    d.update({
        "labor_hours": x.get("labor_hours") == 8,
        "parts_empty": (x.get("parts_used") or []) == [],
        "service_description_key_fact": has(sd, "6.2") and has(sd, "6.3") and "s/n" not in sd.lower() and "r6651580000057" not in sd.lower(),
        "work_performed_key_facts": has(wp, "6.2") and has(wp, "6.3") and has(wp, "nozzles") and ready(wp),
        "wrong_serial_not_used": "r6651580000057" not in blob(x),
    })
    return d


def s_ariaform(r):
    x = fx(r)
    wp = x.get("work_performed", "")
    d = ident(r, "FACSAria III", "P648282B3003", "repair", None, "2024-03-17")
    d.update({
        "labor_hours": x.get("labor_hours") == 5,
        "components_empty": (x.get("components_replaced") or []) == [],
        "root_cause_key_fact": has(x.get("root_cause"), "flow cell", "optical"),
        "fault_description_key_fact": has(x.get("fault_description"), "cst") and has(x.get("fault_description"), "violet") and has(x.get("fault_description"), "red"),
        "work_performed_key_facts": has(wp, "flow cell") and has(wp, "optical") and has(wp, "cst") and ready(wp),
        "filename_work_order_not_used": "03376771" not in blob(x),
    })
    return d


SCORERS = {
    "s8-pm": s_s8pm,
    "aria-repair-2025": s_aria2025,
    "fortessa-2024": s_fortessa2024,
    "fortessa-rescan-2024": s_fortessa2024,
    "fortessa-2021": s_fortessa2021,
    "s8-upgrade": s_s8upgrade,
    "aria-form": s_ariaform,
}

out = collections.OrderedDict()
print("== Extraction scores (classification + template fields)")
for f in sorted(glob.glob(RES + "/run[12]*.json")):
    r = json.load(open(f))
    if "report_after_extract" not in r:
        continue
    sc = SCORERS[r["label"]](r)
    out[os.path.basename(f)] = sc
    bad = [k for k, v in sc.items() if not v]
    print(f"{os.path.basename(f)}: {sum(sc.values())}/{len(sc)}" + (f"  FAILED: {bad}" if bad else ""))

# Duplicate-flag checks: (file, upload flags expected, classification flags expected, description)
print("\n== Duplicate flags (upload / classification)")
EXPECT = [
    ("run1_fortessa-2024_1.json", "none", "none", "first upload of Fortessa 2024"),
    ("run3_fortessa-2024-identical_1.json", "some", "some", "identical bytes of Fortessa 2024"),
    ("run1_fortessa-rescan-2024_1.json", "none", "some", "re-scan: different bytes, matched by WO-03424229 at classification"),
    ("run1_fortessa-2021_1.json", "none", "none", "Fortessa 2021 after 2024: same instrument, different WO"),
    ("run1b_s8-pm_1.json", "none", "none", "S8 PM"),
    ("run1_s8-upgrade_1.json", "none", "none", "S8 upgrade alongside S8 PM"),
    ("run1_aria-form_1.json", "none", "none", "Aria form has no WO, never flagged by one"),
    ("run3_aria-v3_1.json", "none", "none", "Aria WO-04215114, first upload (earlier fresh DB)"),
    ("run3_aria-v3_1-identical_1.json", "some", "some", "Aria WO-04215114 identical bytes (earlier fresh DB)"),
]
dup = collections.OrderedDict()
for name, up_exp, cl_exp, what in EXPECT:
    r = json.load(open(os.path.join(RES, name)))
    u = len(r["upload"]["body"]["duplicate_report_ids"])
    c = len(r["classify_job"]["classification"].get("duplicate_report_ids", []))
    ok = ((u == 0) == (up_exp == "none")) and ((c == 0) == (cl_exp == "none")) and r["upload"]["status"] == 201 and r["classify_job"]["status"] == "succeeded"
    dup[name] = {"what": what, "upload_flags": u, "classification_flags": c, "as_expected": ok}
    print(f"{'PASS' if ok else 'FAIL'}  {what}: upload {u}, classification {c}")
out["_duplicate_checks"] = dup

json.dump(out, open(os.path.join(RES, "..", "scores.json"), "w"), indent=1)

calls = errs = tin = tout = 0
secs = []
for line in open(RAW):
    d = json.loads(line)
    calls += 1
    if "error" in d:
        errs += 1
        continue
    u = d["response"]["usage"]
    tin += u["input_tokens"]
    tout += u["output_tokens"]
    secs.append((d["request"].get("tool_choice", {}).get("name") == "record_extraction", d["elapsed_s"]))
cl = [s for big, s in secs if not big]
ex = [s for big, s in secs if big]
print(f"\nraw responses: {calls} calls, {errs} errors, {tin} input tokens, {tout} output tokens")
print(f"classification-sized calls {len(cl)} avg {statistics.mean(cl):.1f}s; extraction-sized {len(ex)} avg {statistics.mean(ex):.1f}s max {max(ex):.1f}s")
