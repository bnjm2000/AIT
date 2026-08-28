from pathlib import Path


PACKING_LIST_SOURCE = (
    Path(__file__).resolve().parents[1] / "static" / "js" / "packing-list.js"
).read_text(encoding="utf-8")


def test_multiple_subprojects_are_exported_as_separate_pdf_sections():
    assert "function buildPackingListSubprojectSnapshot" in PACKING_LIST_SOURCE
    assert "function buildPackingListPdfSections" in PACKING_LIST_SOURCE
    assert "subprojects.length <= 1" in PACKING_LIST_SOURCE
    assert "Sub-project:" in PACKING_LIST_SOURCE
    assert "normalisedSections.flatMap" in PACKING_LIST_SOURCE
    assert "const sections = buildPackingListPdfSections(event);" in PACKING_LIST_SOURCE


def test_single_subproject_keeps_the_eventwide_packing_list():
    assert "snapshot: buildPackingListSnapshot(event)" in PACKING_LIST_SOURCE
    assert "name: ''" in PACKING_LIST_SOURCE


def test_room_asset_references_drive_each_subproject_snapshot():
    assert "item.assetRefs || []" in PACKING_LIST_SOURCE
    assert "subproject.extraRefs || []" in PACKING_LIST_SOURCE
    assert "packingListSubprojectAssetRecord" in PACKING_LIST_SOURCE


def test_packing_list_does_not_include_asset_serial_numbers():
    record_start = PACKING_LIST_SOURCE.index("function packingListAssetRecord")
    record_end = PACKING_LIST_SOURCE.index("function packingListAssetsById", record_start)
    record_source = PACKING_LIST_SOURCE[record_start:record_end]
    html_start = PACKING_LIST_SOURCE.index("function packingListAssetHtml")
    html_end = PACKING_LIST_SOURCE.index("function packingListTableHead", html_start)
    html_source = PACKING_LIST_SOURCE[html_start:html_end]

    assert "serial:" not in record_source
    assert "asset?.serial" not in record_source
    assert "asset.serial" not in html_source
    assert "/ SN " not in html_source
