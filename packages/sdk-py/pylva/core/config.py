"""SDK configuration — D19 parity with TS.

``init()`` validates the API key format synchronously. Backend validation is
fire-and-forget; the first 401 from a flush enters degraded mode and drops
the buffer (see ``core.telemetry``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

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


@dataclass(frozen=True)
class ResolvedConfig:
    api_key: str
    endpoint: str
    batch_size: int
    flush_interval: float  # seconds
    local_mode: bool
    non_llm: Mapping[str, Any] | None = None


_current: ResolvedConfig | None = None


def is_valid_api_key_format(api_key: str) -> bool:
    return bool(API_KEY_PATTERN.match(api_key))


def init(
    api_key: str,
    *,
    endpoint: str | None = None,
    batch_size: int = 100,
    flush_interval: float = 5.0,
    local_mode: bool = False,
    non_llm: Mapping[str, Any] | None = None,
) -> None:
    """Configure the SDK. Raises InvalidApiKeyError on malformed key."""
    global _current
    if not isinstance(api_key, str) or not is_valid_api_key_format(api_key):
        raise InvalidApiKeyError(
            "apiKey must match pv_(live|cli)_{8 hex}_{32 hex} format",
        )
    _current = ResolvedConfig(
        api_key=api_key,
        endpoint=endpoint or "https://api.pylva.com",
        batch_size=batch_size,
        flush_interval=flush_interval,
        local_mode=local_mode,
        non_llm=non_llm,
    )


def get_config() -> ResolvedConfig | None:
    return _current


def require_config() -> ResolvedConfig:
    if _current is None:
        raise RuntimeError(
            "[pylva] SDK not initialized; call pylva.init(api_key=...) first",
        )
    return _current


def is_initialized() -> bool:
    return _current is not None


def _reset_config_for_tests() -> None:
    global _current
    _current = None
