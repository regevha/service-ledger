"""The sample service report behind the "Try a sample report" button.

A new visitor usually has no scanned service form at hand, so the New report
tab can fetch this one and run it through the ordinary upload -> classify ->
review flow. It is a one-page text PDF laid out like a BD work-order report
for the fleet's LSRFortessa, so the app reads it without an API key
(services/text_reader.py finds the model, serial, task code and work-order
number in its text layer) and a live model has real content to extract.

Every call produces a different work-order number, and with it different file
bytes, because the app refuses a file whose exact bytes are already on file
(409 "already on file") and flags a repeated work-order number: the button can
be pressed again and again. The numbers start with 9 so they do not collide
with a real BD number, and the page says in its first lines that it is sample
data, so nobody mistakes it for a service record.
"""
from __future__ import annotations

import secrets
import textwrap

# One fleet instrument, as seeded by seed_instruments.py. If the unit was
# deleted the report still reads (the model matches the fleet's by name only
# when the unit exists), and the review screen offers the usual manual pick.
_PRODUCT_LINE = "647794E6 - LSRFortessa SO"
_SERIAL = "R647794E6092"


def _lines(work_order: str) -> list[str]:
    return [
        "SAMPLE DOCUMENT - fictional data for trying out ServiceLedger. Not a service record.",
        "",
        "BD Care EU - Work Order Service Report",
        f"WORK ORDER NUMBER: {work_order}",
        "Work Order Task Code",
        "T113 Repair / Troubleshooting Visit",
        "",
        "Installed Product",
        _PRODUCT_LINE,
        "Serial Number",
        _SERIAL,
        "Location: Core Lab",
        "",
        "Fault description",
        "Sort stream drifts during long runs; side streams need re-adjusting every hour.",
        "Root cause",
        "Worn sheath filter and a loose fitting on the sheath line.",
        "Work performed",
        "Replaced the sheath filter and tightened the sheath line fitting. Primed the fluidics",
        "several times and ran a 3 hour sort test: the stream stayed stable. Ran CS&T",
        "performance check, passed. System is ready for use.",
        "",
        "Parts used",
        "Part number    Description               Qty",
        "340345         Sheath filter assembly    1",
        "",
        "Labor hours: 2.5",
        "Retest result: pass",
        "Customer signature: ______________________",
    ]


def _pdf(lines: list[str]) -> bytes:
    """A minimal, well-formed one-page PDF whose text layer holds `lines` (a
    real cross-reference table, so pypdf can read it). Long lines are wrapped
    so nothing runs off the page."""
    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(textwrap.wrap(line, width=92) or [""])
    ops = ["BT", "/F1 11 Tf", "13 TL", "50 750 Td"]
    for line in wrapped:
        text = line.encode("latin-1", errors="replace").decode("latin-1")
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        ops.append(f"({escaped}) Tj T*")
    ops.append("ET")
    stream = "\n".join(ops).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def build_sample_report() -> tuple[str, bytes]:
    """(file name, PDF bytes) of a new sample report, different every call."""
    work_order = f"WO-9{secrets.randbelow(10_000_000):07d}"
    return f"sample-service-report-{work_order}.pdf", _pdf(_lines(work_order))
