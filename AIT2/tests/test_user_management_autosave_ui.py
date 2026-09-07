from pathlib import Path

from tests.static_source import APP_BUNDLE_SOURCE


ROOT = Path(__file__).resolve().parents[1]


def user_management_script():
    script = APP_BUNDLE_SOURCE
    start = script.index("function usersAdminRowMarkup")
    end = script.index("async function resetUserPasswordAdmin")
    return script, script[start:end]


def test_user_management_rows_autosave_without_a_save_button():
    script, user_management = user_management_script()

    assert "function saveUserAdmin(" not in script
    assert 'onclick="saveUserAdmin' not in user_management
    assert 'data-user-admin-autosave="name"' in user_management
    assert 'data-user-admin-autosave="username"' in user_management
    assert 'data-user-admin-autosave="company"' in user_management
    assert 'data-user-admin-save-status' in user_management
    assert "bindUsersAdminAutosave(container);" in user_management


def test_user_management_autosave_updates_only_the_edited_row():
    _, user_management = user_management_script()
    autosave_start = user_management.index("async function flushUserAdminAutosave")
    autosave_end = user_management.index("async function loadUsersAdmin")
    autosave = user_management[autosave_start:autosave_end]

    assert "await apiCall(`/api/users/${encodeURIComponent(endpointUsername)}`, 'PUT', payload)" in autosave
    assert "await loadUsersAdmin()" not in autosave
    assert "applyUserAdminSavedData(row" in autosave
    assert "state.inFlight" in autosave
    assert "state.queued" in autosave
    assert "saveSucceeded && currentFingerprint !== state.lastSavedFingerprint" in autosave


def test_user_management_text_and_choice_controls_use_suitable_save_timing():
    _, user_management = user_management_script()

    assert "control.addEventListener('input', () => scheduleUserAdminAutosave(row))" in user_management
    assert "control.addEventListener('change', () => scheduleUserAdminAutosave(row, 0))" in user_management
    assert "control.addEventListener('blur', () => scheduleUserAdminAutosave(row, 0))" in user_management
    assert "USERS_ADMIN_AUTOSAVE_DELAY = 700" in APP_BUNDLE_SOURCE


def test_owner_role_option_is_only_rendered_for_owner_sessions():
    script = APP_BUNDLE_SOURCE
    options_start = script.index("function userRoleOptionsMarkup")
    options_end = script.index("function userRoleSummaryMarkup", options_start)
    options = script[options_start:options_end]

    assert "isPlatformAdminUser()" in options
    assert "['owner', 'admin', 'manager', 'user']" in options
    assert "? ['admin', 'manager', 'user']" in options
    assert ": ['manager', 'user']" in options
    assert "owner: 'Owner'" in script


def test_manager_user_controls_are_limited_by_target_role():
    script, user_management = user_management_script()

    assert 'function canCurrentUserManageUser(user)' in script
    assert "currentUserRole() === 'manager' && ['manager', 'user'].includes(targetRole)" in script
    assert 'const canEditUser = canCurrentUserManageUser(user);' in user_management
    assert '${canCurrentUserManageUsers() ? `' in script


def test_user_management_uses_clickable_status_and_sales_badges():
    _, user_management = user_management_script()

    assert "function userAdminBadgeToggleMarkup" in APP_BUNDLE_SOURCE
    assert "user-admin-badge-toggle-active" in APP_BUNDLE_SOURCE
    assert "user-admin-badge-toggle-sales" in APP_BUNDLE_SOURCE
    assert "user-admin-state-badge-on" in APP_BUNDLE_SOURCE
    assert "user-admin-state-badge-off" in APP_BUNDLE_SOURCE
    assert "text-decoration: line-through" in APP_BUNDLE_SOURCE
    assert "user-admin-switch-compact" not in user_management


def test_user_management_shows_telegram_link_below_username():
    _, user_management = user_management_script()

    assert "function userTelegramBadgeMarkup" in APP_BUNDLE_SOURCE
    assert "Telegram not linked" in APP_BUNDLE_SOURCE
    assert "userTelegramBadgeMarkup(user)" in user_management
    assert "userActiveBadgeMarkup" not in APP_BUNDLE_SOURCE


def test_user_management_role_control_uses_role_palette():
    _, user_management = user_management_script()

    assert "user-admin-role-select-${role}" in user_management
    assert "syncUserAdminRoleColour(row)" in user_management
    assert ".user-admin-role-select + .sb-select-button" in APP_BUNDLE_SOURCE
    for role in ("owner", "admin", "manager", "user"):
        assert f"user-admin-role-select-{role}" in APP_BUNDLE_SOURCE
