"""Builds the synthetic PDFs the Playwright specs upload or read (SL-62, D-13).

Every value here is invented: the institutions, dates and technician names are
made up, and the instrument serial is the demo-fleet serial from
backend/app/seed_instruments.py. Nothing is copied from a vendor document.

Run from the repository root with the backend venv (reportlab is already in
backend/requirements.txt):

    backend/.venv/bin/python frontend/tests/e2e/fixtures/generate_synthetic_pdfs.py

The output is deterministic (invariant mode: no creation date, no random IDs),
so re-running it leaves the committed files byte-identical.

Each file is built to take the same path through the stub-mode readers that
the spec expectations were written against:

* synthetic-confident-scan.pdf: a BD-format text layer (Installed Product line,
  serial, task code). classification.py reads it as a confident repair on the
  LSRFortessa, which the seeded fleet holds.
* synthetic-sample-work-order.pdf: no text layer (a scan). The stub's
  sample-document rule applies (the name contains "sample-work-order"), so the
  type is the uncertain call that stops at the manual pick.
* synthetic-pick-fields-form.pdf: a plain text layer with the values the
  pick-fields specs look for ("Laser delay 29.40", "Technician: Dana Levi").
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent


def _text_page(c: canvas.Canvas, lines: list[str]) -> None:
    y = A4[1] - 60
    for index, line in enumerate(lines):
        c.setFont("Helvetica-Bold" if index == 0 else "Helvetica", 12 if index == 0 else 10)
        c.drawString(50, y, line)
        y -= 20 if index == 0 else 16
    c.showPage()


def build_confident_scan(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle("Synthetic service report")
    _text_page(
        c,
        [
            "BD Care Work Order Service Report (synthetic test document)",
            "Institution: Harbor Clinical Lab",
            "Service date: 2026-03-14",
            "Installed Product 647794E6 - LSRFortessa SO",
            "Serial Number: R647794E6092",
            "Work Order Task Code T113 Repair / Troubleshooting Visit",
            "Subject: No events on the sample channel",
            "Description: Fluidics pressure low during the run",
        ],
    )
    c.save()


def build_sample_work_order(path: Path) -> None:
    # A scan: drawn strokes only, no text layer. The stub reads the name, not the page.
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle("Synthetic scanned work order")
    c.rect(40, 80, A4[0] - 80, A4[1] - 160, stroke=1, fill=0)
    for row in range(12):
        y = A4[1] - 120 - row * 40
        c.line(60, y, A4[0] - 60, y)
    c.showPage()
    c.save()


def build_pick_fields_form(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle("Synthetic form for picking fields")
    _text_page(
        c,
        [
            "Synthetic Calibration Form (test document)",
            "Institution: Riverside Core Lab",
            "Date: 2026-05-02",
            "Laser delay 29.40",
            "Technician: Dana Levi",
            "Notes: Checked against the invented reference beads",
        ],
    )
    c.save()


def main() -> None:
    build_confident_scan(HERE / "synthetic-confident-scan.pdf")
    build_sample_work_order(HERE / "synthetic-sample-work-order.pdf")
    build_pick_fields_form(HERE / "synthetic-pick-fields-form.pdf")


if __name__ == "__main__":
    main()
