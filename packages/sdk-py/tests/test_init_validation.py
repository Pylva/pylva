"""Init-time failover validation (D52). Mirrors
``packages/sdk-ts/tests/init_validation.test.ts`` — verifies that the SDK
warns once at init when a reliability_failover rule names a backup
provider that is neither auto-patched nor passed to the Pylva constructor."""

from __future__ import annotations

from typing import Any

import pytest

from pylva.wrappers._init_validation import (
    _reset_init_validation_for_tests,
    mark_provider_patched,
    validate_failover_wrappers,
)

from ._fixtures import failover_rule, routing_rule


@pytest.fixture(autouse=True)
def _reset_validation() -> None:
    _reset_init_validation_for_tests()


def test_warns_when_backup_neither_patched_nor_registered(
    capsys: pytest.CaptureFixture[str],
) -> None:
    validate_failover_wrappers([failover_rule()])
    captured = capsys.readouterr()
    assert 'reliability_failover rule "f1"' in captured.out
    assert "anthropic SDK is neither auto-patched nor passed" in captured.out
    assert 'Pylva(..., providers={"anthropic": client})' in captured.out
    assert "constructor alias" not in captured.out


def test_no_warning_when_both_wrappers_loaded(capsys: pytest.CaptureFixture[str]) -> None:
    mark_provider_patched("openai")
    mark_provider_patched("anthropic")
    validate_failover_wrappers([failover_rule()])
    assert capsys.readouterr().out == ""


def test_warns_once_per_pair_across_multiple_runs(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers([failover_rule()])
    validate_failover_wrappers([failover_rule()])
    validate_failover_wrappers([failover_rule()])
    captured_out = capsys.readouterr().out
    # Only one warning line in the captured stream.
    assert captured_out.count("reliability_failover rule") == 1


def test_warns_separately_for_distinct_pairs(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers(
        [
            failover_rule(
                rule_id="f1",
                cfg_overrides={"primary_provider": "openai", "backup_provider": "anthropic"},
            ),
            failover_rule(
                rule_id="f2",
                cfg_overrides={"primary_provider": "anthropic", "backup_provider": "google"},
            ),
        ]
    )
    captured_out = capsys.readouterr().out
    assert captured_out.count("reliability_failover rule") == 2


def test_skips_envelope_disabled(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers([failover_rule(envelope_enabled=False)])
    assert capsys.readouterr().out == ""


def test_skips_cfg_disabled(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers([failover_rule(cfg_overrides={"enabled": False})])
    assert capsys.readouterr().out == ""


def test_ignores_non_failover_rules(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers([routing_rule()])
    assert capsys.readouterr().out == ""


def test_handles_empty_rules_array(capsys: pytest.CaptureFixture[str]) -> None:
    validate_failover_wrappers([])
    assert capsys.readouterr().out == ""


def test_swallows_malformed_rules_with_diagnostic(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If narrow_rules raises (cache returned schema-drift garbage), the
    validator surfaces a single 'skipped' warning instead of crashing init."""
    from pylva.wrappers import _init_validation

    def _broken(_raw: list[Any]) -> list[Any]:
        raise RuntimeError("schema drift")

    monkeypatch.setattr(_init_validation, "narrow_rules", _broken)
    validate_failover_wrappers([failover_rule()])
    out = capsys.readouterr().out
    assert "failover validation skipped" in out
    # The error type name should appear so operators can pin down the cause.
    assert "RuntimeError" in out


def test_mark_provider_patched_clears_warning(capsys: pytest.CaptureFixture[str]) -> None:
    """Once a wrapper registers, future validations for that pair stay silent."""
    mark_provider_patched("anthropic")
    validate_failover_wrappers([failover_rule()])
    assert capsys.readouterr().out == ""
