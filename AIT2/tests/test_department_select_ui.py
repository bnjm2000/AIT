from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_shared_select_renders_department_badges_names_and_selection_state():
    script = source("static/js/custom-select.js")
    styles = source("static/css/custom-select.css")

    assert "function isDepartmentSelect(select)" in script
    assert "function departmentOptionMeta(option)" in script
    assert "function departmentBadge(meta)" in script
    assert "is-department-option" in script
    assert "sb-select-menu-department" in script
    assert ".sb-department-badge" in styles
    assert ".sb-select-option.is-department-option" in styles


def test_department_selects_use_the_shared_visual_treatment():
    files = {
        "templates/index.html": 'id="assetDepartment" data-department-select="true"',
        "static/js/plan.js": 'id="planCustomDepartment" data-department-select="true"',
        "static/js/prepare.js": 'id="prepareNewCustomDepartment" data-department-select="true"',
        "static/js/app.js": 'id="prepareCustomAssetDepartment" data-department-select="true"',
        "static/js/workforce-admin.js": 'id="wfAssignmentDepartment" data-department-select="true"',
        "static/js/workforce-schedule.js": 'id="wfFullTimeStaffDepartment" data-department-select="true"',
    }
    for path, marker in files.items():
        assert marker in source(path), path


def test_inventory_department_filter_uses_matching_badges_and_checks():
    script = source("static/js/admin-settings.js")
    styles = source("static/css/custom-select.css")

    assert 'class="inventory-department-filter-option"' in script
    assert 'class="sb-department-badge"' in script
    assert 'class="inventory-department-filter-check"' in script
    assert ".inventory-department-filter-option:has(input:checked)" in styles
    assert ".inventory-department-filter-check::before" in styles


def test_manpower_bulk_department_picker_matches_day_view_menu():
    script = source("static/js/workforce-schedule.js")

    assert "const selectedMarker = selected.badge" in script
    assert 'badge: `<i class="wf-schedule-tag-menu-badge"' in script
