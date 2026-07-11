"""Explicit-client Pylva constructor.

Mirrors packages/sdk-ts/src/Pylva.ts. Telemetry-only deployments
keep using ``pylva.init(api_key)``; cross-provider failover
requires this constructor so the SDK has a handle to the backup
provider's client.

Usage::

    from openai import OpenAI
    from anthropic import Anthropic
    from pylva import Pylva

    Pylva(
        api_key="pv_live_...",
        openai=OpenAI(),
        anthropic=Anthropic(),
        providers={"openrouter": openrouter_client},
    )
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .core.client_registry import register_provider_client, register_provider_clients


class Pylva:
    """Explicit-client SDK constructor (O6 — required for failover)."""

    def __init__(
        self,
        api_key: str,
        *,
        endpoint: str | None = None,
        batch_size: int = 100,
        flush_interval: float = 5.0,
        local_mode: bool = False,
        non_llm: dict[str, Any] | None = None,
        openai: Any | None = None,
        anthropic: Any | None = None,
        providers: Mapping[str, Any] | None = None,
    ) -> None:
        # Late import to avoid circulars; pylva/__init__.py imports
        # this module to re-export Pylva.
        from . import init as _init

        _init(
            api_key,
            endpoint=endpoint,
            batch_size=batch_size,
            flush_interval=flush_interval,
            local_mode=local_mode,
            non_llm=non_llm,
        )

        if openai is not None:
            register_provider_client("openai", openai)
        if anthropic is not None:
            register_provider_client("anthropic", anthropic)
        if providers is not None:
            register_provider_clients(providers)

        self.has_openai = openai is not None
        self.has_anthropic = anthropic is not None
