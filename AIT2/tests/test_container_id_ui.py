from tests.static_source import APP_BUNDLE_SOURCE


def _source_between(start, end):
    return APP_BUNDLE_SOURCE.split(start, 1)[1].split(end, 1)[0]


def test_container_actions_keep_ids_out_of_inline_javascript():
    action_handler = _source_between(
        'function handleContainerAction(button)',
        'function getContainerLatestMaintenance',
    )
    cards = _source_between(
        'function renderContainerCards(containerList)',
        'function renderContainerAssetsTable',
    )
    editor = _source_between(
        'function makeContainerEditorHtml(mode, container = null)',
        'async function loadContainers',
    )
    viewer = _source_between(
        'async function viewContainer(containerId)',
        'async function editContainer(containerId)',
    )

    assert "button?.dataset?.containerId" in action_handler
    for action in ('maintain', 'view', 'edit', 'save', 'delete'):
        assert f"{action}:" in action_handler

    combined_markup = cards + editor + viewer
    assert 'onclick="handleContainerAction(this)"' in combined_markup
    assert 'data-container-id="${escapeHtmlAttr(container.id)}"' in cards
    assert 'data-container-id="${escapeHtmlAttr(containerId)}"' in editor
    assert 'data-container-id="${escapeHtmlAttr(c.id)}"' in viewer
    assert "replace(/'/g" not in combined_markup


def test_maintenance_filter_container_chip_uses_safe_data_attribute():
    selections = _source_between(
        'function renderMaintenanceReportAssetSelections()',
        'function addMaintenanceReportAssetFilterValue',
    )

    assert 'data-container-action="remove-maintenance-filter"' in selections
    assert 'data-container-id="${escapeHtmlAttr(containerId)}"' in selections
    assert "removeMaintenanceReportContainerFilter('${" not in selections
