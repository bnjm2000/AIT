"""Company-scoped manpower, transport, and worker-submission persistence."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from PIL import Image, ImageOps

from storage_paths import documents_root_for_data_folder


WORKFORCE_FILENAME = "Workforce.json"
UPLOAD_FOLDERNAME = "workforce_uploads"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
VALID_STATUSES = {"Pending Review", "Approved", "Denied", "Paid"}
INVOICE_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
CLAIM_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
TRANSPORT_EXTENSIONS = set(INVOICE_EXTENSIONS)
INVOICE_SPREADSHEET_EXTENSIONS = {".xls", ".xlsx"}

_STORE_LOCKS: dict[str, threading.RLock] = {}
_STORE_LOCKS_GUARD = threading.RLock()
_DOCUMENT_STORES = {}
_OCR_ENGINE = None
_OCR_ENGINE_LOCK = threading.RLock()
DOCUMENT_EXTRACTOR_VERSION = 3


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def money(value, default=None):
    if value in (None, ""):
        return default
    try:
        amount = Decimal(str(value).replace(",", "").strip())
        if not amount.is_finite() or amount < 0:
            return default
        return float(amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, OverflowError):
        return default


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


def normalize_call_times(value) -> dict:
    """Return valid ISO-date to 24-hour call-time mappings."""
    source = value if isinstance(value, dict) else {}
    normalized = {}
    for raw_date, raw_time in source.items():
        date_value = str(raw_date or "").strip()
        time_value = str(raw_time or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
            continue
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", time_value):
            continue
        normalized[date_value] = time_value
    return normalized


def normalize_schedule_date_values(value, *, uppercase=False, max_length=100) -> dict:
    """Return safe ISO-date mappings used by per-day schedule overrides."""
    source = value if isinstance(value, dict) else {}
    normalized = {}
    for raw_date, raw_value in source.items():
        date_value = str(raw_date or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
            continue
        text_value = str(raw_value or "").strip()[:max_length]
        normalized[date_value] = text_value.upper() if uppercase else text_value
    return normalized


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
        "vehicles": [],
        "vehicleBookings": [],
        "submissions": {},
        "updatedAt": "",
    }


def _store_path(data_folder: str) -> str:
    return os.path.join(os.path.abspath(data_folder), WORKFORCE_FILENAME)


def register_company_document_store(data_folder, loader, saver) -> None:
    """Route structured workforce data for a folder to its SQL manager."""
    _DOCUMENT_STORES[os.path.abspath(data_folder)] = (loader, saver)


def _document_store(data_folder):
    return _DOCUMENT_STORES.get(os.path.abspath(data_folder))


def _lock_for(data_folder: str) -> threading.RLock:
    path = _store_path(data_folder)
    with _STORE_LOCKS_GUARD:
        return _STORE_LOCKS.setdefault(path, threading.RLock())


def _list(value):
    return value if isinstance(value, list) else []


def _dict(value):
    return value if isinstance(value, dict) else {}


def _transport_location_parts(name, address=""):
    location_name = str(name or "").strip()
    location_address = str(address or "").strip()
    if not location_address:
        matched = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", location_name)
        if matched:
            location_name = matched.group(1).strip()
            location_address = matched.group(2).strip()
    return location_name, location_address


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
            "vehicles": _list(source.get("vehicles")),
            "vehicleBookings": _list(source.get("vehicleBookings")),
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
    for assignments in normalized["assignments"].values():
        for assignment in _list(assignments):
            if isinstance(assignment, dict):
                assignment["callTimes"] = normalize_call_times(
                    assignment.get("callTimes")
                )
                assignment["dateDepartments"] = normalize_schedule_date_values(
                    assignment.get("dateDepartments"), uppercase=True, max_length=12
                )
                assignment["dateRoles"] = normalize_schedule_date_values(
                    assignment.get("dateRoles")
                )
    for vehicle in normalized["vehicles"]:
        if isinstance(vehicle, dict):
            vehicle.pop("capacity", None)
    for location in normalized["transportLocations"]:
        if not isinstance(location, dict):
            continue
        name, address = _transport_location_parts(
            location.get("name"), location.get("address")
        )
        location["name"] = name
        location["address"] = address
    for bookings in normalized["transportBookings"].values():
        for booking in _list(bookings):
            if not isinstance(booking, dict):
                continue
            for field in ("From", "To"):
                name, address = _transport_location_parts(
                    booking.get(f"location{field}Name")
                    or booking.get(f"location{field}"),
                    booking.get(f"location{field}Address"),
                )
                booking[f"location{field}"] = name
                booking[f"location{field}Name"] = name
                booking[f"location{field}Address"] = address
    return normalized


def load_workforce(data_folder: str) -> dict:
    store = _document_store(data_folder)
    if store:
        return normalize_workforce(store[0]('workforce', None))
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
    normalized = normalize_workforce(data)
    normalized["updatedAt"] = now_iso()
    store = _document_store(data_folder)
    if store:
        store[1]('workforce', normalized)
        return normalized
    path = _store_path(data_folder)
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


def _safe_storage_segment(value) -> str:
    """Return a stable filesystem-safe segment without changing logical IDs."""
    raw = str(value or "transport").strip() or "transport"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._") or "item"
    if safe == raw:
        return safe
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
    return f"{safe}-{digest}"


def _validate_magic(content: bytes, extension: str) -> bool:
    if extension == ".pdf":
        return content.startswith(b"%PDF")
    if extension == ".png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if extension in {".jpg", ".jpeg"}:
        return content.startswith(b"\xff\xd8\xff")
    if extension == ".xls":
        return content.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if extension == ".xlsx":
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                names = set(archive.namelist())
                return (
                    "[Content_Types].xml" in names
                    and any(name.startswith("xl/") for name in names)
                )
        except (OSError, ValueError, zipfile.BadZipFile):
            return False
    return False


def save_upload(
    data_folder: str,
    uploaded_file,
    event_id,
    freelancer_id,
    kind: str,
    *,
    allow_spreadsheets: bool = False,
) -> dict:
    original_name = _safe_original_name(getattr(uploaded_file, "filename", ""))
    extension = os.path.splitext(original_name)[1].lower()
    allowed = {
        "invoice": INVOICE_EXTENSIONS,
        "claim": CLAIM_EXTENSIONS,
        "transport": TRANSPORT_EXTENSIONS,
    }.get(kind, set())
    if allow_spreadsheets and kind in {"invoice", "transport"}:
        allowed = allowed | INVOICE_SPREADSHEET_EXTENSIONS
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
        _safe_storage_segment(freelancer_id),
    )
    document_root = os.path.abspath(documents_root_for_data_folder(data_folder))
    absolute_folder = os.path.abspath(os.path.join(document_root, relative_folder))
    if os.path.commonpath([document_root, absolute_folder]) != document_root:
        raise ValueError("Invalid upload path")
    os.makedirs(absolute_folder, exist_ok=True)

    stored_name = f"{kind}-{secrets.token_hex(12)}{extension}"
    absolute_path = os.path.join(absolute_folder, stored_name)
    with open(absolute_path, "wb") as handle:
        handle.write(content)

    return {
        "originalName": original_name,
        "storedPath": os.path.relpath(absolute_path, document_root).replace(os.sep, "/"),
        "size": len(content),
        "contentType": {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".xls": "application/vnd.ms-excel",
            ".xlsx": (
                "application/vnd.openxmlformats-officedocument."
                "spreadsheetml.sheet"
            ),
        }[extension],
    }


def upload_absolute_path(data_folder: str, stored_path: str) -> str | None:
    relative_path = str(stored_path or "").replace("/", os.sep)
    roots = [os.path.abspath(documents_root_for_data_folder(data_folder))]
    legacy_root = os.path.abspath(data_folder)
    if os.path.normcase(legacy_root) != os.path.normcase(roots[0]):
        roots.append(legacy_root)

    first_safe_candidate = None
    for root in roots:
        candidate = os.path.abspath(os.path.join(root, relative_path))
        try:
            if os.path.commonpath([root, candidate]) != root:
                continue
        except ValueError:
            continue
        first_safe_candidate = first_safe_candidate or candidate
        if os.path.isfile(candidate):
            return candidate
    return first_safe_candidate


def delete_upload(data_folder: str, record: dict) -> None:
    path = upload_absolute_path(data_folder, record.get("storedPath"))
    if path and os.path.isfile(path):
        os.remove(path)


def _pdf_text(path: str) -> str:
    text = ""
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        text = "\n".join(
            (page.extract_text() or "") for page in reader.pages[:8]
        )
        if text.strip() and not (len(text) > 400 and len(text.splitlines()) < 3):
            return text
    except Exception:
        pass
    try:
        import fitz

        document = fitz.open(path)
        try:
            return "\n".join(page.get_text("text") for page in list(document)[:8]) or text
        finally:
            document.close()
    except Exception:
        return text


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
            lines = _ocr_image_regions(engine, ImageOps.exif_transpose(image).convert("RGB"))
        return "\n".join(lines)
    except Exception:
        return ""


_AMOUNT_RE = re.compile(
    r"(?<![A-Za-z0-9.,])"
    r"(?P<currency>SGD|S\$|\$)?\s*"
    r"(?P<amount>(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[\.,]\d{1,2})?)"
    r"(?![.,]\d)(?=SGD\b|[^A-Za-z0-9]|$)",
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


def _amount_candidate_feature(lines, line_index, match_index):
    """Hash a value-independent layout cue; never retain document text in a model."""
    line = lines[line_index].lower()
    if not re.search(r"[a-z]{3}", line) and line_index:
        line = lines[line_index - 1].lower() + " | " + line
    line = re.sub(r"\btota[i1l]\b", "total", line)
    line = re.sub(r"\d+(?:[.,]\d+)*", "#", line)
    line = re.sub(r"\s+", " ", line).strip()
    return hashlib.sha256(f"{line}|candidate:{match_index}".encode()).hexdigest()


def _amount_candidates(text: str) -> list:
    candidates = []
    keyword_scores = (
        ("实付款", 125),
        ("实付金额", 125),
        ("total amount due", 125),
        ("total amount", 118),
        ("total payable", 110),
        ("amount payable", 105),
        ("amount due", 100),
        ("balance due", 98),
        ("grand total", 95),
        ("other total", 102),
        ("mop ", 98),
        ("total due", 94),
        ("net total", 90),
        ("total incl", 88),
        ("total including", 88),
        ("invoice total", 86),
        ("paid amount", 100),
        ("parking fee", 100),
        ("total", 65),
    )
    lines = [
        re.sub(r'(?<=\$)[Oo](?=\.\d{2}\b)', '0',
               re.sub(r'\bS[S5](?=\s*\d[\d,]*\.\d{2}\b)', 'S$',
                      re.sub(r"\s+", " ", raw_line).strip()))
        for raw_line in str(text or "").splitlines()
        if raw_line.strip()
    ]
    for line_index, line in enumerate(lines):
        lowered = re.sub(r"\btota[i1l]\b", "total", line.lower())
        # Dates, times and segmented account/reference numbers are not money.
        # They can otherwise inherit a neighbouring total's score, or overflow
        # Decimal when OCR reads a barcode as a long run of digits.
        non_amount_spans = [
            match.span()
            for pattern in (*_DATE_PATTERNS,
                            re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"),
                            re.compile(r"(?<!\w)\d+(?:[-/]\d+)+(?!\w)"))
            for match in pattern.finditer(line)
        ]
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
        for match_index, match in enumerate(_AMOUNT_RE.finditer(line)):
            raw_amount = match.group("amount")
            amount = _invoice_amount_number(raw_amount)
            has_currency = bool(match.group("currency"))
            has_decimal = bool(re.search(r"[\.,]\d{1,2}$", raw_amount))
            if amount is None or amount <= 0:
                continue
            if any(start < match.end('amount') and end > match.start('amount')
                   for start, end in non_amount_spans):
                continue
            if len(re.sub(r'\D', '', raw_amount.split('.')[0])) > 12:
                continue
            if re.match(
                r"\s*[)\]]?\s*(?:%|percent\b)",
                line[match.end():],
                re.IGNORECASE,
            ):
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
            if re.search(
                r"\b(?:total\s+)?includes?\s+(?:gst|tax)\s+(?:of|[:=])",
                lowered,
            ):
                # This wording labels the tax component, not the payable total
                # (for example, "TOTAL INCLUDES GST OF 4.19").
                score -= 180
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
            if any(
                phrase in lowered
                for phrase in (
                    "late fee",
                    "late charge",
                    "payment term",
                    "upon receipt",
                    "months of no payment",
                )
            ):
                score -= 120
            if re.search(r'\b(?:card\s+balance|remaining\s+balance|stored\s+value)\b', lowered):
                score -= 140
            if has_currency or "sgd" in lowered or "s$" in lowered:
                score += 5
            if has_decimal:
                score += 3
            if re.search(
                r'\b(?:total(?:\s+(?:amount(?:\s+due)?|due|payable|fee|price))?'
                r'|amount\s+(?:due|payable)|balance\s+due)'
                r'\s*[:=\-]?\s*(?:\([^\d)]*\))?\s*(?:SGD|S\$|\$)?\s*$',
                lowered[:match.start('amount')], re.I,
            ) and not re.search(r'\bsub[ -]?total\b', lowered[:match.start('amount')], re.I):
                score += 45
            if any(label in lowered for label in ('实付款', '实付金额')) and has_currency:
                score += 45
            if not has_currency and not has_decimal:
                if amount >= 1000000:
                    score -= 140
                elif re.search(r'(?:\$\s*\d|\d[.,]\d{2}(?!\d))', line):
                    # A quantity beside a price must not beat that price just
                    # because the quantity repeats in every item row.
                    score -= 90
            if re.fullmatch(r'(?:SGD|S\$|\$)\s*[\d, .]+|[\d, .]+\s*(?:SGD|S\$|\$)', line, re.I):
                score = max(score, 75)
            if line_index and re.fullmatch(r'(?:SGD|S\$|\$)?\s*[\d, .]+\s*\$?', line, re.I):
                if re.fullmatch(r'(?:total(?:\s+(?:amount(?:\s+due)?|due|payable|fee))?'
                                r'|amount\s+(?:due|payable)|balance\s+due)\s*[:=\-]?',
                                lines[line_index - 1], re.I):
                    score += 45
            if re.search(r'\b(?:give|save|refer(?:ral)?|promo|voucher|cashback)\b', lowered):
                score -= 120
            if (
                not has_decimal
                and not has_currency
                and 1900 <= amount <= 2100
                and "total" not in lowered
            ):
                score -= 80
            if lines:
                score += int((line_index / len(lines)) * 8)
            candidates.append((
                score, line_index, amount, line,
                _amount_candidate_feature(lines, line_index, match_index),
            ))

    if not candidates:
        return []
    # Some invoices finish with "Subtotal" and have no tax or grand-total
    # section. Penalising that sole summary below item prices loses the total.
    final_total = re.compile(r'\b(?:total|amount\s+(?:due|payable)|balance\s+due)\b', re.I)
    has_final_total = any(
        final_total.search(line)
        and not re.search(r'\bsub[ -]?total\b|\btotal\s+includes?\s+(?:gst|tax)\s+of\b', line, re.I)
        for score, index, amount, line, feature in candidates
    )
    if not has_final_total:
        subtotal_values = {}
        for _score, index, _amount, line, _feature in candidates:
            label = re.search(r'\bsub[ -]?total\b', line, re.I)
            value = _AMOUNT_RE.search(line, label.end()) if label else None
            if value:
                subtotal_values[index] = _invoice_amount_number(value.group('amount'))
        candidates = [
            (max(score, 100) if subtotal_values.get(index) == amount
             else score, index, amount, line, feature)
            for score, index, amount, line, feature in candidates
        ]
    occurrence_counts = {}
    for _score, _line_index, candidate_amount, _line, _feature in candidates:
        amount_key = round(candidate_amount, 2)
        occurrence_counts[amount_key] = occurrence_counts.get(amount_key, 0) + 1
    candidates = [
        (
            score + min(24, max(0, occurrence_counts[round(amount, 2)] - 1) * 12),
            line_index,
            amount,
            line,
            feature,
        )
        for score, line_index, amount, line, feature in candidates
    ]
    return [
        {'score': score, 'lineIndex': index, 'amount': amount,
         'matchedText': line[:240], 'feature': feature}
        for score, index, amount, line, feature in candidates
    ]


def _amount_from_text(text: str, learning_profile=None) -> dict:
    candidates = _amount_candidates(text)
    if not candidates:
        return {"amount": None, "confidence": "Low", "matchedText": ""}
    profile = learning_profile or {}
    for candidate in candidates:
        candidate['score'] += profile.get(candidate['feature'], 0)
    candidates.sort(
        key=lambda row: (row['score'], row['lineIndex'], row['amount']),
        reverse=True,
    )
    best = candidates[0]
    score, amount, line = best['score'], best['amount'], best['matchedText']
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
        r"(?P<month>0?[1-9]|1[0-2])\s*[./-]\s*(?P<day>0?[1-9]|[12]\d|3[01])(?=$|[^\d]|\d{1,2}:)"
    ),
    re.compile(
        r"(?<!\d)(?P<day>0?[1-9]|[12]\d|3[01])\s*[./-]\s*"
        r"(?P<month>0?[1-9]|[12]\d|3[01])\s*[./-]\s*"
        r"(?P<year>(?:19|20)\d{2}|\d{2})(?=$|[^\d]|\d{1,2}:)"
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

_INVOICE_DUE_DATE_LABEL = re.compile(
    r"\b(?:due\s+date|date\s+due|payment\s+due|payment\s+deadline|"
    r"payable\s+(?:by|on)|pay\s+by|due\s+by)\b",
    re.IGNORECASE,
)
_INVOICE_REFERENCE_DATE_LABEL = re.compile(
    r"\b(?:invoice\s+date|date\s+of\s+invoice|date\s+issued|issued\s+date|"
    r"issue\s+date|submitted\s+date|submission\s+date)\b",
    re.IGNORECASE,
)
_INVOICE_EVENT_DATE_LABEL = re.compile(
    r"\b(?:event|service|job)\s+date\b",
    re.IGNORECASE,
)
_INVOICE_TERM_PATTERNS = (
    re.compile(
        r"\b(?:payment\s+)?(?:is\s+)?due\s*(?:in|within|:)?\s*"
        r"(?P<value>\d{1,3})\s*(?P<unit>days?|weeks?|months?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bpayment\s+(?:terms?|term\s+is)\s*(?:is|:|-)?\s*"
        r"(?:within\s+)?(?P<value>\d{1,3})\s*"
        r"(?P<unit>days?|weeks?|months?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bterms?\s*(?:is|:|-)?\s*net\s*(?P<value>\d{1,3})\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bterm\s*(?:is|:|-)?\s*(?P<value>\d{1,3})\s*"
        r"(?P<unit>days?|weeks?|months?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bpayment\s+is\s+to\s+be\s+made\s+within\s+"
        r"(?P<value>\d{1,3})\s*(?P<unit>days?|weeks?|months?)\b",
        re.IGNORECASE,
    ),
)


def _date_match_value(match):
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
        day = int(match.group("day"))
        # Only use month/day order when day/month is impossible;
        # ambiguous local documents remain day-first.
        if not month_name and month > 12 and day <= 12:
            day, month = month, day
        value = datetime(year, int(month), day)
    except (TypeError, ValueError):
        return None
    return value if 1990 <= value.year <= 2100 else None


def _line_date_matches(line):
    matches = []
    for pattern in _DATE_PATTERNS:
        for match in pattern.finditer(line):
            value = _date_match_value(match)
            if value is not None:
                matches.append((match.start(), value))
    return sorted(matches, key=lambda row: row[0])


def _labelled_invoice_date(lines, label_pattern):
    """Read a date on a labelled line or immediately after a lone label."""
    candidates = []
    for line_index, line in enumerate(lines):
        label = label_pattern.search(line)
        if not label:
            continue
        same_line = _line_date_matches(line)
        following = [row for row in same_line if row[0] >= label.end()]
        if following:
            # The closest following date belongs to this label when invoice
            # and due dates share a serialized table row.
            _position, value = min(following, key=lambda row: row[0])
            candidates.append((200, -line_index, value, line))
        elif same_line:
            # Some PDF tables serialize the value before its column label.
            _position, value = max(same_line, key=lambda row: row[0])
            candidates.append((150, -line_index, value, line))
        if same_line:
            continue
        for next_index in range(line_index + 1, min(len(lines), line_index + 3)):
            next_line = lines[next_index]
            if (
                _INVOICE_DUE_DATE_LABEL.search(next_line)
                or _INVOICE_REFERENCE_DATE_LABEL.search(next_line)
                or _INVOICE_EVENT_DATE_LABEL.search(next_line)
            ):
                break
            following = _line_date_matches(next_line)
            if following:
                candidates.append((130 - (next_index - line_index) * 10,
                                   -next_index, following[0][1], next_line))
                break
            if re.search(r"[A-Za-z]{3,}", next_line):
                break
    if not candidates:
        return {"date": "", "matchedText": ""}
    _score, _position, value, line = max(candidates)
    return {
        "date": value.strftime("%Y-%m-%d"),
        "matchedText": line[:240],
    }


def _invoice_term_from_text(text):
    # OCR often emits "three(3) months". The printed number is the reliable
    # part and lets the same patterns handle that form without word guessing.
    normalized = re.sub(
        r"\b[A-Za-z]+\s*\(\s*(\d{1,3})\s*\)",
        r"\1",
        str(text or ""),
    )
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in normalized.splitlines()
        if line.strip()
    ]
    for index, line in enumerate(lines):
        candidates = [line]
        if (
            index + 1 < len(lines)
            and re.fullmatch(
                r"(?:payment\s+due|payment\s+terms?|terms?)\s*:?\s*",
                line,
                re.IGNORECASE,
            )
        ):
            candidates.insert(0, f"{line} {lines[index + 1]}")
        for candidate in candidates:
            lowered = candidate.casefold()
            if any(phrase in lowered for phrase in (
                "late fee", "late payment", "overdue", "interest", "no payment",
            )):
                continue
            for pattern in _INVOICE_TERM_PATTERNS:
                match = pattern.search(candidate)
                if not match:
                    continue
                value = int(match.group("value"))
                if value > 730:
                    continue
                unit = str(match.groupdict().get("unit") or "days").lower()
                return {
                    "value": value,
                    "unit": "month" if unit.startswith("month") else (
                        "week" if unit.startswith("week") else "day"
                    ),
                    "matchedText": candidate[:240],
                }
    return {}


def _invoice_reference_date(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        pass
    for format_string in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw[:10], format_string)
        except ValueError:
            continue
    return None


def _add_invoice_term(reference, value, unit):
    if unit == "week":
        return reference + timedelta(days=value * 7)
    if unit != "month":
        return reference + timedelta(days=value)
    month_index = reference.month - 1 + value
    year = reference.year + month_index // 12
    month = month_index % 12 + 1
    if month == 12:
        next_month = datetime(year + 1, 1, 1)
    else:
        next_month = datetime(year, month + 1, 1)
    last_day = (next_month - timedelta(days=1)).day
    return reference.replace(year=year, month=month, day=min(reference.day, last_day))


def _invoice_due_date_from_text(text: str, submitted_at="") -> dict:
    """Extract an explicit invoice due date or resolve a printed payment term.

    No default term is invented. The Showbase submission timestamp is only a
    fallback reference when the document prints a term but no invoice/submitted
    date of its own.
    """
    lines = [re.sub(r"\s+", " ", line).strip() for line in str(text or "").splitlines() if line.strip()]
    explicit = _labelled_invoice_date(lines, _INVOICE_DUE_DATE_LABEL)
    invoice_date = _labelled_invoice_date(lines, _INVOICE_REFERENCE_DATE_LABEL)
    if explicit["date"]:
        return {
            "dueDate": explicit["date"],
            "dueDateSource": "Explicit due date",
            "dueDateMatchedText": explicit["matchedText"],
            "dueDateReferenceDate": invoice_date["date"],
            "invoiceDateMatchedText": invoice_date["matchedText"],
            "dueInDays": None,
        }

    term = _invoice_term_from_text(text)
    if not term:
        return {
            "dueDate": "",
            "dueDateSource": "",
            "dueDateMatchedText": "",
            "dueDateReferenceDate": invoice_date["date"],
            "invoiceDateMatchedText": invoice_date["matchedText"],
            "dueInDays": None,
        }

    reference_label = "invoice date"
    reference_value = invoice_date["date"]
    if re.search(r"\b(?:event|service|job)\s+date\b", term["matchedText"], re.IGNORECASE):
        event_date = _labelled_invoice_date(lines, _INVOICE_EVENT_DATE_LABEL)
        if event_date["date"]:
            reference_value = event_date["date"]
            reference_label = "event date"
    reference = _invoice_reference_date(reference_value)
    if reference is None:
        reference = _invoice_reference_date(submitted_at)
        reference_label = "Showbase upload date"
        reference_value = reference.strftime("%Y-%m-%d") if reference else ""
    due_date = _add_invoice_term(reference, term["value"], term["unit"]) if reference else None
    unit_label = term["unit"] + ("" if term["value"] == 1 else "s")
    return {
        "dueDate": due_date.strftime("%Y-%m-%d") if due_date else "",
        "dueDateSource": (
            f"{term['value']} {unit_label} from {reference_label}"
            if due_date else "Printed payment term; reference date unavailable"
        ),
        "dueDateMatchedText": term["matchedText"],
        "dueDateReferenceDate": reference_value,
        "invoiceDateMatchedText": invoice_date["matchedText"],
        "dueInDays": term["value"] if term["unit"] == "day" else None,
    }


def _date_from_text(text: str) -> dict:
    candidates = []
    # Scanners often join a time's minutes to the following receipt date.
    text = re.sub(r'(\b\d{1,2}:\d{2})(?=\d{2}[-/]\d{2}[-/]\d{4}\b)', r'\1 ', str(text or ''))
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in str(text or "").splitlines()
        if line.strip()
    ]
    entry_date_lines = {
        index for index, line in enumerate(lines)
        if re.match(r'^(?:in|entry)(?:\s+(?:date|time))*\s*[:\-]', line, re.I)
        and any(pattern.search(line) for pattern in _DATE_PATTERNS)
    }
    exit_date_lines = {
        index for index, line in enumerate(lines)
        # Thermal-receipt OCR commonly reads the T in OUT as F ("OUf").
        if re.match(r'^(?:[o0]u[tf]|exi[tl])(?:\s+(?:date|time))*\s*[:\-]', line, re.I)
        and any(pattern.search(line) for pattern in _DATE_PATTERNS)
    }
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
                    day = int(match.group('day'))
                    # Only use month/day order when day/month is impossible;
                    # ambiguous local receipts remain day-first.
                    if not month_name and month > 12 and day <= 12:
                        day, month = month, day
                    value = datetime(
                        year, int(month), day
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
                # Overnight parking receipts can show both dates. The charge is
                # incurred at exit, not at entry on the previous calendar day.
                if entry_date_lines and exit_date_lines:
                    if line_index in exit_date_lines:
                        score += 140
                    elif line_index in entry_date_lines:
                        score -= 60
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


def _unlabelled_invoice_table_total(text: str):
    """Confirm a printed summary against dated rows in a single amount column.

    Some spreadsheet-exported invoices have no total label and serialize their
    cells out of visual order. Arithmetic is only supporting evidence: the total
    must already be printed below the rows, never synthesized from them.
    """
    lines = [re.sub(r'\s+', ' ', line).strip() for line in text.splitlines() if line.strip()]
    item_cents = []
    totals = []
    in_table = False
    for line in lines:
        if (re.search(r'\bdate\b', line, re.I)
                and re.search(r'\bamount(?:\s*\(SGD\))?\s*$', line, re.I)
                and re.search(r'\b(?:description|venue|role)\b', line, re.I)):
            item_cents = []
            in_table = True
            continue
        if not in_table:
            continue
        if any(pattern.search(line) for pattern in _DATE_PATTERNS):
            amounts = [match for match in _AMOUNT_RE.finditer(line)
                       if match.group('currency') or re.search(r'[.,]\d{2}$', match.group('amount'))]
            # Multiple price columns or an unreadable row cannot substantiate
            # the summary. Leave those documents to the established detector.
            if len(amounts) != 1:
                in_table = False
                continue
            value = _invoice_amount_number(amounts[0].group('amount'))
            if value is None:
                in_table = False
                continue
            item_cents.append(round(value * 100))
            continue
        summary = _AMOUNT_RE.fullmatch(line)
        if summary and summary.group('currency') and item_cents:
            value = _invoice_amount_number(summary.group('amount'))
            if value is not None and value > 0 and round(value * 100) == sum(item_cents):
                totals.append(value)
            in_table = False
        elif re.search(r'\b(?:bank|payment|subtotal|total|discount|tax|gst)\b', line, re.I):
            in_table = False
    return totals[0] if len(totals) == 1 else None


def _pdf_invoice_table_text(path: str) -> str:
    """Use visual PDF order only when its printed, unlabelled sum is verified."""
    try:
        import fitz

        with fitz.open(path) as document:
            text = '\n'.join(page.get_text('text', sort=True) for page in list(document)[:8])
        total = _unlabelled_invoice_table_total(text)
        if total is not None and _amount_from_text(text)['amount'] == total:
            return text
    except Exception:
        pass
    return ''


def _document_extraction_text(path: str, kind: str, content_type: str = "") -> dict:
    """Shared routing for live extraction and offline calibration.

    Missing receipt dates can justify OCR without discarding a better native
    amount. Routing is independent of learned scores to avoid training drift.
    """
    is_pdf = Path(path).suffix.lower() == '.pdf' or content_type == 'application/pdf'
    if not is_pdf:
        text = _ocr_image(path)
        return {'text': text, 'dateText': text, 'source': 'Receipt image OCR', 'ocrUsed': True}
    native = _pdf_text(path)
    source = 'PDF text'
    if kind == 'invoice' and not re.search(r'\b(?:total|subtotal|payable|amount\s+due)\b', native, re.I):
        layout = _pdf_invoice_table_text(path)
        if layout:
            native, source = layout, 'PDF table layout'
    baseline = _amount_from_text(native)
    date = _date_from_text(native) if kind == 'claim' else {}
    single_letters = len(re.findall(r'\b[A-Za-z]\b', native))
    fragmented = single_letters > 30 and single_letters > len(re.findall(r'\b[A-Za-z]{2,}\b', native))
    unlabelled_invoice = (kind == 'invoice' and source != 'PDF table layout' and baseline['confidence'] != 'High'
                          and not re.search(r'\b(?:total|subtotal|payable|amount\s+due)\b', native, re.I))
    result = {'text': native, 'dateText': native, 'source': source, 'ocrUsed': False}
    if not fragmented and not unlabelled_invoice and baseline['amount'] is not None and baseline['confidence'] != 'Low' and (kind != 'claim' or date.get('date')):
        return result
    scanned = _ocr_pdf(path)
    ocr_amount = _amount_from_text(scanned)
    ranks = {'Low': 0, 'Medium': 1, 'High': 2}
    if ocr_amount['amount'] is not None and (
        baseline['amount'] is None
        or fragmented
        or ranks[ocr_amount['confidence']] > ranks[baseline['confidence']]
        or baseline['confidence'] == ocr_amount['confidence'] == 'Low'
        or (unlabelled_invoice and ranks[ocr_amount['confidence']] >= ranks[baseline['confidence']])
    ):
        result.update(text=scanned, source='Scanned document OCR', ocrUsed=True)
    if kind == 'claim' and not date.get('date') and _date_from_text(scanned)['date']:
        result.update(dateText=scanned, ocrUsed=True)
    return result


def _spreadsheet_invoice_text(path: str) -> str:
    try:
        from spreadsheet_preview import read_spreadsheet_preview

        workbook = read_spreadsheet_preview(path)
        return "\n".join(
            " ".join(
                str(cell.get("text") or "").strip()
                for cell in row
                if isinstance(cell, dict) and str(cell.get("text") or "").strip()
            )
            for sheet in workbook.get("sheets", [])
            if isinstance(sheet, dict)
            for row in sheet.get("rows", [])
            if isinstance(row, list)
        )
    except (OSError, ValueError, TypeError):
        return ""


def extract_invoice_amount(path: str, *, data_folder=None, submitted_at="") -> dict:
    from document_learning import load_amount_profile

    profile = load_amount_profile(data_folder, 'invoice')
    if Path(path).suffix.lower() in INVOICE_SPREADSHEET_EXTENSIONS:
        result = {
            "amount": None,
            "confidence": "Low",
            "source": "Spreadsheet - manual review",
            "matchedText": "",
            "ocrUsed": False,
        }
        result.update(_invoice_due_date_from_text(
            _spreadsheet_invoice_text(path), submitted_at
        ))
        return result
    document = _document_extraction_text(path, 'invoice')
    result = _amount_from_text(document['text'], profile)
    result.update(_invoice_due_date_from_text(document['text'], submitted_at))
    result.update(source=document['source'], ocrUsed=document['ocrUsed'])
    return _local_submission_amount(result)


def extract_claim_amount(
    path: str,
    content_type: str = "",
    original_name: str = "",
    *,
    data_folder=None,
) -> dict:
    from document_learning import load_amount_profile

    profile = load_amount_profile(data_folder, 'claim')
    document = _document_extraction_text(path, 'claim', content_type)
    result = _amount_from_text(document['text'], profile)
    result.update(_date_from_text(document['dateText']))
    if not result["date"]:
        result.update(_date_from_filename(original_name))
    result.update(source=document['source'], ocrUsed=document['ocrUsed'])
    return _local_submission_amount(result)


def _local_submission_amount(result: dict) -> dict:
    """Foreign totals need the actual SGD charge, which OCR cannot infer."""
    line = result.get('matchedText', '')
    if (re.search(r'\b(?:EUR|USD|GBP|CNY|RMB|MYR)\b|[€£¥￥]|US\$', line, re.I)
            and not re.search(r'SGD|(?<![A-Za-z])S\$', line, re.I)):
        return {**result, 'amount': None, 'confidence': 'Low',
                'source': 'Foreign currency - enter SGD amount'}
    return result


def transport_company_invoices(booking):
    """Return company invoices from the current list and legacy single record."""
    if not isinstance(booking, dict):
        return []
    records = []
    seen = set()
    for record in _list(booking.get('companyInvoices')) + [booking.get('companyInvoice')]:
        if not isinstance(record, dict):
            continue
        identity = str(record.get('id') or id(record))
        if identity in seen:
            continue
        seen.add(identity)
        records.append(record)
    return records


def transport_company_groups(bookings, profiles=()):
    """Group event bookings by company and collect each company invoice once."""
    profiles_by_id = {str(row.get('id')): row for row in profiles if isinstance(row, dict)}
    grouped = {}
    for booking in bookings:
        if not isinstance(booking, dict):
            continue
        fleet = str(booking.get('sourceType') or '').lower() == 'fleet'
        profile = profiles_by_id.get(str(booking.get('vendorId') or ''), {})
        company = 'Own fleet' if fleet else (
            str(booking.get('company') or '').strip() or str(profile.get('company') or '').strip()
        )
        key = 'fleet' if fleet else (
            'company:' + ' '.join(company.casefold().split()) if company
            else 'vendor:' + str(booking.get('vendorId') or booking.get('id') or '')
        )
        group = grouped.setdefault(key, {
            'key': key, 'company': company or 'External transport',
            'isFleet': fleet, 'bookings': [], 'invoice': None, 'invoices': [],
            'invoiceBookingId': '', 'estimatedCost': 0.0,
        })
        group['bookings'].append(booking)
        if booking.get('status') != 'Denied':
            group['estimatedCost'] += (money(booking.get('cost'), 0) or 0) * (2 if booking.get('twoWay') else 1)
        known_invoice_ids = {
            str(row.get('id') or id(row)) for row in group['invoices']
        }
        for invoice in transport_company_invoices(booking):
            identity = str(invoice.get('id') or id(invoice))
            if identity not in known_invoice_ids:
                group['invoices'].append(invoice)
                known_invoice_ids.add(identity)
        if group['invoices']:
            # Keep the singular alias while older clients transition to invoices.
            group['invoice'] = group['invoices'][-1]
            group['invoiceBookingId'] = str(group['bookings'][0].get('id') or '')
    for group in grouped.values():
        group['estimatedCost'] = round(group['estimatedCost'], 2)
        invoice_amounts = [
            money(invoice.get('amount'))
            for invoice in group['invoices']
            if invoice.get('status') != 'Denied'
            and money(invoice.get('amount')) is not None
        ]
        group['cost'] = (
            round(sum(invoice_amounts), 2)
            if invoice_amounts else group['estimatedCost']
        )
    return sorted(grouped.values(), key=lambda group: group['company'].casefold())


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
        if assignment.get("subjectType") == "app-user":
            username = str(assignment.get("userUsername") or "")
            freelancer_id = f"user:{username}" if username else ""
        else:
            freelancer_id = str(
                assignment.get("freelancerId")
                or assignment.get("vendorId")
                or ""
            )
        department = str(
            assignment.get("department")
            or ("FT" if assignment.get("subjectType") == "app-user" else "Unassigned")
        )
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

    totals['transport'] = sum(group['cost'] for group in transport_company_groups(event_bookings(data, event_id), data.get('transportVendors', [])))

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
