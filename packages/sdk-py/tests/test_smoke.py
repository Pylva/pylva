"""Phase 0 smoke test — confirms the package imports and exposes its metadata version."""

from __future__ import annotations

import pathlib

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

import pylva

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_package_imports() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    assert pylva.__version__ == project["version"]


def test_authoritative_control_helpers_are_public() -> None:
    expected = {
        "controlled_usage",
        "controlled_usage_sync",
        "controlled_exact_usage",
        "controlled_exact_usage_sync",
        "controlled_tavily_search",
        "controlled_tavily_search_sync",
        "wrap_openai",
        "wrap_anthropic",
    }

    assert expected <= set(pylva.__all__)
    assert all(callable(getattr(pylva, name)) for name in expected)
