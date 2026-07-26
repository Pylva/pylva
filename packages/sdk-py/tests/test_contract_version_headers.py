"""Regression guard for the canonical workspace contract declaration."""

from __future__ import annotations

import ast
from pathlib import Path

from pylva._version import API_CONTRACT_VERSION


def _literal_dict_keys(node: ast.Dict) -> dict[str, ast.expr]:
    items: dict[str, ast.expr] = {}
    for key, value in zip(node.keys, node.values, strict=True):
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            items[key.value.lower()] = value
    return items


def test_every_pylva_key_header_declares_contract_v2() -> None:
    """Every SDK request carrying a Pylva key must identify the v2 contract."""

    assert API_CONTRACT_VERSION == "2"
    package_root = Path(__file__).parents[1] / "pylva"
    authenticated_header_dicts: list[tuple[Path, ast.Dict]] = []

    for source_path in sorted(package_root.rglob("*.py")):
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            keys = _literal_dict_keys(node)
            if "x-pylva-key" in keys:
                authenticated_header_dicts.append((source_path, node))

    # Keep this inventory explicit so a new HTTP path cannot bypass the guard
    # by appearing outside the currently reviewed authenticated request sites.
    assert len(authenticated_header_dicts) == 8

    for source_path, node in authenticated_header_dicts:
        keys = _literal_dict_keys(node)
        value = keys.get("x-pylva-contract-version")
        assert isinstance(value, ast.Name), (
            f"{source_path}:{node.lineno} must send X-Pylva-Contract-Version"
        )
        assert value.id == "API_CONTRACT_VERSION", (
            f"{source_path}:{node.lineno} must use the shared contract-version constant"
        )
