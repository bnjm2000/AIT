import inspect
import io
from pathlib import Path

from pypdf import PdfReader

import app as app_module
from costing_pdf import build_costing_pdf
from event_report import build_event_report_pdf
from pdf_fonts import pdf_font_names
from pdf_rich_text import (
    rich_text_to_plain_text,
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
