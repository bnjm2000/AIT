from pathlib import Path

from tests.static_source import APP_BUNDLE_SOURCE


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = APP_BUNDLE_SOURCE
TEMPLATE = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')


def function_source(name, next_name):
    start = SCRIPT.index(f'function {name}')
    end = SCRIPT.index(f'function {next_name}', start)
    return SCRIPT[start:end]


def test_planning_primary_action_opens_prepare_and_plan_is_in_progress_icons():
    primary_action = function_source('getEventPrimaryAction', 'eventNextActionText')
    planning_branch = primary_action.split("if (event.state === 'Planning')", 1)[1].split(
        "if (event.state === 'Preparing')", 1
    )[0]

    assert "label: 'Prepare'" in planning_branch
    assert 'openPrepareWorkspaceForEvent' in planning_branch
    assert "label: 'Plan'" not in planning_branch

    icons = function_source('eventWorkflowProgressHtml', 'openEventFinance')
    menu = function_source('eventCardMenuHtml', 'createEventsOverviewCard')
    assert "['plan', `openEventPlanning(${Number(event.id)})`]" in icons
    assert 'openEventPlanning(${event.id})' not in menu
    assert '<span>Plan</span>' not in menu


def test_event_quick_actions_pass_the_clicked_event_through_navigation():
    planning = function_source('openEventPlanning', 'openPrepareWorkspaceForEvent')
    preparing = function_source('openPrepareWorkspaceForEvent', 'openReturnWorkspaceForEvent')
    returning = function_source('openReturnWorkspaceForEvent', 'closeEventCardMenus')

    assert "showSection('plan', { eventId: id })" in planning
    assert "showSection('prepare-new', { eventId: id })" in preparing
    assert "showSection('return', { eventId: id })" in returning
    for source in (planning, preparing, returning):
        assert 'workflowRememberEvent(id)' in source


def test_new_events_are_registered_in_every_workflow_selector_before_navigation():
    register = function_source('registerCreatedEventInClient', 'formatEventFileSize')
    reset = function_source('resetWorkflowEventOptionCaches', 'registerCreatedEventInClient')
    add_event_handler = SCRIPT.split(
        '.getElementById("addEventForm")', 1
    )[1].split("const assetIsBulkToggle", 1)[0]
    finance = (ROOT / 'static' / 'js' / 'finance.js').read_text(encoding='utf-8')

    assert 'workflowRememberEvent(id)' in register
    assert 'await fetchEventSummary(id)' in register
    assert 'events = mergeNewestFirst(events)' in register
    assert 'planPageState.events = mergeNewestFirst' in register
    assert 'prepareNewPageState.events = mergeNewestFirst' in register
    assert 'returnPageState.events = mergeNewestFirst' in register
    assert 'workforcePageState.eventOptions = mergeNewestFirst' in register
    assert 'financeState.events = mergeNewestFirst' in register
    assert 'resetWorkflowEventOptionCaches()' in register
    assert 'workforcePageState.eventOptions = []' in reset
    assert 'const response = await apiCall("/api/events", "POST", eventData)' in add_event_handler
    assert 'await registerCreatedEventInClient(response.eventId)' in add_event_handler
    assert finance.count('await registerCreatedEventInClient(') >= 2


def test_grid_and_list_show_progress_icons_and_one_compact_next_action():
    menu = function_source('eventCardMenuHtml', 'createEventsOverviewCard')
    cards = function_source('createEventsOverviewCard', 'renderAllEventsCards')
    table = function_source('renderAllEventsTable', 'renderAllEventsList')
    icons = function_source('eventWorkflowProgressHtml', 'openEventFinance')

    for kind in ('plan', 'manpower', 'transport', 'prepare', 'return', 'finance'):
        assert f"['{kind}'," in icons
    assert 'openEventWorkforce(${event.id})' not in menu
    assert 'openEventTransport(${event.id})' not in menu
    assert 'openPrepareWorkspaceForEvent(${event.id})' not in menu
    assert 'openReturnWorkspaceForEvent(${event.id})' not in menu
    assert 'eventQuickActionButtonsHtml' not in SCRIPT
    assert 'event-secondary-action' not in cards
    assert 'event-secondary-action' not in table
    assert cards.count('class="event-primary-action"') == 1
    assert table.count('class="event-primary-action"') == 1
    assert 'eventWorkflowProgressHtml(event' in cards
    assert 'eventWorkflowProgressHtml(event' in table
    assert '<strong>Next action</strong>' not in cards
    assert '<th>Type / State</th>' in table
    assert '<th>Workspaces</th>' in table


def test_progress_icons_open_the_requested_manpower_views():
    finance = function_source('openEventFinance', 'eventCardMenuHtml')
    assert "openEventWorkforce(id, 'department')" in finance
    assert "profitLossState.eventId = id" in finance

    workforce = (ROOT / 'static' / 'js' / 'workforce-admin.js').read_text(encoding='utf-8')
    assert "viewMode: 'schedule'" in workforce
    assert "focus === 'department'" in workforce


def test_event_card_next_action_and_compact_button_share_one_footer_row():
    footer_css = TEMPLATE.split('      .event-workflow-footer {', 2)[2].split('}', 1)[0]
    controls_css = TEMPLATE.split('      .event-card-controls {', 1)[1].split('}', 1)[0]
    action_css = TEMPLATE.split('      .event-primary-action {', 1)[1].split('}', 1)[0]
    overflow_css = TEMPLATE.split('      .event-overflow-button {', 1)[1].split('}', 1)[0]

    assert 'display: grid;' in footer_css
    assert 'grid-template-columns: minmax(0, 1fr) auto;' in footer_css
    assert 'align-items: center;' in footer_css
    assert 'justify-self: end;' in controls_css
    assert 'min-height: 26px;' in action_css
    assert 'padding: 4px 8px;' in action_css
    assert 'font-size: 9px;' in action_css
    assert 'width: 26px;' in overflow_css


def test_event_overview_reuses_progress_icons_and_keeps_documents_below():
    overview = function_source('viewEvent', 'toggleViewSection')
    navigation = function_source('eventOverviewNavigate', 'exportEventOverviewPdf')

    assert "eventWorkflowProgressHtml(event, 'event-overview-workflow-icons', true)" in overview
    assert 'class="event-overview-document-actions"' in overview
    assert '<span>Delivery Order</span>' in overview
    assert '<span>Packing List</span>' in overview
    assert 'class="event-overview-links"' not in overview
    assert 'event-overview-header-title-actions' in overview
    assert "kind === 'transport'" in navigation
    assert 'openEventTransport(eventId)' in navigation
    assert "kind === 'finance'" in navigation
    assert 'openEventFinance(eventId)' in navigation
    assert 'closeEventOverview({ updateHistory: false })' in navigation
    assert '.event-overview-workflow-actions' in TEMPLATE


def test_manpower_and_vendor_icon_uses_a_person_and_briefcase_everywhere():
    icon_geometry = (
        '<circle cx="7" cy="7" r="2.5"></circle>'
        '<path d="M2.5 19a4.5 4.5 0 0 1 9 0"></path>'
        '<rect x="13" y="8" width="9" height="10" rx="1.5"></rect>'
        '<path d="M16 8V6h3v2M13 12h9"></path>'
    )

    assert SCRIPT.count(icon_geometry) >= 2
    assert icon_geometry in TEMPLATE


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


def test_all_events_loads_active_cards_first_and_fetches_closed_on_demand():
    state_filter = function_source('setEventStateFilter', 'overviewStateFilterNeedsFullSet')
    loader = function_source('loadAllEvents', 'ensureEventPageToolbar')

    assert "let allEventsStateFilter = 'Active';" in SCRIPT
    assert 'const EVENT_OVERVIEW_PAGE_SIZE = 500;' in SCRIPT
    assert "loadAllEvents({ scope: 'all' })" in state_filter
    assert "['All', 'Closed', 'Pending Closure']" in SCRIPT
    assert (
        '/api/events?view=summary&scope=${requestedScope}'
        '&limit=${EVENT_OVERVIEW_PAGE_SIZE}&offset=${offset}'
    ) in loader
    assert 'allEventsOverviewStateCounts = response.meta?.stateCounts' in loader
    assert 'allEventsOverviewStateCountsByTag = response.meta?.stateCountsByTag' in loader


def test_event_overview_includes_a_single_or_legacy_main_room():
    room_rows = function_source('eventOverviewSubprojectRows', 'eventOverviewSubprojects')
    overview = function_source('viewEvent', 'toggleViewSection')

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


def test_calendar_event_labels_are_regular_weight_white_for_every_status():
    assert '.calendar-event.state-added { background: #ec407a; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-pending { background: #6d28d9; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-preparing { background: #0877e8; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-active { background: #16a34a; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-returned { background: #0b97a4; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-returning { background: #f97316; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-pending-closure { background: #334155; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-overdue { background: #ef3340; color: #fff; }' in TEMPLATE
    assert '.calendar-event.state-completed { background: #64748b; color: #fff; }' in TEMPLATE
    calendar_event_css = TEMPLATE.split('      .calendar-event {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 400;' in calendar_event_css
    assert 'height: 17px;' in calendar_event_css
    assert 'text-shadow: 0 1px 2px rgba(2, 6, 23, .72);' in calendar_event_css


def test_event_cards_and_calendar_use_a_selective_type_weight_hierarchy():
    card_css = TEMPLATE.split('      .event-workflow-kicker {', 1)[1].split(
        '      #events-section .event-list-table-wrap,', 1
    )[0]
    assert '.event-workflow-kicker {' in TEMPLATE
    assert 'font-weight: 500;' in card_css.split('      .event-type-badge,', 1)[0]
    assert 'font-weight: 500;' in card_css.split('      .event-type-badge,', 1)[1].split(
        '      .event-type-badge {', 1
    )[0]
    assert 'font-weight: 600;' in card_css.split('      .event-workflow-title {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 600;' in card_css.split('      .event-progress-value {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 500;' in card_css.split('      .event-workflow-notice {', 1)[1].split('}', 1)[0]
    action_css = card_css.split('      .event-primary-action {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 600;' in action_css

    calendar_controls = TEMPLATE.split('      .calendar-nav button {', 1)[1].split(
        '      .calendar-event {', 1
    )[0]
    assert 'font-weight: 400;' in calendar_controls.split('}', 1)[0]
    assert 'font-weight: 600;' in calendar_controls.split('      .calendar-month-jump {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 500;' in calendar_controls.split('      .calendar-day-header {', 1)[1].split('}', 1)[0]
    assert 'font-weight: 500;' in calendar_controls.split('      .calendar-day-number {', 1)[1].split('}', 1)[0]


def test_calendar_uses_lightweight_cached_month_ranges():
    load_calendar = function_source('loadCalendarView', 'setCalendarEventHover')

    assert 'view=calendar&rangeStart=' in SCRIPT
    assert 'const calendarMonthCache = new Map()' in SCRIPT
    assert 'fetchCalendarMonth(currentCalendarDate' in load_calendar
    assert 'prefetchAdjacentCalendarMonths()' in load_calendar
    assert 'calendar-is-loading' in load_calendar
    assert 'processEventsForCalendar(events, calendarDays)' in SCRIPT
    assert 'const placementsByDay = new Map()' in SCRIPT


def test_calendar_dates_create_prefilled_events_by_click_or_drag():
    render_calendar = function_source('renderCalendar', 'calendarSelectionBounds')
    selection = function_source('bindCalendarDateSelection', 'closeCalendarMonthPicker')

    assert 'data-calendar-date=' in render_calendar
    assert 'bindCalendarDateSelection(container)' in render_calendar
    assert "grid.addEventListener('pointerdown'" in selection
    assert "grid.addEventListener('pointermove'" in selection
    assert "grid.addEventListener('pointerup'" in selection
    assert 'openAddEventModalForRange(selection.startKey, selection.endKey)' in selection
    assert "startInput.value = first" in SCRIPT
    assert "endInput.value = last" in SCRIPT
    assert '.calendar-day.is-selection-preview' in TEMPLATE


def test_calendar_month_heading_opens_a_jump_picker():
    render_calendar = function_source('renderCalendar', 'calendarSelectionBounds')

    assert 'class="calendar-month-jump"' in render_calendar
    assert 'id="calendarMonthInput" type="month"' in render_calendar
    assert 'function toggleCalendarMonthPicker(event)' in SCRIPT
    assert 'function jumpToCalendarMonth()' in SCRIPT
    assert '.calendar-month-picker' in TEMPLATE


def test_event_cards_and_list_rows_use_compact_dimensions():
    assert 'min-height: 260px;' in TEMPLATE
    assert '.event-list-table td { padding:6px 9px;' in SCRIPT
    assert '.event-list-table .event-primary-action { min-height:29px;' in SCRIPT
