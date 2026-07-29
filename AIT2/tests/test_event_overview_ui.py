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


def test_add_event_tag_is_a_top_of_form_segmented_selector():
    form = TEMPLATE.split('<form id="addEventForm">', 1)[1].split('</form>', 1)[0]

    assert form.index('class="add-event-tag-selector"') < form.index('id="eventName"')
    assert 'role="radiogroup"' in form
    assert 'data-add-event-tag="events"' in form
    assert 'data-add-event-tag="dry hire"' in form
    assert "onclick=\"setAddEventTag('events')\"" in form
    assert "onclick=\"setAddEventTag('dry hire')\"" in form
    assert 'class="form-input" id="eventTag"' not in form

    selector = function_source('setAddEventTag', 'syncAddEventLocationRequirement')
    assert 'tagInput.value = normalizedTag' in selector
    assert 'options.dataset.selected' in selector
    assert 'option.setAttribute(' in selector
    assert 'syncAddEventLocationRequirement();' in selector


def test_add_event_fields_are_paired_in_responsive_rows():
    form = TEMPLATE.split('<form id="addEventForm">', 1)[1].split('</form>', 1)[0]
    identity_row = form.split('data-add-event-row="identity"', 1)[1].split(
        'data-add-event-row="dates"', 1
    )[0]
    dates_row = form.split('data-add-event-row="dates"', 1)[1].split(
        'data-event-assignee-context="add"', 1
    )[0]

    assert 'id="eventName"' in identity_row
    assert 'id="eventLocation"' in identity_row
    assert identity_row.count('add-event-required-mark') == 2
    assert 'eventLocationHelp' not in identity_row
    assert 'Required for Events.' not in identity_row
    assert 'Optional for Dry Hire.' not in identity_row
    assert 'id="eventStartDate"' in dates_row
    assert 'id="eventEndDate"' in dates_row
    assert 'grid-template-columns: repeat(2, minmax(0, 1fr));' in TEMPLATE
    assert '@media (max-width: 620px)' in TEMPLATE


def test_event_menus_are_portaled_clamped_and_restored():
    toggle_menu = function_source('toggleEventCardMenu', 'eventMenuIconHtml')
    close_menu = function_source('closeEventCardMenus', 'toggleEventCardMenu')

    assert 'document.body.appendChild(target)' in toggle_menu
    assert "target.dataset.eventMenuPortal = 'true'" in toggle_menu
    assert "context === 'list'" not in toggle_menu
    assert '.event-card-menu[data-event-menu-portal="true"]' in SCRIPT
    assert 'const menuRect = target.getBoundingClientRect()' in toggle_menu
    assert 'buttonRect.top - menuRect.height - gap' in toggle_menu
    assert 'window.innerHeight - menuRect.height - margin' in toggle_menu
    assert "target.style.zIndex = '2000'" in toggle_menu
    assert 'origin.insertBefore(menu' in close_menu
    assert "delete menu.dataset.eventMenuPortal" in close_menu


def test_all_events_title_uses_the_company_theme():
    assert 'color: var(--theme-primary, var(--brand-main, #0f766e));' in TEMPLATE


def test_event_overview_includes_a_single_or_legacy_main_room():
    room_rows = function_source('eventOverviewSubprojectRows', 'eventOverviewSubprojects')
    overview = function_source('viewEvent', 'viewEventLegacy')

    assert "name: 'Main Room'" in room_rows
    assert 'Object.values(event?.modelGroups || {})' in room_rows
    assert 'groupEventCustomAssets(getCustomAssetsFromEvent(event))' in room_rows
    assert 'eventOverviewSubprojectRows(event).length' in overview


def test_calendar_label_uses_the_visible_multi_day_span():
    render_calendar = function_source('renderCalendar', 'processEventsForCalendar')
    placement = function_source('processEventsForCalendar', 'showDayEvents')

    assert 'class="calendar-event-label"' in render_calendar
    assert 'placement.spanDays || 1' in render_calendar
    assert 'width:calc(${spanDays * 100}%' in render_calendar
    assert 'data-calendar-event-id=' in render_calendar
    assert 'setCalendarEventHover' in render_calendar
    assert 'spanDays: group.length' in placement
    assert "spanClass: group.length > 1 ? 'span-range' : 'span-single'" in placement
    assert 'spanIndex: dayIndexInGroup' not in placement
    assert '.calendar-event.span-range' in TEMPLATE
    assert '.calendar-event.is-group-hovered' in TEMPLATE
    assert 'function setCalendarEventHover(eventId, active)' in SCRIPT
    assert 'has-event-span-origin' not in TEMPLATE
    assert 'has-event-span-origin' not in render_calendar


def test_calendar_days_do_not_hide_bars_arriving_from_an_earlier_day():
    calendar_day_css = TEMPLATE.split('      .calendar-day {', 1)[1].split('}', 1)[0]
    calendar_events_css = TEMPLATE.split('      .calendar-events-container {', 1)[1].split('}', 1)[0]

    assert 'z-index:' not in calendar_day_css
    assert 'z-index:' not in calendar_events_css


def test_event_cards_and_list_rows_use_compact_dimensions():
    assert 'min-height: 260px;' in TEMPLATE
    assert '.event-list-table td { padding:6px 9px;' in SCRIPT
    assert '.event-list-table .event-primary-action { min-height:29px;' in SCRIPT
