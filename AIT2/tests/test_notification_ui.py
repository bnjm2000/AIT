from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
TEMPLATE = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')


def function_source(name, next_name):
    start = SCRIPT.index(f'function {name}')
    end = SCRIPT.index(f'function {next_name}', start)
    return SCRIPT[start:end]


def test_notifications_replace_the_active_banner_instead_of_stacking():
    source = function_source('showNotification', 'isBulkModelGroupForPrepare')

    assert 'if (activeNotification)' in source
    assert 'dismissNotification(activeNotification, true)' in source
    assert 'document.querySelectorAll(".notification")' in source
    assert 'activeNotification = notification' in source


def test_notifications_can_be_dismissed_with_pointer_or_keyboard():
    source = function_source('showNotification', 'isBulkModelGroupForPrepare')

    assert 'notification.addEventListener("click"' in source
    assert 'notification.addEventListener("keydown"' in source
    assert 'event.key === "Enter"' in source
    assert 'event.key === " "' in source
    assert 'event.key === "Escape"' in source
    assert 'notification.setAttribute("tabindex", "0")' in source
    assert 'Click to dismiss notification.' in source


def test_notification_banner_has_click_and_focus_affordances():
    assert 'cursor: pointer;' in TEMPLATE
    assert '.notification:hover {' in TEMPLATE
    assert '.notification:focus-visible {' in TEMPLATE
