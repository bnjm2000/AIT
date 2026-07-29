"""Print-ready quotation and invoice PDF rendering."""

from io import BytesIO
from html import escape
from datetime import datetime, timedelta
import os
import re
import threading


_CJK_TEXT_RE = re.compile(
    r'[\u2E80-\u2EFF\u3000-\u303F\u31C0-\u31EF'
    r'\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+'
)
_CJK_FONT_LOCK = threading.Lock()
_CJK_FONT_NAMES = {}


def _line_system_name(line):
    custom = re.sub(r'\s+', ' ', str((line or {}).get('systemName') or '').strip())
    if custom:
        return custom
    department = re.sub(
        r'\s+',
        ' ',
        str((line or {}).get('department') or '').strip(),
    )
    base_department = re.sub(
        r'\s+(?:department|system)$',
        '',
        department,
        flags=re.IGNORECASE,
    ).strip()
    if base_department.lower() == 'manpower':
        return 'Manpower'
    if base_department.lower() in {'transport', 'transportation'}:
        return 'Transportation'
    return f'{base_department} System' if base_department else 'Unknown System'


def _ensure_cjk_font(bold=False):
    """Register an embedded CJK font when available, with a CID fallback."""
    weight = 'bold' if bold else 'regular'
    if _CJK_FONT_NAMES.get(weight):
        return _CJK_FONT_NAMES[weight]

    from reportlab.pdfbase import pdfmetrics

    with _CJK_FONT_LOCK:
        if _CJK_FONT_NAMES.get(weight):
            return _CJK_FONT_NAMES[weight]

        configured_regular = str(
            os.environ.get('SHOWBASE_CJK_FONT') or ''
        ).strip()
        configured_bold = str(
            os.environ.get('SHOWBASE_CJK_BOLD_FONT') or ''
        ).strip()
        regular_candidates = [
            configured_regular,
            os.path.join(
                os.path.dirname(__file__),
                'static',
                'fonts',
                'NotoSansSC-Regular.ttf',
            ),
            r'C:\Windows\Fonts\Deng.ttf',
            r'C:\Windows\Fonts\NotoSansSC-VF.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
        ]
        bold_candidates = [
            configured_bold,
            os.path.join(
                os.path.dirname(__file__),
                'static',
                'fonts',
                'NotoSansSC-Bold.ttf',
            ),
            r'C:\Windows\Fonts\Dengb.ttf',
            configured_regular,
            r'C:\Windows\Fonts\Deng.ttf',
            r'C:\Windows\Fonts\NotoSansSC-VF.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansSC-Bold.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
        ]
        font_name = 'ShowbaseCJKBold' if bold else 'ShowbaseCJK'
        candidates = bold_candidates if bold else regular_candidates
        for font_path in candidates:
            if not font_path or not os.path.isfile(font_path):
                continue
            try:
                from reportlab.pdfbase.ttfonts import TTFont

                pdfmetrics.registerFont(TTFont(font_name, font_path))
                _CJK_FONT_NAMES[weight] = font_name
                return font_name
            except Exception:
                continue

        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        try:
            pdfmetrics.getFont('STSong-Light')
        except KeyError:
            pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
        _CJK_FONT_NAMES[weight] = 'STSong-Light'
        return _CJK_FONT_NAMES[weight]


def _has_cjk(value):
    return bool(_CJK_TEXT_RE.search(str(value or '')))


def _cjk_markup(value, bold=False):
    value = str(value or '')
    if not _has_cjk(value):
        return value
    font_name = _ensure_cjk_font(bold=bold)
    return _CJK_TEXT_RE.sub(
        lambda match: (
            f'<font name="{font_name}">{match.group(0)}</font>'
        ),
        value,
    )


def _canvas_font(value, latin_font):
    return (
        _ensure_cjk_font(bold='bold' in latin_font.casefold())
        if _has_cjk(value)
        else latin_font
    )


def _text(value):
    value = str(value or '')
    replacements = {
        '\u2013': '-',
        '\u2014': '-',
        '\u2011': '-',
        '\u2022': '-',
        '\u2018': "'",
        '\u2019': "'",
        '\u201c': '"',
        '\u201d': '"',
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return value


def _paragraph(value, style):
    from reportlab.platypus import Paragraph

    safe = escape(_text(value)).replace('\n', '<br/>')
    return Paragraph(
        _cjk_markup(
            safe,
            bold='bold' in str(getattr(style, 'fontName', '')).casefold(),
        ),
        style,
    )


def _money(value, currency='SGD'):
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0
    sign = '-' if amount < 0 else ''
    return f"{sign}${abs(amount):,.2f}"


def _date(value):
    raw = str(value or '').strip()
    try:
        return datetime.strptime(raw, '%Y-%m-%d').strftime('%d %b %Y')
    except ValueError:
        return raw


def _schedule_date_summary(rows):
    parsed = []
    unparsed = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw = str(row.get('date') or '').strip()
        time_value = str(row.get('time') or '').strip()
        identity = (raw, time_value.casefold())
        if not raw or identity in seen:
            continue
        seen.add(identity)
        try:
            parsed.append((datetime.strptime(raw, '%Y-%m-%d').date(), time_value))
        except ValueError:
            unparsed.append((_date(raw), time_value))

    parsed.sort(key=lambda item: item[0])
    date_counts = {}
    for value, _time_value in parsed:
        date_counts[value] = date_counts.get(value, 0) + 1
    groups = []
    for value, time_value in parsed:
        previous_date = groups[-1][-1][0] if groups else None
        if (
            groups
            and value == previous_date + timedelta(days=1)
            and date_counts.get(previous_date) == 1
            and date_counts.get(value) == 1
        ):
            groups[-1].append((value, time_value))
        else:
            groups.append([(value, time_value)])

    def format_time(value):
        value = str(value or '').strip()
        if not value:
            return ''
        return value if value.lower().endswith('hrs') else f"{value}hrs"

    def format_date(value):
        return f"{value.day} {value.strftime('%B %Y')}"

    def format_group(group):
        start, end = group[0][0], group[-1][0]
        if start == end:
            label = f"{start.day} {start.strftime('%B %Y')}"
        elif start.year == end.year and start.month == end.month:
            label = f"{start.day}-{end.day} {end.strftime('%B %Y')}"
        elif start.year == end.year:
            label = f"{start.day} {start.strftime('%B')}-{end.day} {end.strftime('%B %Y')}"
        else:
            label = f"{start.day} {start.strftime('%B %Y')}-{end.day} {end.strftime('%B %Y')}"
        time_values = [str(time_value or '').strip() for _value, time_value in group]
        unique_times = set(time_values)
        if len(unique_times) == 1 and next(iter(unique_times), ''):
            label = f"{label}, {format_time(time_values[0])}"
        elif any(time_values):
            return '; '.join(
                f"{format_date(value)}{f', {format_time(time_value)}' if time_value else ''}"
                for value, time_value in group
            )
        return label

    unparsed_labels = [
        f"{date_label}{f', {format_time(time_value)}' if time_value else ''}"
        for date_label, time_value in unparsed
    ]
    return '; '.join([*(format_group(group) for group in groups), *unparsed_labels])


def _validity_label(document):
    amount = document.get('validityAmount')
    unit = str(document.get('validityUnit') or 'days').lower()
    if unit not in {'days', 'weeks', 'months'}:
        unit = 'days'
    try:
        amount = int(float(amount or 0))
    except (TypeError, ValueError):
        amount = 0
    if amount <= 0:
        try:
            days = int(float(document.get('validityDays') or 30))
        except (TypeError, ValueError):
            days = 30
        amount = days
        unit = 'days'
    label = {
        'days': 'day(s)',
        'weeks': 'week(s)',
        'months': 'month(s)',
    }[unit]
    return f"{amount} {label}"


def _safe_hex(value, fallback='#0F766E'):
    raw = str(value or '').strip()
    return raw if re.fullmatch(r'#[0-9A-Fa-f]{6}', raw) else fallback


def _hex_luminance(value):
    raw = _safe_hex(value).lstrip('#')
    red = int(raw[0:2], 16) / 255
    green = int(raw[2:4], 16) / 255
    blue = int(raw[4:6], 16) / 255
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def build_finance_pdf(document, company, logo_path=''):
    """Return an A4 quotation/invoice as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
        CondPageBreak,
        HRFlowable,
        KeepTogether,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buffer = BytesIO()
    page_width, page_height = A4
    margin = 13 * mm
    footer_height = 17 * mm
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=29 * mm,
        bottomMargin=footer_height + 4 * mm,
        title=_text(document.get('number')),
        author=_text(company.get('companyName')),
    )

    styles = getSampleStyleSheet()
    ink = colors.HexColor('#172033')
    muted = colors.HexColor('#64748B')
    rule = colors.HexColor('#CBD5E1')
    panel = colors.HexColor('#F1F5F9')
    accent_hex = _safe_hex(company.get('themeColor'), '#0F766E')
    accent_luminance = _hex_luminance(accent_hex)
    accent = colors.HexColor(accent_hex)
    accent_text = colors.black if accent_luminance > 0.68 else colors.white
    accent_on_white = ink if accent_luminance > 0.74 else accent
    success = colors.HexColor('#0F766E')

    body = ParagraphStyle(
        'FinanceBody',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=ink,
    )
    small = ParagraphStyle(
        'FinanceSmall',
        parent=body,
        fontSize=7.2,
        leading=9,
        textColor=muted,
    )
    label = ParagraphStyle(
        'FinanceLabel',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=7.2,
        leading=9,
        textColor=muted,
        spaceAfter=2,
    )
    table_header_label = ParagraphStyle(
        'FinanceTableHeaderLabel',
        parent=label,
        textColor=accent_text,
    )
    title_style = ParagraphStyle(
        'FinanceTitle',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=23,
        textColor=ink,
    )
    number_style = ParagraphStyle(
        'FinanceNumber',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=15,
        textColor=accent_on_white,
        alignment=TA_RIGHT,
    )
    project_reference_style = ParagraphStyle(
        'FinanceProjectReference',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=11.5,
        leading=14,
        textColor=accent_on_white,
        alignment=TA_RIGHT,
    )
    right = ParagraphStyle('FinanceRight', parent=body, alignment=TA_RIGHT)
    center = ParagraphStyle('FinanceCenter', parent=body, alignment=TA_CENTER)
    table_header_center = ParagraphStyle(
        'FinanceTableHeaderCenter', parent=table_header_label, alignment=TA_CENTER
    )
    table_header_right = ParagraphStyle(
        'FinanceTableHeaderRight', parent=table_header_label, alignment=TA_RIGHT
    )
    right_bold = ParagraphStyle(
        'FinanceRightBold',
        parent=right,
        fontName='Helvetica-Bold',
    )
    section_title = ParagraphStyle(
        'FinanceSectionTitle',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=9.5,
        leading=12,
        textColor=ink,
        spaceBefore=4,
        spaceAfter=5,
    )

    footer_text = _text(company.get('footerText')).strip()
    letterhead_lines = [
        _text(line).strip()
        for line in str(company.get('letterheadText') or '').splitlines()
        if _text(line).strip()
    ]
    letterhead_enabled = company.get('letterheadEnabled', True) is not False
    company_name = _text(company.get('companyName')).strip()
    company_lines = (letterhead_lines or [
        company_name,
        f"UEN / Reg No: {_text(company.get('registrationNumber'))}" if company.get('registrationNumber') else '',
        _text(company.get('billingAddress')),
        ' | '.join(
            value for value in (
                _text(company.get('phone')),
                _text(company.get('email')),
                _text(company.get('website')),
            ) if value
        ),
    ]) if letterhead_enabled else []
    company_lines = [line for line in company_lines if line]
    company_detail_lines = [
        line for line in company_lines
        if not company_name or line.casefold() != company_name.casefold()
    ]

    def draw_page(canvas, pdf_doc):
        canvas.saveState()
        canvas.setFillColor(colors.white)
        canvas.rect(0, 0, page_width, page_height, stroke=0, fill=1)
        logo_drawn = False
        if logo_path and os.path.exists(logo_path):
            try:
                image = ImageReader(logo_path)
                width, height = image.getSize()
                max_width, max_height = 42 * mm, 14 * mm
                scale = min(max_width / width, max_height / height)
                canvas.drawImage(
                    image,
                    margin,
                    page_height - 21 * mm,
                    width=width * scale,
                    height=height * scale,
                    preserveAspectRatio=True,
                    mask='auto',
                )
                logo_drawn = True
            except Exception:
                logo_drawn = False
        if letterhead_enabled and not logo_drawn:
            canvas.setFont(_canvas_font(company_name, 'Helvetica-Bold'), 15)
            canvas.setFillColor(ink)
            canvas.drawString(margin, page_height - 14 * mm, company_name[:34])

        if letterhead_enabled and logo_drawn and company_name:
            canvas.setFillColor(ink)
            canvas.setFont(
                _canvas_font(company_name, 'Helvetica-Bold'),
                8.8,
            )
            canvas.drawRightString(page_width - margin, page_height - 9.5 * mm, company_name[:72])

        if letterhead_enabled:
            canvas.setFillColor(muted)
            y = page_height - 12.8 * mm if logo_drawn and company_name else page_height - 10 * mm
            for line in company_detail_lines[:4]:
                canvas.setFont(_canvas_font(line, 'Helvetica'), 6.4)
                canvas.drawRightString(page_width - margin, y, line[:100])
                y -= 3 * mm

        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 14 * mm, page_width - margin, 14 * mm)
        canvas.setFillColor(muted)
        footer_line = footer_text.replace('\n', ' | ') if footer_text else company_lines[0] if company_lines else ''
        canvas.setFont(_canvas_font(footer_line, 'Helvetica'), 6.2)
        canvas.drawString(margin, 9 * mm, footer_line[:125])
        canvas.restoreState()

    class NumberedCanvas(Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            page_count = len(self._saved_page_states)
            for page_number, state in enumerate(self._saved_page_states, start=1):
                self.__dict__.update(state)
                self.saveState()
                self.setFillColor(muted)
                self.setFont('Helvetica', 6.2)
                self.drawRightString(
                    page_width - margin,
                    9 * mm,
                    f"Page {page_number} of {page_count}",
                )
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    document_type = str(document.get('type') or 'quotation').lower()
    title = 'INVOICE' if document_type == 'invoice' else 'QUOTATION'
    currency = _text(document.get('currency') or company.get('currency') or 'SGD')
    totals = document.get('totals') or {}
    client = document.get('client') or {}
    lines = document.get('lineItems') or []
    adjustments = document.get('adjustments') or []
    subprojects = document.get('subprojects') or [{'id': 'main', 'name': 'Main Room'}]

    story = [
        Table(
            [[_paragraph(title, title_style), _paragraph(document.get('number'), number_style)]],
            colWidths=[doc.width * 0.5, doc.width * 0.5],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ]),
        ),
        HRFlowable(width='100%', thickness=0.7, color=rule),
        Spacer(1, 5 * mm),
    ]

    client_name = ' '.join(
        value for value in (
            str(client.get('salutation') or '').strip(),
            str(client.get('name') or '').strip(),
        )
        if value
    )
    bill_lines = [
        client_name or client.get('contactPerson'),
        client.get('company'),
        client.get('contactPerson') if client.get('contactPerson') != client.get('name') else '',
        client.get('address1'),
        client.get('address2'),
        client.get('address3'),
        client.get('postalCode'),
        client.get('taxNumber'),
        client.get('email'),
        client.get('phone'),
    ]
    bill_lines = [str(value).strip() for value in bill_lines if str(value or '').strip()]

    if document_type == 'invoice':
        date_label, date_value = 'Invoice date', document.get('invoiceDate') or document.get('date')
        secondary_label, secondary_value = 'Due date', document.get('dueDate')
    else:
        date_label, date_value = 'Quotation date', document.get('quotationDate') or document.get('date')
        secondary_label = 'Valid for'
        secondary_value = _validity_label(document)

    meta_rows = [
        [_paragraph(date_label, label), _paragraph(_date(date_value), body)],
        [_paragraph(secondary_label, label), _paragraph(_date(secondary_value) if document_type == 'invoice' else secondary_value, body)],
        [_paragraph('PO / Reference' if document_type == 'invoice' else 'Reference', label), _paragraph(document.get('reference'), body)],
        [_paragraph('Salesperson', label), _paragraph(document.get('salesperson'), body)],
        [_paragraph('Payment terms', label), _paragraph(document.get('paymentTerms'), body)],
    ]
    meta_table = Table(
        meta_rows,
        colWidths=[34 * mm, 51 * mm],
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]),
    )
    client_block = [
        _paragraph('BILL TO', label),
        _paragraph('\n'.join(bill_lines) or 'No client selected', body),
    ]
    client_table = Table(
        [[client_block, meta_table]],
        colWidths=[doc.width - 88 * mm, 88 * mm],
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
            ('BOX', (0, 0), (-1, -1), 0.6, rule),
            ('LINEBEFORE', (1, 0), (1, 0), 0.6, rule),
            ('LEFTPADDING', (0, 0), (-1, -1), 5 * mm),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 4 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4 * mm),
        ]),
    )
    story.extend([client_table, Spacer(1, 4 * mm)])

    event_bits = []
    for event_label, key in (
        ('Project Name', 'projectName'),
        ('Location', 'eventLocation'),
    ):
        if document.get(key):
            event_bits.append(f"<b>{escape(event_label)}:</b> {escape(_text(document[key]))}")
    for event_label, date_key, time_key, additional_key in (
        ('Set-up', 'setupDate', 'setupTime', 'additionalSetups'),
        ('Rehearsal', 'rehearsalDate', 'rehearsalTime', 'additionalRehearsals'),
        ('Show', 'showDate', 'showTime', 'additionalShows'),
        ('Teardown', 'teardownDate', 'teardownTime', 'additionalTeardowns'),
    ):
        rows = []
        if document.get(date_key):
            rows.append({'date': document.get(date_key), 'time': document.get(time_key)})
        if additional_key:
            rows.extend(document.get(additional_key) or [])
        value = _schedule_date_summary(rows)
        if value:
            event_bits.append(f"<b>{escape(event_label)}:</b> {escape(_text(value))}")
    if event_bits:
        quotation_reference = (
            f"Ref: {_text(document.get('sourceQuotationNumber'))}"
            if document_type == 'invoice' and document.get('sourceQuotationNumber')
            else ''
        )
        event_panel_cells = [
            Paragraph(_cjk_markup('<br/>'.join(event_bits)), body)
        ]
        event_panel_widths = [doc.width]
        if quotation_reference:
            event_panel_cells.append(_paragraph(quotation_reference, project_reference_style))
            event_panel_widths = [doc.width * 0.68, doc.width * 0.32]
        event_panel = Table(
            [event_panel_cells],
            colWidths=event_panel_widths,
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), panel),
                ('BOX', (0, 0), (-1, -1), 0.5, rule),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
                ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
            ]),
        )
        story.extend([event_panel, Spacer(1, 4 * mm)])

    departments = []
    for line in lines:
        department = _line_system_name(line)
        if department not in departments:
            departments.append(department)

    show_unit_prices = bool(document.get('showUnitPrices'))
    show_department_discounts = bool(document.get('showDepartmentDiscounts'))
    show_department_subtotals = document.get('showDepartmentSubtotals', True) is not False
    show_line_numbers = document.get('showLineNumbers', True) is not False
    column_widths = [
        8 * mm,
        72 * mm,
        13 * mm,
        20 * mm,
        23 * mm,
        14 * mm,
        30 * mm,
    ]

    if show_unit_prices or show_department_subtotals:
        story.append(_paragraph('LINE ITEMS', section_title))

    export_groups = []
    if show_unit_prices or show_department_subtotals:
        for subproject in subprojects:
            subproject_id = str(subproject.get('id') or 'main')
            subproject_departments = []
            for line in lines:
                if str(line.get('subprojectId') or 'main') != subproject_id:
                    continue
                department = _line_system_name(line)
                if department not in subproject_departments:
                    subproject_departments.append(department)
            export_groups.extend(
                (subproject, department)
                for department in subproject_departments
            )
    department_summaries = []
    for subproject, department in export_groups:
        subproject_id = str(subproject.get('id') or 'main')
        department_lines = [
            line for line in lines
            if _line_system_name(line) == department
            and str(line.get('subprojectId') or 'main') == subproject_id
        ]
        if not department_lines:
            continue
        department_total = sum(float(line.get('total') or 0) for line in department_lines)
        department_total += sum(
            float(row.get('amount') or 0)
            for row in adjustments
            if row.get('scope') == 'department' and row.get('department') == department
            and str(row.get('subprojectId') or 'main') == subproject_id
        )
        department_summaries.append({
            'name': department,
            'department': department,
            'subprojectId': subproject_id,
            'subprojectName': str(subproject.get('name') or 'Room'),
            'lineCount': len(department_lines),
            'total': department_total,
        })
    pdf_line_number = 1
    current_subproject_id = None
    show_subproject_headers = len(subprojects) > 1
    for group_index, (subproject, department) in enumerate(export_groups):
        subproject_id = str(subproject.get('id') or 'main')
        if subproject_id != current_subproject_id:
            current_subproject_id = subproject_id
            if show_subproject_headers:
                story.extend([
                    _paragraph(
                        str(subproject.get('name') or 'Room').upper(),
                        ParagraphStyle(
                            f"Subproject-{subproject_id}",
                            parent=section_title,
                            fontSize=12,
                            leading=15,
                            textColor=accent_on_white,
                            spaceBefore=5,
                        ),
                    ),
                    Spacer(1, 1 * mm),
                ])
        department_lines = [
            line for line in lines
            if _line_system_name(line) == department
            and str(line.get('subprojectId') or 'main') == subproject_id
        ]
        if not department_lines:
            continue
        department_total = sum(float(line.get('total') or 0) for line in department_lines)
        department_adjustments = [
            row for row in adjustments
            if row.get('scope') == 'department' and row.get('department') == department
            and str(row.get('subprojectId') or 'main') == subproject_id
        ]
        department_total += sum(float(row.get('amount') or 0) for row in department_adjustments)
        table_rows = [
            [
                _paragraph(
                    department,
                    ParagraphStyle(
                        f"Department-{len(story)}",
                        parent=body,
                        fontName='Helvetica-Bold',
                        textColor=ink,
                    ),
                ),
                '', '', '', '', '', '',
            ],
            [
                _paragraph('#' if show_line_numbers else '', table_header_center),
                _paragraph('DESCRIPTION', table_header_label),
                _paragraph('DAY(S)', table_header_right),
                _paragraph('QTY', table_header_right),
                _paragraph('UNIT PRICE', table_header_right),
                _paragraph('DISC %', table_header_right),
                _paragraph('TOTAL', table_header_right),
            ],
        ]
        row_styles = [
            ('SPAN', (0, 0), (-1, 0)),
            ('BACKGROUND', (0, 0), (-1, 0), panel),
            ('BACKGROUND', (0, 1), (-1, 1), accent),
            ('TEXTCOLOR', (0, 1), (-1, 1), accent_text),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, 1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, 1), 5),
            ('BOX', (0, 0), (-1, -1), 0.35, rule),
            ('INNERGRID', (0, 1), (-1, -1), 0.35, rule),
        ]

        for line in department_lines:
            description = _text(line.get('description'))
            quantity = f"{float(line.get('quantity') or 0):g}"
            uom = _text('unit(s)' if line.get('uom') == 'units' else line.get('uom')).strip()
            table_rows.append([
                _paragraph(str(pdf_line_number) if show_line_numbers else '', center),
                _paragraph(description, body),
                _paragraph(f"{float(line.get('days') or 0):g}", right),
                _paragraph(f"{quantity} {uom}".strip(), right),
                _paragraph(_money(line.get('unitPrice'), currency) if show_unit_prices else '', right),
                _paragraph(
                    f"{float(line.get('discountPercent') or 0):g}%"
                    if show_unit_prices and float(line.get('discountPercent') or 0)
                    else '',
                    right,
                ),
                _paragraph(_money(line.get('total'), currency) if show_unit_prices else '', right),
            ])
            pdf_line_number += 1

        if show_department_discounts and show_department_subtotals:
            for adjustment in department_adjustments:
                adjustment_index = len(table_rows)
                table_rows.append([
                    '',
                    _paragraph(adjustment.get('label') or 'System discount', body),
                    '', '', '', '',
                    _paragraph(_money(adjustment.get('amount'), currency), right),
                ])
                row_styles.extend([
                    ('SPAN', (1, adjustment_index), (5, adjustment_index)),
                    ('TEXTCOLOR', (1, adjustment_index), (-1, adjustment_index), success),
                    ('BACKGROUND', (0, adjustment_index), (-1, adjustment_index), colors.HexColor('#ECFDF5')),
                ])

        if show_department_subtotals:
            subtotal_index = len(table_rows)
            table_rows.append([
                '',
                _paragraph(f"{department} subtotal", right_bold),
                '', '', '', '',
                _paragraph(_money(department_total, currency), right_bold),
            ])
            row_styles.extend([
                ('SPAN', (1, subtotal_index), (5, subtotal_index)),
                ('BACKGROUND', (0, subtotal_index), (-1, subtotal_index), panel),
                ('LINEABOVE', (0, subtotal_index), (-1, subtotal_index), 0.8, ink),
            ])

        items_table = Table(
            table_rows,
            repeatRows=2,
            colWidths=column_widths,
            style=TableStyle(row_styles),
            splitByRow=1,
        )
        table_flowable = (
            KeepTogether([items_table])
            if len(department_lines) <= 15
            else items_table
        )
        story.append(table_flowable)
        if group_index < len(export_groups) - 1:
            story.append(Spacer(1, 3 * mm))

    if export_groups:
        story.append(CondPageBreak(doc.height))

    tax_label = _text(company.get('taxLabel') or 'Tax')
    tax_rate = float(document.get('taxRate') or 0)
    use_subproject_summary = (
        len(subprojects) > 1
        and document.get('summaryBySubproject', True) is not False
    )
    story.append(_paragraph(
        'SUB-PROJECT SUMMARY' if use_subproject_summary else 'SYSTEM SUMMARY',
        section_title,
    ))
    if department_summaries:
        if use_subproject_summary:
            summary_source = []
            for subproject in subprojects:
                subproject_id = str(subproject.get('id') or 'main')
                rows = [row for row in department_summaries if row['subprojectId'] == subproject_id]
                if rows:
                    summary_source.append({
                        'name': str(subproject.get('name') or 'Room'),
                        'lineCount': sum(row['lineCount'] for row in rows),
                        'total': sum(row['total'] for row in rows),
                    })
        else:
            summary_source = []
            summaries_by_department = {}
            for row in department_summaries:
                department = row['department']
                summary = summaries_by_department.get(department)
                if summary is None:
                    summary = {
                        'name': department,
                        'lineCount': 0,
                        'total': 0,
                    }
                    summaries_by_department[department] = summary
                    summary_source.append(summary)
                summary['lineCount'] += row['lineCount']
                summary['total'] += row['total']
        department_summary_rows = [[
            _paragraph('SUB-PROJECT' if use_subproject_summary else 'SYSTEM', table_header_label),
            _paragraph('LINE ITEMS', table_header_center),
            _paragraph('SUBTOTAL', table_header_right),
        ]]
        for department_summary in summary_source:
            department_summary_rows.append([
                _paragraph(department_summary['name'], body),
                _paragraph(str(department_summary['lineCount']), center),
                _paragraph(_money(department_summary['total'], currency), right_bold),
            ])
        department_summary = Table(
            department_summary_rows,
            repeatRows=1,
            colWidths=[doc.width - 56 * mm, 22 * mm, 34 * mm],
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), accent),
                ('TEXTCOLOR', (0, 0), (-1, 0), accent_text),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 7),
                ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                ('TOPPADDING', (0, 0), (-1, -1), 5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
                ('LINEBELOW', (0, 1), (-1, -1), 0.35, rule),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F8FAFC')]),
            ]),
        )
        story.extend([department_summary, Spacer(1, 4 * mm)])

    summary_rows = []
    if show_unit_prices or show_department_subtotals:
        for adjustment in adjustments:
            if adjustment.get('scope') != 'total':
                continue
            summary_rows.append([
                _paragraph(adjustment.get('label') or 'Total adjustment', body),
                _paragraph(_money(adjustment.get('amount'), currency), right),
            ])
    if tax_rate > 0:
        summary_rows.append(
            [_paragraph('Total before GST', body), _paragraph(_money(totals.get('netSubtotal'), currency), right)]
        )
        summary_rows.extend([
            [_paragraph(f"{tax_label} ({tax_rate:g}%)", body), _paragraph(_money(totals.get('tax'), currency), right)],
            [_paragraph('TOTAL', ParagraphStyle('TotalLabel', parent=body, fontName='Helvetica-Bold', fontSize=10.5)),
             _paragraph(_money(totals.get('total'), currency), ParagraphStyle('TotalAmount', parent=right_bold, fontSize=11, textColor=accent_on_white))],
        ])
    else:
        summary_rows.append([
            _paragraph('TOTAL', ParagraphStyle('TotalLabelNoTax', parent=body, fontName='Helvetica-Bold', fontSize=10.5)),
            _paragraph(_money(totals.get('netSubtotal'), currency), ParagraphStyle('TotalAmountNoTax', parent=right_bold, fontSize=11, textColor=accent_on_white)),
        ])
    summary = Table(
        summary_rows,
        colWidths=[56 * mm, 40 * mm],
        hAlign='RIGHT',
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 9),
            ('RIGHTPADDING', (0, 0), (-1, -1), 9),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LINEABOVE', (0, -1), (-1, -1), 1.1, ink),
            ('BACKGROUND', (0, -1), (-1, -1), panel),
        ]),
    )
    story.extend([summary, Spacer(1, 5 * mm)])

    payment_lines = []
    for payment_label, key in (
        ('Bank', 'bankName'),
        ('Account name', 'bankAccountName'),
        ('Account number', 'bankAccountNumber'),
        ('PayNow UEN', 'paynowUen'),
    ):
        if company.get(key):
            payment_lines.append(f"<b>{escape(payment_label)}:</b> {escape(_text(company[key]))}")

    notes = _text(document.get('notes')).strip()
    terms = _text(document.get('terms') or company.get('defaultTerms')).strip()
    if notes:
        story.append(KeepTogether([
            _paragraph('NOTES', section_title),
            _paragraph(notes, body),
        ]))
    if document_type == 'invoice' and payment_lines:
        story.append(KeepTogether([
            _paragraph('PAYMENT DETAILS', section_title),
            Paragraph(_cjk_markup('<br/>'.join(payment_lines)), body),
        ]))
    if terms:
        story.append(KeepTogether([
            _paragraph('TERMS AND CONDITIONS', section_title),
            _paragraph(terms, small),
        ]))

    if document.get('showSignOff'):
        signoff_heading = ParagraphStyle(
            'FinanceSignOffHeading',
            parent=body,
            fontName='Helvetica-Bold',
            fontSize=9.5,
            leading=12,
        )
        signoff_name = ParagraphStyle(
            'FinanceSignOffName',
            parent=body,
            fontName='Helvetica-Bold',
            fontSize=9,
            leading=11,
        )
        signoff_caption = ParagraphStyle(
            'FinanceSignOffCaption',
            parent=small,
            fontName='Helvetica-Bold',
            fontSize=7.5,
            leading=9,
            alignment=TA_CENTER,
            textColor=ink,
        )
        quotation_reference = (
            document.get('sourceQuotationNumber')
            if document_type == 'invoice'
            else document.get('number')
        ) or document.get('number')
        quoted_by = [
            _paragraph('Quoted by:', signoff_heading),
            Spacer(1, 18 * mm),
            _paragraph(document.get('salesperson') or company.get('companyName') or '', signoff_name),
        ]
        if document.get('salespersonPhone'):
            quoted_by.append(_paragraph(f"Mobile: {document.get('salespersonPhone')}", body))
        quoted_by.append(_paragraph(f"Quote Ref: {quotation_reference}", body))
        accepted_by = [
            _paragraph('Confirmed & accepted by:', signoff_heading),
            Spacer(1, 25 * mm),
            HRFlowable(width='100%', thickness=0.8, color=ink),
            Spacer(1, 1.5 * mm),
            _paragraph('(Authorised Signature / Date / Co. Stamp)', signoff_caption),
        ]
        signoff = Table(
            [[quoted_by, accepted_by]],
            colWidths=[doc.width * 0.46, doc.width * 0.46],
            hAlign='CENTER',
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (0, 0), 0),
                ('RIGHTPADDING', (0, 0), (0, 0), 10 * mm),
                ('LEFTPADDING', (1, 0), (1, 0), 10 * mm),
                ('RIGHTPADDING', (1, 0), (1, 0), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]),
        )
        story.append(KeepTogether([Spacer(1, 8 * mm), signoff]))

    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()


def safe_pdf_filename(number, fallback='document'):
    value = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(number or fallback)).strip('._')
    return f"{value or fallback}.pdf"
