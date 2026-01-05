import os
import sys
import re
import subprocess
import io
from collections import defaultdict

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def pause():
    input("\nPress Enter to continue...")

def sanitize_filename(filename):
    return re.sub(r'[<>:"/\\|?*]', '_', filename)

def play_sound(success=True):
    if sys.platform == 'darwin':  # Check if the OS is macOS
        if success:
            subprocess.Popen(['afplay', '/System/Library/Sounds/Glass.aiff'])
        else:
            subprocess.Popen(['afplay', '/System/Library/Sounds/Sosumi.aiff'])

def get_state_color(state):
    if state == 'Added':
        return '\033[94m'  # Blue
    elif state == 'Preparing':
        return '\033[93m'  # Yellow
    elif state == 'Ready':
        return '\033[92m'  # Green
    elif state == 'Returning':
        return '\033[95m'  # Magenta
    elif state == 'Closed':
        return '\033[90m'  # Gray
    else:
        return '\033[0m'   # Default

def get_colored_item_description(model_description):
    # Define color codes
    color_codes = {
        "AX": "\033[94m",    # Blue
        "LX": "\033[92m",    # Green
        "VX": "\033[95m",    # Purple
        "LOAN": "\033[91m",  # Red
        "MISC": "\033[93m",  # Yellow
        "DEFAULT": "\033[0m", # Reset
    }
    
    # Determine the department code from the model_description
    if model_description.startswith('[LOAN]'):
        color = color_codes["LOAN"]
        description = model_description[7:].strip()
    elif model_description.startswith('[MISC]'):
        color = color_codes["MISC"]
        description = model_description[6:].strip()
    elif model_description.startswith('[LX]'):
        color = color_codes["LX"]
        description = model_description[4:].strip()
    elif model_description.startswith('[AX]'):
        color = color_codes["AX"]
        description = model_description[4:].strip()
    elif model_description.startswith('[VX]'):
        color = color_codes["VX"]
        description = model_description[4:].strip()
    else:
        color = color_codes["DEFAULT"]
        description = model_description

    return f"{color}{model_description}\033[0m"

def sort_items_for_display(items):
    def sort_key(item):
        if isinstance(item, dict):
            description = item.get('model_description', '')
        elif hasattr(item, 'department_code'):  # InventoryItem
            description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
        elif isinstance(item, str):
            description = item
        else:
            description = ''

        if '[LOAN]' in description:
            return (2, description.lower())  # Loan items come last
        elif '[MISC]' in description:
            return (1, description.lower())  # Misc items come second to last
        else:
            return (0, description.lower())  # Regular items first

    return sorted(items, key=sort_key)

def group_items_by_model(items):
    groups = defaultdict(int)
    for item in items:
        if hasattr(item, 'department_code'):  # InventoryItem
            key = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
        elif isinstance(item, str):
            key = item  # Assuming it's a model description string
        else:
            raise ValueError("Unexpected item type for grouping.")

        groups[key] += 1

    # Sort groups such that loan and misc items appear last
    sorted_keys = sorted(groups.keys(), key=lambda k: (not ("[LOAN]" in k or "[MISC]" in k), k.lower()))
    
    return {key: groups[key] for key in sorted_keys}

# --- robust csv helpers ---

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
