from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def user_management_script():
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")
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
    assert "USERS_ADMIN_AUTOSAVE_DELAY = 700" in (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")
