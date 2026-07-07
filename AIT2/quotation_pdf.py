"""Print-ready quotation and invoice PDF rendering."""

from io import BytesIO
from html import escape
import os
import re


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
    return Paragraph(safe, style)


def _money(value, currency='SGD'):
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0
    sign = '-' if amount < 0 else ''
    return f"{sign}${abs(amount):,.2f}"


def _date(value):
    from datetime import datetime

    raw = str(value or '').strip()
    try:
        return datetime.strptime(raw, '%Y-%m-%d').strftime('%d %b %Y')
    except ValueError:
        return raw


def build_finance_pdf(document, company, logo_path=''):
    """Return an A4 quotation/invoice as PDF bytes."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        HRFlowable,
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
    accent = colors.HexColor('#4338CA')
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
        textColor=accent,
        alignment=TA_RIGHT,
    )
    right = ParagraphStyle('FinanceRight', parent=body, alignment=TA_RIGHT)
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
    company_lines = [
        _text(company.get('companyName')),
        f"UEN / Reg No: {_text(company.get('registrationNumber'))}" if company.get('registrationNumber') else '',
        _text(company.get('billingAddress')),
        ' | '.join(
            value for value in (
                _text(company.get('phone')),
                _text(company.get('email')),
                _text(company.get('website')),
            ) if value
        ),
    ]
    company_lines = [line for line in company_lines if line]

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
        if not logo_drawn:
            canvas.setFont('Helvetica-Bold', 15)
            canvas.setFillColor(ink)
            canvas.drawString(margin, page_height - 14 * mm, _text(company.get('companyName'))[:34])

        canvas.setFillColor(muted)
        canvas.setFont('Helvetica', 6.6)
        y = page_height - 10 * mm
        for line in company_lines[:4]:
            canvas.drawRightString(page_width - margin, y, line[:100])
            y -= 3.2 * mm

        canvas.setStrokeColor(rule)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 14 * mm, page_width - margin, 14 * mm)
        canvas.setFillColor(muted)
        canvas.setFont('Helvetica', 6.2)
        footer_line = footer_text.replace('\n', ' | ') if footer_text else company_lines[0] if company_lines else ''
        canvas.drawString(margin, 9 * mm, footer_line[:125])
        canvas.drawRightString(
            page_width - margin,
            9 * mm,
            f"Page {pdf_doc.page}",
        )
        canvas.restoreState()

    document_type = str(document.get('type') or 'quotation').lower()
    title = 'INVOICE' if document_type == 'invoice' else 'QUOTATION'
    currency = _text(document.get('currency') or company.get('currency') or 'SGD')
    totals = document.get('totals') or {}
    client = document.get('client') or {}
    lines = document.get('lineItems') or []
    adjustments = document.get('adjustments') or []

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

    bill_lines = [
        client.get('name') or client.get('contactPerson'),
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
        secondary_label, secondary_value = 'Valid until', document.get('validUntil')

    meta_rows = [
        [_paragraph(date_label, label), _paragraph(_date(date_value), body)],
        [_paragraph(secondary_label, label), _paragraph(_date(secondary_value), body)],
        [_paragraph('Reference', label), _paragraph(document.get('reference'), body)],
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
        ('Set-up', 'setupDate'),
        ('Rehearsal', 'rehearsalDate'),
        ('Show', 'showDate'),
        ('Teardown', 'teardownDate'),
    ):
        if document.get(key):
            value = document[key]
            if key.endswith('Date'):
                time_key = key.replace('Date', 'Time')
                value = _date(value)
                if document.get(time_key):
                    value = f"{value} {document[time_key]}"
            event_bits.append(f"<b>{escape(event_label)}:</b> {escape(_text(value))}")
    if event_bits:
        event_panel = Table(
            [[Paragraph('<br/>'.join(event_bits), body)]],
            colWidths=[doc.width],
            style=TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), panel),
                ('BOX', (0, 0), (-1, -1), 0.5, rule),
                ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
                ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3 * mm),
            ]),
        )
        story.extend([event_panel, Spacer(1, 4 * mm)])

    story.append(_paragraph('LINE ITEMS', section_title))
    departments = []
    for department in document.get('departments') or []:
        department = str(department or '').strip()
        if department and department not in departments:
            departments.append(department)
    for line in lines:
        department = str(line.get('department') or 'General').strip() or 'General'
        if department not in departments:
            departments.append(department)

    show_unit_prices = bool(document.get('showUnitPrices'))
    show_department_discounts = bool(document.get('showDepartmentDiscounts'))
    column_widths = [
        8 * mm,
        43 * mm,
        28 * mm,
        13 * mm,
        12 * mm,
        14 * mm,
        23 * mm,
        14 * mm,
        29 * mm,
    ]

    for department in departments:
        department_lines = [
            line for line in lines
            if (str(line.get('department') or 'General').strip() or 'General') == department
        ]
        if not department_lines:
            continue
        department_total = sum(float(line.get('total') or 0) for line in department_lines)
        department_adjustments = [
            row for row in adjustments
            if row.get('scope') == 'department' and row.get('department') == department
        ]
        department_total += sum(float(row.get('amount') or 0) for row in department_adjustments)
        table_rows = [
            [
                _paragraph('#', label),
                _paragraph('DESCRIPTION', label),
                _paragraph('DEPARTMENT', label),
                _paragraph('DAYS', label),
                _paragraph('QTY', label),
                _paragraph('UOM', label),
                _paragraph('UNIT PRICE', label),
                _paragraph('DISC %', label),
                _paragraph('TOTAL', label),
            ],
            [
                _paragraph(
                    department,
                    ParagraphStyle(
                        f"Department-{len(story)}",
                        parent=body,
                        fontName='Helvetica-Bold',
                    ),
                ),
                '', '', '', '', '', '', '', '',
            ],
        ]
        row_styles = [
            ('BACKGROUND', (0, 0), (-1, 0), ink),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('BACKGROUND', (0, 1), (-1, 1), panel),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, 1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, 1), 5),
            ('GRID', (0, 0), (-1, -1), 0.35, rule),
        ]

        for line_index, line in enumerate(department_lines, start=1):
            description = _text(line.get('description'))
            table_rows.append([
                _paragraph(str(line_index), right),
                _paragraph(description, body),
                _paragraph(department, body),
                _paragraph(f"{float(line.get('days') or 0):g}", right),
                _paragraph(f"{float(line.get('quantity') or 0):g}", right),
                _paragraph('unit(s)' if line.get('uom') == 'units' else line.get('uom'), body),
                _paragraph(_money(line.get('unitPrice'), currency) if show_unit_prices else '', right),
                _paragraph(
                    f"{float(line.get('discountPercent') or 0):g}%"
                    if show_unit_prices and float(line.get('discountPercent') or 0)
                    else '',
                    right,
                ),
                _paragraph(_money(line.get('total'), currency) if show_unit_prices else '', right),
            ])

        if show_department_discounts:
            for adjustment in department_adjustments:
                adjustment_index = len(table_rows)
                table_rows.append([
                    '',
                    _paragraph(adjustment.get('label') or 'Department discount', body),
                    '', '', '', '', '', '',
                    _paragraph(_money(adjustment.get('amount'), currency), right),
                ])
                row_styles.extend([
                    ('SPAN', (1, adjustment_index), (7, adjustment_index)),
                    ('TEXTCOLOR', (1, adjustment_index), (-1, adjustment_index), success),
                    ('BACKGROUND', (0, adjustment_index), (-1, adjustment_index), colors.HexColor('#ECFDF5')),
                ])

        subtotal_index = len(table_rows)
        table_rows.append([
            '',
            _paragraph(f"{department} subtotal", right_bold),
            '', '', '', '', '', '',
            _paragraph(_money(department_total, currency), right_bold),
        ])
        row_styles.extend([
            ('SPAN', (1, subtotal_index), (7, subtotal_index)),
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
        story.extend([table_flowable, Spacer(1, 3 * mm)])

    tax_label = _text(company.get('taxLabel') or 'Tax')
    tax_rate = float(document.get('taxRate') or 0)
    summary_rows = [
        [_paragraph('Total before GST', body), _paragraph(_money(totals.get('netSubtotal'), currency), right)],
    ]
    summary_rows.extend([
        [_paragraph(f"{tax_label} ({tax_rate:g}%)", body), _paragraph(_money(totals.get('tax'), currency), right)],
        [_paragraph('TOTAL', ParagraphStyle('TotalLabel', parent=body, fontName='Helvetica-Bold', fontSize=10.5)),
         _paragraph(_money(totals.get('total'), currency), ParagraphStyle('TotalAmount', parent=right_bold, fontSize=11, textColor=accent))],
    ])
    summary = Table(
        summary_rows,
        colWidths=[56 * mm, 40 * mm],
        hAlign='RIGHT',
        style=TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('LINEABOVE', (0, -1), (-1, -1), 1, ink),
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
    if payment_lines:
        story.append(KeepTogether([
            _paragraph('PAYMENT DETAILS', section_title),
            Paragraph('<br/>'.join(payment_lines), body),
        ]))
    if terms:
        story.append(KeepTogether([
            _paragraph('TERMS AND CONDITIONS', section_title),
            _paragraph(terms, small),
        ]))

    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)
    return buffer.getvalue()


def safe_pdf_filename(number, fallback='document'):
    value = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(number or fallback)).strip('._')
    return f"{value or fallback}.pdf"
