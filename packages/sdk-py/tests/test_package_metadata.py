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
    version = pyproject["project"]["version"]

    assert pyproject["project"]["name"] == "pylva-sdk"
    assert isinstance(version, str)
    assert version.count(".") == 2
    assert pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == ["pylva"]
    assert pylva.__version__ == version
    assert pylva.Pylva.__name__ == "Pylva"


def test_provider_sdks_are_development_only_dependencies() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    runtime_dependencies = project["dependencies"]
    development_dependencies = project["optional-dependencies"]["dev"]

    assert not any(item.startswith(("openai", "anthropic")) for item in runtime_dependencies)
    assert any(item.startswith("openai") for item in development_dependencies)
    assert any(item.startswith("anthropic") for item in development_dependencies)
