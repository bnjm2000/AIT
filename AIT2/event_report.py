"""Professional PDF report for an event's operational details."""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
import os

from quotation_pdf import _canvas_font, _paragraph
from workforce_schedule import (
    SHOWBASE_BORDER,
    SHOWBASE_GREEN,
    SHOWBASE_INK,
    SHOWBASE_MUTED,
    _contrast_colour,
    _darken_colour,
    _safe_colour,
)


def _text(value, fallback="-"):
    clean = str(value or "").strip()
    return clean or fallback


def _date_label(value):
    raw = str(value or "").strip()
    for pattern in ("%Y-%m-%d", "%Y%m%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, pattern).strftime("%d %B %Y").lstrip("0")
        except ValueError:
            continue
    return raw or "-"


def build_event_report_pdf(payload, *, company=None, logo_path="", generated_by=""):
    """Return a complete, CJK-capable event operations PDF."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import HRFlowable, KeepTogether, SimpleDocTemplate, Spacer, Table, TableStyle

    event = payload.get("event") or {}
    company = company or payload.get("company") or {}
    page_width, page_height = A4
    margin = 11 * mm
    accent_hex = _safe_colour(company.get("themeColor"), SHOWBASE_GREEN)
    accent = colors.HexColor(accent_hex)
    header_hex = accent_hex if _contrast_colour(accent_hex) == "#FFFFFF" else _darken_colour(accent_hex)
    header_accent = colors.HexColor(header_hex)
    ink = colors.HexColor(SHOWBASE_INK)
    muted = colors.HexColor(SHOWBASE_MUTED)
    border = colors.HexColor(SHOWBASE_BORDER)
    panel = colors.HexColor("#F8FAFC")
    buffer = BytesIO()
    company_name = _text(company.get("companyName") or company.get("name"), "Showbase")
    letterhead_enabled = company.get("letterheadEnabled", True) is not False
    footer_text = str(company.get("footerText") or "").replace("\n", " | ").strip()
    generated_at = datetime.now().strftime("%d %B %Y, %H:%Mhrs")

    def draw_page(canvas, _doc):
        canvas.saveState()
        logo_drawn = False
        if letterhead_enabled and logo_path and os.path.isfile(logo_path):
            try:
                image = ImageReader(logo_path)
                width, height = image.getSize()
                scale = min((38 * mm) / width, (12 * mm) / height)
                canvas.drawImage(image, margin, page_height - 19 * mm,
                                 width=width * scale, height=height * scale,
                                 preserveAspectRatio=True, mask="auto")
                logo_drawn = True
            except Exception:
                logo_drawn = False
        if letterhead_enabled and not logo_drawn:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(company_name, "Helvetica-Bold"), 14)
            canvas.drawString(margin, page_height - 13 * mm, company_name[:48])
        canvas.setStrokeColor(border)
        canvas.setLineWidth(.5)
        canvas.line(margin, 12 * mm, page_width - margin, 12 * mm)
        footer_line = footer_text or company_name
        canvas.setFillColor(muted)
        canvas.setFont(_canvas_font(footer_line, "Helvetica"), 5.8)
        canvas.drawString(margin, 7.5 * mm, footer_line[:165])
        canvas.restoreState()

    class NumberedCanvas(Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_pages = []

        def showPage(self):
            self._saved_pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            page_count = len(self._saved_pages)
            for page_number, page in enumerate(self._saved_pages, start=1):
                self.__dict__.update(page)
                draw_page(self, None)
                self.saveState()
                self.setFillColor(muted)
                self.setFont("Helvetica", 5.8)
                self.drawRightString(page_width - margin, 7.5 * mm,
                                     f"Page {page_number} of {page_count}")
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    doc = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=margin, rightMargin=margin,
        topMargin=30 * mm, bottomMargin=17 * mm,
        title=f"Event #{event.get('id') or '-'} - {event.get('name') or 'Event'}",
        author=company_name,
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle("EventReportTitle", parent=styles["Heading1"],
                           fontName="Helvetica-Bold", fontSize=18, leading=21,
                           textColor=ink, spaceAfter=3)
    section = ParagraphStyle("EventReportSection", parent=styles["Heading2"],
                             fontName="Helvetica-Bold", fontSize=10, leading=12,
                             textColor=ink)
    cell = ParagraphStyle("EventReportCell", parent=styles["BodyText"],
                          fontName="Helvetica", fontSize=7, leading=8.5, textColor=ink)
    bold = ParagraphStyle("EventReportBold", parent=cell, fontName="Helvetica-Bold")
    table_header = ParagraphStyle("EventReportHeader", parent=bold, textColor=colors.white)
    center = ParagraphStyle("EventReportCenter", parent=cell, alignment=TA_CENTER)
    meta_label = ParagraphStyle("EventReportMetaLabel", parent=cell,
                                fontName="Helvetica-Bold", fontSize=5.7,
                                leading=7, textColor=muted)
    meta_value = ParagraphStyle("EventReportMetaValue", parent=bold)

    def section_heading(label, count=""):
        return Table(
            [[_paragraph(label, section), _paragraph(count, center)]],
            colWidths=[doc.width * .78, doc.width * .22],
            style=TableStyle([
                ("LINEBELOW", (0, 0), (-1, -1), 1, accent),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]),
        )

    def data_table(headers, rows, widths, empty_text):
        table_rows = [[_paragraph(value, table_header) for value in headers]]
        for row in rows:
            table_rows.append([
                _paragraph(value, center if index in {2, 3} and len(headers) > 3 else cell)
                for index, value in enumerate(row)
            ])
        if not rows:
            table_rows.append([_paragraph(empty_text, cell)] + [""] * (len(headers) - 1))
        scale = doc.width / (sum(widths) * mm)
        table = Table(table_rows, colWidths=[width * mm * scale for width in widths], repeatRows=1)
        commands = [
            ("BACKGROUND", (0, 0), (-1, 0), header_accent),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("BOX", (0, 0), (-1, -1), .5, border),
            ("INNERGRID", (0, 0), (-1, -1), .3, border),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        if not rows:
            commands.append(("SPAN", (0, 1), (-1, 1)))
        table.setStyle(TableStyle(commands))
        return table

    date_range = _date_label(event.get("startDate"))
    if event.get("endDate") and event.get("endDate") != event.get("startDate"):
        date_range += f" - {_date_label(event.get('endDate'))}"
    metadata = [
        ("Event", f"#{event.get('id') or '-'} · {_text(event.get('name'), 'Event')}"),
        ("Location", _text(event.get("location"))),
        ("Dates", date_range),
        ("Status", _text(event.get("state"))),
        ("Generated by", generated_by or "-"),
        ("Generated on", generated_at),
    ]
    meta_cells = [[_paragraph(a, meta_label), _paragraph(b, meta_value)] for a, b in metadata]
    meta_rows = [meta_cells[index] + meta_cells[index + 1]
                 for index in range(0, len(meta_cells), 2)]
    story = [
        _paragraph("EVENT OPERATIONS REPORT", title),
        HRFlowable(width="100%", thickness=.8, color=accent),
        Spacer(1, 3 * mm),
        Table(meta_rows, colWidths=[23 * mm, doc.width / 2 - 23 * mm] * 2,
              style=TableStyle([
                  ("BACKGROUND", (0, 0), (-1, -1), panel),
                  ("BOX", (0, 0), (-1, -1), .45, border),
                  ("INNERGRID", (0, 0), (-1, -1), .3, border),
                  ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                  ("LEFTPADDING", (0, 0), (-1, -1), 5),
                  ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                  ("TOPPADDING", (0, 0), (-1, -1), 3.5),
                  ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
              ])),
        Spacer(1, 5 * mm),
    ]

    asset_rows = payload.get("assets") or []
    story.extend([
        section_heading("ASSETS", f"{sum(int(row.get('required') or 0) for row in asset_rows)} required"),
        Spacer(1, 2 * mm),
        data_table(
            ["Item", "Department", "Required", "Prepared", "Returned", "Asset IDs / status"],
            [[row.get("item"), row.get("department"), row.get("required"),
              row.get("prepared"), row.get("returned"), row.get("assetIds")]
             for row in asset_rows],
            [70, 30, 19, 19, 18, 55], "No assets are required for this event.",
        ),
        Spacer(1, 5 * mm),
    ])

    manpower_rows = payload.get("manpower") or []
    story.extend([
        section_heading("MANPOWER", f"{len(manpower_rows)} scheduled row(s)"),
        Spacer(1, 2 * mm),
        data_table(
            ["Date", "Name", "Room", "Department", "Role", "Call time", "Pax"],
            [[row.get("date"), row.get("name"), row.get("room"), row.get("department"),
              row.get("role"), row.get("callTime"), row.get("pax")]
             for row in manpower_rows],
            [29, 42, 28, 31, 47, 25, 13], "No crew are scheduled for this event.",
        ),
        Spacer(1, 5 * mm),
    ])

    vendor_rows = payload.get("vendorServices") or []
    if vendor_rows:
        story.extend([
            section_heading("VENDOR SERVICES", f"{len(vendor_rows)} service(s)"),
            Spacer(1, 2 * mm),
            data_table(
                ["Vendor", "Room", "Department", "Service", "Dates / call time"],
                [[row.get("name"), row.get("room"), row.get("department"),
                  row.get("service"), row.get("schedule")] for row in vendor_rows],
                [44, 30, 34, 62, 45], "No vendor services are booked.",
            ),
            Spacer(1, 5 * mm),
        ])

    transport_rows = payload.get("transport") or []
    story.extend([
        section_heading("TRANSPORT", f"{len(transport_rows)} booking(s)"),
        Spacer(1, 2 * mm),
        data_table(
            ["Trip / time", "Route", "Company", "Vehicle", "Driver / contact"],
            [[row.get("time"), row.get("route"), row.get("company"),
              row.get("vehicle"), row.get("driver")] for row in transport_rows],
            [44, 52, 35, 39, 45], "No transport is booked for this event.",
        ),
    ])
    notes = str(event.get("notes") or "").strip()
    if notes:
        story.extend([
            Spacer(1, 5 * mm), section_heading("EVENT NOTES"), Spacer(1, 2 * mm),
            KeepTogether([Table([[_paragraph(notes, cell)]], colWidths=[doc.width],
                                style=TableStyle([
                                    ("BACKGROUND", (0, 0), (-1, -1), panel),
                                    ("BOX", (0, 0), (-1, -1), .45, border),
                                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                                ]))]),
        ])
    doc.build(story, canvasmaker=NumberedCanvas)
    return buffer.getvalue()
