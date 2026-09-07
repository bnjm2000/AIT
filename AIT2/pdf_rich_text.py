"""Safe rich-text storage and ReportLab markup conversion for PDF settings."""

from html import escape
from html.parser import HTMLParser
import re

from pdf_fonts import (
    DEFAULT_PDF_FONT_FAMILY,
    PDF_FONT_FAMILIES,
    normalise_pdf_font_family,
    pdf_font_family_names,
)


_ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "br", "div", "p", "span", "font"}
_HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT_LOOKUP = {name.casefold(): name for name in PDF_FONT_FAMILIES}


def _font_from_css(value):
    first = str(value or "").split(",", 1)[0].strip().strip("'\"")
    if first.casefold() == "showbase avenir next":
        return "Avenir Next"
    return _FONT_LOOKUP.get(first.casefold(), "")


def _size_from_css(value):
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(?:pt|px)?\s*", str(value or ""), re.I)
    if not match:
        return 0
    size = float(match.group(1))
    return size if 6 <= size <= 24 else 0


def _safe_inline_style(raw_style):
    values = {}
    for declaration in str(raw_style or "").split(";"):
        if ":" not in declaration:
            continue
        key, value = declaration.split(":", 1)
        values[key.strip().casefold()] = value.strip()
    safe = []
    family = _font_from_css(values.get("font-family"))
    if family:
        safe.append(f"font-family:{family}")
    size = _size_from_css(values.get("font-size"))
    if size:
        safe.append(f"font-size:{size:g}pt")
    colour = values.get("color", "")
    if _HEX_COLOUR.fullmatch(colour):
        safe.append(f"color:{colour.lower()}")
    return ";".join(safe)


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        if tag not in _ALLOWED_TAGS:
            self.stack.append("")
            return
        attrs = {str(key).casefold(): value for key, value in attrs}
        if tag == "br":
            self.output.append("<br>")
            self.stack.append("")
            return
        normalised = {"b": "strong", "i": "em", "font": "span"}.get(tag, tag)
        if tag == "font":
            declarations = []
            family = _font_from_css(attrs.get("face"))
            if family:
                declarations.append(f"font-family:{family}")
            size = _size_from_css(attrs.get("size"))
            if size:
                declarations.append(f"font-size:{size:g}pt")
            colour = str(attrs.get("color") or "")
            if _HEX_COLOUR.fullmatch(colour):
                declarations.append(f"color:{colour.lower()}")
            style = ";".join(declarations)
        else:
            style = _safe_inline_style(attrs.get("style")) if normalised == "span" else ""
        style_attr = f' style="{escape(style, quote=True)}"' if style else ""
        self.output.append(f"<{normalised}{style_attr}>")
        self.stack.append(normalised)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.casefold() != "br":
            self.handle_endtag(tag)

    def handle_endtag(self, _tag):
        if not self.stack:
            return
        normalised = self.stack.pop()
        if normalised:
            self.output.append(f"</{normalised}>")

    def handle_data(self, data):
        self.output.append(escape(data))


def sanitise_pdf_rich_text(value):
    parser = _Sanitizer()
    parser.feed(str(value or ""))
    parser.close()
    while parser.stack:
        normalised = parser.stack.pop()
        if normalised:
            parser.output.append(f"</{normalised}>")
    return "".join(parser.output).strip()


def plain_text_to_rich_html(value, *, bold_first_line=False):
    lines = str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    output = []
    first_content = True
    for line in lines:
        text = escape(line)
        if bold_first_line and first_content and line.strip():
            text = f"<strong>{text}</strong>"
            first_content = False
        elif line.strip():
            first_content = False
        output.append(f"<div>{text or '<br>'}</div>")
    return "".join(output) if output else ""


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, _attrs):
        if tag.casefold() == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag.casefold() in {"div", "p"} and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")


def rich_text_to_plain_text(value):
    parser = _PlainText()
    parser.feed(sanitise_pdf_rich_text(value))
    parser.close()
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()


class _TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = []
        self.children = self.root
        self.stack = []

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        node = {"tag": tag, "attrs": dict(attrs), "children": []}
        self.children.append(node)
        if tag != "br":
            self.stack.append(self.children)
            self.children = node["children"]

    def handle_endtag(self, _tag):
        if self.stack:
            self.children = self.stack.pop()

    def handle_data(self, data):
        self.children.append(data)


def _reportlab_nodes(nodes, context):
    output = []
    for node in nodes:
        if isinstance(node, str):
            if not node:
                continue
            family = normalise_pdf_font_family(context.get("fontFamily") or DEFAULT_PDF_FONT_FAMILY)
            regular, bold, italic, bold_italic = pdf_font_family_names(family)
            font_name = (
                bold_italic if context.get("bold") and context.get("italic")
                else bold if context.get("bold")
                else italic if context.get("italic")
                else regular
            )
            attributes = [f'name="{escape(font_name, quote=True)}"']
            if context.get("fontSize"):
                attributes.append(f'size="{float(context["fontSize"]):g}"')
            if context.get("color"):
                attributes.append(f'color="{context["color"]}"')
            text = escape(node)
            if context.get("underline"):
                text = f"<u>{text}</u>"
            output.append(f"<font {' '.join(attributes)}>{text}</font>")
            continue
        tag = node.get("tag")
        if tag == "br":
            output.append("<br/>")
            continue
        child_context = dict(context)
        if tag in {"b", "strong"}:
            child_context["bold"] = True
        elif tag in {"i", "em"}:
            child_context["italic"] = True
        elif tag == "u":
            child_context["underline"] = True
        elif tag == "span":
            style = _safe_inline_style((node.get("attrs") or {}).get("style"))
            for declaration in style.split(";") if style else ():
                key, value = declaration.split(":", 1)
                if key == "font-family":
                    child_context["fontFamily"] = value
                elif key == "font-size":
                    child_context["fontSize"] = _size_from_css(value)
                elif key == "color":
                    child_context["color"] = value
        child = _reportlab_nodes(node.get("children") or [], child_context)
        if tag in {"div", "p"} and output and not output[-1].endswith("<br/>"):
            output.append("<br/>")
        output.append(child)
        if tag in {"div", "p"}:
            output.append("<br/>")
    return "".join(output)


def rich_text_to_reportlab_markup(value, *, default_family=DEFAULT_PDF_FONT_FAMILY):
    clean = sanitise_pdf_rich_text(value)
    parser = _TreeParser()
    parser.feed(clean)
    parser.close()
    markup = re.sub(r"(?:<br/>){3,}", "<br/><br/>", _reportlab_nodes(
        parser.root, {"fontFamily": default_family}
    ))
    markup = re.sub(r"^(?:<br/>)+|(?:<br/>)+$", "", markup)
    return markup


def draw_pdf_rich_text(
    canvas,
    value,
    x,
    y,
    width,
    *,
    default_family=DEFAULT_PDF_FONT_FAMILY,
    default_size=7,
    leading=None,
    text_color=None,
    alignment=0,
    top_y=False,
):
    """Draw sanitized mixed-format HTML as a ReportLab paragraph."""
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph

    markup = rich_text_to_reportlab_markup(value, default_family=default_family)
    if not markup:
        return 0
    regular = pdf_font_family_names(default_family)[0]
    style = ParagraphStyle(
        "PdfRichText",
        fontName=regular,
        fontSize=float(default_size),
        leading=float(leading or (float(default_size) * 1.25)),
        textColor=text_color,
        alignment=alignment,
    )
    try:
        from quotation_pdf import _cjk_markup
        markup = _cjk_markup(markup)
    except (ImportError, RuntimeError):
        pass
    paragraph = Paragraph(markup, style)
    _, height = paragraph.wrap(width, 1000)
    paragraph.drawOn(canvas, x, y - height if top_y else y)
    return height
