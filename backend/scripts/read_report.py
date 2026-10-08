"""Reads service report PDFs the way the app does with no API key, and lists
the ones that look like the same document. No database, no network, no model.

    python -m scripts.read_report scan1.pdf scan2.pdf ...

For each file it prints the identifying facts parsed from the PDF's own text
layer (the same code classification and upload use: app/services/text_reader.py)
and what they mean for the app: the instrument model, the serial number, the
task code and the report type it maps to, and the work-order number. Then it
lists probable duplicates: files with identical bytes, and files that name the
same work order. Reading the template's fields (what was done, parts, labor)
needs Claude and is not attempted here.

The instrument models are the seeded fleet's (app/seed_instruments.py); pass
--model "Name" (repeatable) to add or replace them.
"""
from __future__ import annotations

import argparse
import hashlib
from collections import defaultdict
from pathlib import Path

from app.seed_instruments import INSTRUMENTS
from app.services.classification import report_type_from_task_code
from app.services.documents import detect_media_type
from app.services.duplicates import normalize_work_order
from app.services.text_reader import extract_text, read_identifiers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--model", action="append", help="fleet model name (default: the seeded fleet)")
    args = parser.parse_args()
    models = args.model or sorted({spec["model"] for spec in INSTRUMENTS})

    by_hash: dict[str, list[str]] = defaultdict(list)
    by_work_order: dict[str, list[str]] = defaultdict(list)
    for path in args.files:
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        by_hash[digest].append(path.name)
        media_type = detect_media_type(data)
        print(f"\n{path.name}")
        print(f"  sha256        {digest[:16]}…  ({len(data) / 1024:.0f} KB, {media_type or 'not a PDF or image'})")
        text = extract_text(data)
        if not text:
            print("  no text layer — a scan or image; only Claude can read this one")
            continue
        read = read_identifiers(text, models)
        report_type = report_type_from_task_code(read.task_code)
        print(f"  model         {read.model or '—'}")
        print(f"  serial        {read.serial or '—'}")
        print(f"  task code     {read.task_code or '—'}" + (f"  ->  {report_type.value}" if report_type else ""))
        print(f"  work order    {read.work_order_number or '—'}")
        if not read.recognised:
            print("  nothing here looks like a BD service report")
        work_order = normalize_work_order(read.work_order_number)
        if work_order:
            by_work_order[work_order].append(path.name)

    print("\nProbable duplicates")
    found = False
    for digest, names in by_hash.items():
        if len(names) > 1:
            found = True
            print(f"  same file     {', '.join(names)}")
    for work_order, names in by_work_order.items():
        if len(names) > 1:
            found = True
            print(f"  work order    {work_order}: {', '.join(names)}")
    if not found:
        print("  none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
