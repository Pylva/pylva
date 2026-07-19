"""Parity with TS config.test.ts — D19 sync format validation."""

from collections.abc import Iterator, Mapping

import pytest

import pylva
from pylva.core.config import (
    ControlConfig,
    InvalidApiKeyError,
    InvalidControlConfigError,
    _reset_config_for_tests,
    get_config,
    get_config_generation,
)

VALID_KEY = "pv_live_12345678_" + "a" * 32


class _HostileStr(str):
    def __hash__(self) -> int:
        raise RuntimeError("hash must not run")

    def __eq__(self, _other: object) -> bool:
        raise RuntimeError("equality must not run")

    def __repr__(self) -> str:
        raise RuntimeError("repr must not run")


class _HostileInt(int):
    def __lt__(self, _other: object) -> bool:
        raise RuntimeError("comparison must not run")

    def __gt__(self, _other: object) -> bool:
        raise RuntimeError("comparison must not run")

    def __repr__(self) -> str:
        raise RuntimeError("repr must not run")


class _BrokenMapping(Mapping[str, object]):
    def __getitem__(self, _key: str) -> object:
        raise RuntimeError("mapping lookup failed")

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError("mapping iteration failed")

    def __len__(self) -> int:
        return 1


class _InterruptingMapping(Mapping[str, object]):
    def __getitem__(self, _key: str) -> object:
        raise KeyboardInterrupt

    def __iter__(self) -> Iterator[str]:
        raise KeyboardInterrupt

    def __len__(self) -> int:
        return 1


class _HostileKey:
    def __hash__(self) -> int:
        return 7

    def __eq__(self, _other: object) -> bool:
        raise RuntimeError("key equality must not run")

    def __repr__(self) -> str:
        raise RuntimeError("key repr must not run")


class _OneKeyMapping(Mapping[object, object]):
    def __init__(self, key: object) -> None:
        self.key = key

    def __getitem__(self, key: object) -> object:
        if key is not self.key:
            raise KeyError
        return "enforce"

    def __iter__(self) -> Iterator[object]:
        yield self.key

    def __len__(self) -> int:
        return 1


class _ThrowingHashKey:
    def __hash__(self) -> int:
        raise RuntimeError("key hash failed")


def _forged_control_config(
    *,
    mode: object = "legacy",
    on_unavailable: object = "allow",
    timeout_ms: object = 2_000,
) -> ControlConfig:
    value = object.__new__(ControlConfig)
    object.__setattr__(value, "mode", mode)
    object.__setattr__(value, "on_unavailable", on_unavailable)
    object.__setattr__(value, "timeout_ms", timeout_ms)
    return value


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


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("mode", _HostileStr("enforce")),
        ("on_unavailable", _HostileStr("deny")),
        ("timeout_ms", _HostileInt(2_000)),
        ("timeout_ms", True),
    ],
    ids=["mode-subclass", "policy-subclass", "timeout-subclass", "timeout-bool"],
)
def test_control_values_require_exact_builtin_types_without_executing_hooks(
    field: str,
    value: object,
) -> None:
    with pytest.raises(InvalidControlConfigError):
        pylva.init(VALID_KEY, control={field: value})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "value",
    [
        _forged_control_config(mode=[]),
        _forged_control_config(on_unavailable={}),
        _forged_control_config(timeout_ms=True),
        _forged_control_config(timeout_ms=_HostileInt(2_000)),
    ],
    ids=["mode", "policy", "timeout-bool", "timeout-subclass"],
)
def test_forged_control_config_is_revalidated(value: ControlConfig) -> None:
    with pytest.raises(InvalidControlConfigError):
        pylva.init(VALID_KEY, control=value)


def test_hostile_mapping_failures_and_keys_use_sanitized_documented_error() -> None:
    values: list[object] = [
        _BrokenMapping(),
        _OneKeyMapping(_ThrowingHashKey()),
        _OneKeyMapping(_HostileKey()),
    ]
    for value in values:
        with pytest.raises(InvalidControlConfigError) as caught:
            pylva.init(VALID_KEY, control=value)  # type: ignore[arg-type]
        assert str(caught.value).startswith("[pylva] invalid control config:")
        assert caught.value.__cause__ is None


def test_control_normalization_does_not_catch_base_exception() -> None:
    with pytest.raises(KeyboardInterrupt):
        pylva.init(VALID_KEY, control=_InterruptingMapping())


def test_rejected_control_does_not_replace_installed_configuration() -> None:
    pylva.init(VALID_KEY, endpoint="https://installed.test", control={"mode": "shadow"})
    installed = get_config()
    generation = get_config_generation()

    with pytest.raises(InvalidControlConfigError):
        pylva.init(
            VALID_KEY,
            endpoint="https://rejected.test",
            control=_forged_control_config(mode=[]),
        )

    assert get_config() is installed
    assert get_config_generation() == generation
