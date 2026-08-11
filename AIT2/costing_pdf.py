"""Print-ready internal costing report rendering."""

from collections import OrderedDict
from datetime import datetime
from html import escape
from io import BytesIO
import colorsys
import os

from quotation_pdf import (
    _canvas_font,
    _cjk_markup,
    _escaped_line_breaks,
    _group_display_entries,
    _group_display_entry_chunks,
    _group_line_description,
    _paragraph,
    _safe_hex,
    _text,
)


def _number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _money(value):
    amount = _number(value)
    sign = '-' if amount < 0 else ''
    return f"{sign}${abs(amount):,.2f}"


def _quantity(value):
    amount = _number(value)
    return f"{amount:,.0f}" if amount.is_integer() else f"{amount:,.2f}".rstrip('0')


def _format_datetime(value):
    raw = str(value or '').strip()
    if not raw:
        return '-'
    try:
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return parsed.strftime('%d %B %Y, %H:%Mhrs')
    except ValueError:
        return _text(raw)


def _hsl_color(hue, saturation, lightness):
    from reportlab.lib.colors import Color

    red, green, blue = colorsys.hls_to_rgb(
        (hue % 360) / 360,
        lightness,
        saturation,
    )
    return Color(red, green, blue)


def _vendor_hue(value):
    """Match costingVendorHue so each vendor keeps its on-screen colour."""
    name = str(value or '').strip().lower()
    hash_value = 17
    for character in name:
        hash_value = ((hash_value * 31) + ord(character)) & 0xFFFFFFFF
    return hash_value % 360


def _vendor_palette(value):
    from reportlab.lib import colors

    name = str(value or '').strip()
    if not name:
        return colors.HexColor('#FFF1F2'), colors.HexColor('#C32727')
    if name.casefold() == 'self':
        return colors.HexColor('#E5E7EB'), colors.HexColor('#475569')
    hue = _vendor_hue(name)
    return _hsl_color(hue, 0.74, 0.92), _hsl_color(hue, 0.55, 0.28)


def _price_state(actual, cost, target):
    actual = _number(actual)
    cost = _number(cost)
    target = _number(target)
    if actual < cost - 0.005:
        return 'below-cost'
    if actual < target - 0.005:
        return 'below-margin'
    return 'at-or-above-margin'


def _price_palette(state):
    from reportlab.lib import colors

    return {
        'below-cost': (
            colors.HexColor('#FFF1F2'), colors.HexColor('#C32727')
        ),
        'below-margin': (
            colors.HexColor('#FFF7E6'), colors.HexColor('#B56A00')
        ),
        'at-or-above-margin': (
            colors.HexColor('#ECFDF3'), colors.HexColor('#07823A')
        ),
    }[state]


def _comparison_text(actual, cost):
    difference = _number(actual) - _number(cost)
    if abs(difference) < 0.005:
        return '$0.00'
    return f"{'+' if difference > 0 else '-'}${abs(difference):,.2f}"


def _line_unit_price(line, field='salePrice'):
    divisor = max(0, _number(line.get('quantity'))) * max(
        0, _number(line.get('multiplier'))
    )
    total = max(0, _number(line.get(field)))
    return total / divisor if divisor else total


def _line_item_text(line):
    if line.get('groupId'):
        return _group_line_description(line).strip() or 'Item'
    return _text(line.get('description')).strip() or 'Item'


def _ordered_sections(costing):
    lines = [row for row in costing.get('lineItems') or [] if isinstance(row, dict)]
    rooms = [
        row for row in costing.get('subprojects') or []
        if isinstance(row, dict) and str(row.get('id') or '').strip()
    ] or [{'id': 'main', 'name': 'Main Room'}]
    known_ids = {str(room.get('id')) for room in rooms}
    for line in lines:
        room_id = str(line.get('subprojectId') or 'main')
        if room_id not in known_ids:
            rooms.append({'id': room_id, 'name': 'Main Room' if room_id == 'main' else room_id})
            known_ids.add(room_id)

    sections = []
    for room in rooms:
        room_id = str(room.get('id') or 'main')
        room_lines = [
            line for line in lines
            if str(line.get('subprojectId') or 'main') == room_id
        ]
        categories = OrderedDict()
        for line in room_lines:
            category = str(line.get('category') or 'General').strip() or 'General'
            categories.setdefault(category, []).append(line)
        sections.append((room, categories))
    return sections


def _category_total(costing, room_id, category, lines):
    stored = next((
        row for row in costing.get('categoryTotals') or []
        if isinstance(row, dict)
        and str(row.get('subprojectId') or 'main') == str(room_id)
        and str(row.get('category') or '').casefold() == str(category).casefold()
    ), None)
    if stored:
        return stored
    cost = round(sum(_number(line.get('costTotal')) for line in lines), 2)
    raw_sale = round(sum(_number(line.get('salePrice')) for line in lines), 2)
    return {
        'cost': cost,
        'rawSale': raw_sale,
        'adjustment': 0,
        'charged': raw_sale,
        'profit': round(raw_sale - cost, 2),
    }


def build_costing_pdf(costing, company, logo_path='', generated_by=''):
    """Return a landscape A4 costing report as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
        HRFlowable,
        KeepTogether,
        LongTable,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buffer = BytesIO()
    page_width, page_height = landscape(A4)
    margin = 11 * mm
    footer_height = 14 * mm
    project_name = _text(costing.get('projectName')).strip() or 'Untitled costing'
    doc = SimpleDocTemplate(
        buffer,
        pagesize=(page_width, page_height),
        leftMargin=margin,
        rightMargin=margin,
        topMargin=25 * mm,
        bottomMargin=footer_height + 3 * mm,
        title=f'Costing - {project_name}',
        author=_text(company.get('companyName')),
    )

    styles = getSampleStyleSheet()
    ink = colors.HexColor('#172033')
    muted = colors.HexColor('#64748B')
    rule = colors.HexColor('#CBD5E1')
    soft_rule = colors.HexColor('#E2E8F0')
    panel = colors.HexColor('#F8FAFC')
    accent = colors.HexColor(_safe_hex(company.get('themeColor'), '#078C9F'))
    teal = colors.HexColor('#078C9F')

    body = ParagraphStyle(
        'CostingBody', parent=styles['BodyText'], fontName='Helvetica',
        fontSize=7, leading=8.5, textColor=ink,
    )
    small = ParagraphStyle(
        'CostingSmall', parent=body, fontSize=6, leading=7.2, textColor=muted,
    )
    tiny = ParagraphStyle(
        'CostingTiny', parent=body, fontSize=5.4, leading=6.4, textColor=muted,
    )
    title_style = ParagraphStyle(
        'CostingTitle', parent=body, fontName='Helvetica-Bold',
        fontSize=19, leading=22, textColor=ink,
    )
    project_style = ParagraphStyle(
        'CostingProject', parent=body, fontName='Helvetica-Bold',
        fontSize=12, leading=14, textColor=ink,
    )
    label_style = ParagraphStyle(
        'CostingLabel', parent=body, fontName='Helvetica-Bold',
        fontSize=5.8, leading=7, textColor=muted,
    )
    value_style = ParagraphStyle(
        'CostingValue', parent=body, fontName='Helvetica-Bold',
        fontSize=7.4, leading=9, textColor=ink,
    )
    table_header = ParagraphStyle(
        'CostingTableHeader', parent=body, fontName='Helvetica-Bold',
        fontSize=5.5, leading=6.5, textColor=colors.white,
        alignment=TA_CENTER,
    )
    table_left = ParagraphStyle(
        'CostingTableLeft', parent=body, fontSize=6, leading=7.2,
        alignment=TA_LEFT,
    )
    table_center = ParagraphStyle(
        'CostingTableCenter', parent=table_left, alignment=TA_CENTER,
    )
    table_right = ParagraphStyle(
        'CostingTableRight', parent=table_left, alignment=TA_RIGHT,
    )
    table_right_bold = ParagraphStyle(
        'CostingTableRightBold', parent=table_right, fontName='Helvetica-Bold',
    )
    section_style = ParagraphStyle(
        'CostingSection', parent=body, fontName='Helvetica-Bold',
        fontSize=9, leading=11, textColor=ink, spaceBefore=3, spaceAfter=3,
        keepWithNext=1,
    )
    room_style = ParagraphStyle(
        'CostingRoom', parent=body, fontName='Helvetica-Bold',
        fontSize=10, leading=12, textColor=teal, spaceBefore=5, spaceAfter=3,
        keepWithNext=1,
    )
    category_style = ParagraphStyle(
        'CostingCategory', parent=body, fontName='Helvetica-Bold',
        fontSize=7.2, leading=8.5, textColor=ink,
    )

    company_name = _text(company.get('companyName')).strip()
    letterhead_enabled = company.get('letterheadEnabled', True) is not False
    letterhead_lines = [
        _text(line).strip()
        for line in str(company.get('letterheadText') or '').splitlines()
        if _text(line).strip()
    ]
    company_lines = (letterhead_lines or [
        company_name,
        _text(company.get('billingAddress')).strip(),
        ' | '.join(filter(None, (
            _text(company.get('phone')).strip(),
            _text(company.get('email')).strip(),
            _text(company.get('website')).strip(),
        ))),
    ]) if letterhead_enabled else []
    company_lines = [line for line in company_lines if line]
    company_details = [
        line for line in company_lines
        if not company_name or line.casefold() != company_name.casefold()
    ]
    footer_text = _text(company.get('footerText')).replace('\n', ' | ').strip()

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
        if letterhead_enabled and not logo_drawn and company_name:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(company_name, 'Helvetica-Bold'), 14)
            canvas.drawString(margin, page_height - 13 * mm, company_name[:48])
        if letterhead_enabled and company_name and logo_drawn:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(company_name, 'Helvetica-Bold'), 8.5)
            canvas.drawRightString(page_width - margin, page_height - 8 * mm, company_name[:80])
        if letterhead_enabled:
            canvas.setFillColor(muted)
            y = page_height - 11 * mm
            for line in company_details[:3]:
                canvas.setFont(_canvas_font(line, 'Helvetica'), 5.8)
                canvas.drawRightString(page_width - margin, y, line[:140])
                y -= 2.7 * mm
        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 12 * mm, page_width - margin, 12 * mm)
        footer_line = footer_text or (company_lines[0] if company_lines else '')
        canvas.setFillColor(muted)
        canvas.setFont(_canvas_font(footer_line, 'Helvetica'), 5.8)
        canvas.drawString(margin, 7.5 * mm, footer_line[:165])
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
                self.setFont('Helvetica', 5.8)
                self.drawRightString(
                    page_width - margin, 7.5 * mm,
                    f'Page {page_number} of {page_count}',
                )
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    totals = costing.get('totals') or {}
    margin_percent = _number(totals.get('marginPercent'))
    quotation_number = (
        costing.get('convertedQuotationNumber')
        or costing.get('sourceQuotationNumber')
        or 'Not created'
    )
    status = str(costing.get('status') or 'draft').replace('-', ' ').title()
    generated_at = datetime.now().strftime('%d %B %Y, %H:%Mhrs')
    metadata = [
        ('Event location', costing.get('eventLocation') or '-'),
        ('Salesperson', costing.get('salesperson') or costing.get('salespersonUsername') or '-'),
        ('Quotation', quotation_number),
        ('Status', status),
        ('Created', _format_datetime(costing.get('createdAt'))),
        ('Last modified', _format_datetime(costing.get('updatedAt'))),
        ('Generated by', generated_by or '-'),
        ('Generated on', generated_at),
    ]

    story = [
        Table(
            [[_paragraph('COSTING REPORT', title_style), _paragraph(project_name, project_style)]],
            colWidths=[doc.width * 0.34, doc.width * 0.66],
            style=TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
                ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
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
        [
            _paragraph(label, label_style),
            _paragraph(value, value_style),
        ]
        for label, value in metadata
    ]
    metadata_rows = [
        metadata_cells[index] + metadata_cells[index + 1]
        for index in range(0, len(metadata_cells), 2)
    ]
    story.extend([
        Table(
            metadata_rows,
            colWidths=[29 * mm, 99 * mm, 29 * mm, doc.width - 157 * mm],
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), panel),
                ('BOX', (0, 0), (-1, -1), 0.45, soft_rule),
                ('INNERGRID', (0, 0), (-1, -1), 0.3, soft_rule),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ]),
        ),
        Spacer(1, 3 * mm),
    ])

    kpis = [
        ('TOTAL ITEM COSTING', _money(totals.get('cost')), '#E8F4F8', '#075E70'),
        ('TOTAL CHARGEABLE', _money(totals.get('sale')), '#EEF5FF', '#245B9E'),
        ('GROSS PROFIT', _money(totals.get('profit')), '#ECFDF3', '#07823A'),
        ('MARGIN', f'{margin_percent:,.1f}%', '#F2F0FF', '#5B43A6'),
    ]
    kpi_table = Table(
        [[
            Table(
                [[_paragraph(label, label_style)], [_paragraph(value, value_style)]],
                colWidths=[doc.width / 4 - 5 * mm],
                style=TableStyle([
                    ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor(background)),
                    ('TEXTCOLOR', (0, 1), (0, 1), colors.HexColor(foreground)),
                    ('LEFTPADDING', (0, 0), (-1, -1), 7),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                    ('TOPPADDING', (0, 0), (-1, 0), 5),
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
    )
    story.extend([kpi_table, Spacer(1, 3 * mm)])

    legend_rows = [[
        _paragraph('PRICING COMPARISON', label_style),
        _paragraph('At / above target margin', small),
        _paragraph('Below target margin', small),
        _paragraph('Below cost', small),
        _paragraph('Difference shown against cost', tiny),
    ]]
    legend = Table(
        legend_rows,
        colWidths=[34 * mm, 39 * mm, 35 * mm, 27 * mm, doc.width - 135 * mm],
        style=TableStyle([
            ('BOX', (0, 0), (-1, -1), 0.35, soft_rule),
            ('BACKGROUND', (1, 0), (1, 0), _price_palette('at-or-above-margin')[0]),
            ('TEXTCOLOR', (1, 0), (1, 0), _price_palette('at-or-above-margin')[1]),
            ('BACKGROUND', (2, 0), (2, 0), _price_palette('below-margin')[0]),
            ('TEXTCOLOR', (2, 0), (2, 0), _price_palette('below-margin')[1]),
            ('BACKGROUND', (3, 0), (3, 0), _price_palette('below-cost')[0]),
            ('TEXTCOLOR', (3, 0), (3, 0), _price_palette('below-cost')[1]),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]),
    )
    story.extend([legend, Spacer(1, 2 * mm)])

    sections = _ordered_sections(costing)
    multiple_rooms = len(sections) > 1
    column_widths = [
        49 * mm, 11 * mm, 12 * mm, 27 * mm, 35 * mm,
        19 * mm, 20 * mm, 22 * mm, 20 * mm, 21 * mm, 21 * mm,
    ]
    headers = [
        'ITEM', 'QTY', '', 'VENDOR', 'REMARKS', 'UNIT COST',
        'COST TOTAL', 'MARGIN', 'CALC. PRICE', 'UNIT PRICE', 'SALE PRICE',
    ]
    for room, categories in sections:
        room_name = _text(room.get('name')).strip() or 'Main Room'
        pending_room_heading = (
            _paragraph(room_name, room_style) if multiple_rooms else None
        )
        if not categories:
            empty_room = [_paragraph('No items in this room.', small)]
            if pending_room_heading:
                empty_room.insert(0, pending_room_heading)
            story.append(KeepTogether(empty_room))
            continue
        for category, lines in categories.items():
            room_id = str(room.get('id') or 'main')
            total = _category_total(costing, room_id, category, lines)
            category_headers = list(headers)
            category_headers[2] = (
                'DAY(S)' if lines[0].get('multiplierLabel') == 'Day' else 'MULT'
            )
            data = [
                [_paragraph(category, category_style)] + [''] * 6 + [
                    _paragraph('COST', label_style),
                    _paragraph(_money(total.get('cost')), table_right_bold),
                    _paragraph('CLIENT CHARGE', label_style),
                    _paragraph(_money(total.get('charged')), table_right_bold),
                ],
                [_paragraph(value, table_header) for value in category_headers],
            ]
            style_commands = [
                ('SPAN', (0, 0), (6, 0)),
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#EEF4F7')),
                ('LINEBELOW', (0, 0), (-1, 0), 0.5, colors.HexColor('#B8C8D1')),
                ('BACKGROUND', (0, 1), (-1, 1), teal),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 3),
                ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                ('TOPPADDING', (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ('GRID', (0, 1), (-1, -1), 0.3, soft_rule),
            ]
            line_units = []
            rendered_groups = set()
            for line in lines:
                group_id = str(line.get('groupId') or '')
                if not group_id:
                    line_units.append([line])
                    continue
                if group_id in rendered_groups:
                    continue
                rendered_groups.add(group_id)
                line_units.append([
                    candidate for candidate in lines
                    if str(candidate.get('groupId') or '') == group_id
                ])

            for line_unit in line_units:
                line = next(
                    (member for member in line_unit if member.get('groupLeader')),
                    line_unit[0],
                )
                is_group = bool(line.get('groupId'))
                multiplier = max(0, _number(line.get('multiplier')))
                if is_group:
                    quantity = max(0, _number(line.get('groupHeaderQuantity'), 1))
                    cost_total = sum(
                        max(0, _number(member.get('costTotal')))
                        for member in line_unit
                    )
                    calculated = sum(
                        max(0, _number(member.get('calculatedSalePrice')))
                        for member in line_unit
                    )
                    sale_price = sum(
                        max(0, _number(member.get('salePrice')))
                        for member in line_unit
                    )
                    divisor = quantity * multiplier
                    unit_cost = cost_total / divisor if divisor else cost_total
                    calculated_unit = calculated / divisor if divisor else calculated
                    unit_price = sale_price / divisor if divisor else sale_price
                    margin_percent_line = (
                        (calculated - cost_total) / cost_total * 100
                        if cost_total else (100 if calculated else 0)
                    )
                    vendor_names = list(dict.fromkeys(
                        str(member.get('vendorName') or '').strip() or 'Unassigned'
                        for member in line_unit
                    ))
                    vendor_name = (
                        vendor_names[0] if len(vendor_names) == 1
                        else 'Multiple vendors'
                    )
                    remarks = '\n'.join(dict.fromkeys(
                        str(member.get('remarks') or '').strip()
                        for member in line_unit
                        if str(member.get('remarks') or '').strip()
                    )) or '-'
                    group_title = _text(line.get('groupTitle') or 'Group')
                    item_flowables = []
                    for chunk_index, chunk in enumerate(
                        _group_display_entry_chunks(
                            _group_display_entries(line_unit)
                        )
                    ):
                        title_markup = _cjk_markup(
                            escape(
                                group_title
                                if chunk_index == 0
                                else f'{group_title} (continued)'
                            ),
                            bold=True,
                        )
                        child_markup = '<br/>'.join(
                            _cjk_markup(_escaped_line_breaks(
                                f"{entry['quantity']:g}x {entry['description']}"
                                if entry.get('showQuantity')
                                else entry['description']
                            ))
                            for entry in chunk
                        )
                        item_flowables.append(Paragraph(
                            f'<b>{title_markup}</b>'
                            + (f'<br/>{child_markup}' if child_markup else ''),
                            table_left,
                        ))
                else:
                    quantity = max(0, _number(line.get('quantity')))
                    unit_cost = max(0, _number(line.get('itemCost')))
                    cost_total = max(0, _number(line.get('costTotal')))
                    calculated = max(0, _number(line.get('calculatedSalePrice')))
                    sale_price = max(0, _number(line.get('salePrice')))
                    unit_price = _line_unit_price(line)
                    calculated_unit = _line_unit_price(line, 'calculatedSalePrice')
                    margin_percent_line = _number(line.get('targetMarginPercent'))
                    vendor_name = (
                        str(line.get('vendorName') or '').strip() or 'Unassigned'
                    )
                    remarks = line.get('remarks') or '-'
                    item_flowables = [
                        _paragraph(_line_item_text(line), table_left)
                    ]

                for flowable_index, item_flowable in enumerate(item_flowables):
                    first_row = flowable_index == 0
                    row = [
                        item_flowable,
                        _paragraph(_quantity(quantity) if first_row else '', table_center),
                        _paragraph(_quantity(multiplier) if first_row else '', table_center),
                        _paragraph(vendor_name if first_row else '', table_center),
                        _paragraph(remarks if first_row else '', table_left),
                        _paragraph(_money(unit_cost) if first_row else '', table_right),
                        _paragraph(_money(cost_total) if first_row else '', table_right),
                        _paragraph(
                            f'{margin_percent_line:,.2f}%\n{_money(calculated - cost_total)}'
                            if first_row else '',
                            table_right,
                        ),
                        _paragraph(_money(calculated) if first_row else '', table_right),
                        _paragraph(
                            f'{_money(unit_price)}\n{_comparison_text(unit_price, unit_cost)}'
                            if first_row else '',
                            table_right_bold,
                        ),
                        _paragraph(
                            f'{_money(sale_price)}\n{_comparison_text(sale_price, cost_total)}'
                            if first_row else '',
                            table_right_bold,
                        ),
                    ]
                    data.append(row)
                    if not first_row:
                        continue
                    row_index = len(data) - 1
                    vendor_background, vendor_text = _vendor_palette(vendor_name)
                    unit_state = _price_state(unit_price, unit_cost, calculated_unit)
                    sale_state = _price_state(sale_price, cost_total, calculated)
                    unit_background, unit_text = _price_palette(unit_state)
                    sale_background, sale_text = _price_palette(sale_state)
                    style_commands.extend([
                        ('BACKGROUND', (3, row_index), (3, row_index), vendor_background),
                        ('TEXTCOLOR', (3, row_index), (3, row_index), vendor_text),
                        ('BACKGROUND', (9, row_index), (9, row_index), unit_background),
                        ('TEXTCOLOR', (9, row_index), (9, row_index), unit_text),
                        ('BACKGROUND', (10, row_index), (10, row_index), sale_background),
                        ('TEXTCOLOR', (10, row_index), (10, row_index), sale_text),
                    ])

            adjustment = _number(total.get('adjustment'))
            data.append([
                _paragraph('Category subtotal', table_right_bold), '', '', '', '',
                _paragraph('Cost', label_style),
                _paragraph(_money(total.get('cost')), table_right_bold),
                _paragraph('Profit', label_style),
                _paragraph(_money(total.get('profit')), table_right_bold),
                _paragraph(
                    f"Charge{f'\n({_money(adjustment)} adj.)' if adjustment else ''}",
                    label_style,
                ),
                _paragraph(_money(total.get('charged')), table_right_bold),
            ])
            subtotal_row = len(data) - 1
            style_commands.extend([
                ('SPAN', (0, subtotal_row), (4, subtotal_row)),
                ('BACKGROUND', (0, subtotal_row), (-1, subtotal_row), colors.HexColor('#F8FAFC')),
                ('LINEABOVE', (0, subtotal_row), (-1, subtotal_row), 0.7, teal),
            ])
            category_table = LongTable(
                data,
                colWidths=column_widths,
                repeatRows=2,
                splitByRow=1,
                hAlign='CENTER',
                style=TableStyle(style_commands),
            )
            if pending_room_heading:
                story.append(pending_room_heading)
                pending_room_heading = None
            story.extend([category_table, Spacer(1, 2 * mm)])

    story.extend([PageBreak(), _paragraph('Summary', section_style)])
    category_rows = [[
        _paragraph(value, table_header)
        for value in ('ROOM', 'CATEGORY', 'COST', 'ADJUSTMENT', 'CLIENT CHARGE', 'PROFIT')
    ]]
    for room, categories in sections:
        room_id = str(room.get('id') or 'main')
        room_name = _text(room.get('name')).strip() or 'Main Room'
        for category, lines in categories.items():
            total = _category_total(costing, room_id, category, lines)
            category_rows.append([
                _paragraph(room_name, table_left),
                _paragraph(category, table_left),
                _paragraph(_money(total.get('cost')), table_right),
                _paragraph(_money(total.get('adjustment')), table_right),
                _paragraph(_money(total.get('charged')), table_right),
                _paragraph(_money(total.get('profit')), table_right_bold),
            ])
    category_rows.append([
        '', _paragraph('Overall total', table_right_bold),
        _paragraph(_money(totals.get('cost')), table_right_bold), '',
        _paragraph(_money(totals.get('sale')), table_right_bold),
        _paragraph(_money(totals.get('profit')), table_right_bold),
    ])
    summary_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), teal),
        ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#EEF4F7')),
        ('LINEABOVE', (0, -1), (-1, -1), 0.7, teal),
    ])
    story.extend([
        LongTable(
            category_rows,
            colWidths=[43 * mm, 70 * mm, 31 * mm, 31 * mm, 37 * mm, 35 * mm],
            repeatRows=1,
            hAlign='CENTER',
            style=summary_style,
        ),
        Spacer(1, 4 * mm),
        _paragraph('Cost by Vendor', section_style),
    ])

    vendor_management = {
        str(row.get('vendorName') or '').strip().casefold(): row
        for row in costing.get('vendorManagement') or []
        if isinstance(row, dict) and str(row.get('vendorName') or '').strip()
    }
    cost_by_vendor = OrderedDict()
    for line in costing.get('lineItems') or []:
        if not isinstance(line, dict):
            continue
        vendor_name = str(line.get('vendorName') or '').strip() or 'Unassigned'
        key = vendor_name.casefold()
        row = cost_by_vendor.setdefault(key, {
            'vendorName': vendor_name,
            'vendorType': str(line.get('vendorType') or 'vendor'),
            'itemCount': 0,
            'quantity': 0,
            'amount': 0,
        })
        row['itemCount'] += 1
        row['quantity'] += max(0, _number(line.get('quantity')))
        row['amount'] += max(0, _number(line.get('costTotal')))
    vendor_cost_rows = [[
        _paragraph(value, table_header)
        for value in ('VENDOR', 'TYPE', 'FULFILMENT', 'ITEM LINES', 'QUANTITY', 'COST')
    ]]
    vendor_cost_styles = [
        ('BACKGROUND', (0, 0), (-1, 0), teal),
        ('GRID', (0, 0), (-1, -1), 0.35, soft_rule),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]
    for row in cost_by_vendor.values():
        vendor_name = row['vendorName']
        management = vendor_management.get(vendor_name.casefold(), {})
        if vendor_name.casefold() == 'self':
            vendor_type = 'Internal'
            fulfilment = 'Self'
        elif vendor_name == 'Unassigned':
            vendor_type = '-'
            fulfilment = '-'
        else:
            vendor_type = str(
                management.get('vendorType') or row.get('vendorType') or 'vendor'
            ).replace('-', ' ').title()
            fulfilment = str(
                management.get('mode') or 'dry-hire'
            )
            fulfilment = (
                'Delivered' if fulfilment == 'outsourced' else 'Self Pickup'
            )
        vendor_cost_rows.append([
            _paragraph(vendor_name, table_left),
            _paragraph(vendor_type, table_center),
            _paragraph(fulfilment, table_center),
            _paragraph(_quantity(row.get('itemCount')), table_center),
            _paragraph(_quantity(row.get('quantity')), table_center),
            _paragraph(_money(row.get('amount')), table_right_bold),
        ])
        row_index = len(vendor_cost_rows) - 1
        background, foreground = _vendor_palette(vendor_name)
        vendor_cost_styles.extend([
            ('BACKGROUND', (0, row_index), (0, row_index), background),
            ('TEXTCOLOR', (0, row_index), (0, row_index), foreground),
        ])
    if not cost_by_vendor:
        vendor_cost_rows.append([
            _paragraph('No vendor costs in this costing.', small), '', '', '', '', ''
        ])
        vendor_cost_styles.append(('SPAN', (0, 1), (-1, 1)))
    vendor_cost_rows.append([
        _paragraph('Total cost', table_right_bold), '', '', '', '',
        _paragraph(
            _money(sum(row.get('amount', 0) for row in cost_by_vendor.values())),
            table_right_bold,
        ),
    ])
    total_vendor_row = len(vendor_cost_rows) - 1
    vendor_cost_styles.extend([
        ('SPAN', (0, total_vendor_row), (4, total_vendor_row)),
        ('BACKGROUND', (0, total_vendor_row), (-1, total_vendor_row), colors.HexColor('#EEF4F7')),
        ('LINEABOVE', (0, total_vendor_row), (-1, total_vendor_row), 0.7, teal),
    ])
    story.append(LongTable(
        vendor_cost_rows,
        colWidths=[58 * mm, 36 * mm, 43 * mm, 30 * mm, 30 * mm, 35 * mm],
        repeatRows=1,
        hAlign='CENTER',
        style=TableStyle(vendor_cost_styles),
    ))

    discrepancies = [
        row for row in costing.get('vendorDiscrepancies') or []
        if isinstance(row, dict)
    ]
    if discrepancies:
        discrepancy_rows = [[
            _paragraph('VENDOR TOTALS NEED REVIEW', table_header), '', '',
        ], [
            _paragraph('VENDOR', label_style),
            _paragraph('COSTING', label_style),
            _paragraph('MANPOWER & TRANSPORT', label_style),
        ]]
        for row in discrepancies:
            discrepancy_rows.append([
                _paragraph(row.get('vendorName') or 'Vendor', table_left),
                _paragraph(_money(row.get('expectedAmount')), table_right),
                _paragraph(
                    'Missing' if row.get('actualAmount') is None
                    else _money(row.get('actualAmount')),
                    table_right,
                ),
            ])
        story.extend([
            Spacer(1, 4 * mm),
            Table(
                discrepancy_rows,
                colWidths=[104 * mm, 64 * mm, 64 * mm],
                style=TableStyle([
                    ('SPAN', (0, 0), (-1, 0)),
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#B56A00')),
                    ('BACKGROUND', (0, 1), (-1, 1), colors.HexColor('#FFF7E6')),
                    ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#F0C36A')),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 4),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 4),
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
