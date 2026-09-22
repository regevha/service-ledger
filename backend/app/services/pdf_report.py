"""Renders a single report as a formatted PDF (§7/§11 — "PDF report
generation," the one Phase 2 item shipped ahead of plan alongside the
structured template/instrument editors, following the same precedent §11
already documents for those).

Deliberately mirrors the review screen (FieldEditor.tsx/App.tsx) rather than
inventing a second, parallel layout: it walks the resolved template's
field_schema in the same order, uses the same "replace underscores with
spaces" label rule, and the same per-type value shapes (a boolean's Yes/No,
an enum[]'s comma list, an object[]'s row table, a number[detector]/
number[laser] map's key: value pairs) — so a PDF handed to someone outside
the system always matches what the technician actually reviewed and
finalized on screen, rather than drifting into its own formatting rules.

A pure function of an already-loaded Report (report.instrument and
report.template are read, so callers should have them available — SQLAlchemy
will lazy-load them within the request's session if not) — no I/O beyond
building bytes in memory, same shape as export_reports' CSV buffer.
"""
from __future__ import annotations

from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app import models
from app.schemas import TemplateFieldType

_REPORT_TYPE_LABEL = {
    models.ReportType.calibration: "Calibration",
    models.ReportType.repair: "Malfunction / repair",
    models.ReportType.preventive_maintenance: "Preventive maintenance",
}

_STATUS_LABEL = {
    models.ReportStatus.draft: "Draft",
    models.ReportStatus.classified: "Classified",
    models.ReportStatus.extracted: "Extracted",
    models.ReportStatus.in_review: "In review",
    models.ReportStatus.finalized: "Finalized",
}

_EM_DASH = "—"


def _label(name: str) -> str:
    """The exact field.name.replace(/_/g, ' ') rule FieldEditor.tsx/App.tsx
    use for a review-screen field label — kept identical on purpose (see
    module docstring)."""
    return name.replace("_", " ")


def _safe(text: str) -> str:
    """Escapes for ReportLab's mini-HTML Paragraph markup and turns real
    newlines into <br/> — a multi-line "Work Performed" narrative (repair's
    biggest text field) would otherwise collapse onto one line, since
    Paragraph treats a literal "\\n" as whitespace like HTML does."""
    return escape(text).replace("\n", "<br/>")


def _format_value(field: dict, value: object) -> str:
    """Everything except object[] (handled separately as its own table in
    render_report_pdf, since a table can't collapse into one Paragraph
    string) resolves to a single display string.

    Booleans are checked before the generic "missing" test below — `False`
    is a real, meaningful value (not "unset"), and `False in (None, "")` is
    also just plain False in Python, but being explicit here means that
    fact never has to be re-derived by whoever reads this next."""
    field_type = field.get("type")
    unit = field.get("unit")

    if field_type == TemplateFieldType.boolean and isinstance(value, bool):
        return "Yes" if value else "No"
    if field_type == TemplateFieldType.enum_list:
        items = value if isinstance(value, list) else []
        return ", ".join(escape(str(v)) for v in items) if items else _EM_DASH
    if field_type in (TemplateFieldType.number_detector, TemplateFieldType.number_laser):
        entries = value if isinstance(value, dict) else {}
        if not entries:
            return _EM_DASH
        suffix = f" {escape(unit)}" if unit else ""
        return ", ".join(f"{escape(str(k))}: {escape(str(v))}{suffix}" for k, v in entries.items())

    if value in (None, ""):
        return _EM_DASH
    if field_type == TemplateFieldType.text:
        return _safe(str(value))
    if field_type == TemplateFieldType.number and isinstance(value, (int, float)) and not isinstance(value, bool):
        # int-valued floats (extraction/stub data is JSON, so a whole number
        # still round-trips as e.g. 2.0) print as "2", not "2.0" — %g drops
        # the trailing zero the way a technician would actually write it.
        number_text = f"{value:g}" if isinstance(value, float) else str(value)
        return f"{number_text} {escape(unit)}" if unit else number_text
    return escape(str(value))


def render_report_pdf(report: models.Report) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=LETTER,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        title=f"ServiceLedger report {report.id}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("SLTitle", parent=styles["Title"], fontSize=18, alignment=0, spaceAfter=2)
    subtitle_style = ParagraphStyle("SLSubtitle", parent=styles["Normal"], fontSize=12, textColor=colors.HexColor("#555555"))
    section_style = ParagraphStyle("SLSection", parent=styles["Heading2"], fontSize=13, spaceBefore=16, spaceAfter=6)
    label_style = ParagraphStyle("SLFieldLabel", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#666666"))
    value_style = ParagraphStyle("SLFieldValue", parent=styles["Normal"], fontSize=11, spaceAfter=10, leading=14)
    note_style = ParagraphStyle("SLNote", parent=styles["Normal"], fontSize=8, textColor=colors.HexColor("#999999"), spaceAfter=10)
    table_cell_style = ParagraphStyle("SLTableCell", parent=styles["Normal"], fontSize=9, leading=11)
    table_head_style = ParagraphStyle("SLTableHead", parent=table_cell_style, textColor=colors.white)

    instrument = report.instrument
    template = report.template
    report_type_label = _REPORT_TYPE_LABEL.get(template.report_type, "Report") if template else "Report"

    story = [
        Paragraph("ServiceLedger &mdash; Service Report", title_style),
        Paragraph(escape(report_type_label), subtitle_style),
        Spacer(1, 10),
        HRFlowable(width="100%", thickness=0.75, color=colors.HexColor("#dddddd")),
        Spacer(1, 10),
    ]

    meta_rows: list[tuple[str, str]] = []
    if instrument:
        meta_rows.append(("Instrument", escape(f"{instrument.model} ({instrument.serial_number})")))
    meta_rows.append(("Status", escape(_STATUS_LABEL.get(report.status, report.status.value))))
    meta_rows.append(("Technician", escape(report.technician_name) if report.technician_name else _EM_DASH))
    meta_rows.append(("Report date", report.report_date.isoformat() if report.report_date else _EM_DASH))
    if report.finalized_at:
        meta_rows.append(("Finalized", report.finalized_at.strftime("%Y-%m-%d %H:%M UTC")))

    meta_table = Table(
        [[Paragraph(f"<b>{k}</b>", label_style), Paragraph(v, value_style)] for k, v in meta_rows],
        colWidths=[1.4 * inch, 4.6 * inch],
    )
    meta_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    story.append(meta_table)

    if template:
        story.append(Paragraph("Fields", section_style))
        extracted = report.extracted_fields or {}
        for field in template.field_schema.get("fields", []):
            name = field.get("name", "")
            unit = field.get("unit")
            label = escape(_label(name)) + (f" ({escape(unit)})" if unit else "")
            value = extracted.get(name)

            story.append(Paragraph(label, label_style))

            if field.get("type") == TemplateFieldType.object_list:
                rows = value if isinstance(value, list) else []
                # item_schema is a list of {name, type} columns, not a dict —
                # see ItemSchemaColumn's docstring (schemas.py): a dict's key
                # order doesn't survive Postgres's JSONB storage, a JSON
                # array's element order does.
                columns = [col["name"] for col in field.get("item_schema") or []]
                if rows and columns:
                    table_data = [[Paragraph(f"<b>{escape(_label(c))}</b>", table_head_style) for c in columns]]
                    for row in rows:
                        table_data.append(
                            [
                                Paragraph(escape(str(row.get(c))) if row.get(c) not in (None, "") else _EM_DASH, table_cell_style)
                                for c in columns
                            ]
                        )
                    col_width = 5.0 * inch / len(columns)
                    obj_table = Table(table_data, colWidths=[col_width] * len(columns))
                    obj_table.setStyle(
                        TableStyle(
                            [
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4a5568")),
                                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dddddd")),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                                ("TOPPADDING", (0, 0), (-1, -1), 4),
                                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ]
                        )
                    )
                    story.append(obj_table)
                    story.append(Spacer(1, 10))
                else:
                    story.append(Paragraph(_EM_DASH, value_style))
            else:
                story.append(Paragraph(_format_value(field, value), value_style))

            notes = field.get("notes")
            if notes:
                story.append(Paragraph(escape(notes), note_style))

    doc.build(story)
    return buffer.getvalue()
