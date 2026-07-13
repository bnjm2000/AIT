"""Company-scoped manpower, transport, and worker-submission persistence."""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from PIL import Image


WORKFORCE_FILENAME = "Workforce.json"
UPLOAD_FOLDERNAME = "workforce_uploads"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
VALID_STATUSES = {"Pending Review", "Approved", "Denied", "Paid"}
INVOICE_EXTENSIONS = {".pdf"}
CLAIM_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
TRANSPORT_EXTENSIONS = {".pdf"}

_STORE_LOCKS: dict[str, threading.RLock] = {}
_STORE_LOCKS_GUARD = threading.RLock()
_OCR_ENGINE = None
_OCR_ENGINE_LOCK = threading.RLock()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def money(value, default=None):
    if value in (None, ""):
        return default
    try:
        amount = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return default
    if amount < 0:
        return default
    return float(amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def normalize_phone(value: str) -> str:
    raw = str(value or "").strip()
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return ""
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 8:
        digits = f"65{digits}"
    return f"+{digits}"


def empty_workforce() -> dict:
    return {
        "version": 1,
        "freelancers": [],
        "vendors": [],
        "roles": [],
        "assignments": {},
        "manualDepartments": {},
        "hiddenDepartments": {},
        "uploadAllowances": {},
        "transportVendors": [],
        "transportLocations": [],
        "transportBookings": {},
        "submissions": {},
        "updatedAt": "",
    }


def _store_path(data_folder: str) -> str:
    return os.path.join(os.path.abspath(data_folder), WORKFORCE_FILENAME)


def _lock_for(data_folder: str) -> threading.RLock:
    path = _store_path(data_folder)
    with _STORE_LOCKS_GUARD:
        return _STORE_LOCKS.setdefault(path, threading.RLock())


def _list(value):
    return value if isinstance(value, list) else []


def _dict(value):
    return value if isinstance(value, dict) else {}


def normalize_workforce(data) -> dict:
    source = data if isinstance(data, dict) else {}
    normalized = empty_workforce()
    normalized.update(
        {
            "version": 1,
            "freelancers": _list(source.get("freelancers")),
            "vendors": _list(source.get("vendors")),
            "roles": _list(source.get("roles")),
            "assignments": _dict(source.get("assignments")),
            "manualDepartments": _dict(source.get("manualDepartments")),
            "hiddenDepartments": _dict(source.get("hiddenDepartments")),
            "uploadAllowances": _dict(source.get("uploadAllowances")),
            "transportVendors": _list(source.get("transportVendors")),
            "transportLocations": _list(source.get("transportLocations")),
            "transportBookings": _dict(source.get("transportBookings")),
            "submissions": _dict(source.get("submissions")),
            "updatedAt": str(source.get("updatedAt") or ""),
        }
    )
    for freelancer in normalized["freelancers"]:
        if isinstance(freelancer, dict):
            freelancer["phone"] = normalize_phone(freelancer.get("phone"))
            freelancer.setdefault("active", True)
    for vendor in normalized["vendors"]:
        if isinstance(vendor, dict):
            vendor["memberIds"] = [
                str(value)
                for value in _list(vendor.get("memberIds"))
                if str(value or "").strip()
            ]
            vendor.setdefault("active", True)
    return normalized


def load_workforce(data_folder: str) -> dict:
    path = _store_path(data_folder)
    with _lock_for(data_folder):
        if not os.path.exists(path):
            return empty_workforce()
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return normalize_workforce(json.load(handle))
        except (OSError, ValueError):
            return empty_workforce()


def save_workforce(data_folder: str, data: dict) -> dict:
    path = _store_path(data_folder)
    normalized = normalize_workforce(data)
    normalized["updatedAt"] = now_iso()
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    temporary = f"{path}.{secrets.token_hex(6)}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(normalized, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.remove(temporary)
        except OSError:
            pass
        raise
    return normalized


@contextmanager
def mutate_workforce(data_folder: str):
    lock = _lock_for(data_folder)
    with lock:
        data = load_workforce(data_folder)
        yield data
        save_workforce(data_folder, data)


def find_by_id(rows, row_id):
    return next(
        (
            row
            for row in _list(rows)
            if isinstance(row, dict) and str(row.get("id")) == str(row_id)
        ),
        None,
    )


def event_assignments(data: dict, event_id) -> list:
    return _list(_dict(data.get("assignments")).get(str(event_id)))


def event_bookings(data: dict, event_id) -> list:
    return _list(_dict(data.get("transportBookings")).get(str(event_id)))


def worker_submissions(data: dict, event_id, freelancer_id, create=False) -> dict:
    all_submissions = data.setdefault("submissions", {})
    event_rows = all_submissions.setdefault(str(event_id), {}) if create else _dict(
        all_submissions.get(str(event_id))
    )
    if create:
        return event_rows.setdefault(
            str(freelancer_id), {"invoices": [], "claims": []}
        )
    return _dict(event_rows.get(str(freelancer_id)))


def active_invoice(rows: dict):
    return next(
        (
            row
            for row in reversed(_list(rows.get("invoices")))
            if isinstance(row, dict) and row.get("status") != "Denied"
        ),
        None,
    )


def active_claims(rows: dict) -> list:
    return [
        row
        for row in _list(rows.get("claims"))
        if isinstance(row, dict) and row.get("status") != "Denied"
    ]


def _safe_original_name(filename: str) -> str:
    name = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._() \-\[\]]+", "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name or "upload")[:180]


def _validate_magic(content: bytes, extension: str) -> bool:
    if extension == ".pdf":
        return content.startswith(b"%PDF")
    if extension == ".png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if extension in {".jpg", ".jpeg"}:
        return content.startswith(b"\xff\xd8\xff")
    return False


def save_upload(
    data_folder: str,
    uploaded_file,
    event_id,
    freelancer_id,
    kind: str,
) -> dict:
    original_name = _safe_original_name(getattr(uploaded_file, "filename", ""))
    extension = os.path.splitext(original_name)[1].lower()
    allowed = {
        "invoice": INVOICE_EXTENSIONS,
        "claim": CLAIM_EXTENSIONS,
        "transport": TRANSPORT_EXTENSIONS,
    }.get(kind, set())
    if extension not in allowed:
        raise ValueError("Unsupported file type")

    content = uploaded_file.stream.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise ValueError("The selected file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("Files must be 10 MB or smaller")
    if not _validate_magic(content, extension):
        raise ValueError("The file contents do not match the selected file type")

    relative_folder = os.path.join(
        UPLOAD_FOLDERNAME,
        str(event_id),
        str(freelancer_id or "transport"),
    )
    absolute_folder = os.path.abspath(os.path.join(data_folder, relative_folder))
    data_root = os.path.abspath(data_folder)
    if os.path.commonpath([data_root, absolute_folder]) != data_root:
        raise ValueError("Invalid upload path")
    os.makedirs(absolute_folder, exist_ok=True)

    stored_name = f"{kind}-{secrets.token_hex(12)}{extension}"
    absolute_path = os.path.join(absolute_folder, stored_name)
    with open(absolute_path, "wb") as handle:
        handle.write(content)

    return {
        "originalName": original_name,
        "storedPath": os.path.relpath(absolute_path, data_root).replace(os.sep, "/"),
        "size": len(content),
        "contentType": {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }[extension],
    }


def upload_absolute_path(data_folder: str, stored_path: str) -> str | None:
    root = os.path.abspath(data_folder)
    candidate = os.path.abspath(
        os.path.join(root, str(stored_path or "").replace("/", os.sep))
    )
    if os.path.commonpath([root, candidate]) != root:
        return None
    return candidate


def delete_upload(data_folder: str, record: dict) -> None:
    path = upload_absolute_path(data_folder, record.get("storedPath"))
    if path and os.path.isfile(path):
        os.remove(path)


def _pdf_text(path: str) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        text = "\n".join(
            (page.extract_text() or "") for page in reader.pages[:8]
        )
        if text.strip():
            return text
    except Exception:
        pass
    try:
        import fitz

        document = fitz.open(path)
        try:
            return "\n".join(page.get_text("text") for page in list(document)[:8])
        finally:
            document.close()
    except Exception:
        return ""


def _rapid_ocr_engine():
    global _OCR_ENGINE
    with _OCR_ENGINE_LOCK:
        if _OCR_ENGINE is None:
            from rapidocr_onnxruntime import RapidOCR

            _OCR_ENGINE = RapidOCR(
                intra_op_num_threads=1,
                inter_op_num_threads=1,
            )
        return _OCR_ENGINE


def _ocr_pdf(path: str) -> str:
    try:
        import fitz

        engine = _rapid_ocr_engine()
        lines = []
        document = fitz.open(path)
        try:
            for page in list(document)[:6]:
                pixmap = page.get_pixmap(dpi=180, alpha=False)
                image = Image.open(io.BytesIO(pixmap.tobytes("png"))).convert("RGB")
                lines.extend(_ocr_image_regions(engine, image))
        finally:
            document.close()
        return "\n".join(lines)
    except Exception:
        return ""


def _ocr_result_text(result) -> str:
    tokens = []
    fallback = []
    for item in result or []:
        if len(item) < 2 or not str(item[1]).strip():
            continue
        text = str(item[1]).strip()
        try:
            points = list(item[0])
            xs = [float(point[0]) for point in points]
            ys = [float(point[1]) for point in points]
            tokens.append({
                "text": text,
                "x": min(xs),
                "y": (min(ys) + max(ys)) / 2,
                "height": max(ys) - min(ys),
            })
        except Exception:
            fallback.append(text)
    if not tokens:
        return "\n".join(fallback)
    tokens.sort(key=lambda token: (token["y"], token["x"]))
    rows = []
    for token in tokens:
        row = next(
            (
                candidate
                for candidate in reversed(rows[-5:])
                if abs(candidate["y"] - token["y"])
                <= max(
                    8.0,
                    min(candidate["height"], token["height"]) * 0.65,
                )
            ),
            None,
        )
        if row is None:
            row = {
                "y": token["y"],
                "height": token["height"],
                "tokens": [],
            }
            rows.append(row)
        row["tokens"].append(token)
        row["y"] = sum(value["y"] for value in row["tokens"]) / len(
            row["tokens"]
        )
    lines = []
    for row in sorted(rows, key=lambda value: value["y"]):
        row["tokens"].sort(key=lambda token: token["x"])
        lines.append(" ".join(token["text"] for token in row["tokens"]))
    lines.extend(fallback)
    return "\n".join(lines)


def _ocr_image_regions(engine, image: Image.Image) -> list[str]:
    regions = [image]
    width, height = image.size
    if height > width * 1.35 and height >= 1200:
        regions.extend([
            image.crop((0, 0, width, int(height * 0.32))),
            image.crop((0, int(height * 0.65), width, height)),
        ])
    lines = []
    seen = set()
    for region in regions:
        output = io.BytesIO()
        region.save(output, format="PNG")
        result, _elapsed = engine(output.getvalue())
        for line in _ocr_result_text(result).splitlines():
            normalized = re.sub(r"\s+", " ", line).strip()
            key = normalized.casefold()
            if normalized and key not in seen:
                seen.add(key)
                lines.append(normalized)
    return lines


def _ocr_image(path: str) -> str:
    try:
        engine = _rapid_ocr_engine()
        with Image.open(path) as image:
            lines = _ocr_image_regions(engine, image.convert("RGB"))
        return "\n".join(lines)
    except Exception:
        return ""


_AMOUNT_RE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?P<currency>SGD|S\$|\$)?\s*"
    r"(?P<amount>(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[\.,]\d{2})?)"
    r"(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def _invoice_amount_number(raw_value: str):
    value = re.sub(r"\s+", "", str(raw_value or ""))
    if not value:
        return None
    if "," in value and "." not in value:
        parts = value.split(",")
        if len(parts[-1]) == 2 and len(parts) > 1:
            value = "".join(parts[:-1]) + "." + parts[-1]
        else:
            value = "".join(parts)
    elif "," in value:
        value = value.replace(",", "")
    if value.count(".") > 1:
        parts = value.split(".")
        if len(parts[-1]) == 2:
            value = "".join(parts[:-1]) + "." + parts[-1]
    return money(value)


def _amount_from_text(text: str) -> dict:
    candidates = []
    keyword_scores = (
        ("total amount due", 125),
        ("total amount", 118),
        ("total payable", 110),
        ("amount payable", 105),
        ("amount due", 100),
        ("balance due", 98),
        ("grand total", 95),
        ("total due", 94),
        ("net total", 90),
        ("total incl", 88),
        ("total including", 88),
        ("invoice total", 86),
        ("total", 65),
    )
    lines = [
        re.sub(r"\s+", " ", raw_line).strip()
        for raw_line in str(text or "").splitlines()
        if raw_line.strip()
    ]
    for line_index, line in enumerate(lines):
        lowered = re.sub(r"\btota[i1l]\b", "total", line.lower())
        nearby = []
        for context_index in range(
            max(0, line_index - 2),
            min(len(lines), line_index + 3),
        ):
            nearby.append((
                context_index,
                re.sub(
                    r"\btota[i1l]\b",
                    "total",
                    lines[context_index].lower(),
                ),
            ))
        for match in _AMOUNT_RE.finditer(line):
            raw_amount = match.group("amount")
            amount = _invoice_amount_number(raw_amount)
            has_currency = bool(match.group("currency"))
            has_decimal = bool(re.search(r"[\.,]\d{2}$", raw_amount))
            if amount is None or amount <= 0:
                continue
            score = 15
            positive_distances = []
            for keyword, keyword_score in keyword_scores:
                keyword_on_line = (
                    keyword in lowered
                    and not (
                        keyword == "total"
                        and (
                            "subtotal" in lowered
                            or "sub-total" in lowered
                        )
                    )
                )
                if keyword_on_line:
                    score = max(score, keyword_score)
                    positive_distances.append(0)
                for context_index, context_line in nearby:
                    keyword_in_context = (
                        keyword in context_line
                        and not (
                            keyword == "total"
                            and (
                                "subtotal" in context_line
                                or "sub-total" in context_line
                            )
                        )
                    )
                    if keyword_in_context:
                        distance = abs(context_index - line_index)
                        positive_distances.append(distance)
                        score = max(
                            score,
                            keyword_score - (distance * 14),
                        )
            negative_distances = [
                abs(context_index - line_index)
                for context_index, context_line in nearby
                if any(
                    phrase in context_line
                    for phrase in (
                        "subtotal",
                        "sub-total",
                        "gst",
                        "tax",
                        "deposit",
                        "discount",
                        "amount paid",
                        "payment received",
                    )
                )
            ]
            if (
                negative_distances
                and (
                    not positive_distances
                    or min(negative_distances) < min(positive_distances)
                )
            ):
                score -= max(
                    25,
                    80 - (min(negative_distances) * 20),
                )
            if "subtotal" in lowered or "sub-total" in lowered:
                score -= 95
            if re.search(r"\b(?:gst|tax)\b", lowered) and "total" not in lowered:
                score -= 65
            if any(
                phrase in lowered
                for phrase in (
                    "deposit",
                    "discount",
                    "amount paid",
                    "payment received",
                )
            ):
                score -= 45
            if has_currency or "sgd" in lowered or "s$" in lowered:
                score += 5
            if has_decimal:
                score += 3
            if (
                not has_decimal
                and not has_currency
                and 1900 <= amount <= 2100
                and "total" not in lowered
            ):
                score -= 80
            if lines:
                score += int((line_index / len(lines)) * 8)
            candidates.append((score, line_index, amount, line))

    if not candidates:
        return {"amount": None, "confidence": "Low", "matchedText": ""}
    candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    score, _line_index, amount, line = candidates[0]
    confidence = "High" if score >= 90 else "Medium" if score >= 60 else "Low"
    return {"amount": amount, "confidence": confidence, "matchedText": line[:240]}


_MONTH_NUMBERS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_MONTH_PATTERN = "|".join(
    sorted(_MONTH_NUMBERS, key=len, reverse=True)
)
_DATE_PATTERNS = (
    re.compile(
        r"(?<!\d)(?P<year>20\d{2})\s*[./-]\s*"
        r"(?P<month>\d{1,2})\s*[./-]\s*(?P<day>\d{1,2})(?!\d)"
    ),
    re.compile(
        r"(?<!\d)(?P<day>\d{1,2})\s*[./-]\s*"
        r"(?P<month>\d{1,2})\s*[./-]\s*"
        r"(?P<year>\d{4}|\d{2})(?=$|[^\d]|\d{1,2}:)"
    ),
    re.compile(
        rf"(?<!\w)(?P<day>\d{{1,2}})(?:st|nd|rd|th)?"
        rf"\s*[-./\s]?\s*(?P<month_name>{_MONTH_PATTERN})"
        rf"\s*[-,./\s'’]?\s*['’]?"
        rf"(?P<year>\d{{4}}|\d{{2}})(?=$|[^\d]|\d{{1,2}}:)",
        re.IGNORECASE,
    ),
    re.compile(
        rf"(?<!\w)(?P<month_name>{_MONTH_PATTERN})"
        rf"\s*[-./\s]\s*(?P<day>\d{{1,2}})(?:st|nd|rd|th)?"
        rf"\s*[-,./\s'’]\s*['’]?"
        rf"(?P<year>\d{{4}}|\d{{2}})(?=$|[^\d]|\d{{1,2}}:)",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?<!\d)(?P<day>\d{2})(?P<month>\d{2})"
        r"(?P<year>20\d{2})(?!\d)"
    ),
)


def _date_from_text(text: str) -> dict:
    candidates = []
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in str(text or "").splitlines()
        if line.strip()
    ]
    for line_index, line in enumerate(lines):
        lowered = line.lower()
        nearby = [
            (index, lines[index].lower())
            for index in range(
                max(0, line_index - 2),
                min(len(lines), line_index + 3),
            )
        ]
        for pattern in _DATE_PATTERNS:
            for match in pattern.finditer(line):
                try:
                    year = int(match.group("year"))
                    if year < 100:
                        year += 2000 if year <= 79 else 1900
                    month_name = match.groupdict().get("month_name")
                    month = (
                        _MONTH_NUMBERS.get(month_name.lower())
                        if month_name
                        else int(match.group("month"))
                    )
                    value = datetime(
                        year, int(month), int(match.group("day"))
                    )
                except (TypeError, ValueError):
                    continue
                if not 1990 <= value.year <= 2100:
                    continue
                score = 20
                positive_distances = []
                negative_distances = []
                for context_index, context_line in nearby:
                    distance = abs(context_index - line_index)
                    if any(
                        phrase in context_line
                        for phrase in (
                            "transaction date",
                            "receipt date",
                            "purchase date",
                            "date of purchase",
                        )
                    ):
                        positive_distances.append(distance)
                        score = max(score, 120 - (distance * 18))
                    elif re.search(r"\bdate\b", context_line):
                        positive_distances.append(distance)
                        score = max(score, 85 - (distance * 16))
                    if any(
                        phrase in context_line
                        for phrase in (
                            "due date",
                            "expiry",
                            "expires",
                            "expiration",
                            "valid until",
                        )
                    ):
                        negative_distances.append(distance)
                if (
                    negative_distances
                    and (
                        not positive_distances
                        or min(negative_distances) <= min(positive_distances)
                    )
                ):
                    score -= max(
                        80,
                        120 - (min(negative_distances) * 18),
                    )
                candidates.append(
                    (score, -line_index, value.strftime("%Y-%m-%d"), line)
                )
    if not candidates:
        return {"date": "", "dateMatchedText": ""}
    candidates.sort(reverse=True)
    _score, _position, value, line = candidates[0]
    return {"date": value, "dateMatchedText": line[:240]}


def _date_from_filename(filename: str) -> dict:
    value = str(filename or "")
    match = re.search(
        r"(?<!\d)(?P<year>20\d{2})[-_.]?"
        r"(?P<month>\d{2})[-_.]?(?P<day>\d{2})(?!\d)",
        value,
    )
    if not match:
        return {"date": "", "dateMatchedText": ""}
    try:
        parsed = datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
        )
    except ValueError:
        return {"date": "", "dateMatchedText": ""}
    return {
        "date": parsed.strftime("%Y-%m-%d"),
        "dateMatchedText": f"File name: {Path(value).name}",
    }


def extract_invoice_amount(path: str) -> dict:
    text = _pdf_text(path)
    result = _amount_from_text(text)
    result["source"] = "PDF text"
    result["ocrUsed"] = False
    if result["amount"] is not None and result["confidence"] != "Low":
        return result

    ocr_text = _ocr_pdf(path)
    ocr_result = _amount_from_text(ocr_text)
    if ocr_result["amount"] is not None:
        ocr_result["source"] = "Scanned document OCR"
        ocr_result["ocrUsed"] = True
        return ocr_result
    return result


def extract_claim_amount(
    path: str,
    content_type: str = "",
    original_name: str = "",
) -> dict:
    extension = Path(path).suffix.lower()
    if extension == ".pdf" or content_type == "application/pdf":
        text = _pdf_text(path)
        result = _amount_from_text(text)
        result.update(_date_from_text(text))
        result["source"] = "PDF text"
        result["ocrUsed"] = False
        if (
            result["amount"] is not None
            and result["confidence"] != "Low"
            and result["date"]
        ):
            return result
        ocr_text = _ocr_pdf(path)
        ocr_amount = _amount_from_text(ocr_text)
        ocr_date = _date_from_text(ocr_text)
        if ocr_amount["amount"] is not None:
            result.update(ocr_amount)
        if ocr_date["date"]:
            result.update(ocr_date)
        if ocr_text:
            result["source"] = "Scanned document OCR"
            result["ocrUsed"] = True
        if not result["date"]:
            result.update(_date_from_filename(original_name))
        return result
    ocr_text = _ocr_image(path)
    result = _amount_from_text(ocr_text)
    result.update(_date_from_text(ocr_text))
    if not result["date"]:
        result.update(_date_from_filename(original_name))
    result["source"] = "Receipt image OCR"
    result["ocrUsed"] = True
    return result


def submission_totals(data: dict, event_id) -> dict:
    totals = {
        "invoice": 0.0,
        "claims": 0.0,
        "transport": 0.0,
        "combined": 0.0,
        "departments": {},
    }
    event_rows = _dict(_dict(data.get("submissions")).get(str(event_id)))
    assignments = event_assignments(data, event_id)
    assignment_departments = {}
    for assignment in assignments:
        if not isinstance(assignment, dict):
            continue
        freelancer_id = str(
            assignment.get("freelancerId")
            or assignment.get("vendorId")
            or ""
        )
        department = str(assignment.get("department") or "Unassigned")
        assignment_departments.setdefault(freelancer_id, [])
        if department not in assignment_departments[freelancer_id]:
            assignment_departments[freelancer_id].append(department)

    def add_department(department, kind, amount):
        row = totals["departments"].setdefault(
            department or "Unassigned",
            {"invoice": 0.0, "claims": 0.0, "combined": 0.0},
        )
        row[kind] += amount
        row["combined"] += amount

    for freelancer_id, rows in event_rows.items():
        rows = _dict(rows)
        for invoice in _list(rows.get("invoices")):
            if not isinstance(invoice, dict) or invoice.get("status") == "Denied":
                continue
            amount = money(invoice.get("amount"), 0.0) or 0.0
            totals["invoice"] += amount
            allocations = _list(invoice.get("allocations"))
            allocated = 0.0
            for allocation in allocations:
                if not isinstance(allocation, dict):
                    continue
                allocation_amount = money(allocation.get("amount"), 0.0) or 0.0
                allocated += allocation_amount
                add_department(
                    str(allocation.get("department") or "Unassigned"),
                    "invoice",
                    allocation_amount,
                )
            remainder = round(amount - allocated, 2)
            if remainder > 0:
                departments = assignment_departments.get(str(freelancer_id), [])
                add_department(
                    departments[0] if len(departments) == 1 else "Unallocated",
                    "invoice",
                    remainder,
                )

        for claim in _list(rows.get("claims")):
            if (
                not isinstance(claim, dict)
                or claim.get("status") == "Denied"
                or (
                    "detailsComplete" in claim
                    and not claim.get("detailsComplete")
                )
            ):
                continue
            amount = money(claim.get("amount"), 0.0) or 0.0
            totals["claims"] += amount
            add_department(
                str(claim.get("department") or "Unassigned"), "claims", amount
            )

    for booking in event_bookings(data, event_id):
        if not isinstance(booking, dict) or booking.get("status") == "Denied":
            continue
        trip_cost = money(booking.get("cost"), 0.0) or 0.0
        totals["transport"] += trip_cost * (
            2 if booking.get("twoWay") else 1
        )

    totals["combined"] = totals["invoice"] + totals["claims"]
    for key in ("invoice", "claims", "transport", "combined"):
        totals[key] = round(totals[key], 2)
    for row in totals["departments"].values():
        for key in row:
            row[key] = round(row[key], 2)
    return totals


def build_zip(data_folder: str, records: list[dict]) -> io.BytesIO:
    output = io.BytesIO()
    used_names = set()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for record in records:
            path = upload_absolute_path(data_folder, record.get("storedPath"))
            if not path or not os.path.isfile(path):
                continue
            name = _safe_original_name(record.get("originalName"))
            stem, extension = os.path.splitext(name)
            candidate = name
            counter = 2
            while candidate.lower() in used_names:
                candidate = f"{stem}_{counter}{extension}"
                counter += 1
            used_names.add(candidate.lower())
            archive.write(path, candidate)
    output.seek(0)
    return output
