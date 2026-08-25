import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STYLE_SOURCES = [
    *sorted((ROOT / 'static' / 'css').glob('*.css')),
    ROOT / 'templates' / 'index.html',
]


def test_white_text_controls_have_a_background_fallback():
    """A missing custom property must never leave white controls on white."""
    unsafe = []
    rule_pattern = re.compile(r'([^{}]+)\{([^{}]*)\}', re.DOTALL)
    white_text = re.compile(
        r'color\s*:\s*(?:#fff(?:fff)?|white)\b', re.IGNORECASE
    )
    background_variable_without_fallback = re.compile(
        r'background(?:-color)?\s*:\s*var\(--[^,;)]+\)', re.IGNORECASE
    )
    for source in STYLE_SOURCES:
        text = source.read_text(encoding='utf-8')
        for match in rule_pattern.finditer(text):
            body = match.group(2)
            if (
                white_text.search(body)
                and background_variable_without_fallback.search(body)
            ):
                line = text.count('\n', 0, match.start()) + 1
                selector = ' '.join(match.group(1).split())
                unsafe.append(f'{source.relative_to(ROOT)}:{line} {selector}')
    assert not unsafe, (
        'White-text controls need a concrete custom-property fallback:\n'
        + '\n'.join(unsafe)
    )


def test_portalled_invoice_dialogs_carry_invoice_theme_tokens():
    css = (ROOT / 'static' / 'css' / 'invoices.css').read_text(
        encoding='utf-8'
    )
    assert '.invoice-soa-modal,' in css
    assert '.invoice-plan-manager-modal,' in css
    assert '.invoice-paid-modal {' in css
    assert '--invoice-green: var(--company-theme-color, var(--brand-main, #0f766e));' in css
    assert 'background: var(--invoice-green, #0f766e) !important;' in css
