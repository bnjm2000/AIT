"""Print-ready quotation and invoice PDF rendering."""

from io import BytesIO
from html import escape
from datetime import datetime, timedelta
import os
import re
import threading

from pdf_fonts import pdf_font_names, pdf_text_typography
from pdf_rich_text import (
    plain_text_to_rich_html,
    rich_text_to_reportlab_markup,
    sanitise_pdf_rich_text,
)


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
        # Preserve punctuation that belongs to the inventory description. A
        # leading "- " is meaningful content, not merely a display separator.
        remainder = description[len(prefix):].strip()
        if remainder:
            return remainder
    return description


def _group_pdf_line_units(lines):
    """Return PDF rows, keeping all members of a group in one logical row."""
    source = [line for line in (lines or []) if isinstance(line, dict)]
    group_indexes = {}
    units = []
    for line in source:
        group_id = str(line.get('groupId') or '')
        if not group_id:
            units.append([line])
            continue
        group_index = group_indexes.get(group_id)
        if group_index is None:
            group_indexes[group_id] = len(units)
            units.append([line])
        else:
            units[group_index].append(line)
    return units


def _pdf_line_unit_key(line_unit):
    line = next(
        (member for member in (line_unit or []) if member.get('groupLeader')),
        (line_unit or [{}])[0],
    )
    group_id = str(line.get('groupId') or '')
    return (
        f'group:{group_id}'
        if group_id
        else f"line:{str(line.get('id') or '')}"
    )


def _pdf_header_positions(header_rows, export_groups):
    """Place custom headers before category blocks, line units, or a room's end."""
    positions = {}
    orphaned = []
    groups_by_subproject = {}
    for subproject, department, department_lines in export_groups:
        subproject_id = str(subproject.get('id') or 'main')
        group = {
            'department': department,
            'units': _group_pdf_line_units(department_lines),
        }
        groups_by_subproject.setdefault(subproject_id, []).append(group)

    for header in header_rows or []:
        if not isinstance(header, dict):
            continue
        subproject_id = str(header.get('subprojectId') or 'main')
        subproject_groups = groups_by_subproject.get(subproject_id, [])
        anchor_id = str(header.get('beforeLineId') or '')
        anchor = None
        for group in subproject_groups:
            for unit_index, line_unit in enumerate(group['units']):
                if any(str(line.get('id') or '') == anchor_id for line in line_unit):
                    anchor = (group, unit_index, _pdf_line_unit_key(line_unit))
                    break
            if anchor:
                break
        if anchor:
            group, unit_index, unit_key = anchor
            position_key = (
                ('before-group', subproject_id, group['department'])
                if unit_index == 0
                else ('before-unit', subproject_id, group['department'], unit_key)
            )
            positions.setdefault(position_key, []).append(header)
        elif subproject_groups:
            last_group = subproject_groups[-1]
            positions.setdefault(
                ('end-group', subproject_id, last_group['department']), []
            ).append(header)
        else:
            orphaned.append(header)
    return positions, orphaned


def _group_display_entries(lines):
    """Consolidate group members exactly as their selected display fields render."""
    entries = []
    by_key = {}
    for line in lines or []:
        description = _group_line_description(line).strip() or 'Item'
        custom_text = bool(line.get('groupCustomText'))
        key = (custom_text, description.casefold())
        if key not in by_key:
            by_key[key] = {
                'description': description,
                'quantity': 0.0,
                'customText': custom_text,
            }
            entries.append(by_key[key])
        by_key[key]['quantity'] += max(
            0.0, float(line.get('groupItemQuantity', 1) or 0)
        )
    return entries


def _group_content_markup(entries):
    """Build group contents without inserting width-dependent hard breaks."""
    return '<br/>'.join(
        _cjk_markup(_escaped_line_breaks(
            _text(entry.get('description')).strip()
            if entry.get('customText')
            else (
                f"{float(entry.get('quantity') or 0):g}x "
                f"{_text(entry.get('description')).strip()}"
            )
        ))
        for entry in entries or []
    )


def _split_paragraph_by_height(paragraph, available_width, max_height):
    """Split only paragraphs too tall for a page, using ReportLab measurements."""
    pending = [paragraph]
    chunks = []
    while pending:
        current = pending.pop(0)
        _, rendered_height = current.wrap(available_width, 1_000_000)
        if rendered_height <= max_height:
            chunks.append(current)
            continue
        pieces = current.split(available_width, max_height)
        if len(pieces) < 2:
            # ReportLab could not find a legal split point. Keeping the content
            # intact is safer than truncating it or looping indefinitely.
            chunks.append(current)
            continue
        chunks.append(pieces[0])
        pending = list(pieces[1:]) + pending
    return chunks


def _is_optional_category(value):
    return bool(re.search(r'\boptional\b', str(value or ''), flags=re.IGNORECASE))


def _multiplier_column_label(lines):
    """Match the quotation category header's Days/Mult selection."""
    labels = {
        'Mult'
        if str(line.get('costingMultiplierLabel') or '').strip().lower() == 'mult'
        else 'Day'
        for line in (lines or [])
        if isinstance(line, dict)
    }
    return 'MULT' if labels == {'Mult'} else 'DAY(S)'


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

    safe = _escaped_line_breaks(value)
    return Paragraph(
        _cjk_markup(
            safe,
            bold='bold' in str(getattr(style, 'fontName', '')).casefold(),
        ),
        style,
    )


def _escaped_line_breaks(value):
    normalised = _text(value).replace('\r\n', '\n').replace('\r', '\n')
    return escape(normalised).replace('\n', '<br/>')


def _money(value, currency='SGD'):
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0
    sign = '-' if amount < 0 else ''
    return f"{sign}${abs(amount):,.2f}"


def _discount_percent(value):
    try:
        percent = float(value or 0)
    except (TypeError, ValueError):
        percent = 0
    return f'{percent:.2f}%'


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
        label = f'{label} ({_discount_percent(percent)})'
    return label


def _date(value):
    raw = str(value or '').strip()
    try:
        return datetime.strptime(raw, '%Y-%m-%d').strftime('%d %b %Y')
    except ValueError:
        return raw


def _date_long(value):
    raw = str(value or '').strip()
    try:
        parsed = datetime.strptime(raw, '%Y-%m-%d')
        return f'{parsed.day} {parsed.strftime("%B %Y")}'
    except ValueError:
        return raw


def _schedule_time_label(value):
    value = str(value or '').strip()
    if not value:
        return ''
    if value.casefold() == 'tbc':
        return 'TBC'
    return value if value.casefold().endswith('hrs') else f'{value}hrs'


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
            label = f"{label}, {_schedule_time_label(time_values[0])}"
        elif any(time_values):
            return '; '.join(
                f"{format_date(value)}{f', {_schedule_time_label(time_value)}' if time_value else ''}"
                for value, time_value in group
            )
        return label

    unparsed_labels = [
        f"{date_label}{f', {_schedule_time_label(time_value)}' if time_value else ''}"
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
        summary += f", {_schedule_time_label(details['time'])}"

    missing_dates = sorted(
        datetime.strptime(date_value, '%Y-%m-%d').date()
        for date_value, _time_value in excluded
        if (date_value, _time_value) in details['expected']
    )
    if missing_dates:
        summary += '; except ' + _schedule_date_summary([
            {'date': value.isoformat(), 'time': ''}
            for value in missing_dates
        ])
    return summary, required


def _schedule_rows_summary(document, rows, kind):
    rows = [row for row in rows or [] if isinstance(row, dict)]
    if not rows:
        return ''

    rows_by_batch = {}
    for row in rows:
        rows_by_batch.setdefault(str(row.get('batchId') or ''), []).append(row)

    batch_segments = []
    covered = set()
    handled_batch_ids = set()
    for batch in document.get('scheduleBatches') or []:
        if not isinstance(batch, dict) or batch.get('kind') != kind:
            continue
        batch_id = str(batch.get('id') or '')
        batch_rows = rows_by_batch.get(batch_id, [])
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


def _light_theme_tint(value, white_ratio=0.94):
    """Return a very pale version of a company theme colour."""
    raw = _safe_hex(value).lstrip('#')
    ratio = max(0.0, min(1.0, float(white_ratio)))
    channels = [int(raw[index:index + 2], 16) for index in (0, 2, 4)]
    tinted = [round(channel + (255 - channel) * ratio) for channel in channels]
    return '#' + ''.join(f'{channel:02X}' for channel in tinted)


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

    font_regular, font_bold = pdf_font_names(company)
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
    accent_hex = _safe_hex(company.get('themeColor'), '#0F766E')
    accent_luminance = _hex_luminance(accent_hex)
    accent = colors.HexColor(accent_hex)
    panel = colors.HexColor(_light_theme_tint(accent_hex))
    accent_text = colors.black if accent_luminance > 0.68 else colors.white
    accent_on_white = ink if accent_luminance > 0.74 else accent
    success = colors.HexColor('#0F766E')

    body = ParagraphStyle(
        'FinanceBody',
        parent=styles['BodyText'],
        fontName=font_regular,
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
        fontName=font_bold,
        fontSize=7.2,
        leading=9,
        textColor=muted,
        spaceAfter=2,
    )
    project_label = ParagraphStyle(
        'FinanceProjectLabel',
        parent=label,
        spaceAfter=-2 * mm,
    )
    bill_to_name = ParagraphStyle(
        'FinanceBillToName',
        parent=body,
        fontName=font_bold,
        fontSize=9.5,
        leading=12,
    )
    table_header_label = ParagraphStyle(
        'FinanceTableHeaderLabel',
        parent=label,
        textColor=accent_text,
    )
    title_style = ParagraphStyle(
        'FinanceTitle',
        parent=body,
        fontName=font_bold,
        fontSize=20,
        leading=23,
        textColor=ink,
    )
    number_style = ParagraphStyle(
        'FinanceNumber',
        parent=body,
        fontName=font_bold,
        fontSize=12,
        leading=15,
        textColor=accent_on_white,
        alignment=TA_RIGHT,
    )
    right = ParagraphStyle('FinanceRight', parent=body, alignment=TA_RIGHT)
    center = ParagraphStyle('FinanceCenter', parent=body, alignment=TA_CENTER)
    custom_header_style = ParagraphStyle(
        'FinanceCustomHeader',
        parent=body,
        fontName=font_bold,
        alignment=TA_CENTER,
        textColor=ink,
    )
    table_header_center = ParagraphStyle(
        'FinanceTableHeaderCenter', parent=table_header_label, alignment=TA_CENTER
    )
    table_header_right = ParagraphStyle(
        'FinanceTableHeaderRight', parent=table_header_label, alignment=TA_RIGHT
    )
    right_bold = ParagraphStyle(
        'FinanceRightBold',
        parent=right,
        fontName=font_bold,
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
        fontName=font_bold,
        alignment=TA_RIGHT,
    )
    quotation_reference_style = ParagraphStyle(
        'FinanceQuotationReference',
        parent=body,
        fontName=font_bold,
        fontSize=9.2,
        leading=11,
        textColor=accent_on_white,
    )
    project_name_style = ParagraphStyle(
        'FinanceProjectName',
        parent=body,
        fontName=font_bold,
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
        fontName=font_bold,
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

    class FinanceDepartmentTable(Table):
        """Mark repeated department headers after a table page split."""

        def __init__(
            self,
            *args,
            continuation_row=None,
            continuation_factory=None,
            **kwargs,
        ):
            self._continuation_row = continuation_row
            self._continuation_factory = continuation_factory
            self._split_callback_count = 0
            super().__init__(*args, **kwargs)

        def onSplit(self, fragment, byRow=1):
            fragment._continuation_row = self._continuation_row
            fragment._continuation_factory = self._continuation_factory
            fragment._split_callback_count = 0
            self._split_callback_count += 1
            # ReportLab calls onSplit first for the current-page fragment and
            # then for the continuation fragment. Only the latter gets the
            # muted continuation marker; it retains the same behavior if it
            # has to split again on a later page.
            if self._split_callback_count % 2 != 0:
                return
            row_index = self._continuation_row
            if (
                row_index is None
                or not callable(self._continuation_factory)
                or row_index < 0
                or row_index >= len(fragment._cellvalues)
            ):
                return
            # Repeated header rows share their source list with the first
            # fragment. Copy the row before replacing its leading cell so the
            # first page keeps the unmarked department heading.
            fragment._cellvalues[row_index] = fragment._cellvalues[row_index][:]
            fragment._cellvalues[row_index][0] = self._continuation_factory()

    letterhead_typography = pdf_text_typography(company, 'letterhead', 6.4)
    footer_typography = pdf_text_typography(company, 'footer', 6.2)
    terms_typography = pdf_text_typography(company, 'terms', small.fontSize)
    payment_typography = pdf_text_typography(company, 'paymentDetails', body.fontSize)
    default_font_family = company.get('fontFamily') or 'App Default'
    letterhead_html = sanitise_pdf_rich_text(company.get('letterheadHtml'))
    letterhead_markup = rich_text_to_reportlab_markup(
        letterhead_html, default_family=default_font_family
    ) if letterhead_html else ''
    footer_html = sanitise_pdf_rich_text(company.get('footerHtml'))
    footer_markup = rich_text_to_reportlab_markup(
        footer_html, default_family=default_font_family
    ) if footer_html else ''
    letterhead_setting = company.get('letterheadTypography')
    letterhead_setting = letterhead_setting if isinstance(letterhead_setting, dict) else {}
    letterhead_customised = any((
        letterhead_setting.get('fontFamily'),
        letterhead_setting.get('fontSize'),
        letterhead_setting.get('bold'),
        letterhead_setting.get('italic'),
        letterhead_setting.get('underline'),
    ))

    def draw_typography_text(canvas, value, x, y, typography, *, align='left', fallback_font=None, fallback_size=None):
        text = _text(value)
        font_name = _canvas_font(text, fallback_font or typography['fontName'])
        font_size = float(fallback_size or typography['fontSize'])
        canvas.setFont(font_name, font_size)
        if align == 'right':
            canvas.drawRightString(x, y, text)
            start_x = x - canvas.stringWidth(text, font_name, font_size)
        else:
            canvas.drawString(x, y, text)
            start_x = x
        if typography.get('underline'):
            canvas.setLineWidth(max(0.3, font_size / 20))
            canvas.line(start_x, y - 1.1, start_x + canvas.stringWidth(text, font_name, font_size), y - 1.1)

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
        if letterhead_enabled and letterhead_markup:
            rich_letterhead_style = ParagraphStyle(
                'FinanceRichLetterhead',
                parent=small,
                fontName=font_regular,
                fontSize=6.4,
                leading=8.2,
                textColor=ink,
                alignment=TA_RIGHT if logo_drawn else TA_LEFT,
            )
            rich_letterhead = Paragraph(_cjk_markup(letterhead_markup), rich_letterhead_style)
            rich_width = 112 * mm if logo_drawn else page_width - (2 * margin)
            rich_height = rich_letterhead.wrap(rich_width, 20 * mm)[1]
            rich_x = page_width - margin - rich_width if logo_drawn else margin
            rich_letterhead.drawOn(canvas, rich_x, page_height - 7 * mm - rich_height)
        elif letterhead_enabled and not logo_drawn:
            canvas.setFillColor(ink)
            draw_typography_text(
                canvas, company_name[:34], margin, page_height - 14 * mm,
                letterhead_typography,
                fallback_font=None if letterhead_customised else font_bold,
                fallback_size=None if letterhead_setting.get('fontSize') else 15,
            )

        if letterhead_enabled and not letterhead_markup and logo_drawn and company_name:
            canvas.setFillColor(ink)
            draw_typography_text(
                canvas, company_name[:72], page_width - margin, page_height - 9.5 * mm,
                letterhead_typography,
                align='right',
                fallback_font=None if letterhead_customised else font_bold,
                fallback_size=None if letterhead_setting.get('fontSize') else 8.8,
            )

        if letterhead_enabled and not letterhead_markup:
            canvas.setFillColor(muted)
            y = page_height - 12.8 * mm if logo_drawn and company_name else page_height - 10 * mm
            for line in company_detail_lines[:4]:
                draw_typography_text(
                    canvas, line[:100], page_width - margin, y,
                    letterhead_typography,
                    align='right',
                    fallback_font=None if letterhead_customised else font_regular,
                    fallback_size=None if letterhead_setting.get('fontSize') else 6.4,
                )
                y -= 3 * mm

        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 14 * mm, page_width - margin, 14 * mm)
        canvas.setFillColor(muted)
        footer_line = footer_text.replace('\n', ' | ') if footer_text else company_lines[0] if company_lines else ''
        if footer_markup:
            rich_footer_style = ParagraphStyle(
                'FinanceRichFooter', parent=small, fontName=font_regular,
                fontSize=6.2, leading=7.2, textColor=muted,
            )
            rich_footer = Paragraph(_cjk_markup(footer_markup), rich_footer_style)
            rich_footer.wrapOn(canvas, page_width - (2 * margin) - 30 * mm, 10 * mm)
            rich_footer.drawOn(canvas, margin, 7.5 * mm)
        else:
            draw_typography_text(canvas, footer_line[:125], margin, 9 * mm, footer_typography)
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
                self.setFont(font_regular, 6.2)
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
    lines = [
        line for line in (document.get('lineItems') or [])
        if not (isinstance(line, dict) and line.get('hiddenFromQuotation'))
    ]
    header_rows = [
        row for row in (document.get('headerRows') or [])
        if isinstance(row, dict)
    ]
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
            _paragraph(bill_lines[0], bill_to_name),
        ]
        if len(bill_lines) > 1:
            client_block.append(_paragraph('\n'.join(bill_lines[1:]), body))
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
                _paragraph('PROJECT', project_label),
                _paragraph(project_name, project_name_style),
            ])
        if project_location:
            if project_block:
                project_block.append(Spacer(1, 1 * mm))
            project_block.extend([
                _paragraph('LOCATION', project_label),
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

    show_unit_prices = bool(document.get('showUnitPrices'))
    show_department_discounts = bool(document.get('showDepartmentDiscounts'))
    show_department_subtotals = document.get('showDepartmentSubtotals', True) is not False
    show_line_numbers = document.get('showLineNumbers', True) is not False
    number_width = 8 * mm
    multiplier_width = 13 * mm
    quantity_width = 20 * mm
    if show_unit_prices:
        pricing_widths = [23 * mm, 14 * mm, 30 * mm]
        description_width = doc.width - sum([
            number_width,
            multiplier_width,
            quantity_width,
            *pricing_widths,
        ])
        column_widths = [
            number_width,
            description_width,
            quantity_width,
            multiplier_width,
            *pricing_widths,
        ]
    else:
        # Preserve the Days/Mult and Qty widths while using the former pricing
        # columns to give the description the full available document width.
        description_width = doc.width - sum([
            number_width,
            multiplier_width,
            quantity_width,
        ])
        column_widths = [
            number_width,
            description_width,
            quantity_width,
            multiplier_width,
        ]
    line_table_column_count = len(column_widths)
    description_cell_width = column_widths[1] - 6  # 3pt padding on each side.
    group_content_page_height = max(
        body.leading * 12,
        doc.height - (42 * mm) - body.leading,
    )

    if lines or header_rows:
        story.append(_paragraph('LINE ITEMS', section_title))

    lines_by_group = {}
    departments_by_subproject = {}
    for line in lines:
        subproject_id = str(line.get('subprojectId') or 'main')
        department = _line_system_name(line)
        group_key = (subproject_id, department)
        if group_key not in lines_by_group:
            lines_by_group[group_key] = []
            departments_by_subproject.setdefault(subproject_id, []).append(department)
        lines_by_group[group_key].append(line)

    adjustments_by_group = {}
    for adjustment in adjustments:
        if adjustment.get('scope') != 'department':
            continue
        group_key = (
            str(adjustment.get('subprojectId') or 'main'),
            adjustment.get('department'),
        )
        adjustments_by_group.setdefault(group_key, []).append(adjustment)

    export_groups = []
    for subproject in subprojects:
        subproject_id = str(subproject.get('id') or 'main')
        for department in departments_by_subproject.get(subproject_id, []):
            export_groups.append((
                subproject,
                department,
                lines_by_group[(subproject_id, department)],
            ))
    header_positions, orphaned_headers = _pdf_header_positions(
        header_rows, export_groups
    )

    def append_custom_headers(table_rows, row_styles, rows):
        for header in rows or []:
            header_index = len(table_rows)
            table_rows.append([
                _paragraph(header.get('content') or '', custom_header_style),
                *([''] * (line_table_column_count - 1)),
            ])
            row_styles.extend([
                ('SPAN', (0, header_index), (-1, header_index)),
                ('ALIGN', (0, header_index), (-1, header_index), 'CENTER'),
                ('VALIGN', (0, header_index), (-1, header_index), 'MIDDLE'),
                ('BACKGROUND', (0, header_index), (-1, header_index), panel),
                ('BOX', (0, header_index), (-1, header_index), 0.35, rule),
                ('TOPPADDING', (0, header_index), (-1, header_index), 5),
                ('BOTTOMPADDING', (0, header_index), (-1, header_index), 5),
            ])
    department_summaries = []
    for subproject, department, department_lines in export_groups:
        subproject_id = str(subproject.get('id') or 'main')
        department_total = sum(float(line.get('total') or 0) for line in department_lines)
        department_total += sum(
            float(row.get('amount') or 0)
            for row in adjustments_by_group.get((subproject_id, department), [])
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
    for group_index, (subproject, department, department_lines) in enumerate(export_groups):
        subproject_id = str(subproject.get('id') or 'main')
        optional_category = _is_optional_category(department)
        multiplier_column_label = _multiplier_column_label(department_lines)
        first_group_for_subproject = subproject_id != current_subproject_id
        if first_group_for_subproject:
            current_subproject_id = subproject_id
        department_total = sum(float(line.get('total') or 0) for line in department_lines)
        department_adjustments = adjustments_by_group.get(
            (subproject_id, department), []
        )
        department_total += sum(float(row.get('amount') or 0) for row in department_adjustments)
        table_rows = []
        row_styles = []
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
                        fontName=font_bold,
                        alignment=TA_CENTER,
                        textColor=ink,
                    ),
                ),
                *([''] * (line_table_column_count - 1)),
            ])
        append_custom_headers(
            table_rows,
            row_styles,
            header_positions.get(
                ('before-group', subproject_id, department), []
            ),
        )
        department_header_row = len(table_rows)
        department_header_style = ParagraphStyle(
            f"Department-{len(story)}",
            parent=body,
            fontName=font_bold,
            textColor=ink,
        )
        department_continued_style = ParagraphStyle(
            f"DepartmentContinued-{len(story)}",
            parent=small,
            fontName=font_regular,
            fontSize=6.5,
            leading=body.leading,
            alignment=TA_RIGHT,
            textColor=muted,
        )

        def department_heading(
            continued=False,
            department_name=department,
            header_style=department_header_style,
            continued_style=department_continued_style,
        ):
            continued_width = 24 * mm
            content_width = doc.width - 6
            return Table(
                [[
                    _paragraph(department_name, header_style),
                    (
                        _paragraph('Continued', continued_style)
                        if continued else ''
                    ),
                ]],
                colWidths=[content_width - continued_width, continued_width],
                style=TableStyle([
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                    ('TOPPADDING', (0, 0), (-1, -1), 0),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                ]),
            )

        table_rows.extend([
            [
                department_heading(),
                *([''] * (line_table_column_count - 1)),
            ],
            (
                [
                    _paragraph('#' if show_line_numbers else '', table_header_center),
                    _paragraph('DESCRIPTION', table_header_label),
                    _paragraph('QTY', table_header_right),
                    _paragraph(multiplier_column_label, table_header_right),
                    _paragraph('UNIT PRICE', table_header_right),
                    _paragraph('DISC %', table_header_right),
                    _paragraph('TOTAL', table_header_right),
                ]
                if show_unit_prices
                else [
                    _paragraph('#' if show_line_numbers else '', table_header_center),
                    _paragraph('DESCRIPTION', table_header_label),
                    _paragraph('QTY', table_header_right),
                    _paragraph(multiplier_column_label, table_header_right),
                ]
            ),
        ])
        column_header_row = department_header_row + 1
        row_styles.extend([
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
        ])
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
            append_custom_headers(
                table_rows,
                row_styles,
                header_positions.get((
                    'before-unit',
                    subproject_id,
                    department,
                    _pdf_line_unit_key(line_unit),
                ), []),
            )
            line = next(
                (member for member in line_unit if member.get('groupLeader')),
                line_unit[0],
            )
            is_group = bool(line.get('groupId'))
            if is_group:
                content_markup = _group_content_markup(
                    _group_display_entries(line_unit)
                )
                entry_chunks = (
                    _split_paragraph_by_height(
                        Paragraph(content_markup, body),
                        description_cell_width,
                        group_content_page_height,
                    )
                    if content_markup
                    else [None]
                )
                display_days = float(line.get('days') or 0)
                quantity = f"{float(line.get('quantity') or 0):g}"
                uom = _text(
                    {'units': 'unit(s)', 'sets': 'set(s)'}.get(
                        line.get('uom'), line.get('uom')
                    )
                ).strip()
                quantity_label = f"{quantity} {uom}".strip()
                unit_price = float(line.get('unitPrice') or 0)
                group_total = float(line.get('total') or 0)
            else:
                entry_chunks = [None]
                display_days = float(line.get('days') or 0)
                quantity = f"{float(line.get('quantity') or 0):g}"
                uom = _text(
                    {'units': 'unit(s)', 'sets': 'set(s)'}.get(
                        line.get('uom'), line.get('uom')
                    )
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
            for chunk_index, chunk in enumerate(entry_chunks):
                first_chunk = chunk_index == 0
                if is_group:
                    title = _text(line.get('groupTitle') or 'Group')
                    title_markup = _cjk_markup(
                        escape(title if first_chunk else f'{title} (continued)'),
                        bold=True,
                    )
                    description_flowable = [
                        Paragraph(f'<b>{title_markup}</b>', body),
                    ]
                    if chunk is not None:
                        description_flowable.append(chunk)
                else:
                    description_flowable = _paragraph(
                        _group_line_description(line), body
                    )
                line_cells = [
                    _paragraph(
                        line_number if first_chunk and show_line_numbers else '',
                        center,
                    ),
                    description_flowable,
                    _paragraph(quantity_label if first_chunk else '', right),
                    _paragraph(
                        f"{display_days:g}" if first_chunk and display_days else '',
                        right,
                    ),
                ]
                if show_unit_prices:
                    line_cells.extend([
                        _paragraph(
                            _money(unit_price, currency) if first_chunk else '',
                            right,
                        ),
                        _paragraph(
                            _discount_percent(line.get('discountPercent'))
                            if first_chunk
                            and float(line.get('discountPercent') or 0)
                            else '',
                            right,
                        ),
                        _paragraph(
                            _money(group_total, currency) if first_chunk else '',
                            right,
                        ),
                    ])
                table_rows.append(line_cells)
            pdf_line_number += 1

        append_custom_headers(
            table_rows,
            row_styles,
            header_positions.get(
                ('end-group', subproject_id, department), []
            ),
        )

        show_department_adjustment_block = bool(
            show_department_discounts
            and show_department_subtotals
            and department_adjustments
        )
        if show_department_adjustment_block:
            for adjustment_position, adjustment in enumerate(department_adjustments):
                adjustment_index = len(table_rows)
                adjustment_label = _paragraph(_adjustment_label(adjustment), right)
                adjustment_amount = _paragraph(
                    _money(adjustment.get('amount'), currency), right
                )
                if show_unit_prices:
                    adjustment_cells = [
                        '', adjustment_label,
                        *([''] * (line_table_column_count - 3)),
                        adjustment_amount,
                    ]
                    adjustment_spans = [('SPAN', (1, adjustment_index), (
                        line_table_column_count - 2, adjustment_index
                    ))]
                else:
                    adjustment_cells = ['', adjustment_label, adjustment_amount, '']
                    adjustment_spans = [
                        ('SPAN', (2, adjustment_index), (3, adjustment_index)),
                    ]
                table_rows.append(adjustment_cells)
                row_styles.extend([
                    *adjustment_spans,
                    ('TEXTCOLOR', (1, adjustment_index), (-1, adjustment_index), success),
                    ('BACKGROUND', (0, adjustment_index), (-1, adjustment_index), panel),
                ])
                if adjustment_position == 0:
                    row_styles.append(
                        ('LINEABOVE', (0, adjustment_index), (-1, adjustment_index), 0.8, ink)
                    )

        if show_department_subtotals or optional_category:
            subtotal_index = len(table_rows)
            subtotal_label = _paragraph(f"{department} subtotal", right_bold)
            subtotal_amount = _paragraph(
                _money(department_total, currency), right_bold
            )
            if show_unit_prices:
                subtotal_cells = [
                    '', subtotal_label,
                    *([''] * (line_table_column_count - 3)),
                    subtotal_amount,
                ]
                subtotal_spans = [('SPAN', (1, subtotal_index), (
                    line_table_column_count - 2, subtotal_index
                ))]
            else:
                subtotal_cells = ['', subtotal_label, subtotal_amount, '']
                subtotal_spans = [
                    ('SPAN', (2, subtotal_index), (3, subtotal_index)),
                ]
            table_rows.append(subtotal_cells)
            row_styles.extend([
                *subtotal_spans,
                ('BACKGROUND', (0, subtotal_index), (-1, subtotal_index), panel),
            ])
            if not show_department_adjustment_block:
                row_styles.append(
                    ('LINEABOVE', (0, subtotal_index), (-1, subtotal_index), 0.8, ink)
                )

        items_table = FinanceDepartmentTable(
            table_rows,
            repeatRows=column_header_row + 1,
            colWidths=column_widths,
            style=TableStyle(row_styles),
            splitByRow=1,
            continuation_row=department_header_row,
            continuation_factory=(
                lambda heading=department_heading: heading(True)
            ),
        )
        table_flowable = (
            KeepTogether([items_table])
            if len(department_lines) <= 15
            else items_table
        )
        story.append(table_flowable)
        if group_index < len(export_groups) - 1:
            story.append(Spacer(1, 3 * mm))

    if orphaned_headers:
        orphan_rows = []
        orphan_styles = []
        append_custom_headers(orphan_rows, orphan_styles, orphaned_headers)
        story.append(Table(
            orphan_rows,
            colWidths=column_widths,
            style=TableStyle(orphan_styles),
        ))

    if export_groups or orphaned_headers:
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

    summary_heading = (
        'Invoice Summary' if document_type == 'invoice' else 'Quotation Summary'
    )
    final_page_story.append(_paragraph(summary_heading, summary_section_title))
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
        # Preserve the existing order within each group while guaranteeing
        # that optional categories form the final row(s) of the summary.
        summary_source = sorted(
            summary_source,
            key=lambda row: bool(row['optional']),
        )
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
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, panel]),
            ]),
        )
        final_page_story.extend([department_summary, Spacer(1, 4 * mm)])

    payment_lines = []
    payment_rich_markup = ''
    if document_type == 'invoice' and company.get('paymentDetailsEnabled', True) is not False:
        custom_payment_details = _text(company.get('paymentDetailsText')).strip()
        if custom_payment_details:
            payment_html = sanitise_pdf_rich_text(company.get('paymentDetailsHtml'))
            if payment_html:
                payment_rich_markup = rich_text_to_reportlab_markup(
                    payment_html, default_family=default_font_family
                )
            payment_lines = [
                escape(line.strip())
                for line in custom_payment_details.splitlines()
                if line.strip()
            ]
        else:
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

    received_payments = [
        row for row in document.get('invoicePlanPayments') or []
        if isinstance(row, dict) and float(row.get('amount') or 0) > 0
    ]
    summary_rows = []
    invoice_amount = float(document.get('invoiceAmount') or 0)
    if document_type == 'invoice' and invoice_amount > 0:
        quotation_total = float(document.get('quotationTotal') or totals.get('total') or 0)
        invoice_discount_amount = min(
            float(document.get('quotationPreTax') or quotation_total),
            max(0, float(document.get('invoiceDiscountAmount') or 0)),
        )
        quotation_pre_tax = float(
            document.get('quotationPreTax')
            or (quotation_total / (1 + tax_rate / 100) if tax_rate else quotation_total)
        )
        adjusted_pre_tax = float(
            document.get('invoiceAdjustedPreTax')
            or max(0, quotation_pre_tax - invoice_discount_amount)
        )
        adjusted_tax = float(
            document.get('invoiceAdjustedTax')
            if document.get('invoiceAdjustedTax') not in (None, '')
            else round(adjusted_pre_tax * tax_rate / 100, 2)
        )
        adjusted_total = adjusted_pre_tax + adjusted_tax
        invoice_payments = [
            row for row in received_payments
            if str(row.get('invoiceId') or '') == str(document.get('id') or '')
        ]
        paid_for_invoice = sum(
            float(row.get('amount') or 0)
            for row in invoice_payments
        )
        invoice_due = max(0, invoice_amount - paid_for_invoice)
        outstanding = float(
            document.get('amountOutstanding')
            if document.get('amountOutstanding') not in (None, '')
            else max(
                0,
                adjusted_total - sum(
                    float(row.get('amount') or 0)
                    for row in received_payments
                ),
            )
        )
        summary_rows.append([
            _paragraph('Total (as per quotation)', body),
            _paragraph(_money(quotation_total, currency), right),
        ])
        if invoice_discount_amount > 0:
            discount_label = 'Discounts'
            if _text(document.get('invoiceDiscountMode')).strip().lower() == 'percentage':
                discount_value = float(document.get('invoiceDiscountValue') or 0)
                discount_label = f"{discount_label} ({discount_value:g}%)"
            summary_rows.append([
                _paragraph(discount_label, body),
                _paragraph(_money(-invoice_discount_amount, currency), right),
            ])
        summary_rows.append([
            _paragraph('Grand Total', body),
            _paragraph(_money(adjusted_total, currency), right_bold),
        ])
        if tax_rate > 0:
            summary_rows.append([
                _paragraph(f"{tax_label} amount included ({tax_rate:g}%)", body),
                _paragraph(_money(adjusted_tax, currency), right),
            ])
        summary_rows.extend([
            [
                _paragraph(f"Amount paid on {_date_long(row.get('date'))}", body),
                _paragraph(_money(-float(row.get('amount') or 0), currency), right),
            ]
            for row in received_payments
        ])
        if received_payments:
            summary_rows.append([
                _paragraph('Balance remaining', ParagraphStyle('InvoiceBalanceLabel', parent=body, fontName=font_bold)),
                _paragraph(_money(outstanding, currency), right_bold),
            ])
        due_caption = []
        if _text(document.get('invoiceLabel')).strip():
            due_caption.append(_text(document.get('invoiceLabel')).strip())
        due_date = document.get('paymentDueDate') or document.get('dueDate')
        if _text(due_date).strip():
            due_caption.append(f"Due {_date_long(due_date)}")
        summary_rows.append(
            [
                [
                    _paragraph('AMOUNT DUE', ParagraphStyle('InvoiceDueSummaryLabel', parent=body, fontName=font_bold, fontSize=11.5, textColor=accent_text)),
                    *(
                        [_paragraph(
                            ' - '.join(due_caption),
                            ParagraphStyle(
                                'InvoiceDueSummaryCaption',
                                parent=body,
                                fontSize=7.5,
                                leading=9,
                                textColor=accent_text,
                            ),
                        )]
                        if due_caption
                        else []
                    ),
                ],
                _paragraph(_money(invoice_due, currency), ParagraphStyle('InvoiceDueSummaryAmount', parent=right_bold, fontSize=14, leading=17, textColor=accent_text)),
            ]
        )
    else:
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
                [_paragraph('TOTAL', ParagraphStyle('TotalLabel', parent=body, fontName=font_bold, fontSize=10.5)),
                 _paragraph(_money(totals.get('total'), currency), ParagraphStyle('TotalAmount', parent=right_bold, fontSize=11, textColor=accent_on_white))],
            ])
        else:
            summary_rows.append([
                _paragraph('TOTAL', ParagraphStyle('TotalLabelNoTax', parent=body, fontName=font_bold, fontSize=10.5)),
                _paragraph(_money(totals.get('netSubtotal'), currency), ParagraphStyle('TotalAmountNoTax', parent=right_bold, fontSize=11, textColor=accent_on_white)),
            ])
    notes = _text(document.get('notes')).strip()
    terms = _text(document.get('terms') or company.get('defaultTerms')).strip()
    terms_details = []
    if terms:
        terms_style = ParagraphStyle(
            'FinanceTermsCustom',
            parent=small,
            fontName=terms_typography['fontName'],
            fontSize=terms_typography['fontSize'],
            leading=terms_typography['fontSize'] * 1.25,
        )
        default_terms_html = sanitise_pdf_rich_text(
            company.get('defaultTermsHtml')
        )
        terms_html = (
            default_terms_html
            if terms == _text(company.get('defaultTerms')).strip()
            and default_terms_html
            else plain_text_to_rich_html(terms)
        )
        terms_markup = rich_text_to_reportlab_markup(
            terms_html, default_family=default_font_family
        )
        if terms_typography['underline']:
            terms_markup = f'<u>{terms_markup}</u>'
        terms_details = [
            _paragraph('TERMS AND CONDITIONS', section_title),
            Paragraph(_cjk_markup(terms_markup), terms_style),
        ]

    bottom_column_width = doc.width / 2
    has_bottom_left_column = bool(payment_lines)
    summary_table_width = bottom_column_width if has_bottom_left_column else 96 * mm
    summary_amount_width = 40 * mm
    summary = Table(
        summary_rows,
        colWidths=[summary_table_width - summary_amount_width, summary_amount_width],
        hAlign='RIGHT',
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 9),
            ('RIGHTPADDING', (0, 0), (-1, -1), 9),
            ('RIGHTPADDING', (-1, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('LINEABOVE', (0, -1), (-1, -1), 1.1, ink),
            (
                'BACKGROUND', (0, -1), (-1, -1),
                accent if document_type == 'invoice' and invoice_amount > 0 else panel,
            ),
        ]),
    )
    bottom_left_details = []
    if payment_lines:
        payment_heading = ParagraphStyle(
            'FinancePaymentHeading',
            parent=section_title,
            spaceBefore=0,
            spaceAfter=3,
        )
        payment_style = ParagraphStyle(
            'FinancePaymentDetails',
            parent=body,
            fontName=payment_typography['fontName'],
            fontSize=payment_typography['fontSize'],
            leading=payment_typography['fontSize'] * 1.3,
        )
        payment_markup = payment_rich_markup or '<br/>'.join(payment_lines)
        if payment_typography['underline']:
            payment_markup = f'<u>{payment_markup}</u>'
        bottom_left_details.extend([
            _paragraph('PAYMENT DETAILS', payment_heading),
            Paragraph(_cjk_markup(payment_markup), payment_style),
        ])
    if bottom_left_details:
        payment_and_total = Table(
            [[bottom_left_details, summary]],
            colWidths=[bottom_column_width, bottom_column_width],
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

    notes_details = (
        [_paragraph('NOTES', section_title), _paragraph(notes, body)]
        if notes else []
    )
    if document_type != 'invoice' and terms_details and notes_details:
        final_page_story.append(Table(
            [[terms_details + [Spacer(1, 10 * mm)] + notes_details]],
            colWidths=[doc.width],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]),
        ))
    else:
        if terms_details:
            final_page_story.append(Table(
                [[terms_details]],
                colWidths=[doc.width],
                style=TableStyle([
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                    ('TOPPADDING', (0, 0), (-1, -1), 0),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                ]),
            ))
        final_page_story.extend(notes_details)
    if document_type != 'invoice' and document.get('showSignOff'):
        signoff_heading = ParagraphStyle(
            'FinanceSignOffHeading',
            parent=body,
            fontName=font_bold,
            fontSize=9.5,
            leading=12,
        )
        signoff_name = ParagraphStyle(
            'FinanceSignOffName',
            parent=body,
            fontName=font_bold,
            fontSize=9,
            leading=11,
        )
        signoff_caption = ParagraphStyle(
            'FinanceSignOffCaption',
            parent=small,
            fontName=font_bold,
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


def build_payment_receipt_pdf(receipt, company, logo_path=''):
    """Return a polished one-page payment receipt as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    receipt = receipt if isinstance(receipt, dict) else {}
    company = company if isinstance(company, dict) else {}
    font_regular, font_bold = pdf_font_names(company)
    buffer = BytesIO()
    width, height = A4
    margin = 18 * mm
    accent_hex = str(
        company.get('accentColor') or company.get('themeColor') or '#0f766e'
    ).strip()
    if not re.fullmatch(r'#[0-9A-Fa-f]{6}', accent_hex):
        accent_hex = '#0f766e'
    accent = colors.HexColor(accent_hex)
    ink = colors.HexColor('#172033')
    muted = colors.HexColor('#667085')
    border = colors.HexColor('#dfe5ec')
    panel = colors.HexColor('#f7f9fb')
    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        'ReceiptBody', parent=styles['BodyText'], fontName=font_regular,
        fontSize=9, leading=12, textColor=ink,
    )
    small = ParagraphStyle(
        'ReceiptSmall', parent=body, fontSize=7.5, leading=10,
        textColor=muted,
    )
    label = ParagraphStyle(
        'ReceiptLabel', parent=small, fontName=font_bold,
        fontSize=7, leading=9, textColor=muted,
    )
    right = ParagraphStyle('ReceiptRight', parent=body, alignment=TA_RIGHT)
    right_small = ParagraphStyle(
        'ReceiptRightSmall', parent=small, alignment=TA_RIGHT,
    )
    story = []

    company_name = _text(
        company.get('companyName') or company.get('name') or 'Showbase'
    ).strip()
    header_left = []
    if logo_path and os.path.isfile(logo_path):
        try:
            image_reader = ImageReader(logo_path)
            image_width, image_height = image_reader.getSize()
            max_width, max_height = 42 * mm, 16 * mm
            scale = min(max_width / image_width, max_height / image_height)
            header_left.append(Image(
                logo_path, width=image_width * scale, height=image_height * scale
            ))
            header_left.append(Spacer(1, 2 * mm))
        except Exception:
            pass
    header_left.extend([
        Paragraph(escape(company_name), ParagraphStyle(
            'ReceiptCompany', parent=body, fontName=font_bold,
            fontSize=17, leading=20,
        )),
        Paragraph(escape(_text(
            company.get('address') or company.get('companyAddress') or ''
        )), small),
    ])
    contact = ' | '.join(filter(None, [
        _text(company.get('phone') or company.get('companyPhone')).strip(),
        _text(company.get('email') or company.get('companyEmail')).strip(),
    ]))
    receipt_number = _text(receipt.get('receiptNumber') or 'RECEIPT').strip()
    header_right = [
        Paragraph('PAYMENT RECEIPT', ParagraphStyle(
            'ReceiptTitle', parent=right, fontName=font_bold,
            fontSize=20, leading=23, textColor=accent,
        )),
        Paragraph(escape(receipt_number), right_small),
        Spacer(1, 2 * mm),
        Paragraph(escape(contact), right_small),
    ]
    header = Table(
        [[header_left, header_right]],
        colWidths=[95 * mm, 76 * mm],
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]),
    )
    story.extend([header, Spacer(1, 12 * mm)])

    currency = _text(receipt.get('currency') or company.get('currency') or 'SGD')
    amount_panel = Table(
        [[
            [
                Paragraph('AMOUNT RECEIVED', ParagraphStyle(
                    'ReceiptAmountLabel', parent=label, textColor=colors.white,
                )),
                Paragraph(_money(receipt.get('amount'), currency), ParagraphStyle(
                    'ReceiptAmount', parent=body, fontName=font_bold,
                    fontSize=24, leading=28, textColor=colors.white,
                )),
            ],
            [
                Paragraph('PAYMENT DATE', ParagraphStyle(
                    'ReceiptDateLabel', parent=label, textColor=colors.white,
                    alignment=TA_RIGHT,
                )),
                Paragraph(escape(_date_long(receipt.get('date'))), ParagraphStyle(
                    'ReceiptDate', parent=right, fontName=font_bold,
                    fontSize=11, textColor=colors.white,
                )),
            ],
        ]],
        colWidths=[104 * mm, 67 * mm],
        style=TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), accent),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 7 * mm),
            ('RIGHTPADDING', (0, 0), (-1, -1), 7 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 5 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5 * mm),
        ]),
    )
    story.extend([amount_panel, Spacer(1, 9 * mm)])

    received_from = _text(receipt.get('receivedFrom') or 'Not specified').strip()
    project_name = _text(receipt.get('projectName') or 'Not specified').strip()
    details = [
        ('Received from', received_from),
        ('Payment description', _text(receipt.get('label') or 'Payment received')),
        ('Project', project_name),
        ('Quotation', _text(receipt.get('quotationNumber') or 'Not linked')),
        ('Invoice', _text(receipt.get('invoiceNumber') or 'Not allocated')),
        ('Reference', _text(receipt.get('reference') or '-')),
    ]
    detail_rows = [
        [Paragraph(escape(detail_label.upper()), label), Paragraph(
            escape(detail_value), body
        )]
        for detail_label, detail_value in details
    ]
    detail_table = Table(
        detail_rows,
        colWidths=[42 * mm, 129 * mm],
        style=TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), panel),
            ('BOX', (0, 0), (-1, -1), .7, border),
            ('INNERGRID', (0, 0), (-1, -1), .5, border),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 3.5 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5 * mm),
        ]),
    )
    story.extend([
        Paragraph('PAYMENT DETAILS', ParagraphStyle(
            'ReceiptSectionTitle', parent=body, fontName=font_bold,
            fontSize=10, leading=13,
        )),
        Spacer(1, 3 * mm), detail_table, Spacer(1, 12 * mm),
        Paragraph(
            'This receipt acknowledges that the payment shown above has been received.',
            body,
        ),
    ])

    def draw_page(canvas, _doc):
        canvas.saveState()
        canvas.setStrokeColor(border)
        canvas.setLineWidth(.6)
        canvas.line(margin, 15 * mm, width - margin, 15 * mm)
        canvas.setFillColor(muted)
        canvas.setFont(font_regular, 7)
        canvas.drawString(margin, 10 * mm, company_name)
        canvas.drawRightString(
            width - margin, 10 * mm, f'Receipt {receipt_number}'
        )
        canvas.restoreState()

    doc = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=margin, rightMargin=margin,
        topMargin=16 * mm, bottomMargin=22 * mm,
        title=f'Payment Receipt {receipt_number}',
        author=company_name,
    )
    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)
    return buffer.getvalue()


def safe_pdf_filename(number, fallback='document'):
    value = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(number or fallback)).strip('._')
    return f"{value or fallback}.pdf"
