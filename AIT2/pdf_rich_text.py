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


_ALLOWED_TAGS = {
    "b", "strong", "i", "em", "u", "br", "div", "p", "span", "font",
    "ul", "ol", "li",
}
_HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
_LIST_MARKER = re.compile(
    r"^\s*(?:(?P<number>\d{1,3})[.)]|(?P<bullet>[-*\u2022\u25aa\u25e6\u2023]))\s+(?P<body>\S.*)$"
)
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
        elif normalised == "ol":
            try:
                start = int(attrs.get("start") or 1)
            except (TypeError, ValueError):
                start = 1
            style = ""
            style_attr = f' start="{start}"' if 1 <= start <= 999 and start != 1 else ""
        else:
            style = _safe_inline_style(attrs.get("style")) if normalised == "span" else ""
        if normalised != "ol":
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


def plain_text_to_rich_html(value, *, bold_first_line=False, recognise_lists=False):
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
    html = "".join(output) if output else ""
    return normalise_pdf_terms_html(html) if recognise_lists else html


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.lists = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, _attrs):
        tag = tag.casefold()
        if tag == "br":
            self.parts.append("\n")
        elif tag in {"ul", "ol"}:
            attrs = dict(_attrs)
            try:
                start = max(1, int(attrs.get("start") or 1))
            except (TypeError, ValueError):
                start = 1
            self.lists.append({"tag": tag, "next": start})
        elif tag == "li":
            if self.parts and not self.parts[-1].endswith("\n"):
                self.parts.append("\n")
            current = self.lists[-1] if self.lists else {"tag": "ul", "next": 1}
            if current["tag"] == "ol":
                self.parts.append(f'{current["next"]}. ')
                current["next"] += 1
            else:
                self.parts.append("- ")

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if tag in {"div", "p", "li"} and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")
        if tag in {"ul", "ol"} and self.lists:
            self.lists.pop()


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


def _node_text(node):
    if isinstance(node, str):
        return node
    return "".join(_node_text(child) for child in node.get("children") or [])


def _remove_text_prefix(nodes, length):
    """Remove marker characters across the first inline text nodes in-place."""
    remaining = max(0, int(length or 0))
    for index, node in enumerate(nodes):
        if not remaining:
            break
        if isinstance(node, str):
            consumed = min(remaining, len(node))
            nodes[index] = node[consumed:]
            remaining -= consumed
        else:
            remaining = _remove_text_prefix(node.get("children") or [], remaining)
    return remaining


def _tree_html(nodes):
    output = []
    for node in nodes:
        if isinstance(node, str):
            output.append(escape(node))
            continue
        tag = node.get("tag")
        if tag == "br":
            output.append("<br>")
            continue
        attrs = node.get("attrs") or {}
        rendered_attrs = ""
        if tag == "span" and attrs.get("style"):
            rendered_attrs = f' style="{escape(attrs["style"], quote=True)}"'
        elif tag == "ol":
            try:
                start = int(attrs.get("start") or 1)
            except (TypeError, ValueError):
                start = 1
            if 1 <= start <= 999 and start != 1:
                rendered_attrs = f' start="{start}"'
        output.append(f"<{tag}{rendered_attrs}>")
        output.append(_tree_html(node.get("children") or []))
        output.append(f"</{tag}>")
    return "".join(output)


def normalise_pdf_terms_html(value):
    """Turn typed list markers in terms HTML into semantic lists."""
    clean = sanitise_pdf_rich_text(value)
    parser = _TreeParser()
    parser.feed(clean)
    parser.close()
    output = []
    active_list = None
    expected_number = None
    for node in parser.root:
        match = None
        node_text = ""
        if isinstance(node, dict) and node.get("tag") in {"div", "p"}:
            node_text = _node_text(node)
            match = _LIST_MARKER.match(node_text)
        is_continuation = bool(
            not match
            and active_list is not None
            and active_list.get("children")
            and re.match(r"^\s{2,}\S", node_text)
        )
        if is_continuation:
            children = list(node.get("children") or [])
            _remove_text_prefix(children, len(node_text) - len(node_text.lstrip()))
            item_children = active_list["children"][-1]["children"]
            item_children.append({"tag": "br", "attrs": {}, "children": []})
            item_children.extend(children)
            continue
        if not match:
            active_list = None
            expected_number = None
            output.append(node)
            continue
        ordered = bool(match.group("number"))
        number = int(match.group("number")) if ordered else None
        list_tag = "ol" if ordered else "ul"
        needs_new_list = (
            active_list is None
            or active_list.get("tag") != list_tag
            or (ordered and expected_number is not None and number != expected_number)
        )
        if needs_new_list:
            attrs = {"start": str(number)} if ordered and number != 1 else {}
            active_list = {"tag": list_tag, "attrs": attrs, "children": []}
            output.append(active_list)
        children = list(node.get("children") or [])
        _remove_text_prefix(children, match.start("body"))
        active_list["children"].append({"tag": "li", "attrs": {}, "children": children})
        expected_number = number + 1 if ordered else None
    return _tree_html(output).strip()


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
        if tag in {"ul", "ol"}:
            try:
                number = max(1, int((node.get("attrs") or {}).get("start") or 1))
            except (TypeError, ValueError):
                number = 1
            for item in node.get("children") or []:
                if not isinstance(item, dict) or item.get("tag") != "li":
                    continue
                if output and not output[-1].endswith("<br/>"):
                    output.append("<br/>")
                marker = f"{number}. " if tag == "ol" else "\u2022 "
                output.append(_reportlab_nodes([marker], context))
                output.append(_reportlab_nodes(item.get("children") or [], context))
                output.append("<br/>")
                number += 1
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


def rich_text_to_reportlab_flowables(
    value,
    style,
    *,
    default_family=DEFAULT_PDF_FONT_FAMILY,
    recognise_lists=False,
    underline=False,
):
    """Build paragraphs with hanging indents for semantic or typed lists."""
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph

    clean = (
        normalise_pdf_terms_html(value)
        if recognise_lists
        else sanitise_pdf_rich_text(value)
    )
    parser = _TreeParser()
    parser.feed(clean)
    parser.close()
    flowables = []
    inline_nodes = []

    def markup(nodes):
        rendered = _reportlab_nodes(nodes, {
            "fontFamily": default_family,
            "underline": bool(underline),
        })
        rendered = re.sub(r"^(?:<br/>)+|(?:<br/>)+$", "", rendered)
        try:
            from quotation_pdf import _cjk_markup
            rendered = _cjk_markup(rendered)
        except (ImportError, RuntimeError):
            pass
        return rendered or "&#160;"

    def flush_inline():
        if inline_nodes:
            flowables.append(Paragraph(markup(inline_nodes), style))
            inline_nodes.clear()

    for node in parser.root:
        tag = node.get("tag") if isinstance(node, dict) else ""
        if tag in {"ul", "ol"}:
            flush_inline()
            items = [
                item for item in node.get("children") or []
                if isinstance(item, dict) and item.get("tag") == "li"
            ]
            try:
                number = max(1, int((node.get("attrs") or {}).get("start") or 1))
            except (TypeError, ValueError):
                number = 1
            markers = [
                f"{number + index}." if tag == "ol" else "\u2022"
                for index in range(len(items))
            ]
            marker_width = max((len(marker) for marker in markers), default=1)
            font_size = float(getattr(style, "fontSize", 8))
            bullet_indent = font_size * 0.8
            text_indent = bullet_indent + max(
                font_size * 1.35,
                font_size * (0.56 * marker_width + 0.6),
            )
            list_style = ParagraphStyle(
                f"{getattr(style, 'name', 'PdfRichText')}List",
                parent=style,
                leftIndent=text_indent,
                firstLineIndent=0,
                bulletIndent=bullet_indent,
                bulletFontName=getattr(style, "fontName", "Helvetica"),
                bulletFontSize=font_size,
                bulletColor=getattr(style, "textColor", None),
                bulletOffsetY=0,
                spaceBefore=0,
                spaceAfter=max(1, font_size * 0.18),
            )
            for marker, item in zip(markers, items):
                flowables.append(Paragraph(
                    markup(item.get("children") or []),
                    list_style,
                    bulletText=marker,
                ))
            continue
        if tag in {"div", "p"}:
            flush_inline()
            flowables.append(Paragraph(markup(node.get("children") or []), style))
            continue
        inline_nodes.append(node)
    flush_inline()
    return flowables


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
