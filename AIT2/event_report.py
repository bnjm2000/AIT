"""Professional PDF report for an event's operational details."""

from __future__ import annotations

from datetime import datetime
from html import escape
from io import BytesIO
import os

from quotation_pdf import _canvas_font, _cjk_markup, _paragraph
from workforce_schedule import (
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


def _iso_day_label(value):
    raw = str(value or "").strip()
    for pattern in ("%Y-%m-%d", "%Y%m%d", "%d/%m/%Y"):
        try:
            parsed = datetime.strptime(raw, pattern)
            return f"{parsed.strftime('%Y-%m-%d')} ({parsed.strftime('%a').upper()})"
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
    from reportlab.platypus import HRFlowable, KeepTogether, LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

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
    border = colors.HexColor("#94A3B8")
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

    department_rows = [
        row for row in payload.get("departments", []) if isinstance(row, dict)
    ]
    departments = {}
    for department in department_rows:
        code = str(department.get("code") or "").strip().upper()
        name = str(department.get("name") or department.get("Name") or "").strip().casefold()
        if code:
            departments[code] = department
        if name:
            departments[name] = department

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

    def department_style(value):
        clean = str(value or "").strip()
        code = clean.upper()
        if "(" in clean and clean.endswith(")"):
            code = clean.rsplit("(", 1)[1][:-1].strip().upper()
        department = departments.get(code) or departments.get(clean.casefold()) or {}
        if not department:
            return None
        background_hex = _safe_colour(department.get("color"), "#F8FAFC")
        return (
            colors.HexColor(background_hex),
            colors.HexColor(_safe_colour(
                department.get("textColor"), _contrast_colour(background_hex)
            )),
        )

    def asset_item_cell(item, asset_ids):
        item_markup = _cjk_markup(escape(_text(item, "Asset")), bold=True)
        ids_markup = _cjk_markup(escape(str(asset_ids or "").strip()))
        detail = (
            f'<br/><font color="#64748B" size="6">Asset IDs: {ids_markup}</font>'
            if ids_markup else ""
        )
        return Paragraph(f"<b>{item_markup}</b>{detail}", cell)

    def data_table(section_label, section_count, headers, rows, widths, empty_text,
                   *, centered_columns=(), department_column=None,
                   group_column=None, border_width=.8):
        section_text = section_label + (f"  -  {section_count}" if section_count else "")
        section_row = [_paragraph(section_text, section)] + [""] * (len(headers) - 1)
        table_rows = [
            section_row,
            [_paragraph(value, table_header) for value in headers],
        ]
        for row in rows:
            table_rows.append([
                value if hasattr(value, "wrap") else _paragraph(
                    value, center if index in centered_columns else cell
                )
                for index, value in enumerate(row)
            ])
        if not rows:
            table_rows.append([_paragraph(empty_text, cell)] + [""] * (len(headers) - 1))
        scale = doc.width / (sum(widths) * mm)
        table = LongTable(
            table_rows,
            colWidths=[width * mm * scale for width in widths],
            repeatRows=2,
        )
        commands = [
            ("SPAN", (0, 0), (-1, 0)),
            ("LINEBELOW", (0, 0), (-1, 0), 1, accent),
            ("BACKGROUND", (0, 1), (-1, 1), header_accent),
            ("TEXTCOLOR", (0, 1), (-1, 1), colors.white),
            ("BOX", (0, 0), (-1, -1), max(.8, border_width), border),
            ("INNERGRID", (0, 1), (-1, -1), .5, border),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, 0), 3),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 3),
            ("TOPPADDING", (0, 1), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ]
        if not rows:
            commands.append(("SPAN", (0, 2), (-1, 2)))
        if department_column is not None:
            for row_index, row in enumerate(rows, start=2):
                style = department_style(row[department_column])
                if not style:
                    continue
                commands.extend([
                    ("BACKGROUND", (department_column, row_index), (department_column, row_index), style[0]),
                    ("TEXTCOLOR", (department_column, row_index), (department_column, row_index), style[1]),
                ])
        if group_column is not None:
            previous = None
            for row_index, row in enumerate(rows, start=2):
                group_value = str(row[group_column] or '')
                if previous is not None and group_value != previous:
                    commands.append(("LINEABOVE", (0, row_index), (-1, row_index), 1.4, ink))
                previous = group_value
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
    manpower_rows = payload.get("manpower") or []
    transport_rows = payload.get("transport") or []
    asset_summary = {}
    for row in asset_rows:
        department = _text(row.get("department"), "Unassigned")
        asset_summary[department] = asset_summary.get(department, 0) + int(row.get("required") or 0)
    manpower_summary = {}
    for row in manpower_rows:
        key = (_iso_day_label(row.get("date")), _text(row.get("department"), "Unassigned"))
        manpower_summary[key] = manpower_summary.get(key, 0) + max(1, int(row.get("pax") or 1))
    story.extend([
        data_table(
            "SUMMARY · ASSETS", f"{sum(asset_summary.values())} required",
            ["Department", "Assets"],
            [[department, quantity] for department, quantity in sorted(asset_summary.items(), key=lambda item: item[0].casefold())],
            [380, 100], "No assets are required.", centered_columns=(1,), department_column=0,
        ),
        Spacer(1, 4 * mm),
        data_table(
            "SUMMARY · MANPOWER", f"{sum(manpower_summary.values())} person-day(s)",
            ["Date", "Department", "Manpower"],
            [[date_value, department, quantity] for (date_value, department), quantity in sorted(manpower_summary.items())],
            [130, 250, 100], "No manpower is scheduled.", centered_columns=(2,), department_column=1,
            group_column=0, border_width=.8,
        ),
        Spacer(1, 4 * mm),
        data_table(
            "SUMMARY · TRANSPORT", f"{len(transport_rows)} booking(s)",
            ["Booked transport", "Count"],
            [["Event transport bookings", len(transport_rows)]],
            [380, 100], "No transport is booked.", centered_columns=(1,),
        ),
        PageBreak(),
    ])

    asset_chunks = [asset_rows[index:index + 22] for index in range(0, len(asset_rows), 22)] or [[]]
    total_required = sum(int(row.get("required") or 0) for row in asset_rows)
    for chunk_index, chunk in enumerate(asset_chunks):
        story.append(KeepTogether([data_table(
            "ASSETS", f"{total_required} required" if chunk_index == 0 else "Continued",
            ["Item", "Department", "Required", "Prepared", "Returned"],
            [[asset_item_cell(row.get("item"), row.get("assetIds")), row.get("department"),
              row.get("required"), row.get("prepared"), row.get("returned")]
             for row in chunk],
            [250, 80, 50, 50, 50], "No assets are required for this event.",
            centered_columns=(2, 3, 4), department_column=1,
        )]))
        story.append(Spacer(1, (1 if chunk_index < len(asset_chunks) - 1 else 5) * mm))

    story.extend([
        data_table(
            "MANPOWER", f"{len(manpower_rows)} scheduled row(s)",
            ["Room", "Department", "Name", "Date", "Role", "Call time", "Pax"],
            [[row.get("room"), row.get("department"), row.get("name"), _iso_day_label(row.get("date")),
              row.get("role"), row.get("callTime"), row.get("pax")]
             for row in manpower_rows],
            [58, 74, 95, 72, 105, 50, 26], "No crew are scheduled for this event.",
            centered_columns=(5, 6), department_column=1, group_column=0,
            border_width=.9,
        ),
        Spacer(1, 5 * mm),
    ])

    vendor_rows = payload.get("vendorServices") or []
    if vendor_rows:
        story.extend([
            data_table(
                "VENDOR SERVICES", f"{len(vendor_rows)} service(s)",
                ["Vendor", "Room", "Department", "Service", "Dates / call time"],
                [[row.get("name"), row.get("room"), row.get("department"),
                  row.get("service"), row.get("schedule")] for row in vendor_rows],
                [90, 70, 75, 140, 105], "No vendor services are booked.",
                department_column=2,
            ),
            Spacer(1, 5 * mm),
        ])

    def location_cell(name, address):
        name_markup = _cjk_markup(escape(_text(name)), bold=True)
        address_markup = _cjk_markup(escape(str(address or '').strip()))
        detail = f'<br/><font color="#64748B" size="6">{address_markup}</font>' if address_markup else ''
        return Paragraph(f'<b>{name_markup}</b>{detail}', cell)

    story.extend([
        data_table(
            "TRANSPORT", f"{len(transport_rows)} booking(s)",
            ["Trip / time", "From", "To", "Company", "Vehicle", "Driver / contact"],
            [[row.get("time"), location_cell(row.get("fromName"), row.get("fromAddress")),
              location_cell(row.get("toName"), row.get("toAddress")), row.get("company"),
              row.get("vehicle"), row.get("driver")] for row in transport_rows],
            [65, 80, 80, 65, 60, 130], "No transport is booked for this event.",
        ),
    ])
    notes = str(event.get("notes") or "").strip()
    if notes:
        story.extend([Spacer(1, 5 * mm), KeepTogether([
            section_heading("EVENT NOTES"), Spacer(1, 2 * mm),
            Table([[_paragraph(notes, cell)]], colWidths=[doc.width],
                                style=TableStyle([
                                    ("BACKGROUND", (0, 0), (-1, -1), panel),
                                    ("BOX", (0, 0), (-1, -1), .45, border),
                                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                                ])),
        ])])
    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()
