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
