"""Packaging contract for the public PyPI distribution."""

from __future__ import annotations

import pathlib

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

import pylva

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_distribution_name_keeps_pylva_import_package() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())

    assert pyproject["project"]["name"] == "pylva-sdk"
    assert pyproject["project"]["version"] == "1.1.0"
    assert pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "pylva"
    ]
    assert pylva.__version__ == "1.1.0"
    assert pylva.Pylva.__name__ == "Pylva"
