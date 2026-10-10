"""Launches the app's worker with every Anthropic messages.create call recorded.
Lives outside the repo; writes full raw responses to $CAPTURE_FILE (JSON Lines).
Base64 document/image payloads are replaced by size + sha256 in the request record."""
import hashlib, json, os, time, datetime
from anthropic.resources.messages import Messages

CAPTURE = os.environ["CAPTURE_FILE"]
_orig = Messages.create

def _scrub(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "data" and isinstance(v, str) and len(v) > 500:
                out[k] = {"base64_bytes": len(v), "sha256": hashlib.sha256(v.encode()).hexdigest()}
            else:
                out[k] = _scrub(v)
        return out
    if isinstance(obj, list):
        return [_scrub(x) for x in obj]
    return obj

def create(self, *a, **kw):
    t0 = time.time()
    rec = {"ts": datetime.datetime.utcnow().isoformat() + "Z", "request": _scrub(json.loads(json.dumps(kw, default=str)))}
    try:
        resp = _orig(self, *a, **kw)
        rec["elapsed_s"] = round(time.time() - t0, 2)
        rec["response"] = resp.model_dump(mode="json")
        return resp
    except Exception as e:
        rec["elapsed_s"] = round(time.time() - t0, 2)
        rec["error"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        with open(CAPTURE, "a") as f:
            f.write(json.dumps(rec) + "\n")

Messages.create = create

from app.worker import run_forever  # noqa: E402
if __name__ == "__main__":
    run_forever()
