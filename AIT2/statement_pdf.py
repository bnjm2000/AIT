"""Professional company-level statement of account PDF."""

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
    raw = str(value or "").strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").strftime("%d %B %Y").lstrip("0")
    except ValueError:
        return raw or "-"


def _money(value, currency="SGD"):
    symbol = "$" if str(currency or "SGD").upper() == "SGD" else f"{currency} "
    return f"{symbol}{float(value or 0):,.2f}"


def build_statement_of_account_pdf(payload, *, company=None, logo_path=""):
    """Return a polished statement covering all invoices for one company."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.platypus import (
        HRFlowable,
        LongTable,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    company = company or {}
    invoices = [row for row in payload.get("invoices") or [] if isinstance(row, dict)]
    currency = str(payload.get("currency") or company.get("currency") or "SGD").upper()
    account_company = _text(payload.get("accountCompany"), "Company")
    statement_date = str(payload.get("statementDate") or "")[:10]
    total_invoiced = sum(float(row.get("amount") or 0) for row in invoices)
    total_paid = sum(float(row.get("paid") or 0) for row in invoices)
    total_outstanding = sum(float(row.get("balance") or 0) for row in invoices)

    page_width, page_height = A4
    margin = 13 * mm
    accent_hex = _safe_colour(company.get("themeColor"), SHOWBASE_GREEN)
    header_hex = accent_hex if _contrast_colour(accent_hex) == "#FFFFFF" else _darken_colour(accent_hex)
    accent = colors.HexColor(accent_hex)
    header = colors.HexColor(header_hex)
    ink = colors.HexColor(SHOWBASE_INK)
    muted = colors.HexColor(SHOWBASE_MUTED)
    border = colors.HexColor("#94A3B8")
    light_border = colors.HexColor("#CBD5E1")
    panel = colors.HexColor("#F8FAFC")
    positive = colors.HexColor("#047857")
    buffer = BytesIO()
    issuer = _text(company.get("companyName") or company.get("name"), "Showbase")
    footer_text = str(company.get("footerText") or "").replace("\n", " | ").strip()
    letterhead_enabled = company.get("letterheadEnabled", True) is not False

    def draw_page(canvas, _doc):
        canvas.saveState()
        logo_drawn = False
        if logo_path and os.path.isfile(logo_path):
            try:
                image = ImageReader(logo_path)
                width, height = image.getSize()
                scale = min((40 * mm) / width, (12 * mm) / height)
                canvas.drawImage(
                    image, margin, page_height - 19 * mm,
                    width=width * scale, height=height * scale,
                    preserveAspectRatio=True, mask="auto",
                )
                logo_drawn = True
            except Exception:
                logo_drawn = False
        if logo_drawn and issuer:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(issuer, "Helvetica-Bold"), 8.8)
            canvas.drawRightString(
                page_width - margin, page_height - 10 * mm, issuer[:72]
            )
        if letterhead_enabled and not logo_drawn:
            canvas.setFillColor(ink)
            canvas.setFont(_canvas_font(issuer, "Helvetica-Bold"), 14)
            canvas.drawString(margin, page_height - 13 * mm, issuer[:55])
        canvas.setStrokeColor(light_border)
        canvas.setLineWidth(.55)
        canvas.line(margin, 12 * mm, page_width - margin, 12 * mm)
        canvas.setFillColor(muted)
        canvas.setFont(_canvas_font(footer_text or issuer, "Helvetica"), 6)
        canvas.drawString(margin, 7.5 * mm, (footer_text or issuer)[:160])
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
                self.setFont("Helvetica", 6)
                self.drawRightString(
                    page_width - margin, 7.5 * mm,
                    f"Page {page_number} of {page_count}",
                )
                self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=29 * mm,
        bottomMargin=18 * mm,
        title=f"Statement of Account - {account_company}",
        author=issuer,
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "SOATitle", parent=styles["Heading1"], fontName="Helvetica-Bold",
        fontSize=19, leading=22, textColor=ink, spaceAfter=2,
    )
    subtitle = ParagraphStyle(
        "SOASubtitle", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=7.5, leading=10, textColor=muted,
    )
    label = ParagraphStyle(
        "SOALabel", parent=subtitle, fontName="Helvetica-Bold", fontSize=6.3,
        leading=8, textColor=muted,
    )
    value = ParagraphStyle(
        "SOAValue", parent=styles["BodyText"], fontName="Helvetica-Bold",
        fontSize=9, leading=11, textColor=ink,
    )
    cell = ParagraphStyle(
        "SOACell", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=7, leading=8.5, textColor=ink,
    )
    cell_bold = ParagraphStyle("SOACellBold", parent=cell, fontName="Helvetica-Bold")
    cell_right = ParagraphStyle("SOACellRight", parent=cell, alignment=TA_RIGHT)
    cell_right_bold = ParagraphStyle(
        "SOACellRightBold", parent=cell_bold, alignment=TA_RIGHT,
    )
    table_header = ParagraphStyle(
        "SOATableHeader", parent=cell_bold, textColor=colors.white,
        alignment=TA_CENTER,
    )

    client = payload.get("client") if isinstance(payload.get("client"), dict) else {}
    address = [
        str(client.get(key) or "").strip()
        for key in ("address1", "address2", "address3", "postalCode")
        if str(client.get(key) or "").strip()
    ]
    recipient_markup = "<br/>".join(
        _cjk_markup(escape(item)) for item in [account_company, *address]
    )
    metadata = Table(
        [[
            [
                _paragraph("STATEMENT FOR", label),
                Paragraph(recipient_markup, value),
            ],
            [
                _paragraph("STATEMENT DATE", label),
                _paragraph(_date_label(statement_date), value),
                Spacer(1, 1.5 * mm),
                _paragraph("CURRENCY", label),
                _paragraph(currency, value),
            ],
        ]],
        colWidths=[doc.width * .62, doc.width * .38],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), panel),
            ("BOX", (0, 0), (-1, -1), .8, border),
            ("INNERGRID", (0, 0), (-1, -1), .5, light_border),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 9),
            ("RIGHTPADDING", (0, 0), (-1, -1), 9),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]),
    )

    def summary_box(summary_label, amount, colour=ink):
        amount_style = ParagraphStyle(
            f"SOASummary{summary_label}", parent=value, fontSize=13,
            leading=15, textColor=colour, alignment=TA_RIGHT,
        )
        return [
            _paragraph(summary_label.upper(), label),
            _paragraph(_money(amount, currency), amount_style),
        ]

    summary = Table(
        [[
            summary_box("Total invoiced", total_invoiced),
            summary_box("Payments received", total_paid, positive),
            summary_box("Balance outstanding", total_outstanding, accent),
        ]],
        colWidths=[doc.width / 3] * 3,
        style=TableStyle([
            ("BOX", (0, 0), (-1, -1), .8, border),
            ("INNERGRID", (0, 0), (-1, -1), .5, light_border),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]),
    )

    table_rows = [[
        _paragraph("Invoice date", table_header),
        _paragraph("Invoice number", table_header),
        _paragraph("Project / reference", table_header),
        _paragraph("Due date", table_header),
        _paragraph("Invoice amount", table_header),
        _paragraph("Paid", table_header),
        _paragraph("Balance", table_header),
    ]]
    for row in invoices:
        project_parts = [
            _text(row.get("project"), "Untitled project"),
            str(row.get("reference") or "").strip(),
        ]
        project_markup = "<b>" + _cjk_markup(escape(project_parts[0])) + "</b>"
        if project_parts[1]:
            project_markup += (
                '<br/><font color="#64748B" size="6">'
                + _cjk_markup(escape(project_parts[1])) + "</font>"
            )
        table_rows.append([
            _paragraph(_date_label(row.get("invoiceDate")), cell),
            _paragraph(_text(row.get("number"), ""), cell_bold),
            Paragraph(project_markup, cell),
            _paragraph(_date_label(row.get("dueDate")), cell),
            _paragraph(_money(row.get("amount"), currency), cell_right),
            _paragraph(_money(row.get("paid"), currency), cell_right),
            _paragraph(_money(row.get("balance"), currency), cell_right_bold),
        ])
    if not invoices:
        table_rows.append([_paragraph("No invoices as at this statement date.", cell)] + [""] * 6)

    invoice_table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), header),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BOX", (0, 0), (-1, -1), .9, border),
        ("INNERGRID", (0, 0), (-1, -1), .5, light_border),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("BACKGROUND", (0, 2), (-1, -1), colors.HexColor("#FBFDFF")),
    ]
    if not invoices:
        invoice_table_style.append(("SPAN", (0, 1), (-1, 1)))
    invoice_table = LongTable(
        table_rows,
        colWidths=[21 * mm, 26 * mm, 47 * mm, 21 * mm, 23 * mm, 22 * mm, 24 * mm],
        repeatRows=1,
        style=TableStyle(invoice_table_style),
    )

    note = (
        f"This statement includes invoices and payments recorded up to "
        f"{_date_label(statement_date)}. Please quote the invoice number when making payment."
    )
    story = [
        _paragraph("STATEMENT OF ACCOUNT", title),
        _paragraph(f"Account activity for {account_company}", subtitle),
        HRFlowable(width="100%", thickness=.8, color=accent),
        Spacer(1, 4 * mm),
        metadata,
        Spacer(1, 4 * mm),
        summary,
        Spacer(1, 5 * mm),
        invoice_table,
        Spacer(1, 4 * mm),
        _paragraph(note, subtitle),
    ]
    doc.build(
        story,
        onFirstPage=draw_page,
        onLaterPages=draw_page,
        canvasmaker=NumberedCanvas,
    )
    return buffer.getvalue()
