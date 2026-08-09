from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")
APP_PY = (ROOT / "app.py").read_text(encoding="utf-8")
INDEX = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
SETTINGS_CSS = (ROOT / "static" / "css" / "settings.css").read_text(encoding="utf-8")


def test_settings_stylesheet_is_versioned_and_theme_driven():
    assert "css/settings.css" in INDEX
    assert "v=settings_css_version" in INDEX
    assert "settings_css_version=_static_asset_version('css/settings.css')" in APP_PY
    assert "var(--theme-primary" in SETTINGS_CSS
    assert "--settings-accent" in SETTINGS_CSS


def test_companies_page_retains_actions_with_custom_company_picker():
    start = APP_JS.index("function ensureCompanyManagementSection")
    end = APP_JS.index("async function deleteCompanyAdmin", start)
    companies_ui = APP_JS[start:end]

    assert 'id="activeCompanySelect" type="hidden"' in companies_ui
    assert "function toggleCompanySwitcher" in companies_ui
    assert "function chooseCompanyForSwitch" in companies_ui
    assert 'onclick="switchCompanyAdmin()"' in companies_ui
    assert 'onclick="loadCompaniesAdmin()"' in companies_ui
    assert "openCompanyStorageBreakdown" in companies_ui
    assert "company.roleCounts" in companies_ui


def test_company_directory_has_compact_and_mobile_layouts():
    assert ".companies-admin-table td" in SETTINGS_CSS
    assert "border-bottom: 2px solid #e6eeeb" in SETTINGS_CSS
    assert "@media (max-width: 700px)" in SETTINGS_CSS
    assert "content: attr(data-label)" in SETTINGS_CSS


def test_change_password_page_keeps_form_contract_and_visibility_controls():
    start = APP_JS.index("function ensureChangePasswordSection")
    end = APP_JS.index("async function setupAdminUserManagementTab", start)
    password_ui = APP_JS[start:end]

    assert 'id="changePasswordForm"' in password_ui
    assert 'onsubmit="submitChangePassword(event)"' in password_ui
    assert 'id="currentPasswordInput"' in password_ui
    assert 'id="newPasswordInput"' in password_ui
    assert 'id="confirmPasswordInput"' in password_ui
    assert "function toggleSettingsPasswordVisibility" in password_ui
    assert "'/api/current-user/password'" in password_ui


def test_change_password_layout_collapses_cleanly_on_mobile():
    assert ".password-new-grid" in SETTINGS_CSS
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in SETTINGS_CSS
    assert "grid-template-columns: 1fr" in SETTINGS_CSS
    assert "prefers-reduced-motion: reduce" in SETTINGS_CSS
