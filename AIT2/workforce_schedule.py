"""PDF reporting for event manpower schedules."""

from __future__ import annotations

import re
from datetime import datetime
from html import escape
from io import BytesIO
import os

from models import format_user_phone
from quotation_pdf import _canvas_font, _cjk_markup, _paragraph


SHOWBASE_GREEN = "#0f766e"
SHOWBASE_INK = "#1f352f"
SHOWBASE_MUTED = "#60736c"
SHOWBASE_BORDER = "#d9e4e0"


def _pdf_phone(value):
    """Format phone fields for display without discarding legacy values."""
    raw = str(value or "").strip()
    return format_user_phone(raw) or raw


def _number(value, default=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _date(value):
    try:
        return datetime.strptime(str(value or ""), "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _date_label(value, include_weekday=True):
    parsed = _date(value)
    if not parsed:
        return str(value or "-")
    label = parsed.strftime("%d %B %Y").lstrip("0")
    return f"{label} ({parsed.strftime('%a')})" if include_weekday else label


def _short_date_label(value, include_weekday=True):
    parsed = _date(value)
    if not parsed:
        return str(value or "-")
    label = parsed.strftime("%d %b %Y").lstrip("0")
    return f"{label} ({parsed.strftime('%a')})" if include_weekday else label


def _event_dates(event):
    start = _date(event.get("startDateValue"))
    end = _date(event.get("endDateValue"))
    if not start:
        return []
    if not end or end < start:
        end = start
    return [
        datetime.fromordinal(day).strftime("%Y-%m-%d")
        for day in range(start.toordinal(), end.toordinal() + 1)
    ]


def _subject_maps(payload):
    workers = {
        str(row.get("id")): row
        for row in payload.get("freelancers", [])
        if isinstance(row, dict)
    }
    vendors = {
        str(row.get("id")): row
        for row in payload.get("vendors", [])
        if isinstance(row, dict)
    }
    app_users = {
        str(row.get("username")): row
        for row in payload.get("appUsers", [])
        if isinstance(row, dict)
    }
    return workers, vendors, app_users


def _is_schedule_assignment(row):
    return not (
        row.get("subjectType") == "vendor"
        and row.get("providerType") == "service"
    )


def _subject_id(row):
    if row.get("subjectType") == "app-user":
        username = str(row.get("userUsername") or "")
        return f"user:{username}" if username else ""
    return str(row.get("freelancerId") or row.get("vendorId") or "")


def _subject(payload_maps, row):
    workers, vendors, app_users = payload_maps
    subject_id = _subject_id(row)
    if row.get("subjectType") == "app-user":
        username = str(row.get("userUsername") or "")
        record = app_users.get(username) or {}
        return {
            "id": subject_id,
            "name": str(record.get("name") or username or "Unknown user"),
            "phone": _pdf_phone(record.get("phone")),
            "vendor": False,
            "appUser": True,
        }
    is_vendor = row.get("subjectType") == "vendor" or bool(row.get("vendorId"))
    source = vendors if is_vendor else workers
    fallback = "Unknown vendor" if is_vendor else "Unknown worker"
    record = source.get(subject_id) or {}
    return {
        "id": subject_id,
        "name": str(record.get("name") or fallback),
        "phone": _pdf_phone(record.get("phone")),
        "vendor": is_vendor,
        "appUser": False,
    }


def _department_maps(payload):
    rows = [
        *(payload.get("allDepartments") or []),
        *(payload.get("departments") or []),
    ]
    return {
        str(row.get("code") or "").upper(): row
        for row in rows
        if isinstance(row, dict)
    }


def _department(payload_maps, code):
    row = payload_maps.get(str(code or "").upper()) or {}
    return str(row.get("name") or code or "Unassigned")


def _date_value(row, field, date_value, fallback=""):
    values = row.get(field) if isinstance(row.get(field), dict) else {}
    date_key = str(date_value or "")
    return str(values[date_key]) if date_key in values else str(fallback or "")


def _department_code(row, date_value=""):
    fallback = row.get("department") or (
        "FT" if row.get("subjectType") == "app-user" else ""
    )
    return _date_value(row, "dateDepartments", date_value, fallback)


def _room(row):
    return str(row.get("subprojectName") or "").strip() or "-"


def _role(row, date_value=""):
    fallback = row.get("roleName")
    if row.get("subjectType") == "vendor" or row.get("vendorId"):
        pax = max(1, int(_number(row.get("pax"), 1)))
        fallback = fallback or f"{pax} pax manpower"
    else:
        fallback = fallback or "Role not set"
    return _date_value(row, "dateRoles", date_value, fallback) or "Role not set"


def _pax(row):
    if row.get("subjectType") == "vendor" or row.get("vendorId"):
        return max(1, int(_number(row.get("pax"), 1)))
    return 1


def _rate(row):
    amount = row.get("ratePerPax") if row.get("providerType") == "manpower" else row.get("dailyRate")
    if amount in (None, ""):
        return "Not set"
    suffix = "/pax/day" if row.get("providerType") == "manpower" else "/day"
    return f"${_number(amount):,.2f}{suffix}"


def _headcount(rows):
    worker_ids = {
        _subject_id(row)
        for row in rows
        if not (row.get("subjectType") == "vendor" or row.get("vendorId"))
    }
    vendor_total = sum(
        _pax(row)
        for row in rows
        if row.get("subjectType") == "vendor" or row.get("vendorId")
    )
    return len(worker_ids) + vendor_total


def _safe_colour(value, fallback):
    return str(value) if re.fullmatch(r"#[0-9a-fA-F]{6}", str(value or "")) else fallback


def _contrast_colour(value, light="#FFFFFF", dark="#172033"):
    colour = _safe_colour(value, "#FFFFFF").lstrip("#")
    red, green, blue = (int(colour[index:index + 2], 16) for index in (0, 2, 4))
    luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
    return dark if luminance > 0.64 else light


def _darken_colour(value, factor=0.62):
    """Return a darker tint suitable for white table-header text."""
    colour = _safe_colour(value, SHOWBASE_GREEN).lstrip("#")
    channels = (
        max(0, min(255, round(int(colour[index:index + 2], 16) * factor)))
        for index in (0, 2, 4)
    )
    return "#{:02X}{:02X}{:02X}".format(*channels)


def _event_has_multiple_rooms(payload, event, assignments):
    """Use event room metadata first, then legacy assignment room values."""
    configured_rooms = payload.get("subprojects") or event.get("subprojects") or []
    room_keys = {
        str(room.get("id") or room.get("name") or "").strip().casefold()
        for room in configured_rooms
        if isinstance(room, dict)
        and str(room.get("id") or room.get("name") or "").strip()
    }
    if room_keys:
        return len(room_keys) > 1
    assigned_rooms = {
        str(row.get("subprojectId") or row.get("subprojectName") or "")
        .strip()
        .casefold()
        for row in assignments
        if str(row.get("subprojectId") or row.get("subprojectName") or "").strip()
    }
    return len(assigned_rooms) > 1


def build_workforce_schedule_pdf(
    payload,
    *,
    company=None,
    logo_path="",
    subject_id="",
    date_filter="",
    show_rates=False,
    show_phones=False,
    generated_by="",
):
    """Return a professional event or individual manpower schedule PDF."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
        HRFlowable,
        KeepTogether,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    event = payload.get("event") or {}
    company = company or payload.get("company") or {}
    event_assignments = [
        row for row in (payload.get("assignments") or [])
        if isinstance(row, dict) and _is_schedule_assignment(row)
    ]
    assignments = event_assignments
    if subject_id:
        assignments = [row for row in assignments if _subject_id(row) == str(subject_id)]
    assigned_dates = sorted({
        str(date_value)
        for row in assignments
        for date_value in (row.get("workDates") or [])
        if _date(date_value)
    })
    dates = assigned_dates if subject_id else sorted(set(
        _event_dates(event) + assigned_dates
    ))
    if date_filter:
        dates = [date_filter] if date_filter in dates else []

    subject_maps = _subject_maps(payload)
    department_maps = _department_maps(payload)
    page_size = A4
    page_width, page_height = page_size
    margin = 11 * mm
    accent_hex = _safe_colour(company.get("themeColor"), SHOWBASE_GREEN)
    accent = colors.HexColor(accent_hex)
    header_hex = (
        accent_hex
        if _contrast_colour(accent_hex) == "#FFFFFF"
        else _darken_colour(accent_hex)
    )
    header_accent = colors.HexColor(header_hex)
    ink = colors.HexColor(SHOWBASE_INK)
    muted = colors.HexColor(SHOWBASE_MUTED)
    border = colors.HexColor(SHOWBASE_BORDER)
    buffer = BytesIO()

    company_name = str(
        company.get("companyName") or company.get("name") or "Showbase"
    ).strip()
    letterhead_enabled = company.get("letterheadEnabled", True) is not False
    letterhead_lines = [
        str(line or "").strip()
        for line in str(company.get("letterheadText") or "").splitlines()
        if str(line or "").strip()
    ]
    company_lines = (letterhead_lines or [
        company_name,
        str(company.get("billingAddress") or "").strip(),
        " | ".join(filter(None, (
            _pdf_phone(company.get("phone")),
            str(company.get("email") or "").strip(),
            str(company.get("website") or "").strip(),
        ))),
    ]) if letterhead_enabled else []
    company_lines = [line for line in company_lines if line]
    company_details = [
        line for line in company_lines
        if not company_name or line.casefold() != company_name.casefold()
    ]
    footer_text = str(company.get("footerText") or "").replace("\n", " | ").strip()
    generated_at = datetime.now().strftime("%d %B %Y, %H:%Mhrs")

    def draw_page(canvas, _pdf_doc):
        canvas.saveState()
        logo_drawn = False
        if logo_path and os.path.isfile(logo_path):
            try:
                image = ImageReader(logo_path)
                width, height = image.getSize()
                scale = min((38 * mm) / width, (12 * mm) / height)
                canvas.drawImage(
                    image,
                    margin,
                    page_height - 19 * mm,
                    width=width * scale,
                    height=height * scale,
                    preserveAspectRatio=True,
                    mask="auto",
                )
                logo_drawn = True
            except Exception:
                logo_drawn = False
        if letterhead_enabled and not logo_drawn and company_name:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(company_name, "Helvetica-Bold"), 14)
            canvas.drawString(margin, page_height - 13 * mm, company_name[:48])
        if letterhead_enabled and logo_drawn and company_name:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(company_name, "Helvetica-Bold"), 8.5)
            canvas.drawRightString(
                page_width - margin, page_height - 8 * mm, company_name[:80]
            )
        if letterhead_enabled:
            canvas.setFillColor(muted)
            y = page_height - 11 * mm
            for line in company_details[:3]:
                canvas.setFont(_canvas_font(line, "Helvetica"), 5.8)
                canvas.drawRightString(page_width - margin, y, line[:140])
                y -= 2.7 * mm
        canvas.setStrokeColor(border)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 12 * mm, page_width - margin, 12 * mm)
        footer_line = footer_text or (company_lines[0] if company_lines else "")
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
                self.drawRightString(
                    page_width - margin,
                    7.5 * mm,
                    f"Page {page_number} of {page_count}",
                )
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    doc = SimpleDocTemplate(
        buffer,
        pagesize=page_size,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=25 * mm,
        bottomMargin=17 * mm,
        title=f"{event.get('name') or 'Event'} Manpower Schedule",
        author=company_name,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "ScheduleTitle", parent=styles["Heading1"], fontName="Helvetica-Bold",
        fontSize=19, leading=22, textColor=ink, spaceAfter=3,
    )
    section_style = ParagraphStyle(
        "ScheduleSection", parent=styles["Heading2"], fontName="Helvetica-Bold",
        fontSize=10, leading=12, textColor=ink, spaceAfter=5,
    )
    cell_style = ParagraphStyle(
        "ScheduleCell", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=7.4, leading=9.2, textColor=ink,
    )
    cell_bold = ParagraphStyle(
        "ScheduleCellBold", parent=cell_style, fontName="Helvetica-Bold",
    )
    table_header = ParagraphStyle(
        "ScheduleTableHeader", parent=cell_bold, textColor=colors.white,
    )
    cell_right = ParagraphStyle(
        "ScheduleCellRight", parent=cell_style, alignment=TA_RIGHT,
    )
    cell_center = ParagraphStyle(
        "ScheduleCellCenter", parent=cell_style, alignment=TA_CENTER,
    )
    label_style = ParagraphStyle(
        "ScheduleLabel", parent=cell_style, fontName="Helvetica-Bold",
        fontSize=5.8, leading=7, textColor=muted,
    )
    value_style = ParagraphStyle(
        "ScheduleValue", parent=cell_style, fontName="Helvetica-Bold",
        fontSize=7.4, leading=9, textColor=ink,
    )
    show_room = _event_has_multiple_rooms(payload, event, event_assignments)

    subject_record = None
    if subject_id:
        matching = next((row for row in assignments if _subject_id(row) == str(subject_id)), None)
        subject_record = _subject(
            subject_maps, matching or {"freelancerId": subject_id}
        )
    heading = (
        str(subject_record.get("name") or "Worker schedule")
        if subject_record else "MANPOWER SCHEDULE"
    )
    event_dates = " - ".join(filter(None, [
        _date_label(event.get("startDateValue"), False),
        _date_label(event.get("endDateValue"), False)
        if event.get("endDateValue") != event.get("startDateValue") else "",
    ]))
    schedule_dates = " - ".join(filter(None, [
        _date_label(dates[0], False) if dates else "",
        _date_label(dates[-1], False) if len(dates) > 1 else "",
    ])) or "Date not set"
    if subject_record:
        metadata = [
            ("Event ID", f"#{event.get('id') or '-'}"),
            ("Location", event.get("location") or "-"),
            ("Assigned dates", schedule_dates),
            ("Generated by", generated_by or "-"),
            ("Generated on", generated_at),
        ]
        if show_phones:
            metadata.insert(2, ("Phone", subject_record.get("phone") or "-"))
    else:
        metadata = [
            ("Event", f"#{event.get('id') or '-'} - {event.get('name') or 'Event'}"),
            ("Location", event.get("location") or "-"),
            ("Schedule dates", schedule_dates or event_dates),
            ("Schedule type", "Day schedule" if date_filter else "Whole event"),
            ("Generated by", generated_by or "-"),
            ("Generated on", generated_at),
        ]
    metadata_cells = [
        [_paragraph(label, label_style), _paragraph(value, value_style)]
        for label, value in metadata
    ]
    metadata_rows = []
    for index in range(0, len(metadata_cells), 2):
        row = list(metadata_cells[index])
        row.extend(
            metadata_cells[index + 1]
            if index + 1 < len(metadata_cells)
            else [_paragraph("", label_style), _paragraph("", value_style)]
        )
        metadata_rows.append(row)
    story = [
        Table(
            [[_paragraph(heading, title_style), _paragraph(event.get("name") or "Event", section_style)]],
            colWidths=[doc.width * .48, doc.width * .52],
            style=TableStyle([
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]),
        ),
        HRFlowable(width="100%", thickness=.8, color=accent),
        Spacer(1, 3 * mm),
        Table(
            metadata_rows,
            colWidths=[24 * mm, doc.width / 2 - 24 * mm, 24 * mm, doc.width / 2 - 24 * mm],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8FAFC")),
                ("BOX", (0, 0), (-1, -1), .45, border),
                ("INNERGRID", (0, 0), (-1, -1), .3, border),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 3.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
            ]),
        ),
        Spacer(1, 4 * mm),
    ]

    for date_index, date_value in enumerate(dates):
        rows = [row for row in assignments if date_value in (row.get("workDates") or [])]
        if subject_record and not rows:
            continue
        rows.sort(key=lambda row: (
            0 if _department_code(row, date_value) == "FT" else 1,
            str(row.get("callTimes", {}).get(date_value) or "99:99"),
            _department(
                department_maps, _department_code(row, date_value)
            ).lower(),
            _subject(subject_maps, row)["name"].lower(),
        ))
        if subject_record:
            headers = []
            if show_room:
                headers.append("Room")
            headers.extend(["Department", "Role / Assignment", "Call time"])
            table_rows = [[_paragraph(header, table_header) for header in headers]]
            if show_rates:
                table_rows[0].append(_paragraph("Rate", table_header))
            for row in rows:
                role = _role(row, date_value)
                if row.get("subjectType") == "vendor" or row.get("vendorId"):
                    role = re.sub(
                        r"^\d+\s+pax\s+", "", role, flags=re.IGNORECASE
                    ) or "Manpower"
                values = []
                if show_room:
                    values.append(_paragraph(_room(row), cell_style))
                values.extend([
                    _paragraph(_department(
                        department_maps, _department_code(row, date_value)
                    ), cell_style),
                    _paragraph(role, cell_style),
                    _paragraph((row.get("callTimes") or {}).get(date_value) or "Not set", cell_center),
                ])
                if show_rates:
                    values.append(_paragraph(_rate(row), cell_right))
                table_rows.append(values)
            widths = ([42] if show_room else []) + [38, 68, 30]
            if show_rates:
                widths.append(36)
            department_column = 1 if show_room else 0
        else:
            headers = ["Name"]
            if show_room:
                headers.append("Room")
            headers.extend(["Department", "Role / Assignment", "Call time", "Pax"])
            table_rows = [[_paragraph(header, table_header) for header in headers]]
            if show_rates:
                table_rows[0].append(_paragraph("Rate", table_header))
            for row in rows:
                subject = _subject(subject_maps, row)
                call_time = str((row.get("callTimes") or {}).get(date_value) or "Not set")
                values = [
                    Paragraph(_cjk_markup(
                        f"<b>{escape(subject['name'])}</b>" + (
                            f" &nbsp; <font color='{SHOWBASE_MUTED}'>{escape(subject['phone'])}</font>"
                            if show_phones and subject.get("phone") else ""
                        ),
                        bold=True,
                    ), cell_style),
                ]
                if show_room:
                    values.append(_paragraph(_room(row), cell_style))
                values.extend([
                    _paragraph(_department(
                        department_maps, _department_code(row, date_value)
                    ), cell_style),
                    _paragraph(_role(row, date_value), cell_style),
                    _paragraph(call_time, cell_center),
                    _paragraph(_pax(row), cell_center),
                ])
                if show_rates:
                    values.append(_paragraph(_rate(row), cell_right))
                table_rows.append(values)
            if not rows:
                colspan = len(table_rows[0])
                table_rows.append([_paragraph("No manpower assigned.", cell_style)] + [""] * (colspan - 1))
            widths = [48] + ([34] if show_room else []) + [30, 58, 26, 16]
            if show_rates:
                widths.append(32)
            department_column = 2 if show_room else 1
        scale = doc.width / (sum(widths) * mm)
        table = Table(
            table_rows,
            colWidths=[width * mm * scale for width in widths],
            repeatRows=1,
            hAlign="CENTER",
        )
        commands = [
            ("BACKGROUND", (0, 0), (-1, 0), header_accent),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("BOX", (0, 0), (-1, -1), .5, border),
            ("INNERGRID", (0, 0), (-1, -1), .35, border),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("SPAN", (0, 1), (-1, 1)) if not rows else ("LEFTPADDING", (0, 1), (-1, -1), 5),
        ]
        for row_index, row in enumerate(rows, start=1):
            dept = department_maps.get(
                _department_code(row, date_value).upper()
            ) or {}
            department_hex = _safe_colour(dept.get("color"), "#f8fafc")
            colour = colors.HexColor(department_hex)
            commands.append(("BACKGROUND", (department_column, row_index), (department_column, row_index), colour))
            commands.append((
                "TEXTCOLOR",
                (department_column, row_index),
                (department_column, row_index),
                colors.HexColor(_safe_colour(
                    dept.get("textColor"), _contrast_colour(department_hex)
                )),
            ))
        table.setStyle(TableStyle(commands))
        heading_row = Table(
            [[
                _paragraph(_date_label(date_value), section_style),
                _paragraph("" if subject_record else f"{_headcount(rows)} crew", cell_right),
            ]],
            colWidths=[doc.width * .75, doc.width * .25],
        )
        heading_row.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, -1), 1, accent),
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(KeepTogether([heading_row, Spacer(1, 2 * mm), table]))
        if date_index < len(dates) - 1:
            story.append(Spacer(1, 4 * mm))

    if not dates:
        story.append(_paragraph("No event dates are available for this schedule.", cell_style))

    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()


def build_worker_period_schedule_pdf(
    payload,
    *,
    company=None,
    logo_path="",
    show_rates=False,
    show_vendor=False,
    generated_by="",
):
    """Build one worker's assignments across every event in a date range."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    company = company or payload.get("company") or {}
    subject = payload.get("subject") or {}
    rows = [row for row in payload.get("rows", []) if isinstance(row, dict)]
    rows.sort(key=lambda row: (
        str(row.get("date") or ""),
        str(row.get("callTime") or "99:99"),
        str(row.get("eventName") or "").casefold(),
        str(row.get("department") or "").casefold(),
    ))
    page_width, page_height = A4
    margin = 11 * mm
    accent_hex = _safe_colour(company.get("themeColor"), SHOWBASE_GREEN)
    accent = colors.HexColor(accent_hex)
    header_hex = accent_hex if _contrast_colour(accent_hex) == "#FFFFFF" else _darken_colour(accent_hex)
    header_accent = colors.HexColor(header_hex)
    ink = colors.HexColor(SHOWBASE_INK)
    muted = colors.HexColor(SHOWBASE_MUTED)
    border = colors.HexColor(SHOWBASE_BORDER)
    buffer = BytesIO()
    company_name = str(company.get("companyName") or company.get("name") or "Showbase").strip()
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
        if letterhead_enabled and not logo_drawn and company_name:
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
        topMargin=25 * mm, bottomMargin=17 * mm,
        title=f"{subject.get('name') or 'Worker'} Schedule", author=company_name,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "PeriodScheduleTitle", parent=styles["Heading1"], fontName="Helvetica-Bold",
        fontSize=19, leading=22, textColor=ink, spaceAfter=3,
    )
    cell = ParagraphStyle(
        "PeriodScheduleCell", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=7.2, leading=8.8, textColor=ink,
    )
    bold = ParagraphStyle("PeriodScheduleBold", parent=cell, fontName="Helvetica-Bold")
    header = ParagraphStyle("PeriodScheduleHeader", parent=bold, textColor=colors.white)
    center = ParagraphStyle("PeriodScheduleCenter", parent=cell, alignment=TA_CENTER)
    right = ParagraphStyle("PeriodScheduleRight", parent=cell, alignment=TA_RIGHT)
    label = ParagraphStyle(
        "PeriodScheduleLabel", parent=cell, fontName="Helvetica-Bold",
        fontSize=5.8, leading=7, textColor=muted,
    )
    value = ParagraphStyle("PeriodScheduleValue", parent=cell, fontName="Helvetica-Bold")
    booking_detail = ParagraphStyle(
        "PeriodScheduleBookingDetail", parent=cell, fontSize=6.2,
        leading=7.4, textColor=muted, spaceBefore=1,
    )
    start_date = str(payload.get("startDate") or "")
    end_date = str(payload.get("endDate") or "")
    range_label = _short_date_label(start_date, False)
    if end_date and end_date != start_date:
        range_label += f" - {_short_date_label(end_date, False)}"
    metadata = [("Worker", subject.get("name") or "-")]
    vendor_names = [
        str(name).strip()
        for name in subject.get("vendorNames", [])
        if str(name or "").strip()
    ]
    if show_vendor and vendor_names:
        metadata.append(("Vendor" if len(vendor_names) == 1 else "Vendors", ", ".join(vendor_names)))
    metadata.extend([
        ("Date range", range_label or "-"),
        ("Generated by", generated_by or "-"),
        ("Generated on", generated_at),
    ])
    metadata_rows = []
    cells = [[_paragraph(a, label), _paragraph(b, value)] for a, b in metadata]
    for index in range(0, len(cells), 2):
        row = cells[index]
        row += cells[index + 1] if index + 1 < len(cells) else ["", ""]
        metadata_rows.append(row)
    story = [
        _paragraph("WORKER SCHEDULE", title_style),
        HRFlowable(width="100%", thickness=.8, color=accent),
        Spacer(1, 3 * mm),
        Table(metadata_rows, colWidths=[24 * mm, doc.width / 2 - 24 * mm] * 2,
              style=TableStyle([
                  ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8FAFC")),
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
    headers = [
        "Date", "Event", "Location", "Department",
        "Role / Service" if show_vendor else "Role", "Call time",
    ]
    if show_rates:
        headers.append("Rate")
    table_rows = [[_paragraph(text, header) for text in headers]]
    for row in rows:
        event_label = f"{row.get('eventId') or '-'} - {row.get('eventName') or 'Event'}"
        if row.get("room"):
            event_label += f" ({row['room']})"
        role_cell = _paragraph(row.get("role") or "Role not set", cell)
        if row.get("vendorName"):
            booking_label = " - ".join(filter(None, [
                str(row.get("vendorName") or "").strip(),
                str(row.get("bookingType") or "").strip(),
            ]))
            role_cell = [
                _paragraph(row.get("role") or "Vendor booking", bold),
                _paragraph(booking_label, booking_detail),
            ]
        values = [
            _paragraph(_short_date_label(row.get("date")), cell),
            _paragraph(event_label, bold),
            _paragraph(row.get("location") or "Not set", cell),
            _paragraph(row.get("department") or "Unassigned", cell),
            role_cell,
            _paragraph(row.get("callTime") or "Not set", center),
        ]
        if show_rates:
            values.append(_paragraph(row.get("rate") or "Not set", right))
        table_rows.append(values)
    if not rows:
        table_rows.append([_paragraph("No assignments fall within this date range.", cell)] + [""] * (len(headers) - 1))
    widths = [28, 52, 38, 31, 43, 24] + ([30] if show_rates else [])
    scale = doc.width / (sum(widths) * mm)
    table = Table(table_rows, colWidths=[width * mm * scale for width in widths], repeatRows=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), header_accent),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BOX", (0, 0), (-1, -1), .5, border),
        ("INNERGRID", (0, 0), (-1, -1), .35, border),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if not rows:
        commands.append(("SPAN", (0, 1), (-1, 1)))
    departments = {
        str(row.get("code") or "").strip().upper(): row
        for row in payload.get("departments", [])
        if isinstance(row, dict)
    }
    for row_index, row in enumerate(rows, start=1):
        department = departments.get(str(row.get("departmentCode") or "").strip().upper()) or {}
        if not department:
            continue
        background_hex = _safe_colour(department.get("color"), "#F8FAFC")
        commands.extend([
            ("BACKGROUND", (3, row_index), (3, row_index), colors.HexColor(background_hex)),
            ("TEXTCOLOR", (3, row_index), (3, row_index), colors.HexColor(_safe_colour(
                department.get("textColor"), _contrast_colour(background_hex)
            ))),
        ])
    table.setStyle(TableStyle(commands))
    story.append(table)
    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()
