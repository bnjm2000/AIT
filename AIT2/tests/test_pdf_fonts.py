import inspect
import io
from pathlib import Path

from pypdf import PdfReader

import app as app_module
from costing_pdf import build_costing_pdf
from event_report import build_event_report_pdf
from pdf_fonts import pdf_font_names
from pdf_rich_text import (
    normalise_pdf_terms_html,
    plain_text_to_rich_html,
    rich_text_to_plain_text,
    rich_text_to_reportlab_flowables,
    rich_text_to_reportlab_markup,
    sanitise_pdf_rich_text,
)
from profit_loss_pdf import build_profit_loss_pdf
from quotation_pdf import build_finance_pdf, build_payment_receipt_pdf
from services.accounting_documents import document_pdf
from statement_pdf import build_statement_of_account_pdf
from workforce_schedule import (
    build_worker_period_schedule_pdf,
    build_workforce_schedule_pdf,
)


def test_font_selection_is_persisted_instead_of_inferred_from_company_code():
    assert app_module._normalise_pdf_settings({}, 'AVERY')['fontFamily'] == 'App Default'
    assert app_module._normalise_pdf_settings({}, 'AVPL')['fontFamily'] == 'App Default'
    assert app_module._normalise_pdf_settings(
        {'fontFamily': 'Avenir Next'}, 'AVERY'
    )['fontFamily'] == 'Avenir Next'
    assert '"fontFamily": "Avenir Next"' in Path(
        'companies/AVERY/backend/PdfSettings.json'
    ).read_text(encoding='utf-8')
    assert pdf_font_names({'fontFamily': 'Avenir Next'}) == (
        'ShowbaseAvenirNext',
        'ShowbaseAvenirNextBold',
    )
    assert pdf_font_names({'companyCode': 'AVPL'}) == (
        'Helvetica',
        'Helvetica-Bold',
    )


def test_every_reportlab_pdf_builder_uses_the_company_font_resolver():
    builders = (
        build_finance_pdf,
        build_payment_receipt_pdf,
        build_event_report_pdf,
        build_profit_loss_pdf,
        build_costing_pdf,
        build_statement_of_account_pdf,
        build_workforce_schedule_pdf,
        build_worker_period_schedule_pdf,
        document_pdf,
    )
    for builder in builders:
        source = inspect.getsource(builder)
        assert 'pdf_font_names(company' in source, builder.__name__
        assert 'fontName="Helvetica' not in source, builder.__name__
        assert "fontName='Helvetica" not in source, builder.__name__
        assert 'setFont("Helvetica' not in source, builder.__name__
        assert "setFont('Helvetica" not in source, builder.__name__


def test_avery_finance_pdf_embeds_and_uses_regular_and_bold_avenir():
    pdf = build_finance_pdf({
        'type': 'quotation',
        'number': 'QT-AVERY-FONT',
        'projectName': 'Avenir Font QA',
        'quotationDate': '2026-09-07',
        'lineItems': [{
            'id': 'line-1',
            'description': 'Avenir regular body',
            'department': 'Audio',
            'quantity': 1,
            'days': 1,
            'unitPrice': 125,
            'total': 125,
            'subprojectId': 'main',
        }],
        'subprojects': [{'id': 'main', 'name': 'Main Room'}],
        'totals': {'netSubtotal': 125, 'tax': 0, 'total': 125},
    }, {
        'fontFamily': 'Avenir Next',
        'companyName': 'Avery Events and Exhibitions Pte Ltd',
        'currency': 'SGD',
        'themeColor': '#0f766e',
    })
    reader = PdfReader(io.BytesIO(pdf))
    used_fonts = set()

    def collect_font(text, _cm, _tm, font, _size):
        if text.strip() and font:
            used_fonts.add(str(font.get('/BaseFont') or ''))

    for page in reader.pages:
        page.extract_text(visitor_text=collect_font)

    assert any('AvenirNextCyr-Regular' in name for name in used_fonts)
    assert any('AvenirNextCyr-Bold' in name for name in used_fonts)
    assert all('AvenirNextCyr-' in name for name in used_fonts)


def test_browser_print_exports_load_avery_before_measuring_and_printing():
    scripts = Path('static/js')
    app_source = (scripts / 'app.js').read_text(encoding='utf-8')
    assert "companyCode === 'AVERY'" not in app_source
    assert 'PDF_FONT_OPTIONS' in app_source
    assert 'pdfSettings?.fontFamily' in app_source
    assert 'AvenirNextCyr-Regular.ttf' in app_source
    assert 'AvenirNextCyr-Bold.ttf' in app_source
    assert 'async function ensurePdfExportFontReady' in app_source

    for filename in (
        'delivery-order.js',
        'inventory-export.js',
        'packing-list.js',
        'transfer.js',
    ):
        source = (scripts / filename).read_text(encoding='utf-8')
        assert 'PDF_EXPORT_FONT_FAMILY' in source, filename
        assert 'ensurePdfExportFontReady(document)' in source, filename
        assert 'ensurePdfExportFontReady(' in source, filename


def test_typography_settings_are_validated_and_finance_pdf_accepts_them():
    settings = app_module._normalise_pdf_settings({
        'fontFamily': 'Georgia',
        'letterheadTypography': {
            'fontFamily': 'Arial', 'fontSize': 14,
            'bold': True, 'italic': True, 'underline': True,
        },
        'footerTypography': {'fontFamily': 'Not A Font', 'fontSize': 80},
    }, 'AVPL')
    assert settings['fontFamily'] == 'Georgia'
    assert settings['letterheadTypography'] == {
        'fontFamily': 'Arial', 'fontSize': 14.0,
        'bold': True, 'italic': True, 'underline': True,
    }
    assert settings['footerTypography']['fontFamily'] == 'App Default'
    assert settings['footerTypography']['fontSize'] == 0


def test_company_details_exposes_font_previews_formatting_and_pdf_preview():
    settings_source = Path('static/js/admin-settings.js').read_text(encoding='utf-8')
    app_source = Path('static/js/app.js').read_text(encoding='utf-8')
    select_source = Path('static/js/custom-select.js').read_text(encoding='utf-8')
    assert "companyTypographyEditorHtml('letterhead'" in settings_source
    assert "companyTypographyEditorHtml('paymentDetails'" in settings_source
    assert "companyTypographyEditorHtml('terms'" in settings_source
    assert "companyTypographyEditorHtml('footer'" in settings_source
    assert 'PDF document font' in settings_source
    assert 'Preview PDF' in settings_source
    assert 'Contact your administrator to request it' in settings_source
    assert '/api/pdf-settings/preview' in settings_source
    assert 'data-font-preview' in app_source
    assert 'option.dataset.fontPreview' in select_source
    assert 'contenteditable="true"' in settings_source
    assert 'applyCompanyRichTextStyle' in settings_source
    assert 'applyCompanyListStyle' in settings_source
    assert 'normaliseCompanyTermsListsHtml' in settings_source
    assert 'Bulleted list' in settings_source
    assert 'Numbered list' in settings_source
    assert "'color',this.value" in settings_source
    assert 'range.extractContents()' in settings_source


def test_rich_text_sanitizer_preserves_only_supported_inline_typography():
    clean = sanitise_pdf_rich_text(
        '<div onclick="steal()"><strong>First row</strong> '
        '<span style="font-family:Georgia;font-size:14pt;color:#cc1122;position:fixed">'
        'selected words</span><img src=x onerror=steal()></div>'
    )
    assert clean == (
        '<div><strong>First row</strong> '
        '<span style="font-family:Georgia;font-size:14pt;color:#cc1122">'
        'selected words</span></div>'
    )
    assert rich_text_to_plain_text(clean) == 'First row selected words'
    markup = rich_text_to_reportlab_markup(clean, default_family='Avenir Next')
    assert 'ShowbaseAvenirNextBold' in markup
    assert 'ShowbaseGeorgia' in markup
    assert 'color="#cc1122"' in markup
    assert 'size="14"' in markup


def test_legacy_letterhead_is_upgraded_with_a_bold_first_row():
    settings = app_module._normalise_pdf_settings({
        'letterheadText': 'Example Company Pte Ltd\nUEN: 202600001A\nSingapore',
    }, 'AVPL')
    assert settings['letterheadHtml'].startswith(
        '<div><strong>Example Company Pte Ltd</strong></div>'
    )
    assert rich_text_to_plain_text(settings['letterheadHtml']) == settings['letterheadText']


def test_terms_recognise_typed_numbered_and_bulleted_lines():
    html = normalise_pdf_terms_html(
        '<div>1. First numbered clause</div>'
        '<div>2) <strong>Second clause</strong> with detail</div>'
        '<div>Ordinary paragraph</div>'
        '<div>- First bullet with a long continuation</div>'
        '<div>\u2022 Second bullet</div>'
    )
    assert html == (
        '<ol><li>First numbered clause</li>'
        '<li><strong>Second clause</strong> with detail</li></ol>'
        '<div>Ordinary paragraph</div>'
        '<ul><li>First bullet with a long continuation</li>'
        '<li>Second bullet</li></ul>'
    )
    assert rich_text_to_plain_text(html) == (
        '1. First numbered clause\n'
        '2. Second clause with detail\n'
        'Ordinary paragraph\n'
        '- First bullet with a long continuation\n'
        '- Second bullet'
    )
    assert plain_text_to_rich_html(
        '3. Starts at three\n4. Continues at four', recognise_lists=True
    ) == '<ol start="3"><li>Starts at three</li><li>Continues at four</li></ol>'


def test_terms_attach_manually_wrapped_indented_lines_to_the_list_item():
    html = normalise_pdf_terms_html(
        '<div>3. Balance is due within 14 days from the date of </div>'
        '<div>     the invoice.</div>'
        '<div>4. All items are for indoor use.</div>'
        '<div>6. T/T to OCBC Bank Limited.</div>'
        '<div>     Account Number: 601-546195-001.</div>'
    )
    assert html == (
        '<ol start="3">'
        '<li>Balance is due within 14 days from the date of <br>the invoice.</li>'
        '<li>All items are for indoor use.</li>'
        '</ol>'
        '<ol start="6">'
        '<li>T/T to OCBC Bank Limited.<br>Account Number: 601-546195-001.</li>'
        '</ol>'
    )
    assert sanitise_pdf_rich_text(html) == html
    assert rich_text_to_plain_text(html) == (
        '3. Balance is due within 14 days from the date of \n'
        'the invoice.\n'
        '4. All items are for indoor use.\n'
        '6. T/T to OCBC Bank Limited.\n'
        'Account Number: 601-546195-001.'
    )


def test_terms_reportlab_flowables_use_hanging_indents_for_lists():
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.styles import ParagraphStyle

    style = ParagraphStyle(
        'TermsListTest', fontName='Helvetica', fontSize=8,
        leading=10, alignment=TA_LEFT, textColor=colors.HexColor('#334455'),
    )
    flowables = rich_text_to_reportlab_flowables(
        '<div>9. A numbered clause that can wrap onto another line.</div>'
        '<div>10. The next numbered clause also wraps cleanly.</div>'
        '<div>- A bullet point that can wrap cleanly.</div>',
        style,
        recognise_lists=True,
    )
    assert [flowable.bulletText for flowable in flowables] == ['9.', '10.', '\u2022']
    assert all(flowable.style.alignment == TA_LEFT for flowable in flowables)
    assert all(flowable.style.bulletIndent > 0 for flowable in flowables)
    assert all(flowable.style.leftIndent > flowable.style.bulletIndent for flowable in flowables)
    assert all(flowable.style.bulletFontName == style.fontName for flowable in flowables)
    assert all(flowable.style.bulletFontSize == style.fontSize for flowable in flowables)
    assert all(flowable.style.bulletColor == style.textColor for flowable in flowables)


def test_pdf_settings_normalise_existing_terms_markers_into_lists():
    settings = app_module._normalise_pdf_settings({
        'defaultTermsHtml': (
            '<div>1. Deposit is required before confirmation.</div>'
            '<div>2. Balance is due before delivery.</div>'
            '<div>- Prices exclude additional venue charges.</div>'
        ),
    }, 'AVPL')
    assert settings['defaultTermsHtml'] == (
        '<ol><li>Deposit is required before confirmation.</li>'
        '<li>Balance is due before delivery.</li></ol>'
        '<ul><li>Prices exclude additional venue charges.</li></ul>'
    )
    assert settings['defaultTerms'].startswith('1. Deposit is required')


def test_finance_pdf_preserves_mixed_selected_text_fonts_weight_and_colour():
    pdf = build_finance_pdf({
        'type': 'quotation',
        'number': 'QT-MIXED-TYPE',
        'projectName': 'Mixed typography',
        'quotationDate': '2026-09-07',
        'lineItems': [],
        'subprojects': [],
        'totals': {'netSubtotal': 0, 'tax': 0, 'total': 0},
    }, {
        'fontFamily': 'Avenir Next',
        'companyName': 'Example Company',
        'letterheadText': 'Example Company\nRed serif words and normal words',
        'letterheadHtml': (
            '<div><strong>Example Company</strong></div>'
            '<div><span style="font-family:Georgia;color:#cc1122;font-size:14pt">'
            'Red serif words</span> and normal words</div>'
        ),
    })
    reader = PdfReader(io.BytesIO(pdf))
    fonts = set()

    def collect_font(text, _cm, _tm, font, _size):
        if text.strip() and font:
            fonts.add(str(font.get('/BaseFont') or ''))

    page_streams = []
    for page in reader.pages:
        page.extract_text(visitor_text=collect_font)
        page_streams.append(page.get_contents().get_data().decode('latin-1', 'ignore'))

    assert any('AvenirNextCyr-Bold' in name for name in fonts)
    assert any('AvenirNextCyr-Regular' in name for name in fonts)
    assert any('Georgia' in name for name in fonts)
    assert any('.8 .066667 .133333 rg' in stream for stream in page_streams)
