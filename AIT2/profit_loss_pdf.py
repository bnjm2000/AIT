"""Print-ready project profit and loss report rendering."""

from datetime import datetime
from io import BytesIO
import os

from pdf_fonts import (
    draw_pdf_canvas_text,
    pdf_font_names,
    pdf_text_typography,
    pdf_text_typography_is_custom,
)
from pdf_rich_text import draw_pdf_rich_text
from quotation_pdf import _canvas_font, _paragraph, _safe_hex, _text


def _number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _money(value, signed=False):
    amount = _number(value)
    if signed and amount > 0:
        return f"+${amount:,.2f}"
    if amount < 0:
        return f"-${abs(amount):,.2f}"
    return f"${amount:,.2f}"


def _percent(value):
    return f"{_number(value):,.1f}%"


def _format_datetime(value):
    raw = str(value or '').strip()
    if not raw:
        return '-'
    try:
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return parsed.strftime('%d %B %Y, %H:%Mhrs')
    except ValueError:
        return _text(raw)


def _format_date(value):
    raw = str(value or '').strip()
    if not raw:
        return '-'
    for pattern in ('%Y-%m-%d', '%Y%m%d'):
        try:
            return datetime.strptime(raw, pattern).strftime('%d %B %Y')
        except ValueError:
            continue
    return _text(raw)


def _event_dates(event):
    start = str(event.get('startDate') or '').strip()
    end = str(event.get('endDate') or '').strip()
    if start and end and start != end:
        return f'{start} - {end}'
    return start or end or '-'


def _hex_colour(value, fallback):
    from reportlab.lib import colors

    return colors.HexColor(_safe_hex(value, fallback))


def _department_colour(payload, department):
    department = str(department or '').strip()
    if not department:
        return ''
    colours = payload.get('departmentColours') or {}
    return str(
        colours.get(department)
        or colours.get(department.casefold())
        or ''
    )


def _solid_colour(value, fallback='#2563EB'):
    """Match the saturation/lightness adjustment used by the P&L web chart."""
    value = str(value or '').strip()
    if len(value) != 7 or not value.startswith('#'):
        return fallback
    try:
        channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    except ValueError:
        return fallback
    red, green, blue = channels
    maximum = max(channels)
    minimum = min(channels)
    delta = maximum - minimum
    hue = 0.0
    if delta:
        if maximum == red:
            hue = ((green - blue) / delta) % 6
        elif maximum == green:
            hue = ((blue - red) / delta) + 2
        else:
            hue = ((red - green) / delta) + 4
        hue = ((hue * 60) + 360) % 360
    lightness = (maximum + minimum) / 2
    saturation = delta / (1 - abs(2 * lightness - 1)) if delta else 0
    if saturation < 0.08:
        lightness = min(max(lightness, 0.34), 0.5)
    else:
        saturation = max(saturation, 0.68)
        lightness = min(max(lightness, 0.4), 0.52)

    chroma = (1 - abs(2 * lightness - 1)) * saturation
    secondary = chroma * (1 - abs((hue / 60) % 2 - 1))
    offset = lightness - chroma / 2
    if hue < 60:
        rgb = [chroma, secondary, 0]
    elif hue < 120:
        rgb = [secondary, chroma, 0]
    elif hue < 180:
        rgb = [0, chroma, secondary]
    elif hue < 240:
        rgb = [0, secondary, chroma]
    elif hue < 300:
        rgb = [secondary, 0, chroma]
    else:
        rgb = [chroma, 0, secondary]
    return '#' + ''.join(
        f'{round((channel + offset) * 255):02x}' for channel in rgb
    )


def _contrast_colour(value):
    value = str(value or '').replace('#', '')
    if len(value) != 6:
        return '#FFFFFF'
    try:
        red, green, blue = [int(value[index:index + 2], 16) for index in (0, 2, 4)]
    except ValueError:
        return '#FFFFFF'
    luminance = (red * 299 + green * 587 + blue * 114) / 255000
    return '#172033' if luminance > 0.58 else '#FFFFFF'


def _header_colour(value):
    """Keep the configured brand hue while ensuring white header text is legible."""
    solid = _solid_colour(value, '#0F4C5C')
    try:
        channels = [int(solid[index:index + 2], 16) for index in (1, 3, 5)]
    except (TypeError, ValueError):
        return '#0F4C5C'
    luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 255000
    if luminance <= 0.4:
        return solid
    factor = 0.4 / luminance
    return '#' + ''.join(f'{round(channel * factor):02x}' for channel in channels)


def _profit_chart_rows(payload):
    fallback_palettes = {
        'manpower': ['#2563EB', '#0EA5E9', '#06B6D4', '#6366F1', '#0284C7'],
        'vendor': ['#0F766E', '#14B8A6', '#0D9488', '#115E59'],
        'meal': ['#EC4899'],
        'crew-transport': ['#14B8A6'],
        'equipment-transport': ['#D97706'],
        'transport': ['#F59E0B'],
        'other': ['#64748B', '#EF4444', '#14B8A6', '#EC4899', '#84CC16'],
        'commission': ['#8B5CF6'],
        'profit': ['#10B981'],
    }
    group_indexes = {}
    rows = []
    for raw in payload.get('profitChart') or []:
        if not isinstance(raw, dict) or _number(raw.get('amount')) <= 0:
            continue
        group = str(raw.get('group') or 'other')
        index = group_indexes.get(group, 0)
        group_indexes[group] = index + 1
        palette = fallback_palettes.get(group, fallback_palettes['other'])
        colour = (
            _department_colour(payload, raw.get('department'))
            if group == 'manpower'
            else ''
        )
        colour = (
            _solid_colour(colour)
            if colour
            else palette[index % len(palette)]
        )
        rows.append({
            'key': str(raw.get('key') or ''),
            'group': group,
            'department': str(raw.get('department') or ''),
            'label': str(raw.get('label') or 'Other'),
            'amount': round(_number(raw.get('amount')), 2),
            'colour': colour,
        })

    total = sum(row['amount'] for row in rows)
    for row in rows:
        row['percent'] = (row['amount'] / total * 100) if total else 0
    return rows


def _expense_category(expense):
    source = str(expense.get('source') or 'manual')
    category_key = str(expense.get('categoryKey') or '')
    category = str(
        expense.get('categoryLabel')
        or expense.get('category')
        or 'Other expense'
    )
    if category_key == 'vendor-service':
        category = 'Service'
    elif source == 'worker-invoice':
        category = 'Manpower'
    elif category_key == 'meal':
        category = 'Meal'
    elif category_key == 'crew-transport':
        category = 'Crew Transport'
    elif category_key == 'equipment-transport':
        category = 'Equipment Transport'
    elif category_key == 'transport':
        category = 'Transport'
    elif category_key == 'purchase':
        category = 'Purchase'
    department = str(expense.get('department') or '').strip()
    if department and source != 'transport-invoice':
        return f'{category} - {department}'
    return category


def _expense_sort_key(expense):
    source_rank = {
        'manual': 0,
        'worker-claim': 1,
        'worker-invoice': 2,
    }.get(str(expense.get('source') or 'manual').strip().lower(), 3)
    return (
        source_rank,
        str(expense.get('department') or '').strip().casefold(),
        str(
            expense.get('vendor')
            or expense.get('description')
            or ''
        ).strip().casefold(),
        str(expense.get('description') or '').strip().casefold(),
        str(expense.get('id') or '').casefold(),
    )


def _expense_category_colour(payload, expense):
    department_colour = _department_colour(payload, expense.get('department'))
    if department_colour:
        return _solid_colour(department_colour)
    category = _expense_category(expense).casefold()
    if category.startswith('manpower'):
        return '#2563EB'
    if category.startswith('transport'):
        return '#F59E0B'
    return '#64748B'


def _expense_chart_rows(expense, chart_rows):
    source = str(expense.get('source') or 'manual')
    category_key = str(expense.get('categoryKey') or '')
    category_label = str(
        expense.get('categoryLabel')
        or expense.get('category')
        or 'Other'
    ).strip()
    group = 'other'
    label = category_label
    if category_key == 'vendor-service':
        group, label = 'vendor', ''
    elif source == 'transport-invoice':
        group, label = 'transport', ''
    elif source == 'worker-invoice':
        group, label = 'manpower', ''
    elif category_key == 'meal':
        group, label = 'meal', ''
    elif category_key == 'crew-transport':
        group, label = 'crew-transport', ''
    elif category_key == 'equipment-transport':
        group, label = 'equipment-transport', ''
    elif category_key == 'transport':
        group, label = 'transport', ''

    matches = [row for row in chart_rows if row.get('group') == group]
    if label:
        matches = [
            row for row in matches
            if str(row.get('label') or '').strip().casefold() == label.casefold()
        ]
    if group in {'manpower', 'vendor'}:
        departments = {
            value.strip().casefold()
            for value in str(expense.get('department') or '').split(',')
            if value.strip()
        }
        if departments:
            matches = [
                row for row in matches
                if str(row.get('department') or '').strip().casefold() in departments
            ]
    return matches


def _expense_chart_bands(expense, chart_rows):
    matches = _expense_chart_rows(expense, chart_rows)
    allocations = {}
    for row in expense.get('departmentAllocations') or []:
        if not isinstance(row, dict):
            continue
        department = str(row.get('department') or '').strip().casefold()
        amount = max(0, _number(row.get('amount')))
        if department and amount > 0:
            allocations[department] = allocations.get(department, 0) + amount
    weighted = [
        {
            'colour': row['colour'],
            'amount': allocations.get(
                str(row.get('department') or '').strip().casefold(), 0
            ),
        }
        for row in matches
    ]
    weighted = [row for row in weighted if row['amount'] > 0]
    if weighted and sum(row['amount'] for row in weighted) > 0:
        return weighted
    return [{'colour': row['colour'], 'amount': 1} for row in matches]


def _expense_status(expense):
    processing_state = str(expense.get('processingState') or '').strip().casefold()
    if processing_state == 'queued':
        return 'Queued'
    if processing_state == 'processing':
        return 'Processing'
    return str(expense.get('status') or '-').strip() or '-'


def _status_palette(status):
    status = str(status or '').strip().casefold()
    if status == 'queued':
        return '#E0F2FE', '#0369A1'
    if status == 'processing':
        return '#EDE9FE', '#6D28D9'
    if status == 'needs review':
        return '#FFF7ED', '#C2410C'
    if status == 'paid':
        return '#DBEAFE', '#1E40AF'
    if status in {'payment confirmed', 'confirmed'}:
        return '#F0EDFF', '#5B3FC6'
    if status == 'approved':
        return '#DCFCE7', '#166534'
    if any(value in status for value in ('denied', 'rejected', 'cancelled')):
        return '#FEE2E2', '#991B1B'
    if any(value in status for value in ('review', 'pending')):
        return '#FFF7ED', '#C2410C'
    if any(value in status for value in ('upload', 'invoice')):
        return '#DBEAFE', '#1D4ED8'
    return '#F1F5F9', '#475569'


def _chart_wedge_angles(rows):
    """Return clockwise wedge angles matching the SVG chart in the web app."""
    total = sum(_number(row.get('amount')) for row in rows)
    angle = 90.0
    wedges = []
    for row in rows:
        extent = (_number(row.get('amount')) / total * 360) if total else 0
        wedges.append((angle, -extent))
        angle -= extent
    return wedges


def build_profit_loss_pdf(payload, company, logo_path='', generated_by=''):
    """Return a portrait A4 project P&L report as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
        CondPageBreak,
        Flowable,
        HRFlowable,
        LongTable,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    font_regular, font_bold = pdf_font_names(company)
    buffer = BytesIO()
    page_width, page_height = A4
    margin = 11 * mm
    footer_height = 14 * mm
    event = payload.get('event') or {}
    summary = payload.get('summary') or {}
    quotation = payload.get('quotation') or {}
    project_name = str(event.get('name') or quotation.get('projectName') or '').strip()
    project_name = project_name or 'Untitled project'
    doc = SimpleDocTemplate(
        buffer,
        pagesize=(page_width, page_height),
        leftMargin=margin,
        rightMargin=margin,
        topMargin=25 * mm,
        bottomMargin=footer_height + 3 * mm,
        title=f'Profit and Loss - {project_name}',
        author=_text(company.get('companyName')),
    )

    styles = getSampleStyleSheet()
    ink = colors.HexColor('#0F172A')
    muted = colors.HexColor('#334155')
    rule = colors.HexColor('#94A3B8')
    soft_rule = colors.HexColor('#CBD5E1')
    panel = colors.HexColor('#F1F5F9')
    accent = _hex_colour(_header_colour(company.get('themeColor')), '#0F4C5C')
    green = colors.HexColor('#07823A')
    red = colors.HexColor('#C32727')
    orange = colors.HexColor('#B56A00')

    body = ParagraphStyle(
        'PnlBody', parent=styles['BodyText'], fontName=font_regular,
        fontSize=8, leading=9.7, textColor=ink,
    )
    small = ParagraphStyle(
        'PnlSmall', parent=body, fontSize=7, leading=8.4, textColor=muted,
    )
    tiny = ParagraphStyle(
        'PnlTiny', parent=body, fontSize=6.2, leading=7.4, textColor=muted,
    )
    title_style = ParagraphStyle(
        'PnlTitle', parent=body, fontName=font_bold,
        fontSize=14.5, leading=17, textColor=ink,
    )
    project_style = ParagraphStyle(
        'PnlProject', parent=body, fontName=font_bold,
        fontSize=12, leading=14, textColor=ink, alignment=TA_RIGHT,
    )
    section_style = ParagraphStyle(
        'PnlSection', parent=body, fontName=font_bold,
        fontSize=10, leading=12, textColor=ink, spaceBefore=3, spaceAfter=5,
    )
    label_style = ParagraphStyle(
        'PnlLabel', parent=small, fontName=font_bold, textColor=muted,
    )
    value_style = ParagraphStyle(
        'PnlValue', parent=body, fontName=font_bold,
    )
    table_header = ParagraphStyle(
        'PnlTableHeader', parent=tiny, fontName=font_bold,
        textColor=colors.white, alignment=TA_CENTER,
    )
    table_left = ParagraphStyle('PnlTableLeft', parent=small, alignment=TA_LEFT)
    table_left_bold = ParagraphStyle(
        'PnlTableLeftBold', parent=table_left, fontName=font_bold,
    )
    table_left_inverse = ParagraphStyle(
        'PnlTableLeftInverse', parent=table_left,
        fontName=font_bold, textColor=colors.white,
    )
    table_center = ParagraphStyle('PnlTableCenter', parent=small, alignment=TA_CENTER)
    table_right = ParagraphStyle('PnlTableRight', parent=small, alignment=TA_RIGHT)
    table_right_bold = ParagraphStyle(
        'PnlTableRightBold', parent=table_right, fontName=font_bold,
    )

    company_name = _text(company.get('companyName')).strip()
    company_lines = [
        _text(value).replace('\n', ' | ').strip()
        for value in (
            company_name,
            company.get('registrationNumber'),
            company.get('billingAddress'),
            ' | '.join(filter(None, [
                _text(company.get('phone')).strip(),
                _text(company.get('email')).strip(),
                _text(company.get('website')).strip(),
            ])),
        )
        if _text(value).strip()
    ]
    company_details = [
        line for line in company_lines
        if not company_name or line.casefold() != company_name.casefold()
    ]
    footer_text = _text(company.get('footerText')).replace('\n', ' | ').strip()
    letterhead_enabled = bool(company.get('letterheadEnabled', True))
    letterhead_title_typography = pdf_text_typography(company, 'letterhead', 14)
    letterhead_logo_typography = pdf_text_typography(company, 'letterhead', 8.5)
    letterhead_detail_typography = pdf_text_typography(company, 'letterhead', 5.8)
    footer_typography = pdf_text_typography(company, 'footer', 5.8)
    letterhead_customised = pdf_text_typography_is_custom(company, 'letterhead')
    letterhead_html = company.get('letterheadHtml') or ''
    footer_html = company.get('footerHtml') or ''

    def draw_page(canvas, _pdf_doc):
        canvas.saveState()
        canvas.setFillColor(colors.white)
        canvas.rect(0, 0, page_width, page_height, stroke=0, fill=1)
        logo_drawn = False
        if logo_path and os.path.isfile(logo_path):
            try:
                image = ImageReader(logo_path)
                width, height = image.getSize()
                scale = min((38 * mm) / width, (12 * mm) / height)
                canvas.drawImage(
                    image, margin, page_height - 19 * mm,
                    width=width * scale, height=height * scale,
                    preserveAspectRatio=True, mask='auto',
                )
                logo_drawn = True
            except Exception:
                logo_drawn = False
        if letterhead_enabled and letterhead_html:
            draw_pdf_rich_text(
                canvas, letterhead_html,
                page_width - margin - (115 * mm) if logo_drawn else margin,
                page_height - 7 * mm,
                115 * mm if logo_drawn else page_width - (2 * margin),
                default_family=company.get('fontFamily'), default_size=5.8,
                text_color=ink, alignment=2 if logo_drawn else 0, top_y=True,
            )
        elif letterhead_enabled and not logo_drawn and company_name:
            canvas.setFillColor(ink)
            if letterhead_customised:
                draw_pdf_canvas_text(canvas, company_name, margin, page_height - 13 * mm, letterhead_title_typography, max_chars=48)
            else:
                canvas.setFont(_canvas_font(company_name, font_bold), 14)
                canvas.drawString(margin, page_height - 13 * mm, company_name[:48])
        if letterhead_enabled and not letterhead_html and company_name and logo_drawn:
            canvas.setFillColor(ink)
            if letterhead_customised:
                draw_pdf_canvas_text(canvas, company_name, page_width - margin, page_height - 8 * mm, letterhead_logo_typography, align='right', max_chars=80)
            else:
                canvas.setFont(_canvas_font(company_name, font_bold), 8.5)
                canvas.drawRightString(page_width - margin, page_height - 8 * mm, company_name[:80])
        if letterhead_enabled and not letterhead_html:
            canvas.setFillColor(muted)
            y = page_height - 11 * mm
            for line in company_details[:3]:
                if letterhead_customised:
                    draw_pdf_canvas_text(canvas, line, page_width - margin, y, letterhead_detail_typography, align='right', max_chars=140)
                else:
                    canvas.setFont(_canvas_font(line, font_regular), 5.8)
                    canvas.drawRightString(page_width - margin, y, line[:140])
                y -= 2.7 * mm
        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 12 * mm, page_width - margin, 12 * mm)
        footer_line = footer_text or (company_lines[0] if company_lines else '')
        canvas.setFillColor(muted)
        if footer_html:
            draw_pdf_rich_text(
                canvas, footer_html, margin, 6.5 * mm, page_width - (2 * margin) - 30 * mm,
                default_family=company.get('fontFamily'), default_size=5.8, text_color=muted,
            )
        else:
            draw_pdf_canvas_text(canvas, footer_line, margin, 7.5 * mm, footer_typography, max_chars=165)
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
                self.setFont(font_regular, 5.8)
                self.drawRightString(
                    page_width - margin, 7.5 * mm,
                    f'Page {page_number} of {page_count}',
                )
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    class DonutChart(Flowable):
        def __init__(self, rows, chart_summary, width=56 * mm, height=48 * mm):
            super().__init__()
            self.rows = rows
            self.chart_summary = chart_summary
            self.width = width
            self.height = height

        def draw(self):
            canvas = self.canv
            radius = min(self.width, self.height) * 0.43
            centre_x = self.width / 2
            centre_y = self.height / 2
            total = sum(row['amount'] for row in self.rows)
            if total <= 0:
                canvas.setFillColor(colors.HexColor('#E2E8F0'))
                canvas.circle(centre_x, centre_y, radius, stroke=0, fill=1)
            else:
                for row, (start_angle, extent) in zip(
                    self.rows, _chart_wedge_angles(self.rows)
                ):
                    canvas.setFillColor(_hex_colour(row['colour'], '#64748B'))
                    canvas.wedge(
                        centre_x - radius, centre_y - radius,
                        centre_x + radius, centre_y + radius,
                        start_angle, extent, stroke=0, fill=1,
                    )
            canvas.setFillColor(colors.white)
            canvas.circle(centre_x, centre_y, radius * 0.57, stroke=0, fill=1)
            canvas.setFillColor(muted)
            canvas.setFont(font_bold, 5.7)
            canvas.drawCentredString(centre_x, centre_y + 4.2 * mm, 'Net Profit')
            canvas.setFillColor(ink)
            canvas.setFont(font_bold, 8.2)
            canvas.drawCentredString(
                centre_x, centre_y + 0.5 * mm,
                _money(self.chart_summary.get('netProfit'), signed=True),
            )
            canvas.setFillColor(muted)
            canvas.setFont(font_bold, 5.7)
            canvas.drawCentredString(
                centre_x, centre_y - 3.2 * mm,
                _percent(self.chart_summary.get('profitMargin')),
            )

    class CategoryBadge(Flowable):
        def __init__(self, label, bands, fallback_colour):
            super().__init__()
            self.label = str(label or '')
            self.bands = [
                row for row in (bands or [])
                if _number(row.get('amount')) > 0
            ] or [{'colour': fallback_colour, 'amount': 1}]
            self.width = 1
            self.height = 6.2 * mm

        def wrap(self, available_width, _available_height):
            self.width = available_width
            return self.width, self.height

        def draw(self):
            canvas = self.canv
            total = sum(_number(row.get('amount')) for row in self.bands) or 1
            offset = 0
            for row in self.bands:
                width = self.width * (_number(row.get('amount')) / total)
                canvas.setFillColor(_hex_colour(row.get('colour'), '#64748B'))
                canvas.rect(offset, 0, width + 0.15, self.height, stroke=0, fill=1)
                offset += width
            canvas.setStrokeColor(colors.HexColor('#64748B'))
            canvas.setLineWidth(0.35)
            canvas.rect(0, 0, self.width, self.height, stroke=1, fill=0)
            text_colour = _contrast_colour(self.bands[0].get('colour'))
            canvas.setFillColor(colors.HexColor(text_colour))
            font_size = 6.2
            while font_size > 4.5 and stringWidth(
                self.label, font_bold, font_size
            ) > self.width - 4:
                font_size -= 0.25
            canvas.setFont(font_bold, font_size)
            canvas.drawCentredString(
                self.width / 2,
                (self.height - font_size) / 2 + 1.2,
                self.label,
            )

    generated_at = datetime.now().strftime('%d %B %Y, %H:%Mhrs')
    client = quotation.get('client') or {}
    metadata = [
        ('Event', f"#{event.get('id') or '-'} - {project_name}"),
        ('Event dates', _event_dates(event)),
        ('Location', event.get('location') or '-'),
        ('Event status', str(event.get('state') or '-').replace('-', ' ').title()),
        ('Client', client.get('company') or client.get('name') or '-'),
        ('Quotation', quotation.get('number') or 'Manual revenue'),
        ('Generated by', generated_by or '-'),
        ('Generated on', generated_at),
    ]

    story = [
        Table(
            [[
                _paragraph('PROJECT PROFIT AND LOSS', title_style),
                _paragraph(project_name, project_style),
            ]],
            colWidths=[doc.width * 0.55, doc.width * 0.45],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ]),
        ),
        HRFlowable(width='100%', thickness=0.8, color=accent),
        Spacer(1, 3 * mm),
    ]

    metadata_cells = [
        [_paragraph(label, label_style), _paragraph(value, value_style)]
        for label, value in metadata
    ]
    metadata_rows = [
        metadata_cells[index] + metadata_cells[index + 1]
        for index in range(0, len(metadata_cells), 2)
    ]
    story.extend([
        Table(
            metadata_rows,
            colWidths=[23 * mm, (doc.width / 2) - 23 * mm] * 2,
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), panel),
                ('BOX', (0, 0), (-1, -1), 0.45, soft_rule),
                ('INNERGRID', (0, 0), (-1, -1), 0.3, soft_rule),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 3.5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
            ]),
        ),
        Spacer(1, 3 * mm),
    ])

    total_cost = round(
        _number(summary.get('directCosts'))
        + _number(summary.get('otherExpenses'))
        + _number(summary.get('commission')),
        2,
    )
    net_profit = _number(summary.get('netProfit'))
    kpis = [
        ('REVENUE (PRE-TAX)', _money(summary.get('revenue')), '#E8F4F8', '#075E70'),
        ('TOTAL COSTS', _money(total_cost), '#FFF7E6', '#9A5B00'),
        ('NET PROFIT', _money(net_profit), '#ECFDF3' if net_profit >= 0 else '#FFF1F2', '#07823A' if net_profit >= 0 else '#C32727'),
        ('PROFIT MARGIN', _percent(summary.get('profitMargin')), '#F2F0FF', '#5B43A6'),
    ]
    kpi_cells = [
        Table(
            [[_paragraph(label, label_style)], [_paragraph(value, value_style)]],
            colWidths=[doc.width / 2 - 5 * mm],
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor(background)),
                ('TEXTCOLOR', (0, 1), (0, 1), colors.HexColor(foreground)),
                ('LEFTPADDING', (0, 0), (-1, -1), 7),
                ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                ('TOPPADDING', (0, 0), (-1, 0), 4),
                ('BOTTOMPADDING', (0, 1), (-1, 1), 5),
            ]),
        )
        for label, value, background, foreground in kpis
    ]
    story.extend([
        Table(
            [kpi_cells[:2], kpi_cells[2:]],
            colWidths=[doc.width / 2] * 2,
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ]),
        ),
        Spacer(1, 4 * mm),
    ])

    invoice_discount = _number(summary.get('invoiceDiscount'))
    calculation_rows = []
    if invoice_discount > 0:
        calculation_rows.extend([
            ('Quotation revenue', summary.get('quotationRevenue'), False),
            ('Invoice discount', -invoice_discount, False),
            ('Revenue after invoice discount', summary.get('revenue'), True),
        ])
    else:
        calculation_rows.append(('Revenue', summary.get('revenue'), False))
    calculation_rows.extend([
        ('Manpower cost', -_number(summary.get('manpowerCost')), False),
        ('Transport cost', -_number(summary.get('transportCost')), False),
        ('Other expenses', -_number(summary.get('otherExpenses')), False),
        ('Net profit before commission', summary.get('beforeCommission'), True),
        ('Commission', -_number(summary.get('commission')), False),
        ('Net profit after commission', summary.get('netProfit'), True),
    ])
    calculation_data = [[
        _paragraph('PROFIT CALCULATION', table_header),
        _paragraph('AMOUNT', table_header),
    ]]
    for label, amount, bold in calculation_rows:
        calculation_data.append([
            _paragraph(label, table_left_bold if bold else table_left),
            _paragraph(_money(amount, signed=True), table_right_bold if bold else table_right),
        ])
    calculation_table = Table(
        calculation_data,
        colWidths=[doc.width - 40 * mm, 40 * mm],
        style=TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), accent),
            ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
            ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#ECFDF3') if net_profit >= 0 else colors.HexColor('#FFF1F2')),
            ('TEXTCOLOR', (1, -1), (1, -1), green if net_profit >= 0 else red),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]),
    )

    chart_rows = _profit_chart_rows(payload)
    legend_rows = []
    for row in chart_rows:
        legend_rows.append([
            '',
            _paragraph(row['label'], table_left),
            _paragraph(_money(row['amount']), table_right_bold),
            _paragraph(_percent(row['percent']), table_right),
        ])
    if not legend_rows:
        legend_rows = [['', _paragraph('No costs or profit to chart.', small), '', '']]
    legend_style = [
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 2),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
    ]
    for index, row in enumerate(chart_rows):
        legend_style.append((
            'BACKGROUND', (0, index), (0, index),
            _hex_colour(row['colour'], '#64748B'),
        ))
    chart_visual_width = 59 * mm
    legend_width = doc.width - chart_visual_width - 8 * mm
    chart_panel = Table(
        [[
            DonutChart(chart_rows, summary),
            Table(
                legend_rows,
                colWidths=[3 * mm, legend_width - 52 * mm, 31 * mm, 18 * mm],
                style=TableStyle(legend_style),
            ),
        ]],
        colWidths=[chart_visual_width, doc.width - chart_visual_width],
        style=TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), panel),
            ('BOX', (0, 0), (-1, -1), 0.45, soft_rule),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]),
    )
    story.extend([
        _paragraph('Profit Calculation', section_style),
        calculation_table,
        Spacer(1, 3 * mm),
        _paragraph('Profit Summary', section_style),
        chart_panel,
        Spacer(1, 4 * mm),
    ])

    if quotation:
        budget_rows = [[
            _paragraph(value, table_header)
            for value in ('BUDGET AREA', 'QUOTATION BUDGET', 'ACTUAL COST', 'VARIANCE', 'RESULT')
        ]]
        budget_styles = [
            ('BACKGROUND', (0, 0), (-1, 0), accent),
            ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]
        for label, prefix in (('Manpower', 'manpower'), ('Transport', 'transport')):
            budget = _number(summary.get(f'{prefix}Budget'))
            actual = _number(summary.get(f'{prefix}Cost'))
            variance = _number(summary.get(f'{prefix}BudgetVariance'))
            under = variance >= 0
            budget_rows.append([
                _paragraph(label, table_left_bold),
                _paragraph(_money(budget), table_right),
                _paragraph(_money(actual), table_right),
                _paragraph(_money(abs(variance)), table_right_bold),
                _paragraph(f"{_money(abs(variance))} {'under' if under else 'over'}", table_center),
            ])
            index = len(budget_rows) - 1
            budget_styles.extend([
                ('BACKGROUND', (4, index), (4, index), colors.HexColor('#ECFDF3' if under else '#FFF7E6')),
                ('TEXTCOLOR', (4, index), (4, index), green if under else orange),
            ])
        story.extend([
            CondPageBreak(30 * mm),
            _paragraph('Budget Performance', section_style),
            Table(
                budget_rows,
                colWidths=[32 * mm, 38 * mm, 38 * mm, 34 * mm, doc.width - 142 * mm],
                style=TableStyle(budget_styles),
            ),
            Spacer(1, 4 * mm),
        ])

    breakdown = payload.get('breakdown') or {}
    source_rows = [[
        _paragraph(value, table_header)
        for value in ('COST AREA', 'SOURCE', 'AMOUNT')
    ]]
    source_items = [
        ('Manpower', 'Manpower invoices or assignment estimate', breakdown.get('manpowerInvoicesOrEstimate')),
        ('Other', 'Vendor service invoices or assignment estimate', breakdown.get('vendorServices')),
        ('Manpower', 'Crew transport claims', breakdown.get('crewTransportClaims')),
        ('Manpower', 'Meal claims', breakdown.get('workerMealClaims')),
        ('Transport', 'Transport-page bookings', breakdown.get('transportBookings')),
        ('Other', 'Other crew claims', breakdown.get('workerOtherClaims')),
        ('Other', 'Additional meal expenses', breakdown.get('manualMealExpenses')),
        ('Other', 'Additional transport expenses', breakdown.get('manualTransportExpenses')),
        ('Other', 'Additional other expenses', breakdown.get('manualOtherExpenses')),
        ('Commission', 'Commission', breakdown.get('commission')),
    ]
    for area, source, amount in source_items:
        if abs(_number(amount)) < 0.005:
            continue
        source_rows.append([
            _paragraph(area, table_left_bold),
            _paragraph(source, table_left),
            _paragraph(_money(amount), table_right_bold),
        ])
    if len(source_rows) == 1:
        source_rows.append([_paragraph('No costs recorded.', small), '', ''])
    source_style = [
        ('BACKGROUND', (0, 0), (-1, 0), accent),
        ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]
    if len(source_rows) == 2 and not source_rows[1][1]:
        source_style.append(('SPAN', (0, 1), (-1, 1)))
    story.extend([
        CondPageBreak(35 * mm),
        _paragraph('Cost Sources', section_style),
        LongTable(
            source_rows,
            colWidths=[33 * mm, doc.width - 68 * mm, 35 * mm],
            repeatRows=1,
            splitByRow=1,
            style=TableStyle(source_style),
        ),
        Spacer(1, 4 * mm),
    ])

    commissions = [row for row in payload.get('commissions') or [] if isinstance(row, dict)]
    if commissions:
        commission_rows = [[
            _paragraph(value, table_header)
            for value in ('RECIPIENT', 'CALCULATION', 'RATE', 'AMOUNT')
        ]]
        for row in commissions:
            mode = str(row.get('calculationMode') or 'percent')
            commission_rows.append([
                _paragraph(row.get('recipient') or '-', table_left),
                _paragraph('Fixed amount' if mode == 'amount' else 'Percentage of net profit before commission', table_left),
                _paragraph('-' if mode == 'amount' else _percent(row.get('percent')), table_right),
                _paragraph(_money(row.get('amount')), table_right_bold),
            ])
        story.extend([
            CondPageBreak(30 * mm),
            _paragraph('Commission Recipients', section_style),
            Table(
                commission_rows,
                colWidths=[38 * mm, doc.width - 105 * mm, 28 * mm, 39 * mm],
                style=TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#8B5CF6')),
                    ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 5),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                    ('TOPPADDING', (0, 0), (-1, -1), 3),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ]),
            ),
            Spacer(1, 4 * mm),
        ])

    expenses = [row for row in payload.get('expenses') or [] if isinstance(row, dict)]
    expenses.sort(key=_expense_sort_key)
    expense_rows = [[
        _paragraph(value, table_header)
        for value in (
            'DATE', 'DESCRIPTION', 'TYPE', 'CATEGORY', 'VENDOR / PAYEE',
            'STATUS', 'ATTACHMENT', 'AMOUNT',
        )
    ]]
    expense_styles = [
        ('BACKGROUND', (0, 0), (-1, 0), accent),
        ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 3.5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 3.5),
        ('TOPPADDING', (0, 0), (-1, -1), 2.8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.8),
    ]
    for expense in expenses:
        attachment = expense.get('attachment') if isinstance(expense.get('attachment'), dict) else {}
        status = _expense_status(expense)
        status_background, status_text = _status_palette(status)
        status_style = ParagraphStyle(
            f"PnlStatus{len(expense_rows)}", parent=table_center,
            textColor=colors.HexColor(status_text),
        )
        category_label = _expense_category(expense)
        category_colour = _expense_category_colour(payload, expense)
        category_bands = _expense_chart_bands(expense, chart_rows)
        expense_rows.append([
            _paragraph(_format_date(expense.get('expenseDate')), table_center),
            _paragraph(expense.get('description') or '-', table_left_bold),
            _paragraph(expense.get('sourceLabel') or ('Claim' if expense.get('readOnly') else 'Added'), table_center),
            CategoryBadge(category_label, category_bands, category_colour),
            _paragraph(expense.get('vendor') or '-', table_left),
            _paragraph(status, status_style),
            _paragraph(attachment.get('originalName') or '-', tiny),
            _paragraph(_money(expense.get('amount')), table_right_bold),
        ])
        row_index = len(expense_rows) - 1
        expense_styles.extend([
            ('BACKGROUND', (5, row_index), (5, row_index), colors.HexColor(status_background)),
            ('TEXTCOLOR', (5, row_index), (5, row_index), colors.HexColor(status_text)),
        ])
    if not expenses:
        expense_rows.append([_paragraph('No invoices, claims, or additional expenses recorded.', small)] + [''] * 7)
        expense_styles.append(('SPAN', (0, 1), (-1, 1)))
    listed_total = sum(_number(row.get('amount')) for row in expenses)
    expense_rows.append([
        '', _paragraph('Total listed expenses', table_right_bold), '', '', '', '', '',
        _paragraph(_money(listed_total), table_right_bold),
    ])
    total_index = len(expense_rows) - 1
    expense_styles.extend([
        ('SPAN', (1, total_index), (6, total_index)),
        ('BACKGROUND', (0, total_index), (-1, total_index), panel),
        ('LINEABOVE', (0, total_index), (-1, total_index), 0.7, accent),
    ])
    story.extend([
        CondPageBreak(40 * mm),
        _paragraph('Invoices, Claims & Expenses', section_style),
        LongTable(
            expense_rows,
            colWidths=[19 * mm, 38 * mm, 18 * mm, 32 * mm, 22 * mm, 21 * mm, 18 * mm, doc.width - 168 * mm],
            repeatRows=1,
            splitByRow=1,
            style=TableStyle(expense_styles),
        ),
        Spacer(1, 4 * mm),
    ])

    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()
