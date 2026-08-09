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
    return base_department or 'Unknown'


def _group_line_description(line):
    if not isinstance(line, dict) or not line.get('groupId'):
        return _text((line or {}).get('description'))
    if line.get('groupCustomText'):
        return _text(line.get('description'))
    fields = line.get('groupDisplayFields') or ['brand', 'model', 'description']
    description = _group_description_part(line)
    values = []
    for field in fields:
        if field not in {'brand', 'model', 'description'}:
            continue
        value = (
            description
            if field == 'description'
            else _text(line.get(field)).strip()
        )
        if value and value not in values:
            values.append(value)
    return ' '.join(values) or _text(line.get('description'))


def _group_description_part(line):
    line = line if isinstance(line, dict) else {}
    description = _text(line.get('description')).strip()
    if not description:
        return ''
    brand = _text(line.get('brand')).strip()
    model = _text(line.get('model')).strip()
    prefixes = sorted({
        prefix for prefix in (
            ' '.join(value for value in (brand, model) if value),
            ' '.join(value for value in (model, brand) if value),
            brand,
            model,
        ) if prefix
    }, key=len, reverse=True)
    for prefix in prefixes:
        if not description.casefold().startswith(prefix.casefold()):
            continue
        boundary = description[len(prefix):len(prefix) + 1]
        if boundary and not re.match(r'[\s\-\u2013\u2014:|/]', boundary):
            continue
        remainder = re.sub(
            r'^[\s\-\u2013\u2014:|/]+', '', description[len(prefix):]
        ).strip()
        if remainder:
            return remainder
    return description


def _group_pdf_line_units(lines):
    """Return PDF rows, keeping all members of a group in one logical row."""
    source = [line for line in (lines or []) if isinstance(line, dict)]
    rendered_groups = set()
    units = []
    for line in source:
        group_id = str(line.get('groupId') or '')
        if not group_id:
            units.append([line])
            continue
        if group_id in rendered_groups:
            continue
        rendered_groups.add(group_id)
        units.append([
            candidate for candidate in source
            if str(candidate.get('groupId') or '') == group_id
        ])
    return units


def _group_display_entries(lines):
    """Consolidate group members exactly as their selected display fields render."""
    entries = []
    by_key = {}
    for line in lines or []:
        description = _group_line_description(line).strip() or 'Item'
        key = (bool(line.get('groupCustomText')), description.casefold())
        if key not in by_key:
            by_key[key] = {
                'description': description,
                'quantity': 0.0,
            }
            entries.append(by_key[key])
        by_key[key]['quantity'] += max(
            0.0, float(line.get('groupItemQuantity', 1) or 0)
        )
    return entries


def _is_optional_category(value):
    return bool(re.search(r'\boptional\b', str(value or ''), flags=re.IGNORECASE))


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


def _adjustment_label(adjustment, fallback='Discount'):
    adjustment = adjustment if isinstance(adjustment, dict) else {}
    label = _text(adjustment.get('label') or fallback).strip() or fallback
    if label.casefold() == 'system discount':
        label = 'Discount'
    try:
        percent = abs(float(adjustment.get('percent') or 0))
    except (TypeError, ValueError):
        percent = 0
    if percent and not re.search(r'\d+(?:\.\d+)?\s*%', label):
        percent_text = f'{percent:.2f}'.rstrip('0').rstrip('.')
        label = f'{label} ({percent_text}%)'
    return label


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
            label = f"{start.day} - {end.day} {end.strftime('%B %Y')}"
        elif start.year == end.year:
            label = f"{start.day} {start.strftime('%B')} - {end.day} {end.strftime('%B %Y')}"
        else:
            label = f"{start.day} {start.strftime('%B %Y')} - {end.day} {end.strftime('%B %Y')}"
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


def _schedule_identity(date_value, time_value=''):
    return (
        str(date_value or '').strip(),
        str(time_value or '').strip().casefold(),
    )


def _schedule_range_label(start, end):
    if start == end:
        return f"{start.day} {start.strftime('%B %Y')}"
    if start.year == end.year and start.month == end.month:
        return f"{start.day} - {end.day} {end.strftime('%B %Y')}"
    if start.year == end.year:
        return f"{start.day} {start.strftime('%B')} - {end.day} {end.strftime('%B %Y')}"
    return f"{start.day} {start.strftime('%B %Y')} - {end.day} {end.strftime('%B %Y')}"


def _schedule_recurring_batch_details(batch):
    if not isinstance(batch, dict) or batch.get('method') != 'recurring':
        return None
    try:
        start = datetime.strptime(str(batch.get('startDate') or ''), '%Y-%m-%d').date()
        end = datetime.strptime(str(batch.get('endDate') or ''), '%Y-%m-%d').date()
    except ValueError:
        return None
    weekdays = {
        int(day)
        for day in batch.get('weekdays') or []
        if str(day).strip().lstrip('-').isdigit() and 0 <= int(day) <= 6
    }
    if end < start:
        return None
    interval = max(1, min(52, int(batch.get('intervalWeeks') or 1)))
    time_value = str(batch.get('time') or '').strip()
    expected = set()
    cursor = start
    while cursor <= end and len(expected) < 500:
        elapsed_days = (cursor - start).days
        # JavaScript's getUTCDay uses Sunday=0; Python's weekday uses Monday=0.
        javascript_weekday = (cursor.weekday() + 1) % 7
        if not weekdays or (
            javascript_weekday in weekdays
            and (elapsed_days // 7) % interval == 0
        ):
            expected.add(_schedule_identity(cursor.isoformat(), time_value))
        cursor += timedelta(days=1)
    return {
        'start': start,
        'end': end,
        'weekdays': weekdays,
        'interval': interval,
        'time': time_value,
        'expected': expected,
    }


def _schedule_recurring_batch_summary(batch, all_rows):
    details = _schedule_recurring_batch_details(batch)
    if not details:
        return '', set()
    available = {
        _schedule_identity(row.get('date'), row.get('time'))
        for row in all_rows
        if isinstance(row, dict) and row.get('date')
    }
    excluded = {
        tuple(str(identity or '').split('|', 1))
        for identity in batch.get('excludedDates') or []
        if '|' in str(identity or '')
    }
    required = details['expected'] - excluded
    if not required or not required.issubset(available):
        return '', set()

    day_names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    selected_days = [day_names[day] for day in sorted(details['weekdays'])]
    if not selected_days:
        summary = _schedule_range_label(details['start'], details['end'])
    else:
        if len(selected_days) > 1:
            day_label = ', '.join(selected_days[:-1]) + f" and {selected_days[-1]}"
        else:
            day_label = selected_days[0]
        if details['interval'] == 1:
            recurrence = f"Every {day_label}"
        else:
            recurrence = f"Every {details['interval']} weeks on {day_label}"
        summary = f"{recurrence}, {_schedule_range_label(details['start'], details['end'])}"
    if details['time']:
        summary += f", {details['time']}hrs"

    missing_dates = sorted(
        datetime.strptime(date_value, '%Y-%m-%d').date()
        for date_value, _time_value in excluded
        if (date_value, _time_value) in details['expected']
    )
    if missing_dates:
        summary += '; except ' + ', '.join(
            f"{value.day} {value.strftime('%B %Y')}"
            for value in missing_dates
        )
    return summary, required


def _schedule_rows_summary(document, rows, kind):
    rows = [row for row in rows or [] if isinstance(row, dict)]
    if not rows:
        return ''

    batch_segments = []
    covered = set()
    handled_batch_ids = set()
    for batch in document.get('scheduleBatches') or []:
        if not isinstance(batch, dict) or batch.get('kind') != kind:
            continue
        batch_id = str(batch.get('id') or '')
        batch_rows = [row for row in rows if str(row.get('batchId') or '') == batch_id]
        if not batch_rows:
            continue
        handled_batch_ids.add(batch_id)
        recurring_summary, recurring_identities = _schedule_recurring_batch_summary(batch, rows)
        if recurring_summary:
            batch_segments.append(recurring_summary)
            covered.update(recurring_identities)
            continue
        explicit = _schedule_date_summary(batch_rows)
        if explicit:
            batch_segments.append(explicit)
            covered.update(
                _schedule_identity(row.get('date'), row.get('time'))
                for row in batch_rows
            )

    remaining = [
        row for row in rows
        if (
            _schedule_identity(row.get('date'), row.get('time')) not in covered
            and str(row.get('batchId') or '') not in handled_batch_ids
        )
    ]
    remaining_summary = _schedule_date_summary(remaining)
    return '; '.join([
        *([remaining_summary] if remaining_summary else []),
        *batch_segments,
    ])


def _schedule_document_summary(document, date_key, time_key, additional_key, kind):
    rows = []
    if document.get(date_key):
        rows.append({
            'date': document.get(date_key),
            'time': document.get(time_key),
            'batchId': '',
        })
    if additional_key:
        rows.extend(document.get(additional_key) or [])
    return _schedule_rows_summary(document, rows, kind)


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
        HRFlowable,
        KeepInFrame,
        KeepTogether,
        PageBreak,
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
    optional_body = ParagraphStyle(
        'FinanceOptionalBody',
        parent=body,
        textColor=muted,
    )
    optional_center = ParagraphStyle(
        'FinanceOptionalCenter',
        parent=optional_body,
        alignment=TA_CENTER,
    )
    optional_right_bold = ParagraphStyle(
        'FinanceOptionalRightBold',
        parent=optional_body,
        fontName='Helvetica-Bold',
        alignment=TA_RIGHT,
    )
    quotation_reference_style = ParagraphStyle(
        'FinanceQuotationReference',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=9.2,
        leading=11,
        textColor=accent_on_white,
    )
    project_name_style = ParagraphStyle(
        'FinanceProjectName',
        parent=body,
        fontName='Helvetica-Bold',
        fontSize=11.5,
        leading=14,
        textColor=ink,
    )
    project_location_style = ParagraphStyle(
        'FinanceProjectLocation',
        parent=body,
        fontSize=9,
        leading=11.5,
        textColor=ink,
    )
    event_schedule_style = ParagraphStyle(
        'FinanceEventSchedule',
        parent=body,
        fontSize=7.5,
        leading=10,
        textColor=ink,
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
    summary_section_title = ParagraphStyle(
        'FinanceSummarySectionTitle',
        parent=section_title,
        alignment=TA_LEFT,
        leftIndent=0,
        firstLineIndent=0,
        rightIndent=0,
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
    multiplier_labels = {
        'Mult'
        if str(line.get('costingMultiplierLabel') or '').strip().lower() == 'mult'
        else 'Day'
        for line in lines
    }
    multiplier_column_label = (
        'MULT' if multiplier_labels == {'Mult'} else 'DAY(S)'
    )

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

    meta_values = [
        (date_label, _date(date_value)),
        (
            secondary_label,
            _date(secondary_value) if document_type == 'invoice' else secondary_value,
        ),
        (
            'PO / Reference' if document_type == 'invoice' else 'Reference',
            document.get('reference'),
        ),
        ('Salesperson', document.get('salesperson')),
        ('Payment terms', document.get('paymentTerms')),
    ]
    if document_type == 'invoice' and document.get('sourceQuotationNumber'):
        meta_values.append(
            ('Quotation ref', document.get('sourceQuotationNumber'))
        )
    meta_rows = [
        [
            _paragraph(meta_label, label),
            _paragraph(
                meta_value,
                quotation_reference_style
                if meta_label == 'Quotation ref'
                else body,
            ),
        ]
        for meta_label, meta_value in meta_values
        if _text(meta_value).strip()
    ]
    meta_table = Table(
        meta_rows,
        colWidths=[32 * mm, 46 * mm],
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 1),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ]),
    ) if meta_rows else []
    client_block = []
    if bill_lines:
        client_block = [
            _paragraph('BILL TO', label),
            _paragraph('\n'.join(bill_lines), body),
        ]
    if client_block or meta_rows:
        if client_block and meta_rows:
            client_data = [[client_block, meta_table]]
            client_widths = [doc.width - 88 * mm, 88 * mm]
            client_alignment = 'CENTER'
            client_divider = [('LINEBEFORE', (1, 0), (1, 0), 0.6, rule)]
        elif client_block:
            client_data = [[client_block]]
            client_widths = [doc.width]
            client_alignment = 'LEFT'
            client_divider = []
        else:
            client_data = [[meta_table]]
            client_widths = [88 * mm]
            client_alignment = 'RIGHT'
            client_divider = []
        client_table = Table(
            client_data,
            colWidths=client_widths,
            hAlign=client_alignment,
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('BACKGROUND', (0, 0), (-1, -1), colors.white),
                ('BOX', (0, 0), (-1, -1), 0.6, rule),
                ('LEFTPADDING', (0, 0), (-1, -1), 5 * mm),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
                ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
                *client_divider,
            ]),
        )
        story.extend([client_table, Spacer(1, 4 * mm)])

    schedule_entries = []
    dry_hire_schedule = str(document.get('scheduleMode') or '').strip().lower() == 'dry-hire'
    standard_schedules = {
        'setup': (
            'Delivery / Collection' if dry_hire_schedule else 'Set-up',
            'setupDate',
            'setupTime',
            'additionalSetups',
        ),
        'rehearsal': ('Rehearsal', 'rehearsalDate', 'rehearsalTime', 'additionalRehearsals'),
        'show': ('Show', 'showDate', 'showTime', 'additionalShows'),
        'teardown': (
            'Return' if dry_hire_schedule else 'Teardown',
            'teardownDate',
            'teardownTime',
            'additionalTeardowns',
        ),
    }
    custom_schedules = {
        f"custom:{row.get('id')}": row
        for row in document.get('customScheduleGroups') or []
        if isinstance(row, dict) and row.get('id') and row.get('label')
    }
    schedule_order = []
    valid_schedule_tokens = set(standard_schedules) | set(custom_schedules)
    for token in document.get('scheduleOrder') or []:
        if token in valid_schedule_tokens and token not in schedule_order:
            schedule_order.append(token)
    for token in (*standard_schedules, *custom_schedules):
        if token not in schedule_order:
            schedule_order.append(token)

    for token in schedule_order:
        if token in standard_schedules:
            event_label, date_key, time_key, additional_key = standard_schedules[token]
            value = _schedule_document_summary(
                document,
                date_key,
                time_key,
                additional_key,
                token,
            )
        else:
            custom_schedule = custom_schedules[token]
            event_label = str(custom_schedule.get('label') or '').strip()
            value = _schedule_rows_summary(
                document,
                custom_schedule.get('dates') or [],
                token,
            )
        if value:
            schedule_entries.append((event_label, _text(value)))

    project_name = _text(document.get('projectName')).strip()
    project_location = _text(document.get('eventLocation')).strip()
    if project_name or project_location or schedule_entries:
        project_column_width = doc.width - 88 * mm
        project_block = []
        if project_name:
            project_block.extend([
                _paragraph('PROJECT', label),
                _paragraph(project_name, project_name_style),
            ])
        if project_location:
            if project_block:
                project_block.append(Spacer(1, 1 * mm))
            project_block.extend([
                _paragraph('LOCATION', label),
                _paragraph(project_location, project_location_style),
            ])

        schedule_block = []
        if schedule_entries:
            schedule_table = Table(
                [[
                    _paragraph(f'{event_label}:', label),
                    _paragraph(value, event_schedule_style),
                ] for event_label, value in schedule_entries],
                colWidths=[26 * mm, 54 * mm],
                style=TableStyle([
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                    ('TOPPADDING', (0, 0), (-1, -1), 0),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
                ]),
            )
            schedule_block = [
                _paragraph('EVENT SCHEDULE', label),
                schedule_table,
            ]
        event_panel = Table(
            [[project_block, schedule_block]],
            colWidths=[project_column_width, 88 * mm],
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), panel),
                ('BOX', (0, 0), (-1, -1), 0.5, rule),
                ('LINEBEFORE', (1, 0), (1, 0), 0.5, rule),
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

    if lines:
        story.append(_paragraph('LINE ITEMS', section_title))

    export_groups = []
    if lines:
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
            'optional': _is_optional_category(department),
            'subprojectId': subproject_id,
            'subprojectName': str(subproject.get('name') or 'Room'),
            'lineCount': len(_group_pdf_line_units(department_lines)),
            'total': department_total,
        })
    pdf_line_number = 1
    subproject_numbers = {
        str(subproject.get('id') or 'main'): index
        for index, subproject in enumerate(subprojects, start=1)
    }
    subproject_line_numbers = {
        subproject_id: 0
        for subproject_id in subproject_numbers
    }
    current_subproject_id = None
    show_subproject_headers = len(subprojects) > 1
    for group_index, (subproject, department) in enumerate(export_groups):
        subproject_id = str(subproject.get('id') or 'main')
        optional_category = _is_optional_category(department)
        first_group_for_subproject = subproject_id != current_subproject_id
        if first_group_for_subproject:
            current_subproject_id = subproject_id
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
        table_rows = []
        room_header_row = None
        if show_subproject_headers and first_group_for_subproject:
            room_header_row = len(table_rows)
            subproject_number = subproject_numbers.get(subproject_id, 1)
            table_rows.append([
                _paragraph(
                    f"{subproject_number}. {str(subproject.get('name') or 'Room')}",
                    ParagraphStyle(
                        f"Subproject-{subproject_id}",
                        parent=body,
                        fontName='Helvetica-Bold',
                        alignment=TA_CENTER,
                        textColor=ink,
                    ),
                ),
                '', '', '', '', '', '',
            ])
        department_header_row = len(table_rows)
        table_rows.extend([
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
                _paragraph(multiplier_column_label, table_header_right),
                _paragraph('QTY', table_header_right),
                _paragraph('UNIT PRICE', table_header_right),
                _paragraph('DISC %', table_header_right),
                _paragraph('TOTAL', table_header_right),
            ],
        ])
        column_header_row = department_header_row + 1
        row_styles = [
            ('SPAN', (0, department_header_row), (-1, department_header_row)),
            ('BACKGROUND', (0, department_header_row), (-1, department_header_row), panel),
            ('BACKGROUND', (0, column_header_row), (-1, column_header_row), accent),
            ('TEXTCOLOR', (0, column_header_row), (-1, column_header_row), accent_text),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, department_header_row), (-1, column_header_row), 5),
            ('BOTTOMPADDING', (0, department_header_row), (-1, column_header_row), 5),
            ('BOX', (0, 0), (-1, -1), 0.35, rule),
            ('INNERGRID', (0, column_header_row), (-1, -1), 0.35, rule),
        ]
        if room_header_row is not None:
            row_styles.extend([
                ('SPAN', (0, room_header_row), (-1, room_header_row)),
                ('ALIGN', (0, room_header_row), (-1, room_header_row), 'CENTER'),
                ('VALIGN', (0, room_header_row), (-1, room_header_row), 'MIDDLE'),
                ('BACKGROUND', (0, room_header_row), (-1, room_header_row), panel),
                ('BOX', (0, room_header_row), (-1, room_header_row), 0.35, rule),
                ('TOPPADDING', (0, room_header_row), (-1, room_header_row), 5),
                ('BOTTOMPADDING', (0, room_header_row), (-1, room_header_row), 5),
            ])

        for line_unit in _group_pdf_line_units(department_lines):
            line = next(
                (member for member in line_unit if member.get('groupLeader')),
                line_unit[0],
            )
            is_group = bool(line.get('groupId'))
            if is_group:
                title_markup = _cjk_markup(
                    escape(_text(line.get('groupTitle') or 'Group')),
                    bold=True,
                )
                content_markup = '<br/>'.join(
                    _cjk_markup(escape(
                        f"{entry['quantity']:g}x {entry['description']}"
                    ))
                    for entry in _group_display_entries(line_unit)
                )
                description_flowable = Paragraph(
                    f'<b>{title_markup}</b>'
                    + (f'<br/>{content_markup}' if content_markup else ''),
                    body,
                )
                display_days = float(line.get('days') or 0)
                quantity = f"{float(line.get('quantity') or 0):g}"
                uom = _text(
                    'unit(s)' if line.get('uom') == 'units' else line.get('uom')
                ).strip()
                quantity_label = f"{quantity} {uom}".strip()
                unit_price = float(line.get('unitPrice') or 0)
                group_total = float(line.get('total') or 0)
            else:
                description_flowable = _paragraph(
                    _group_line_description(line), body
                )
                display_days = float(line.get('days') or 0)
                quantity = f"{float(line.get('quantity') or 0):g}"
                uom = _text(
                    'unit(s)' if line.get('uom') == 'units' else line.get('uom')
                ).strip()
                quantity_label = f"{quantity} {uom}".strip()
                unit_price = float(line.get('unitPrice') or 0)
                group_total = float(line.get('total') or 0)
            if show_subproject_headers:
                subproject_line_numbers[subproject_id] = (
                    subproject_line_numbers.get(subproject_id, 0) + 1
                )
                line_number = (
                    f"{subproject_numbers.get(subproject_id, 1)}."
                    f"{subproject_line_numbers[subproject_id]:02d}"
                )
            else:
                line_number = str(pdf_line_number)
            table_rows.append([
                _paragraph(line_number if show_line_numbers else '', center),
                description_flowable,
                _paragraph(f"{display_days:g}" if display_days else '', right),
                _paragraph(quantity_label, right),
                _paragraph(_money(unit_price, currency) if show_unit_prices else '', right),
                _paragraph(
                    f"{float(line.get('discountPercent') or 0):g}%"
                    if show_unit_prices and float(line.get('discountPercent') or 0)
                    else '',
                    right,
                ),
                _paragraph(_money(group_total, currency) if show_unit_prices else '', right),
            ])
            pdf_line_number += 1

        show_department_adjustment_block = bool(
            show_department_discounts
            and show_department_subtotals
            and department_adjustments
        )
        if show_department_adjustment_block:
            for adjustment_position, adjustment in enumerate(department_adjustments):
                adjustment_index = len(table_rows)
                table_rows.append([
                    '',
                    _paragraph(_adjustment_label(adjustment), right),
                    '', '', '', '',
                    _paragraph(_money(adjustment.get('amount'), currency), right),
                ])
                row_styles.extend([
                    ('SPAN', (1, adjustment_index), (5, adjustment_index)),
                    ('TEXTCOLOR', (1, adjustment_index), (-1, adjustment_index), success),
                    ('BACKGROUND', (0, adjustment_index), (-1, adjustment_index), panel),
                ])
                if adjustment_position == 0:
                    row_styles.append(
                        ('LINEABOVE', (0, adjustment_index), (-1, adjustment_index), 0.8, ink)
                    )

        if show_department_subtotals or optional_category:
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
            ])
            if not show_department_adjustment_block:
                row_styles.append(
                    ('LINEABOVE', (0, subtotal_index), (-1, subtotal_index), 0.8, ink)
                )

        items_table = Table(
            table_rows,
            repeatRows=3 if room_header_row is not None else 2,
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
        story.append(PageBreak())

    final_page_story = []

    tax_label = _text(company.get('taxLabel') or 'Tax')
    tax_rate = float(document.get('taxRate') or 0)
    use_subproject_summary = (
        len(subprojects) > 1
        and document.get('summaryBySubproject', True) is not False
    )
    included_department_summaries = [
        row for row in department_summaries if not row['optional']
    ]
    optional_department_summaries = [
        row for row in department_summaries if row['optional']
    ]

    def aggregate_category_summaries(rows):
        aggregated = []
        by_department = {}
        for row in rows:
            department = row['department']
            category = by_department.get(department)
            if category is None:
                category = {
                    'name': department,
                    'lineCount': 0,
                    'total': 0,
                    'optional': row['optional'],
                }
                by_department[department] = category
                aggregated.append(category)
            category['lineCount'] += row['lineCount']
            category['total'] += row['total']
        return aggregated

    final_page_story.append(_paragraph('Summary', summary_section_title))
    if department_summaries:
        if use_subproject_summary:
            summary_source = []
            for subproject in subprojects:
                subproject_id = str(subproject.get('id') or 'main')
                rows = [
                    row for row in included_department_summaries
                    if row['subprojectId'] == subproject_id
                ]
                if rows:
                    summary_source.append({
                        'name': str(subproject.get('name') or 'Room'),
                        'lineCount': sum(row['lineCount'] for row in rows),
                        'total': sum(row['total'] for row in rows),
                        'optional': False,
                    })
            summary_source.extend(
                aggregate_category_summaries(optional_department_summaries)
            )
        else:
            summary_source = aggregate_category_summaries(department_summaries)
        summary_shows_price = (
            show_department_subtotals
            or any(row['optional'] for row in summary_source)
        )
        summary_has_optional_rows = any(row['optional'] for row in summary_source)
        summary_middle_width = 34 * mm if summary_has_optional_rows else 22 * mm
        summary_first_column = (
            'PROJECT / CATEGORY'
            if use_subproject_summary and optional_department_summaries
            else ('PROJECT' if use_subproject_summary else 'CATEGORY')
        )
        department_summary_rows = [[
            _paragraph(summary_first_column, table_header_label),
            _paragraph('LINE ITEMS', table_header_center),
            *(
                [_paragraph('SUBTOTAL', table_header_right)]
                if summary_shows_price
                else []
            ),
        ]]
        for department_summary in summary_source:
            row_body = optional_body if department_summary['optional'] else body
            row_center = optional_center if department_summary['optional'] else center
            row_amount = optional_right_bold if department_summary['optional'] else right_bold
            department_summary_rows.append([
                _paragraph(department_summary['name'], row_body),
                _paragraph(
                    'Not included in total'
                    if department_summary['optional']
                    else str(department_summary['lineCount']),
                    row_center,
                ),
                *(
                    [_paragraph(_money(department_summary['total'], currency), row_amount)]
                    if show_department_subtotals or department_summary['optional']
                    else ([''] if summary_shows_price else [])
                ),
            ])
        department_summary = Table(
            department_summary_rows,
            repeatRows=1,
            colWidths=(
                [doc.width - summary_middle_width - 34 * mm, summary_middle_width, 34 * mm]
                if summary_shows_price
                else [doc.width - 30 * mm, 30 * mm]
            ),
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
        final_page_story.extend([department_summary, Spacer(1, 4 * mm)])

    payment_lines = []
    if document_type == 'invoice':
        for payment_label, key in (
            ('Bank', 'bankName'),
            ('Account name', 'bankAccountName'),
            ('Account number', 'bankAccountNumber'),
            ('PayNow UEN', 'paynowUen'),
        ):
            if company.get(key):
                payment_lines.append(
                    f"<b>{escape(payment_label)}:</b> "
                    f"{escape(_text(company[key]))}"
                )

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
    if payment_lines:
        payment_heading = ParagraphStyle(
            'FinancePaymentHeading',
            parent=section_title,
            spaceBefore=0,
            spaceAfter=3,
        )
        payment_details = [
            _paragraph('PAYMENT DETAILS', payment_heading),
            Paragraph(_cjk_markup('<br/>'.join(payment_lines)), body),
        ]
        payment_and_total = Table(
            [[payment_details, summary]],
            colWidths=[doc.width - 100 * mm, 100 * mm],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (0, 0), 5 * mm),
                ('RIGHTPADDING', (1, 0), (1, 0), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]),
        )
        final_page_story.append(payment_and_total)
    else:
        final_page_story.append(summary)

    final_page_story.append(Spacer(1, 5 * mm))

    notes = _text(document.get('notes')).strip()
    terms = _text(document.get('terms') or company.get('defaultTerms')).strip()
    if notes:
        final_page_story.extend([
            _paragraph('NOTES', section_title),
            _paragraph(notes, body),
        ])
    if terms:
        final_page_story.extend([
            _paragraph('TERMS AND CONDITIONS', section_title),
            _paragraph(terms, small),
        ])

    if document_type != 'invoice' and document.get('showSignOff'):
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
        final_page_story.extend([Spacer(1, 8 * mm), signoff])

    story.append(KeepInFrame(
        doc.width,
        doc.height,
        final_page_story,
        mergeSpace=1,
        mode='shrink',
        name='FinanceFinalSummaryPage',
        hAlign='LEFT',
        vAlign='TOP',
    ))

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
