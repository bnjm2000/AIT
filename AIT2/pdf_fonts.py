"""Font selection and typography helpers shared by ReportLab PDF exports."""

from pathlib import Path
import os
import threading


DEFAULT_PDF_FONT_FAMILY = "App Default"
DEFAULT_PDF_FONT = "Helvetica"
DEFAULT_PDF_FONT_BOLD = "Helvetica-Bold"

PDF_FONT_FAMILIES = (
    "App Default",
    "Helvetica",
    "Arial",
    "Aptos",
    "Calibri",
    "Century Gothic",
    "Georgia",
    "Garamond",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
    "Avenir Next",
)

_FONT_LOCK = threading.Lock()
_FONT_CACHE = {}
_ROOT = Path(__file__).resolve().parent

_BASE14 = {
    "App Default": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
    "Helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
    "Times New Roman": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
    "Garamond": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
}

_FONT_FILES = {
    "Arial": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"),
    "Aptos": ("aptos.ttf", "aptos-bold.ttf", "aptos-italic.ttf", "aptos-bold-italic.ttf"),
    "Calibri": ("calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"),
    "Century Gothic": ("GOTHIC.TTF", "GOTHICB.TTF", "GOTHICI.TTF", "GOTHICBI.TTF"),
    "Georgia": ("georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"),
    "Trebuchet MS": ("trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "trebucbi.ttf"),
    "Verdana": ("verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"),
    "Avenir Next": (
        str(_ROOT / "static" / "fonts" / "avenir-next" / "AvenirNextCyr-Regular.ttf"),
        str(_ROOT / "static" / "fonts" / "avenir-next" / "AvenirNextCyr-Bold.ttf"),
        str(_ROOT / "static" / "fonts" / "avenir-next" / "AvenirNextCyr-Regular.ttf"),
        str(_ROOT / "static" / "fonts" / "avenir-next" / "AvenirNextCyr-Bold.ttf"),
    ),
}

_FALLBACKS = {
    "Georgia": _BASE14["Times New Roman"],
    "Garamond": _BASE14["Times New Roman"],
}


def normalise_pdf_font_family(value, *, allow_inherit=False):
    """Return a supported family name, preserving a blank inherited value."""
    raw = str(value or "").strip()
    if allow_inherit and not raw:
        return ""
    aliases = {
        "default": DEFAULT_PDF_FONT_FAMILY,
        "app default": DEFAULT_PDF_FONT_FAMILY,
        "times": "Times New Roman",
        "times-roman": "Times New Roman",
        "avenir": "Avenir Next",
    }
    known = {name.casefold(): name for name in PDF_FONT_FAMILIES}
    canonical = aliases.get(raw.casefold()) or known.get(raw.casefold())
    return canonical or DEFAULT_PDF_FONT_FAMILY


def _font_search_directories():
    directories = []
    windows = os.environ.get("WINDIR")
    if windows:
        directories.append(Path(windows) / "Fonts")
    directories.extend((
        Path("/usr/share/fonts/truetype/msttcorefonts"),
        Path("/usr/share/fonts/truetype/liberation2"),
    ))
    return directories


def _resolve_font_file(value):
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate if candidate.is_file() else None
    for directory in _font_search_directories():
        path = directory / value
        if path.is_file():
            return path
    return None


def _registered_family(family):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    files = _FONT_FILES.get(family)
    if not files:
        return _FALLBACKS.get(family, _BASE14["Helvetica"])
    paths = tuple(_resolve_font_file(value) for value in files)
    if not paths[0] or not paths[1]:
        return _FALLBACKS.get(family, _BASE14["Helvetica"])
    paths = (paths[0], paths[1], paths[2] or paths[0], paths[3] or paths[1])
    slug = "".join(character for character in family if character.isalnum())
    names = tuple(f"Showbase{slug}{suffix}" for suffix in ("", "Bold", "Italic", "BoldItalic"))
    with _FONT_LOCK:
        registered = set(pdfmetrics.getRegisteredFontNames())
        for name, path in zip(names, paths):
            if name not in registered:
                pdfmetrics.registerFont(TTFont(name, str(path)))
        pdfmetrics.registerFontFamily(
            names[0], normal=names[0], bold=names[1], italic=names[2], boldItalic=names[3]
        )
    return names


def pdf_font_family_names(family):
    """Return ReportLab regular, bold, italic and bold-italic names."""
    family = normalise_pdf_font_family(family)
    cached = _FONT_CACHE.get(family)
    if cached:
        return cached
    names = _BASE14.get(family) or _registered_family(family)
    _FONT_CACHE[family] = names
    return names


def pdf_font_names(company=None, default=(DEFAULT_PDF_FONT, DEFAULT_PDF_FONT_BOLD)):
    """Return the selected regular/bold fonts for an exporting company."""
    company = company if isinstance(company, dict) else {}
    family = normalise_pdf_font_family(company.get("fontFamily"))
    if family == DEFAULT_PDF_FONT_FAMILY and default != (DEFAULT_PDF_FONT, DEFAULT_PDF_FONT_BOLD):
        return default
    names = pdf_font_family_names(family)
    return names[0], names[1]


def pdf_text_typography(company, key, default_size):
    """Resolve one configurable text area's font, size and decorations."""
    company = company if isinstance(company, dict) else {}
    raw = company.get(f"{key}Typography")
    raw = raw if isinstance(raw, dict) else {}
    family = normalise_pdf_font_family(raw.get("fontFamily") or company.get("fontFamily"))
    regular, bold, italic, bold_italic = pdf_font_family_names(family)
    is_bold = bool(raw.get("bold"))
    is_italic = bool(raw.get("italic"))
    font_name = (
        bold_italic if is_bold and is_italic
        else bold if is_bold
        else italic if is_italic
        else regular
    )
    try:
        configured_size = float(raw.get("fontSize") or 0)
    except (TypeError, ValueError):
        configured_size = 0
    return {
        "fontName": font_name,
        "fontSize": configured_size if 6 <= configured_size <= 24 else float(default_size),
        "bold": is_bold,
        "italic": is_italic,
        "underline": bool(raw.get("underline")),
        "fontFamily": family,
    }


def pdf_text_typography_is_custom(company, key):
    raw = (company or {}).get(f"{key}Typography") if isinstance(company, dict) else None
    return isinstance(raw, dict) and any((
        raw.get("fontFamily"), raw.get("fontSize"), raw.get("bold"),
        raw.get("italic"), raw.get("underline"),
    ))


def draw_pdf_canvas_text(canvas, value, x, y, typography, *, align="left", max_chars=None):
    """Draw a configured canvas string, including underline when requested."""
    text = str(value or "")
    if max_chars:
        text = text[:max_chars]
    font_name = typography["fontName"]
    # Import lazily to avoid the module-level quotation_pdf -> pdf_fonts cycle.
    # Its resolver swaps in a Unicode CID font only for CJK text.
    try:
        from quotation_pdf import _canvas_font
        font_name = _canvas_font(text, font_name)
    except (ImportError, RuntimeError):
        pass
    font_size = float(typography["fontSize"])
    canvas.setFont(font_name, font_size)
    if align == "right":
        canvas.drawRightString(x, y, text)
        start_x = x - canvas.stringWidth(text, font_name, font_size)
    else:
        canvas.drawString(x, y, text)
        start_x = x
    if typography.get("underline"):
        canvas.setLineWidth(max(0.3, font_size / 20))
        canvas.line(
            start_x,
            y - 1.1,
            start_x + canvas.stringWidth(text, font_name, font_size),
            y - 1.1,
        )
