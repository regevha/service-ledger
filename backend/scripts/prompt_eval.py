"""Replays real documents through the live prompts and scores the answers, so a
prompt change can be judged on evidence instead of a guess.

    python -m scripts.prompt_eval CASES_DIR            # live: calls Claude (needs ANTHROPIC_API_KEY)
    python -m scripts.prompt_eval CASES_DIR --dry-run  # no call: builds each prompt and prints its hash

CASES_DIR holds one `<name>.expected.json` per case, next to the PDF it names
(see prompt_eval_example.json for the format). Keep it OUTSIDE the repository:
real service reports hold customer data. No database is used; the instruments
are the seeded fleet and the templates are the seeded ones.

Each case can score:
  classify  instrument_model, report_type, serial, work_order  (what the screen would show)
  extract   fields (name -> expected value) and report_date, under a seeded
            template picked by `report_type` and `model`
The report prints a hash of every prompt, so two runs are comparable only when
the hash is the same (or changed on purpose), plus pass/fail per value.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from app.config import get_settings
from app.seed_instruments import INSTRUMENTS
from app.seed_templates import TEMPLATE_ROWS
from app.services import claude_client, classification, extraction, prompt_gate


def _norm(value):
    if isinstance(value, str):
        return " ".join(value.split()).casefold()
    if isinstance(value, float):
        return round(value, 2)
    if isinstance(value, list):
        return [_norm(v) for v in value]
    if isinstance(value, dict):
        return {k: _norm(v) for k, v in sorted(value.items())}
    return value


def _same(got, want) -> bool:
    if isinstance(want, (int, float)) and isinstance(got, (int, float)) and not isinstance(want, bool):
        return abs(float(got) - float(want)) < 0.01
    return _norm(got) == _norm(want)


def _instruments() -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            model=i["model"], manufacturer=i.get("manufacturer"), serial_number=i["serial_number"],
            instrument_type=i.get("instrument_type", "facs"),
        )
        for i in INSTRUMENTS
    ]


def _template_fields(report_type: str, model: str | None) -> list[dict]:
    rows = {(rt, m): fields for rt, m, fields in TEMPLATE_ROWS}
    fields = rows.get((report_type, model)) or rows.get((report_type, None))
    if fields is None:
        raise SystemExit(f"No seeded template for report_type={report_type!r} model={model!r}")
    return fields


def _prompt_hash(preview: dict) -> str:
    material = json.dumps(
        {"text": [b.get("text") for b in preview["blocks"] if b["type"] == "text"], "tools": preview["tools"]},
        sort_keys=True, ensure_ascii=False,
    )
    return hashlib.sha256(material.encode()).hexdigest()[:12]


def _preview_of(call) -> dict:
    """Run `call` with the gate closed: it stops at the Claude call and gives the prompt."""
    token = prompt_gate.approved_var.set(False)
    try:
        call()
    except prompt_gate.PromptApprovalNeeded as stop:
        return stop.preview
    finally:
        prompt_gate.approved_var.reset(token)
    raise RuntimeError("the call went through without stopping")


def run_case(path: Path, dry_run: bool) -> tuple[list[tuple[str, bool, object, object]], dict[str, str]]:
    spec = json.loads(path.read_text(encoding="utf-8"))
    pdf = (path.parent / spec["file"]).resolve()
    attachment = SimpleNamespace(file_path=str(pdf), translations=[])
    checks: list[tuple[str, bool, object, object]] = []
    hashes: dict[str, str] = {}
    settings = claude_client.settings

    if "classify" in spec:
        call = lambda: classification._live_classify(None, attachment, _instruments())  # noqa: E731
        settings.view_prompts = True
        hashes["classify"] = _prompt_hash(_preview_of(call))
        if not dry_run:
            settings.view_prompts = False
            read = classification.DocumentRead(*call())
            got = {
                "instrument_model": read.instrument.value,
                "report_type": read.report_type.value,
                "serial": read.serial.value if read.serial else None,
                "work_order": read.work_order_number,
            }
            for key, want in spec["classify"].items():
                checks.append((f"classify.{key}", _same(got.get(key), want), got.get(key), want))

    if "extract" in spec:
        ex = spec["extract"]
        fields = _template_fields(ex["report_type"], ex.get("model"))
        template = SimpleNamespace(field_schema={"fields": fields})
        call = lambda: extraction._live_extract(attachment, template)  # noqa: E731
        settings.view_prompts = True
        hashes["extract"] = _prompt_hash(_preview_of(call))
        if not dry_run:
            settings.view_prompts = False
            result = call()
            for name, want in (ex.get("fields") or {}).items():
                checks.append((f"extract.{name}", _same(result.extracted_fields.get(name), want),
                               result.extracted_fields.get(name), want))
            if "report_date" in ex:
                got_date = result.report_date.isoformat() if isinstance(result.report_date, date) else None
                checks.append(("extract.report_date", got_date == ex["report_date"], got_date, ex["report_date"]))
    return checks, hashes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cases_dir", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="build the prompts and print their hashes; no Claude call")
    parser.add_argument("--only", help="run only the case files whose name contains this text")
    parser.add_argument("--out", type=Path, help="also write the results as JSON here")
    args = parser.parse_args()

    settings = get_settings()
    if not args.dry_run and not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY is not set; use --dry-run to only build the prompts.", file=sys.stderr)
        return 2
    files = sorted(p for p in args.cases_dir.glob("*.expected.json") if not args.only or args.only in p.name)
    if not files:
        print(f"No *.expected.json files in {args.cases_dir}", file=sys.stderr)
        return 2

    passed = failed = 0
    report = []
    for path in files:
        checks, hashes = run_case(path, args.dry_run)
        print(f"\n{path.name}  prompts: " + ", ".join(f"{k}={v}" for k, v in hashes.items()))
        for name, ok, got, want in checks:
            passed += ok
            failed += not ok
            print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"   got {got!r}, expected {want!r}"))
        report.append({"case": path.name, "prompts": hashes,
                       "checks": [{"name": n, "pass": ok, "got": g, "expected": w} for n, ok, g, w in checks]})
    if not args.dry_run:
        print(f"\n{passed} passed, {failed} failed")
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
