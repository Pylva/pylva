"""Replay the shared authoritative budget-control contract fixtures in Python."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from pylva.core.control_schema import BUDGET_CONTROL_SCHEMA_ADAPTERS

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CONTRACT_PATH = os.path.join(REPO_ROOT, "tests", "contracts", "budget-control-contract.json")

EXPECTED_SCHEMA_KEYS = {
    "capabilities_response",
    "reservation_request",
    "reservation_response",
    "commit_request",
    "commit_response",
    "release_request",
    "release_response",
    "extend_request",
    "extend_response",
    "error_response",
}
SPECIAL_NUMBER_VALUES = {
    "nan": float("nan"),
    "positive_infinity": float("inf"),
    "negative_infinity": float("-inf"),
}
SPECIAL_STRING_VALUES = {
    "lone_high_surrogate": "\ud800",
    "lone_low_surrogate": "\udfff",
}


def load_contract_fixtures() -> dict[str, Any]:
    with open(CONTRACT_PATH, encoding="utf-8") as fixture_file:
        value = json.load(fixture_file)
    assert isinstance(value, dict)
    return value


def _materialize_special_values(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"$special_number"}:
            sentinel = value["$special_number"]
            if sentinel not in SPECIAL_NUMBER_VALUES:
                raise AssertionError(f"unknown special-number sentinel: {sentinel!r}")
            return SPECIAL_NUMBER_VALUES[sentinel]
        if set(value) == {"$special_string"}:
            sentinel = value["$special_string"]
            if sentinel not in SPECIAL_STRING_VALUES:
                raise AssertionError(f"unknown special-string sentinel: {sentinel!r}")
            return SPECIAL_STRING_VALUES[sentinel]
        return {key: _materialize_special_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_materialize_special_values(item) for item in value]
    return value


def _collect_special_numbers(value: Any) -> set[str]:
    if isinstance(value, dict):
        if set(value) == {"$special_number"}:
            sentinel = value["$special_number"]
            return {sentinel} if isinstance(sentinel, str) else set()
        found: set[str] = set()
        for item in value.values():
            found.update(_collect_special_numbers(item))
        return found
    if isinstance(value, list):
        found = set()
        for item in value:
            found.update(_collect_special_numbers(item))
        return found
    return set()


def _collect_special_strings(value: Any) -> set[str]:
    if isinstance(value, dict):
        if set(value) == {"$special_string"}:
            sentinel = value["$special_string"]
            return {sentinel} if isinstance(sentinel, str) else set()
        found: set[str] = set()
        for item in value.values():
            found.update(_collect_special_strings(item))
        return found
    if isinstance(value, list):
        found = set()
        for item in value:
            found.update(_collect_special_strings(item))
        return found
    return set()


def _fixture_cases() -> list[dict[str, Any]]:
    data = load_contract_fixtures()
    fixtures = data.get("fixtures")
    assert isinstance(fixtures, list)
    return fixtures


def _adapter_for(fixture: Mapping[str, Any]) -> TypeAdapter[Any]:
    schema = fixture.get("schema")
    assert isinstance(schema, str)
    try:
        return BUDGET_CONTROL_SCHEMA_ADAPTERS[schema]
    except KeyError as error:
        raise AssertionError(f"unknown contract schema registry key: {schema}") from error


def test_contract_manifest_is_complete_and_unambiguous() -> None:
    data = load_contract_fixtures()
    assert data["$schema_version"] == "1.0"
    assert isinstance(data.get("description"), str)

    fixtures = _fixture_cases()
    names: list[str] = []
    valid_schema_keys: set[str] = set()
    special_numbers: set[str] = set()
    special_strings: set[str] = set()

    for fixture in fixtures:
        assert isinstance(fixture, dict)
        assert set(fixture) <= {"name", "schema", "valid", "value", "expected_output"}
        assert {"name", "schema", "valid", "value"} <= set(fixture)
        assert isinstance(fixture["name"], str)
        assert isinstance(fixture["schema"], str)
        assert isinstance(fixture["valid"], bool)
        names.append(fixture["name"])
        special_numbers.update(_collect_special_numbers(fixture["value"]))
        special_strings.update(_collect_special_strings(fixture["value"]))
        if fixture["valid"]:
            valid_schema_keys.add(fixture["schema"])

    assert len(names) == len(set(names)), "contract fixture names must be unique"
    assert set(BUDGET_CONTROL_SCHEMA_ADAPTERS) == EXPECTED_SCHEMA_KEYS
    assert valid_schema_keys == EXPECTED_SCHEMA_KEYS
    assert special_numbers == set(SPECIAL_NUMBER_VALUES)
    assert special_strings == set(SPECIAL_STRING_VALUES)


@pytest.mark.parametrize("fixture", _fixture_cases(), ids=lambda fixture: fixture["name"])
def test_budget_control_contract_fixture(fixture: dict[str, Any]) -> None:
    adapter = _adapter_for(fixture)
    raw_value = fixture["value"]
    special_numbers = _collect_special_numbers(raw_value)
    special_strings = _collect_special_strings(raw_value)

    if fixture["valid"]:
        assert not special_numbers, "valid wire fixtures must be representable as standard JSON"
        assert not special_strings, "valid wire fixtures must contain valid Unicode scalar values"
        parsed = adapter.validate_json(json.dumps(raw_value, allow_nan=False))
        if "expected_output" in fixture:
            dumped = adapter.dump_python(parsed, mode="json")
            assert dumped == fixture["expected_output"]
        return

    with pytest.raises(ValidationError):
        if special_numbers or special_strings:
            adapter.validate_python(_materialize_special_values(raw_value))
        else:
            adapter.validate_json(json.dumps(raw_value, allow_nan=False))
