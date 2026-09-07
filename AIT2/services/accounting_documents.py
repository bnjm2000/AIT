"""Saved accounting document previews and portable, paginated PDF copies."""
from __future__ import annotations

import io
import re
from pathlib import Path
from decimal import Decimal
from html import escape

from pdf_fonts import pdf_font_names
from services.accounting_workspace import KINDS, dec, money, snapshot_document_parties


TAX_LABELS = {'SR9': 'Standard-rated 9%', 'ZR': 'Zero-rated 0%', 'ES': 'Exempt',
              'OP': 'Outside scope', 'TX9': 'Input GST 9%', 'TX0': 'No input GST',
              'BL9': 'Non-claimable GST 9%', 'BL': 'Non-claimable cost'}


def document_view(store, document):
    party = document.get('partySnapshot') or snapshot_document_parties(store, document)
    tax_invoice = document['kind'] == 'invoice' and party.get('gstRegistered')
    title = 'Tax Invoice' if tax_invoice else KINDS[document['kind']]
    status = document['status']
    warnings = []
    if status not in {'posted', 'approved'}:
        warnings.append(f'{status.upper()} - review copy; not for issue')
    required = [('businessName', 'supplier business name'), ('businessAddress', 'supplier address')]
    if tax_invoice:
        required += [('gstRegistrationNumber', 'GST registration number'), ('contactAddress', 'customer address')]
    missing = [label for key, label in required if not str(party.get(key) or '').strip()]
    if missing:
        warnings.append('INCOMPLETE - missing ' + ', '.join(missing) + '. Complete the document details before issue.')
    if status in {'posted', 'approved'} and (not document.get('partySnapshot') or party.get('capturedAtAdoption')):
        warnings.append('Historical document: business/contact details were captured after the original issue. Verify against the retained original.')
    if document['kind'] in {'credit_note', 'vendor_credit'} and not document.get('reference'):
        warnings.append('Add the original invoice reference and date or retain evidence linking this credit to the original supply.')
    groups = {}
    base_net = base_tax = Decimal(0)
    for row in document['lines']:
        group = groups.setdefault(row['taxCode'], {'net': Decimal(0), 'tax': Decimal(0)})
        group['net'] += dec(row['net'])
        group['tax'] += dec(row['tax'])
        # Same conversion and rounding as the posted journal, including mixed supplies.
        base_net += dec(money(dec(row['net']) * dec(document['exchangeRate'])))
        base_tax += dec(money(dec(row['tax']) * dec(document['exchangeRate'])))
    return dict(document=document, party=party, title=title, warnings=warnings,
                supplyGroups=[dict(code=code, label=TAX_LABELS.get(code, code), net=money(g['net']),
                                   tax=money(g['tax']), total=money(g['net'] + g['tax'])) for code, g in groups.items()],
                baseNet=money(base_net), baseTax=money(base_tax), baseTotal=money(base_net + base_tax))


def amount(value):
    return f'{money(value):,.2f}'


def document_html(view):
    d, p = view['document'], view['party']
    e = lambda value: escape(str(value or ''), quote=True).replace('\n', '<br>')
    heading = f'<header><strong>{e(p.get("businessName"))}</strong><p>{e(p.get("businessAddress"))}</p><p>UEN: {e(p.get("uen"))}'
    if p.get('gstRegistered'):
        heading += f' | GST Reg. No.: {e(p.get("gstRegistrationNumber"))}'
    heading += f'</p><h3>{e(view["title"])} {e(d["number"])}</h3></header>'
    warnings = ''.join(f'<p class="ac-document-warning">{e(w)}</p>' for w in view['warnings'])
    due_label = 'Valid until' if d['kind'] in {'quote', 'purchase_order'} else 'Due date'
    details = f'<p><strong>{e(p.get("contactName") or d["contact"])}</strong><br>{e(p.get("contactAddress"))}</p><p>Date: {e(d["date"])} | {due_label}: {e(d["dueDate"])} | Currency: {e(d["currency"])}</p><p>Reference: {e(d.get("reference"))}</p>'
    rows = ''.join(f'<tr><td>{e(r["description"])}</td><td class="money">{e(r["quantity"])}</td><td class="money">{amount(r["unitPrice"])}</td><td>{e(TAX_LABELS.get(r["taxCode"], r["taxCode"]))}</td><td class="money">{amount(r["net"])}</td><td class="money">{amount(r["tax"])}</td></tr>' for r in d['lines'])
    table = '<table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>GST treatment</th><th>Excl. GST</th><th>GST</th></tr></thead><tbody>' + rows + '</tbody></table>'
    groups = '<h4>Supply summary</h4><table><thead><tr><th>Supply / tax treatment</th><th>Excl. GST</th><th>GST</th><th>Incl. GST</th></tr></thead><tbody>'
    groups += ''.join(f'<tr><td>{e(g["label"])}</td><td class="money">{amount(g["net"])}</td><td class="money">{amount(g["tax"])}</td><td class="money">{amount(g["total"])}</td></tr>' for g in view['supplyGroups']) + '</tbody></table>'
    totals = f'<div class="ac-document-total"><p>Total excluding GST: {e(d["currency"])} {amount(d["net"])}</p><p>Total GST: {e(d["currency"])} {amount(d["tax"])}</p><strong>Total including GST: {e(d["currency"])} {amount(d["total"])}</strong>'
    if d['currency'] != 'SGD':
        totals += f'<p>SGD per {e(d["currency"])} 1: {e(d["exchangeRate"])}</p><p>Total excluding GST: SGD {amount(view["baseNet"])}</p><p>Total GST: SGD {amount(view["baseTax"])}</p><strong>Total including GST: SGD {amount(view["baseTotal"])}</strong>'
    totals += '</div>'
    return '<article class="ac-document-preview">' + heading + warnings + details + f'<p>Unit prices {"include" if d.get("priceBasis") == "inclusive" else "exclude"} GST.</p>' + table + groups + totals + f'<p>{e(d.get("notes"))}</p></article>'


def document_pdf(view, company=None):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    import reportlab

    font = 'AccountingSans'
    font_bold = font + 'Bold'
    if font not in pdfmetrics.getRegisteredFontNames():
        fonts = Path(reportlab.__file__).parent / 'fonts'
        pdfmetrics.registerFont(TTFont(font, str(fonts / 'Vera.ttf')))
        pdfmetrics.registerFont(TTFont(font_bold, str(fonts / 'VeraBd.ttf')))
    if 'STSong-Light' not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    font, font_bold = pdf_font_names(company, default=(font, font_bold))
    body = ParagraphStyle('AccountingBody', fontName=font, fontSize=10, leading=14, spaceAfter=5)
    small = ParagraphStyle('AccountingSmall', parent=body, fontSize=8, leading=11)
    right = ParagraphStyle('AccountingAmount', parent=small, alignment=TA_RIGHT)
    title = ParagraphStyle('AccountingTitle', parent=body, fontName=font_bold, fontSize=18, leading=24, spaceAfter=10)
    def para(value, style=body):
        text = escape(str(value or '')).replace('\n', '<br/>')
        text = re.sub(r'[\u2e80-\u9fff]+', lambda match: '<font name="STSong-Light">' + match.group() + '</font>', text)
        return Paragraph(text, style)
    d, p = view['document'], view['party']
    output = io.BytesIO()
    pdf = SimpleDocTemplate(output, pagesize=A4, rightMargin=17*mm, leftMargin=17*mm,
                            topMargin=22*mm, bottomMargin=18*mm, title=f'{view["title"]} {d["number"]}',
                            author=p.get('businessName', ''))
    story = [para(p.get('businessName'), title), para(p.get('businessAddress')),
             para(' | '.join(v for v in ['UEN: ' + p['uen'] if p.get('uen') else '', 'GST Reg. No.: ' + p['gstRegistrationNumber'] if p.get('gstRegistered') and p.get('gstRegistrationNumber') else '']), small),
             Spacer(1, 6*mm), para(f'{view["title"]} {d["number"]}', title)]
    story += [para(w) for w in view['warnings']]
    story += [para(p.get('contactName') or d['contact']), para(p.get('contactAddress')),
              para(f'Date: {d["date"]} | {"Valid until" if d["kind"] in {"quote", "purchase_order"} else "Due date"}: {d["dueDate"]} | Currency: {d["currency"]}', small),
              para('Reference: ' + d.get('reference', ''), small),
              para('Unit prices ' + ('include' if d.get('priceBasis') == 'inclusive' else 'exclude') + ' GST.', small), Spacer(1, 4*mm)]
    def table(rows, widths):
        result = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
        result.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e8f2ee')),
                                  ('LINEBELOW',(0,0),(-1,-1),0.35,colors.HexColor('#cedbd5')),
                                  ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
        return result
    headers = [para(v,small) for v in ['Description','Qty','Unit price','GST treatment','Excl. GST','GST']]
    short_tax = {'SR9':'9% standard', 'ZR':'0% zero-rated', 'TX9':'9% input', 'BL9':'9% blocked'}
    rows = [headers] + [[para(r['description'],small), para(r['quantity'],right), para(amount(r['unitPrice']),right),
                        para(short_tax.get(r['taxCode'],TAX_LABELS.get(r['taxCode'],r['taxCode'])),small), para(amount(r['net']),right), para(amount(r['tax']),right)] for r in d['lines']]
    story.append(table(rows,[57*mm,12*mm,24*mm,35*mm,25*mm,23*mm]))
    closing = [Spacer(1,6*mm), para('Supply summary')]
    rows = [[para(v,small) for v in ['Supply / tax treatment','Excl. GST','GST','Incl. GST']]]
    rows += [[para(g['label'],small),para(amount(g['net']),right),para(amount(g['tax']),right),para(amount(g['total']),right)] for g in view['supplyGroups']]
    closing.append(table(rows,[80*mm,32*mm,32*mm,32*mm]))
    totals = [Spacer(1,4*mm)]
    for label, value in [('Total excluding GST',d['net']),('Total GST',d['tax']),('Total including GST',d['total'])]:
        totals.append(para(f'{label}: {d["currency"]} {amount(value)}'))
    if d['currency'] != 'SGD':
        totals.append(para(f'SGD per {d["currency"]} 1: {d["exchangeRate"]}',small))
        for label, key in [('Total excluding GST','baseNet'),('Total GST','baseTax'),('Total including GST','baseTotal')]:
            totals.append(para(f'{label}: SGD {amount(view[key])}'))
    story += [KeepTogether(closing + totals),Spacer(1,5*mm),para(d.get('notes',''))]
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont(font,8)
        if doc.page > 1:
            canvas.drawString(17*mm,A4[1]-12*mm,'Document continuation')
            canvas.drawRightString(A4[0]-17*mm,A4[1]-12*mm,d['number'][:80])
        canvas.drawString(17*mm,10*mm,d['number'][:80])
        canvas.drawRightString(A4[0]-17*mm,10*mm,f'Page {doc.page}')
        canvas.restoreState()
    pdf.build(story,onFirstPage=footer,onLaterPages=footer)
    output.seek(0)
    return output
