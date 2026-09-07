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


def _profit_chart_rows(payload):
    fallback_palettes = {
        'manpower': ['#2563EB', '#0EA5E9', '#06B6D4', '#6366F1', '#0284C7'],
        'vendor': ['#0F766E', '#14B8A6', '#0D9488', '#115E59'],
        'meal': ['#EC4899'],
        'crew-transport': ['#14B8A6'],
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
        ) or palette[index % len(palette)]
        rows.append({
            'label': str(raw.get('label') or 'Other'),
            'amount': round(_number(raw.get('amount')), 2),
            'colour': colour,
        })

    rows.sort(key=lambda row: row['amount'], reverse=True)
    if len(rows) > 9:
        remainder = rows[8:]
        rows = rows[:8] + [{
            'label': f'Other categories ({len(remainder)})',
            'amount': round(sum(row['amount'] for row in remainder), 2),
            'colour': '#94A3B8',
        }]
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
    elif (
        source == 'worker-invoice'
        or (source == 'worker-claim' and category_key in {'meal', 'transport'})
        or (source == 'manual' and category_key == 'meal')
    ):
        category = 'Manpower'
    elif source == 'manual' and category_key == 'transport':
        category = 'Transport'
    department = str(expense.get('department') or '').strip()
    return f'{category} - {department}' if department else category


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
        return department_colour
    category = _expense_category(expense).casefold()
    if category.startswith('manpower'):
        return '#2563EB'
    if category.startswith('transport'):
        return '#F59E0B'
    return '#64748B'


def _status_palette(status):
    status = str(status or '').strip().casefold()
    if any(value in status for value in ('approved', 'paid', 'confirmed')):
        return '#DCFCE7', '#166534'
    if any(value in status for value in ('denied', 'rejected', 'cancelled')):
        return '#FEE2E2', '#991B1B'
    if any(value in status for value in ('review', 'pending')):
        return '#FFEDD5', '#9A3412'
    if any(value in status for value in ('upload', 'invoice')):
        return '#DBEAFE', '#1D4ED8'
    return '#F1F5F9', '#475569'


def build_profit_loss_pdf(payload, company, logo_path='', generated_by=''):
    """Return a landscape A4 project P&L report as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
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
    page_width, page_height = landscape(A4)
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
    ink = colors.HexColor('#172033')
    muted = colors.HexColor('#64748B')
    rule = colors.HexColor('#CBD5E1')
    soft_rule = colors.HexColor('#E2E8F0')
    panel = colors.HexColor('#F8FAFC')
    accent = _hex_colour(company.get('themeColor'), '#0F766E')
    green = colors.HexColor('#07823A')
    red = colors.HexColor('#C32727')
    orange = colors.HexColor('#B56A00')

    body = ParagraphStyle(
        'PnlBody', parent=styles['BodyText'], fontName=font_regular,
        fontSize=7, leading=8.5, textColor=ink,
    )
    small = ParagraphStyle(
        'PnlSmall', parent=body, fontSize=6.2, leading=7.4, textColor=muted,
    )
    tiny = ParagraphStyle(
        'PnlTiny', parent=body, fontSize=5.4, leading=6.5, textColor=muted,
    )
    title_style = ParagraphStyle(
        'PnlTitle', parent=body, fontName=font_bold,
        fontSize=18, leading=21, textColor=ink,
    )
    project_style = ParagraphStyle(
        'PnlProject', parent=body, fontName=font_bold,
        fontSize=12, leading=14, textColor=ink, alignment=TA_RIGHT,
    )
    section_style = ParagraphStyle(
        'PnlSection', parent=body, fontName=font_bold,
        fontSize=9, leading=11, textColor=ink, spaceBefore=2, spaceAfter=4,
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
        def __init__(self, rows, width=58 * mm, height=43 * mm):
            super().__init__()
            self.rows = rows
            self.width = width
            self.height = height

        def draw(self):
            canvas = self.canv
            radius = min(self.width, self.height) * 0.43
            centre_x = self.width / 2
            centre_y = self.height / 2
            angle = 90
            total = sum(row['amount'] for row in self.rows)
            if total <= 0:
                canvas.setFillColor(colors.HexColor('#E2E8F0'))
                canvas.circle(centre_x, centre_y, radius, stroke=0, fill=1)
            else:
                for row in self.rows:
                    extent = row['amount'] / total * 360
                    canvas.setFillColor(_hex_colour(row['colour'], '#64748B'))
                    canvas.wedge(
                        centre_x - radius, centre_y - radius,
                        centre_x + radius, centre_y + radius,
                        angle, extent, stroke=0, fill=1,
                    )
                    angle += extent
            canvas.setFillColor(colors.white)
            canvas.circle(centre_x, centre_y, radius * 0.57, stroke=0, fill=1)
            canvas.setFillColor(ink)
            canvas.setFont(font_bold, 9)
            canvas.drawCentredString(centre_x, centre_y + 1.2 * mm, _money(total))
            canvas.setFillColor(muted)
            canvas.setFont(font_regular, 5.5)
            canvas.drawCentredString(centre_x, centre_y - 2.5 * mm, 'costs + net profit')

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
                _paragraph('PROJECT PROFIT & LOSS', title_style),
                _paragraph(project_name, project_style),
            ]],
            colWidths=[doc.width * 0.42, doc.width * 0.58],
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
            colWidths=[27 * mm, 102 * mm, 27 * mm, doc.width - 156 * mm],
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
    story.extend([
        Table(
            [[
                Table(
                    [[_paragraph(label, label_style)], [_paragraph(value, value_style)]],
                    colWidths=[doc.width / 4 - 4 * mm],
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
            ]],
            colWidths=[doc.width / 4] * 4,
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
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
        ('Crew & Vendors cost', -_number(summary.get('manpowerCost')), False),
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
        colWidths=[76 * mm, 36 * mm],
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
    chart_panel = Table(
        [[
            DonutChart(chart_rows),
            Table(
                legend_rows,
                colWidths=[3 * mm, 47 * mm, 25 * mm, 17 * mm],
                style=TableStyle(legend_style),
            ),
        ]],
        colWidths=[61 * mm, 96 * mm],
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
        Table(
            [[calculation_table, chart_panel]],
            colWidths=[116 * mm, doc.width - 116 * mm],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (0, 0), 0),
                ('RIGHTPADDING', (0, 0), (0, 0), 4),
                ('LEFTPADDING', (1, 0), (1, 0), 4),
                ('RIGHTPADDING', (1, 0), (1, 0), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]),
        ),
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
            _paragraph('Budget Performance', section_style),
            Table(
                budget_rows,
                colWidths=[55 * mm, 50 * mm, 50 * mm, 42 * mm, doc.width - 197 * mm],
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
        ('Crew & Vendors', 'Crew invoices or assignment estimate', breakdown.get('manpowerInvoicesOrEstimate')),
        ('Crew & Vendors', 'Vendor service invoices or assignment estimate', breakdown.get('vendorServices')),
        ('Crew & Vendors', 'Crew transport claims', breakdown.get('crewTransportClaims')),
        ('Crew & Vendors', 'Meal claims', breakdown.get('workerMealClaims')),
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
        _paragraph('Cost Sources', section_style),
        LongTable(
            source_rows,
            colWidths=[55 * mm, doc.width - 97 * mm, 42 * mm],
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
            _paragraph('Commission Recipients', section_style),
            Table(
                commission_rows,
                colWidths=[65 * mm, doc.width - 150 * mm, 35 * mm, 50 * mm],
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
        status = str(expense.get('status') or '-').strip() or '-'
        status_background, status_text = _status_palette(status)
        status_style = ParagraphStyle(
            f"PnlStatus{len(expense_rows)}", parent=table_center,
            textColor=colors.HexColor(status_text),
        )
        expense_rows.append([
            _paragraph(_format_date(expense.get('expenseDate')), table_center),
            _paragraph(expense.get('description') or '-', table_left_bold),
            _paragraph(expense.get('sourceLabel') or ('Claim' if expense.get('readOnly') else 'Added expense'), table_center),
            _paragraph(_expense_category(expense), table_left_inverse),
            _paragraph(expense.get('vendor') or '-', table_left),
            _paragraph(status, status_style),
            _paragraph(attachment.get('originalName') or '-', tiny),
            _paragraph(_money(expense.get('amount')), table_right_bold),
        ])
        row_index = len(expense_rows) - 1
        category_colour = _expense_category_colour(payload, expense)
        expense_styles.extend([
            ('BACKGROUND', (3, row_index), (3, row_index), _hex_colour(category_colour, '#64748B')),
            ('TEXTCOLOR', (3, row_index), (3, row_index), colors.white),
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
        _paragraph('Invoices, Claims & Expenses', section_style),
        LongTable(
            expense_rows,
            colWidths=[25 * mm, 57 * mm, 25 * mm, 40 * mm, 38 * mm, 29 * mm, doc.width - 246 * mm, 32 * mm],
            repeatRows=1,
            splitByRow=1,
            style=TableStyle(expense_styles),
        ),
        Spacer(1, 4 * mm),
    ])

    activity = [row for row in payload.get('activity') or [] if isinstance(row, dict)]
    if activity:
        activity_rows = [[
            _paragraph(value, table_header)
            for value in ('DATE & TIME', 'USER', 'ACTIVITY')
        ]]
        for row in activity:
            activity_rows.append([
                _paragraph(_format_datetime(row.get('timestamp') or row.get('date')), table_left),
                _paragraph(row.get('user') or 'System', table_left),
                _paragraph(row.get('action') or '-', table_left),
            ])
        story.extend([
            _paragraph('Recent Event Activity', section_style),
            LongTable(
                activity_rows,
                colWidths=[47 * mm, 42 * mm, doc.width - 89 * mm],
                repeatRows=1,
                style=TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), accent),
                    ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 5),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                    ('TOPPADDING', (0, 0), (-1, -1), 3),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ]),
            ),
        ])

    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()
