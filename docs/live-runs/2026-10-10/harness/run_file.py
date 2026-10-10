"""Drives one file through create -> upload -> classify -> (extract) via the live API and saves everything.
usage: run_file.py <label> <pdf path> [--runs N] [--classify-only]"""
import argparse, hashlib, json, os, sys, time, datetime
import httpx
B = "http://localhost:8000"
OUT = os.environ["RESULTS_DIR"]
ap = argparse.ArgumentParser()
ap.add_argument("label"); ap.add_argument("path"); ap.add_argument("--runs", type=int, default=1)
ap.add_argument("--classify-only", action="store_true"); ap.add_argument("--tag", default="run1")
a = ap.parse_args()
c = httpx.Client(base_url=B, timeout=180)

def poll(jid):
    for _ in range(120):
        j = c.get(f"/extraction-jobs/{jid}").json()
        if j["status"] not in ("pending", "classifying", "extracting", "in_progress", "running"):
            return j
        time.sleep(2)
    return j

data = open(a.path, "rb").read()
for i in range(1, a.runs + 1):
    rec = {"label": a.label, "tag": a.tag, "repeat": i, "file": os.path.basename(a.path),
           "sha256": hashlib.sha256(data).hexdigest(), "started": datetime.datetime.utcnow().isoformat() + "Z"}
    rid = c.post("/reports", json={}).json()["id"]; rec["report_id"] = rid
    up = c.post(f"/reports/{rid}/attachments", files={"file": (os.path.basename(a.path), data, "application/pdf")})
    rec["upload"] = {"status": up.status_code, "body": up.json()}
    aid = up.json()["id"]
    cl = c.post(f"/attachments/{aid}/classify"); cj = poll(cl.json()["id"]); rec["classify_job"] = cj
    rec["report_after_classify"] = c.get(f"/reports/{rid}").json()
    if not a.classify_only and cj["status"] == "succeeded" and rec["report_after_classify"].get("template_id"):
        ex = c.post(f"/attachments/{aid}/extract"); ej = poll(ex.json()["id"]); rec["extract_job"] = ej
        rec["report_after_extract"] = c.get(f"/reports/{rid}").json()
    name = f"{a.tag}_{a.label}_{i}.json"
    json.dump(rec, open(os.path.join(OUT, name), "w"), indent=1, default=str)
    print(name, "classify:", cj["status"], "| extract:", rec.get("extract_job", {}).get("status", "-"))
