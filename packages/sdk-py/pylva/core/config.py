"""SDK configuration — D19 parity with TS.

``init()`` validates the API key format synchronously. Backend validation is
fire-and-forget; the first 401 from a flush enters degraded mode and drops
the buffer (see ``core.telemetry``).
"""

from __future__ import annotations

import re
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, cast

# One universal key: pv_live_* is the standard prefix; pv_cli_* keys from
# the retired data-import type remain valid everywhere.
API_KEY_PATTERN = re.compile(r"^pv_(?:live|cli)_[a-f0-9]{8}_[a-f0-9]{32}$")


class InvalidApiKeyError(ValueError):
    """Raised by init() when the apiKey does not match pv_(live|cli)_{8}_{32}."""

    def __init__(
        self,
        message: str = "Invalid Pylva API key format",
    ) -> None:
        super().__init__(f"[pylva] {message}")


class InvalidControlConfigError(TypeError):
    """Raised synchronously when additive authoritative-control config is invalid."""

    def __init__(self, message: str) -> None:
        super().__init__(f"[pylva] invalid control config: {message}")


ControlMode = Literal["legacy", "shadow", "enforce"]
ControlUnavailablePolicy = Literal["allow", "deny"]

DEFAULT_CONTROL_TIMEOUT_MS = 2_000
MIN_CONTROL_TIMEOUT_MS = 100
MAX_CONTROL_TIMEOUT_MS = 30_000


@dataclass(frozen=True)
class ControlConfig:
    """Optional authoritative-control behavior supplied to :func:`pylva.init`."""

    mode: ControlMode = "legacy"
    on_unavailable: ControlUnavailablePolicy = "allow"
    timeout_ms: int = DEFAULT_CONTROL_TIMEOUT_MS

    def __post_init__(self) -> None:
        _validate_control_values(self.mode, self.on_unavailable, self.timeout_ms)


@dataclass(frozen=True)
class ResolvedControlConfig:
    mode: ControlMode
    on_unavailable: ControlUnavailablePolicy
    timeout_ms: int


@dataclass(frozen=True)
class ResolvedConfig:
    api_key: str
    endpoint: str
    batch_size: int
    flush_interval: float  # seconds
    local_mode: bool
    non_llm: Mapping[str, Any] | None = None
    control: ResolvedControlConfig = ResolvedControlConfig(
        mode="legacy",
        on_unavailable="allow",
        timeout_ms=DEFAULT_CONTROL_TIMEOUT_MS,
    )


_current: ResolvedConfig | None = None
_config_generation = 0
_config_lock = threading.RLock()


_IDENTITY_CHANGE_HOOKS = (
    ("pylva.core.telemetry", "_prepare_configuration_change"),
    ("pylva.core.budget_accumulator", "_invalidate_accumulator_for_config_change"),
    ("pylva.core.rules_cache", "_invalidate_rules_cache_for_config_change"),
    ("pylva.core.pricing_cache", "_invalidate_pricing_cache_for_config_change"),
    ("pylva.core.non_llm_policy", "_invalidate_non_llm_policy_for_config_change"),
    ("pylva.core.control_client", "_invalidate_control_client_for_config_change"),
    ("pylva.core.control_ownership", "_invalidate_control_ownership_for_config_change"),
)


def _prepare_builder_identity_change(next_generation: int) -> None:
    """Invalidate loaded builder-scoped modules before installing an identity.

    Only already-imported modules can contain process-local state, so avoiding
    imports here also prevents a configuration call from creating optional
    background subsystems. Hooks are deliberately invoked while
    ``_config_lock`` is held. Each hook owns its finer-grained state lock and
    must not call back into configuration mutation.
    """

    for module_name, hook_name in _IDENTITY_CHANGE_HOOKS:
        module = sys.modules.get(module_name)
        if module is None:
            continue
        hook = getattr(module, hook_name, None)
        if hook is not None:
            hook(next_generation)


def is_valid_api_key_format(api_key: str) -> bool:
    return bool(API_KEY_PATTERN.match(api_key))


def _validate_control_values(mode: object, on_unavailable: object, timeout_ms: object) -> None:
    if type(mode) is not str or mode not in {"legacy", "shadow", "enforce"}:
        raise InvalidControlConfigError("mode must be legacy, shadow, or enforce")
    if type(on_unavailable) is not str or on_unavailable not in {"allow", "deny"}:
        raise InvalidControlConfigError("on_unavailable must be allow or deny")
    if (
        type(timeout_ms) is not int
        or timeout_ms < MIN_CONTROL_TIMEOUT_MS
        or timeout_ms > MAX_CONTROL_TIMEOUT_MS
    ):
        raise InvalidControlConfigError(
            f"timeout_ms must be an integer between {MIN_CONTROL_TIMEOUT_MS} "
            f"and {MAX_CONTROL_TIMEOUT_MS}"
        )


def _resolve_control_config(
    value: ControlConfig | Mapping[str, Any] | None,
) -> ResolvedControlConfig:
    try:
        if value is None:
            return ResolvedControlConfig(
                mode="legacy",
                on_unavailable="allow",
                timeout_ms=DEFAULT_CONTROL_TIMEOUT_MS,
            )
        if isinstance(value, ControlConfig):
            mode = value.mode
            on_unavailable = value.on_unavailable
            timeout_ms = value.timeout_ms
            _validate_control_values(mode, on_unavailable, timeout_ms)
            return ResolvedControlConfig(
                mode=cast(ControlMode, mode),
                on_unavailable=cast(ControlUnavailablePolicy, on_unavailable),
                timeout_ms=cast(int, timeout_ms),
            )
        if not isinstance(value, Mapping):
            raise InvalidControlConfigError("control must be a mapping or ControlConfig")

        # Snapshot an arbitrary Mapping before reading fields so later mapping
        # mutation cannot change the validated configuration. Every ordinary
        # mapping failure is normalized below without rendering attacker-owned
        # keys or values into the public error message.
        snapshot = dict(value)
        allowed = {"mode", "on_unavailable", "timeout_ms"}
        for key in snapshot:
            if type(key) is not str:
                raise InvalidControlConfigError("control field names must be exact strings")
            if key not in allowed:
                raise InvalidControlConfigError("control contains an unknown field")
        mode = snapshot.get("mode", "legacy")
        on_unavailable = snapshot.get("on_unavailable", "allow")
        timeout_ms = snapshot.get("timeout_ms", DEFAULT_CONTROL_TIMEOUT_MS)
        _validate_control_values(mode, on_unavailable, timeout_ms)
        return ResolvedControlConfig(
            mode=cast(ControlMode, mode),
            on_unavailable=cast(ControlUnavailablePolicy, on_unavailable),
            timeout_ms=cast(int, timeout_ms),
        )
    except InvalidControlConfigError:
        raise
    except Exception:
        # Do not retain an attacker-controlled exception as __cause__: logging
        # the normalized public error must not render a hostile/secret message.
        raise InvalidControlConfigError("control could not be read safely") from None


def init(
    api_key: str,
    *,
    endpoint: str | None = None,
    batch_size: int = 100,
    flush_interval: float = 5.0,
    local_mode: bool = False,
    non_llm: Mapping[str, Any] | None = None,
    control: ControlConfig | Mapping[str, Any] | None = None,
) -> None:
    """Configure the SDK. Raises InvalidApiKeyError on malformed key."""
    global _config_generation, _current
    if not isinstance(api_key, str) or not is_valid_api_key_format(api_key):
        raise InvalidApiKeyError(
            "apiKey must match pv_(live|cli)_{8 hex}_{32 hex} format",
        )
    resolved_control = _resolve_control_config(control)
    next_config = ResolvedConfig(
        api_key=api_key,
        endpoint=endpoint or "https://api.pylva.com",
        batch_size=batch_size,
        flush_interval=flush_interval,
        local_mode=local_mode,
        non_llm=non_llm,
        control=resolved_control,
    )
    with _config_lock:
        # Installing the first identity cannot leak data from a previous
        # tenant and must preserve state explicitly seeded before init().
        # Resets already advance/invalidate their own generation.
        identity_changed = _current is not None and (
            _current.api_key != next_config.api_key or _current.endpoint != next_config.endpoint
        )
        if identity_changed:
            next_generation = _config_generation + 1
            # Move every loaded state holder to the next generation first.
            # During this tiny handoff, generation-aware producers refuse to
            # place old-builder work into the freshly cleared state.
            _prepare_builder_identity_change(next_generation)
            _config_generation = next_generation
        _current = next_config


def get_config() -> ResolvedConfig | None:
    with _config_lock:
        return _current


def require_config() -> ResolvedConfig:
    with _config_lock:
        current = _current
    if current is None:
        raise RuntimeError(
            "[pylva] SDK not initialized; call pylva.init(api_key=...) first",
        )
    return current


def _require_config_snapshot() -> tuple[ResolvedConfig, int]:
    """Atomically capture the configured builder and its cache generation."""

    with _config_lock:
        if _current is None:
            raise RuntimeError(
                "[pylva] SDK not initialized; call pylva.init(api_key=...) first",
            )
        return _current, _config_generation


def is_initialized() -> bool:
    with _config_lock:
        return _current is not None


def get_config_generation() -> int:
    """Internal builder-scoped generation; not part of the public facade."""

    with _config_lock:
        return _config_generation


def _reset_config_for_tests() -> None:
    global _config_generation, _current
    with _config_lock:
        next_generation = _config_generation + 1
        _prepare_builder_identity_change(next_generation)
        _current = None
        _config_generation = next_generation
