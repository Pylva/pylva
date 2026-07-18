"""Parity with TS config.test.ts — D19 sync format validation."""

import pytest

import pylva
from pylva.core.config import (
    InvalidApiKeyError,
    InvalidControlConfigError,
    _reset_config_for_tests,
)

VALID_KEY = "pv_live_12345678_" + "a" * 32


def setup_function(_func):  # type: ignore[no-untyped-def]
    _reset_config_for_tests()


def test_accepts_valid_key() -> None:
    pylva.init(VALID_KEY)
    assert pylva.is_initialized() is True


def test_accepts_legacy_cli_key() -> None:
    # One universal key since migration 048: legacy pv_cli_* keys work too.
    pylva.init(f"pv_cli_12345678_{'a' * 32}")
    assert pylva.is_initialized() is True


def test_rejects_malformed_key() -> None:
    with pytest.raises(InvalidApiKeyError):
        pylva.init("not-a-key")


def test_default_invalid_key_message_uses_pylva() -> None:
    err = InvalidApiKeyError()
    assert "Invalid Pylva API key format" in str(err)


def test_rejects_bad_keyid_length() -> None:
    with pytest.raises(InvalidApiKeyError):
        pylva.init(f"pv_live_12345_{'a' * 32}")


def test_rejects_bad_random_length() -> None:
    with pytest.raises(InvalidApiKeyError):
        pylva.init(f"pv_live_12345678_{'a' * 10}")


def test_applies_defaults() -> None:
    pylva.init(VALID_KEY)
    cfg = __import__("pylva").core.config.get_config()
    assert cfg is not None
    assert cfg.endpoint == "https://api.pylva.com"
    assert cfg.batch_size == 100
    assert cfg.flush_interval == 5.0
    assert cfg.local_mode is False
    assert cfg.non_llm is None


def test_stores_non_llm_config() -> None:
    pylva.init(VALID_KEY, non_llm={"mode": "policy", "refresh_interval": 30})
    cfg = __import__("pylva").core.config.get_config()
    assert cfg is not None
    assert cfg.non_llm == {"mode": "policy", "refresh_interval": 30}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("mode", []),
        ("mode", {}),
        ("on_unavailable", []),
        ("on_unavailable", {}),
    ],
)
def test_malformed_unhashable_control_values_use_documented_error(
    field: str,
    value: object,
) -> None:
    with pytest.raises(InvalidControlConfigError):
        pylva.init(VALID_KEY, control={field: value})  # type: ignore[arg-type]
