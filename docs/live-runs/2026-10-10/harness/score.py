"""Scores saved live runs against reference values. usage: score.py <results dir> <raw jsonl> -> prints markdown, writes scores.json next to it."""
import json, glob, os, sys, hashlib, base64, collections
RES, RAW = sys.argv[1], sys.argv[2]

# Aria labor rows (Total Rounded Hours) printed on the form: 6.5 + 7.5 + 12 + 5.75, travel excluded
ARIA_LABOR = round(6.5 + 7.5 + 12 + 5.75, 2)
S8_TOOLS = [("T-000030", "2025-11-17", "2026-11-17"), ("T-4240-003-01", "2025-03-24", "2026-03-24"),
            ("T-000024", "2025-02-03", "2027-02-03"), ("T-000031", "2025-11-17", "2026-11-17")]
def has(t, *words): t = (t or "").lower(); return all(w.lower() in t for w in words)

def score_s8(r):
    cl = r["classify_job"]["classification"]; rp = r["report_after_extract"]; x = rp["extracted_fields"]
    tools = [(t["tool_id"], t["last_calibration_date"], t["next_calibration_date"]) for t in x.get("calibrated_tools") or []]
    wp = x.get("work_performed", ""); comps = x.get("components_replaced") or []
    return {
      "model": cl["instrument"]["value"] == "FACSDiscover S8", "serial": cl["instrument_serial"]["value"] == "MP6651580000057",
      "serial_matched_fleet": cl["serial_match"] == "matched", "type": cl["report_type"]["value"] == "preventive_maintenance",
      "type_from_task_code": cl["report_type_source"] == "task_code", "work_order": cl["work_order_number"] == "WO-04271950",
      "auto_resolved": bool(cl.get("resolved_template_id")), "visit_date": rp["report_date"] == "2026-02-10",
      "labor_hours": x.get("labor_hours") == 6.25,
      "components": len(comps) == 1 and comps[0].get("part_number") == "667009" and comps[0].get("qty") == 1 and has(comps[0].get("part_name"), "pm kit"),
      "calibrated_tools_exact": tools == S8_TOOLS,
      "service_description_key_fact": has(x.get("service_description"), "11 month recurring"),
      "work_performed_key_facts": has(wp, "regel") and has(wp, "3 months") and has(wp, "optical") and has(wp, "cs&t") and has(wp, "image calibration") and has(wp, "accudrop") and has(wp, "ready for use"),
    }
def score_aria(r):
    cl = r["classify_job"]["classification"]; rp = r["report_after_extract"]; x = rp["extracted_fields"]
    comps = x.get("components_replaced") or []; wp = x.get("work_performed", "")
    return {
      "model": cl["instrument"]["value"] == "FACSAria III", "serial": cl["instrument_serial"]["value"] == "P648282B3003",
      "serial_matched_fleet": cl["serial_match"] == "matched", "type": cl["report_type"]["value"] == "repair",
      "type_from_task_code": cl["report_type_source"] == "task_code", "work_order": cl["work_order_number"] == "WO-04215114",
      "auto_resolved": bool(cl.get("resolved_template_id")),
      "visit_date_is_last_labor_day": rp["report_date"] == "2025-11-18",
      "labor_hours": x.get("labor_hours") == ARIA_LABOR,
      "components": len(comps) == 1 and comps[0].get("part_number") == "644651" and comps[0].get("qty") == 1,
      "root_cause_key_fact": has(x.get("root_cause"), "stream") and has(x.get("root_cause"), "fsc"),
      "fault_description_key_fact": has(x.get("fault_description"), "stream is unstable"),
      "work_performed_key_facts": all(has(wp, w) for w in ("ball seal", "sheath regulator", "sample regulator", "o-rings", "2.4psi", "baseline and performance")) and (has(wp, "ready to use") or has(wp, "ready for use")),
    }
out = collections.OrderedDict(); allrows = []
for f in sorted(glob.glob(RES + "/run[12]_*.json")):
    r = json.load(open(f)); lab = r["label"]
    sc = score_s8(r) if lab.startswith("s8") else score_aria(r)
    out[os.path.basename(f)] = sc; allrows.append((os.path.basename(f), sc))
json.dump(out, open(os.path.join(RES, "..", "scores.json"), "w"), indent=1)
for name, sc in allrows:
    bad = [k for k, v in sc.items() if not v]
    print(f"{name}: {sum(sc.values())}/{len(sc)} checks pass" + (f"  FAILED: {bad}" if bad else ""))

# raw responses: tokens, ids, and which file each call belongs to (matched by sha256 of the base64 document sent)
fileshas = {}
for f in glob.glob(RES + "/*.json"):
    r = json.load(open(f)); fileshas[r["sha256"]] = r["file"]
calls = tot_in = tot_out = errs = 0
for line in open(RAW):
    d = json.loads(line); calls += 1
    if "error" in d: errs += 1; continue
    u = d["response"]["usage"]; tot_in += u["input_tokens"]; tot_out += u["output_tokens"]
print(f"raw responses: {calls} calls, {errs} errors, {tot_in} input tokens, {tot_out} output tokens")
