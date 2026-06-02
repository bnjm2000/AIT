"""Shared filename and CSV text helpers."""

import io
import re


def sanitize_filename(filename):
    return re.sub(r'[<>:"/\\|?*]', '_', filename)


# CSV files may come from spreadsheet exports with different encodings.

_FALLBACK_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")


def read_text_file_robust(filepath, encodings=_FALLBACK_ENCODINGS):
    """
    Read a text file robustly by trying multiple encodings.
    Returns (text, encoding_used).
    """
    with open(filepath, "rb") as bf:
        data = bf.read()

    last_err = None
    for enc in encodings:
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError as e:
            last_err = e

    # last resort: don't crash; replace invalid bytes
    return data.decode("utf-8", errors="replace"), f"utf-8 (replace; last_err={last_err})"


def open_csv_robust(filepath, normalize_nbsp=True):
    """
    Returns (StringIO, encoding_used) suitable for csv.reader/csv.DictReader.
    Normalizes non-breaking space (U+00A0) to regular space by default.
    """
    text, enc = read_text_file_robust(filepath)
    if normalize_nbsp:
        text = text.replace("\u00A0", " ")
    # csv module expects newline='' behavior; StringIO is fine for this use
    return io.StringIO(text), enc


def clean_csv_cell(value):
    """
    Normalize common annoying whitespace issues (NBSP) and strip edges.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.replace("\u00A0", " ").strip()
