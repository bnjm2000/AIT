from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
TEMPLATE = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')


def function_source(name, next_name):
    start = SCRIPT.index(f'function {name}')
    end = SCRIPT.index(f'function {next_name}', start)
    return SCRIPT[start:end]


def test_planning_primary_action_opens_prepare_and_plan_remains_in_menu():
    primary_action = function_source('getEventPrimaryAction', 'eventNextActionText')
    planning_branch = primary_action.split("if (event.state === 'Planning')", 1)[1].split(
        "if (event.state === 'Preparing')", 1
    )[0]

    assert "label: 'Prepare'" in planning_branch
    assert 'openPrepareWorkspaceForEvent' in planning_branch
    assert "label: 'Plan'" not in planning_branch

    menu = function_source('eventCardMenuHtml', 'createEventsOverviewCard')
    assert 'openEventPlanning(${event.id})' in menu
    assert '<span>Plan</span>' in menu


def test_add_event_assignee_picker_has_assign_all_for_active_company_users():
    assert "onclick=\"assignAllEventAssignees('add')\"" in TEMPLATE
    assert '>Assign All</button>' in TEMPLATE
    assert 'Only active users from this company are shown.' in TEMPLATE


def test_list_menu_is_clamped_using_its_rendered_height():
    toggle_menu = function_source('toggleEventCardMenu', 'eventMenuIconHtml')

    assert 'document.body.appendChild(target)' in toggle_menu
    assert "target.dataset.eventMenuPortal = 'true'" in toggle_menu
    assert '.event-card-menu[data-event-menu-portal="true"]' in SCRIPT
    assert 'const menuRect = target.getBoundingClientRect()' in toggle_menu
    assert 'buttonRect.top - menuRect.height - gap' in toggle_menu
    assert 'window.innerHeight - menuRect.height - margin' in toggle_menu
    assert "target.style.zIndex = '2000'" in toggle_menu


def test_calendar_label_uses_the_visible_multi_day_span():
    render_calendar = function_source('renderCalendar', 'processEventsForCalendar')
    placement = function_source('processEventsForCalendar', 'showDayEvents')

    assert 'class="calendar-event-label"' in render_calendar
    assert 'placement.spanDays || 1' in render_calendar
    assert 'calendarEventLabelSegments' in render_calendar
    assert 'spanDays: group.length' in placement
    assert 'spanIndex: dayIndexInGroup' in placement
    assert '.calendar-event.span-start .calendar-event-label' in TEMPLATE
    assert 'function calendarEventLabelSegments' in SCRIPT


def test_event_cards_and_list_rows_use_compact_dimensions():
    assert 'min-height: 260px;' in TEMPLATE
    assert '.event-list-table td { padding:6px 9px;' in SCRIPT
    assert '.event-list-table .event-primary-action { min-height:29px;' in SCRIPT
