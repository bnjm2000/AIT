from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_inventory_template_uses_grouped_responsive_catalogue():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")

    assert 'id="inventory-summary-grid"' in template
    assert 'id="inventory-overview-chart"' in template
    assert ".inventory-model-summary" in template
    assert ".inventory-model-detail" in template
    assert "@media(max-width:520px)" in template.replace(" ", "")
    assert "Assets grouped by brand and model." in template


def test_inventory_script_groups_models_and_weights_availability_quantities():
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "function groupInventoryByModel(assetList)" in script
    assert "function inventoryConditionCounts(assetList)" in script
    assert "function inventoryAvailabilityCounts(assetList)" in script
    assert "function inventoryAvailabilityBadgesHtml(asset)" in script
    assert '<strong>${total}</strong>${compact ? \'assets\' : \'total\'}' in script
    assert "bulkOOCQuantity" in script
    assert "bulkMissingQuantity" in script
    assert "bulkDegradedQuantity" in script
    assert "function toggleInventoryModelGroup(encodedKey)" in script
    assert "inventoryAvailabilityChartHtml(availability, true)" in script
    assert "assets available" in script
    assert "withQuantity(counts.degradedAvailable, 'Degraded')" in script
    assert "statusBadgeHtml('deployed'" in script
    assert "conditionCounts.ooc, 'Out of commission'" in script


def test_asset_history_uses_timeline_and_event_cards():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ".maintenance-history-shell" in template
    assert ".maintenance-timeline-item" in template
    assert "Asset past logs" in script
    assert "function loadAssetEventHistoryCards(assetId, containerId)" in script
    assert "No event use recorded." in script


def test_event_overview_workspace_buttons_have_equal_emphasis():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ".event-overview-link.primary" not in template
    assert "index === 0 ? 'primary'" not in script


def test_inventory_department_management_is_a_header_action_and_rows_are_compact():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ">Manage departments</button>" in template
    assert "onclick=\"openModal('department-admin-panel')\"" in template
    assert "panel.className = 'modal'" in script
    assert "min-height:50px" in template
    assert "min-height:36px" in template
    assert "'Assets deployed'" in script
    assert "asset.deployedQuantity" in script


def test_maintenance_log_controls_use_custom_coloured_selectors_and_drop_upload():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "Asset Status Change" in template
    assert 'id="maintenanceMediaDropzone"' in template
    assert "function enhanceMaintenanceCustomSelect(selectEl, kind)" in script
    assert "enhanceMaintenanceCustomSelect(selectEl, 'status')" in script
    assert "enhanceMaintenanceCustomSelect(selectEl, 'type')" in script
    assert "function setupMaintenanceMediaDropzone(inputId, listId, dropzoneId)" in script
    assert "input.files = transfer.files" in script


def test_asset_history_status_changes_use_status_specific_badges():
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "function maintenanceChangeBadgeHtml(label)" in script
    assert "value.includes('ooc')" in script
    assert "value.includes('missing')" in script
    assert "value.includes('degraded')" in script
    assert "changes.map(maintenanceChangeBadgeHtml)" in script


def test_maintenance_dashboard_is_informative_responsive_and_keeps_actions():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'id="maintenance-dashboard-summary"' in template
    assert ".maintenance-activity-row" in template
    assert ".maintenance-flagged-grid" in template
    assert "@media(max-width:720px)" in template.replace(" ", "")
    assert "Maintenance report" in template
    assert "Log maintenance" in template
    assert "function renderMaintenanceDashboardSummary(assetList)" in script
    assert "latest?.description" in script
    assert "latest?.user" in script
    assert "getMaintenanceFlaggedAssets(assets)" in script
    assert "viewMaintenanceLog(" in script
    assert "openFlaggedAssetLogEntry(" in script


def test_maintenance_type_dropdown_uses_lighter_option_colours():
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "'Fault': '#dc5965'" in script
    assert "'Update': '#8b6fd6'" in script
    assert "'Repair': '#d89422'" in script


def test_containers_use_compact_informative_responsive_catalogue():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "Organise transport cases, racks, and kits" in template
    assert "function getContainerConditionCounts(container)" in script
    assert "function getContainerLatestMaintenance(container)" in script
    assert 'class="container-list-head"' in script
    assert "renderContainerConditionSummary(container)" in script
    assert ".container-card-actions .inventory-icon-button" in script
    assert "@media (max-width: 720px)" in script


def test_asset_check_has_guided_progress_and_mobile_rows():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "Count matching assets in Store" in template
    assert "Start a stock check" in script
    assert 'class="asset-check-progress-track"' in script
    assert "const completion = checkableAssets.length" in script
    assert 'data-label="Asset ID"' in script
    assert ".asset-check-table td::before" in script
    assert "@media(max-width:620px)" in script


def test_system_logs_are_searchable_categorised_and_responsive():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "Review operational activity across the company" in template
    assert "function ensureSystemLogStyles()" in script
    assert "function systemLogCategory(log)" in script
    assert "function renderSystemLogs()" in script
    assert 'id="systemLogSearch"' in script
    assert 'class="system-log-summary"' in script
    assert ".system-log-row::before" in script
    assert "@media(max-width:720px)" in script
    assert "function exportLogs()" in script
    assert "canCurrentUserManageRoles()" in script
    assert 'data-log-access-only="true"' in template


def test_maintenance_history_keeps_actions_and_adds_overview_search():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ".maintenance-history-overview" in template
    assert ".maintenance-history-search" in template
    assert "function filterMaintenanceLogTimeline(input)" in script
    assert "Maintenance entries" in script
    assert "Photos and videos" in script
    assert "Recorded maintenance cost" in script
    assert "addNewLogEntryFromModal" in script
    assert "editMaintenanceLog(" in script
    assert "deleteMaintenanceLog(" in script


def test_inventory_asset_details_include_audit_data_and_bulk_only_quantity():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'id="assetDetailsModal" class="modal">\n      <div class="modal-content asset-details-shell">' in template
    assert 'id="addEventModal" class="modal">\n      <div class="modal-content asset-details-shell">' not in template
    assert "<span>Date added</span>" in script
    assert "<span>Last modified</span>" in script
    assert "asset.serial || 'NIL'" in script
    assert "asset.serial2 || 'NIL'" in script
    assert "assetChangeHistoryHtml(asset)" in script
    assert 'class="asset-details-section asset-details-history"' in script
    details_source = script[
        script.index("function openAssetDetailsModal"):
        script.index("function inventoryVirtualRowHtml")
    ]
    assert 'class="asset-details-identity-label"' in details_source
    assert "departmentBadgeHtml(asset.department)" in details_source
    assert 'class="asset-details-product"' in details_source
    assert 'class="asset-details-product-heading"' in details_source
    assert "asset-details-product-heading\"><strong>${escapeHtml([asset.brand, asset.model]" in details_source
    assert 'class="asset-details-grid asset-details-operational-grid"' in details_source
    assert "<h4>Maintenance</h4>" not in details_source
    assert "const bulkStockHtml = asset.isBulk" in script
    assert ": '';" in script[script.index("function inventoryVirtualRowHtml"):script.index("const INVENTORY_CONDITION_META")]
    assert "editAssetChangeHistory" not in script


def test_maintenance_page_uses_filter_buttons_with_shared_tab_search():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'id="maintenance-log-type-filters"' in template
    assert 'id="maintenance-condition-filters"' in template
    assert 'class="maintenance-tabs-search"' in template
    assert "function renderMaintenanceFilterButtons()" in script
    assert "function setMaintenanceLogTypeFilter(type)" in script
    assert "function setMaintenanceConditionFilter(condition)" in script
    assert "maintenanceAssetMatchesCondition(asset, maintenanceConditionFilter)" in script
    assert "asset.serial, asset.serialNumber, asset.serial2, asset.secondarySerial, asset.secondarySerialNumber" in script
    assert "Search asset, serial, model, log or user" in template


def test_maintenance_report_is_responsive_informative_and_keeps_export_controls():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'id="maintenance-report-summary"' in template
    assert 'class="mr-filter-grid"' in template
    assert 'class="mr-preview"' in template
    assert "@media(max-width:720px)" in template.replace(" ", "")
    assert 'onclick="generateMaintenanceReportPdf()"' in template
    assert 'onclick="clearMaintenanceReportFilters()"' in template
    assert "Matching maintenance logs" in script
    assert "Assets represented" in script
    assert 'class="maintenance-report-table"' in script
    assert 'data-label="Description"' in script


def test_event_status_filters_hide_zero_counts_and_event_logs_are_reusable():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ".events-state-filters button[hidden]" in template
    assert "button.hidden = state !== 'All' && count === 0" in script
    assert "function openEventLogs(eventId, eventName = '')" in script
    assert 'id="eventLogSearch"' in script
    assert "eventLogSearchText(log)" in script
    assert "/logs`" in script
    assert 'title="View event logs"' in script
    assert "window.openEventLogs = openEventLogs" in script
    assert "eventCardMenuHtml(event, 'list')" in script


def test_event_overview_and_asset_history_link_to_event_and_logs():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert ".event-overview-title-actions" in template
    assert "View event logs" in script
    assert "aria-label=\"Edit event\"" in script
    assert 'class="asset-history-event-card"' in script
    assert "closeMaintenanceLogModal();viewEvent(" in script
    assert 'class="maintenance-event-logs-button"' in script


def test_event_overview_notes_autosave_and_files_support_drag_and_drop():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert 'class="event-overview-notes"' in script
    assert 'oninput="eventOverviewNotesChanged(this)"' in script
    assert "setTimeout(eventOverviewFlushNotesSave, 700)" in script
    assert 'type="file" multiple' in script
    assert "function eventOverviewBindFileDropzone(eventId)" in script
    assert "dragEvent.dataTransfer?.files" in script
    assert "eventOverviewUpdateFiles(eventId, files || [])" in script
    assert ".event-overview-file-dropzone.drag-active" in template
    assert "topic === 'event-notes' || topic === 'event-files'" in script


def test_prepare_extras_stay_in_matching_requirement_rows():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "js" / "app.js").read_text(encoding="utf-8")

    assert "function prepareNewStandaloneExtras()" in script
    assert "extrasShownInRequirements.add(String(asset.id))" in script
    assert "const extras = prepareNewStandaloneExtras();" in script
    assert "options.extra ? 'extra' : 'assigned'" in script
    assert ".prepare-new-asset-card.assigned.extra" in template
    assert ".prepare-new-status-extra" in template
