"""Compatibility checks for model references stored in event records."""

import pytest

from app import (
    _make_model_marker,
    _parse_model_marker,
    _parse_prepared_model_marker,
    _prepared_model_marker,
)


@pytest.mark.parametrize("parser,prefix", [
    (_parse_model_marker, "[MODEL]"),
    (_parse_prepared_model_marker, "[PREPARED]"),
])
def test_marker_fields_preserve_description_separators(parser, prefix):
    parsed = parser(f"{prefix} ax | Brand | Model | 2 | cable | adapter ")
    assert parsed == {
        "department": "AX", "brand": "Brand", "model": "Model",
        "quantity": "2" if prefix == "[MODEL]" else 2,
        "description": "cable | adapter",
    }
    assert parser(f"{prefix}AX|Brand|Model|2")["description"] == ""
    for invalid in (None, 123, "[OTHER]AX|Brand|Model|2", f"{prefix}AX|Brand|Model"):
        assert parser(invalid) is None


@pytest.mark.parametrize("quantity,prepared_quantity", [("0", 1), ("-3", 1), ("bad", 1), ("5", 5)])
def test_planned_quantity_stays_raw_but_prepared_quantity_is_positive(quantity, prepared_quantity):
    group = {"department": "AX", "brand": "Brand", "model": "Model", "description": "a|b"}
    assert _parse_model_marker(_make_model_marker(group, quantity))["quantity"] == quantity
    assert _parse_prepared_model_marker(
        f"[PREPARED]AX|Brand|Model|{quantity}|a|b"
    )["quantity"] == prepared_quantity
    assert _parse_prepared_model_marker(_prepared_model_marker(group, quantity)) == {
        **group, "quantity": prepared_quantity,
    }
