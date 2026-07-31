from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")
APP_PY = (ROOT / "app.py").read_text(encoding="utf-8")
INDEX = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
SPLIT_CSS = (ROOT / "static" / "css" / "split-screen.css").read_text(encoding="utf-8")
WORKER_CSS = (ROOT / "static" / "css" / "worker.css").read_text(encoding="utf-8")


def test_compact_navigation_uses_split_screen_breakpoint():
    assert 'const COMPACT_NAVIGATION_MEDIA = "(max-width: 1300px)"' in APP_JS
    assert "window.matchMedia(COMPACT_NAVIGATION_MEDIA)" in APP_JS
    assert "css/split-screen.css" in INDEX
    assert "split_screen_css_version=_static_asset_version('css/split-screen.css')" in APP_PY


def test_split_screen_shell_releases_sidebar_width():
    assert "@media (min-width: 769px) and (max-width: 1300px)" in SPLIT_CSS
    assert "#appShell.nav-collapsed > .sidebar" in SPLIT_CSS
    assert "#appShell .mobile-nav-toggle" in SPLIT_CSS
    assert "height: calc(100dvh - 78px)" in SPLIT_CSS


def test_laptop_desktop_view_uses_eighty_percent_ui_scale():
    assert "(min-width: 1301px) and (max-width: 1512px) and (max-height: 982px)" in SPLIT_CSS
    assert "--ui-scale: 0.8" in SPLIT_CSS


def test_wide_content_scrolls_inside_its_panel():
    assert '[class*="table-wrap"]' in SPLIT_CSS
    assert '[class*="table-container"]' in SPLIT_CSS
    assert "overflow-x: auto" in SPLIT_CSS
    assert "#appShell .content-area" in SPLIT_CSS
    assert "overflow-x: hidden" in SPLIT_CSS
    assert "width: 100% !important" in SPLIT_CSS


def test_worker_portal_enters_compact_navigation_earlier():
    assert "@media (max-width: 1100px)" in WORKER_CSS
