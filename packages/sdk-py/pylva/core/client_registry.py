"""Explicit-client registry for failover.

Mirrors packages/sdk-ts/src/core/client_registry.ts. The legacy SDK
relied on auto-patching `openai` / `anthropic` on import; that works for
telemetry but cannot reach a backup provider's client during
reliability_failover. Per Rev-2 O6, callers now pass explicit clients
to ``Pylva(...)`` and the failover engine resolves them here.

Process-wide registry. Last registered client wins per provider.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .identifiers import clean_provider_model_identifier

_registry: dict[str, Any] = {}


def register_provider_client(provider: str, client: Any) -> None:
    safe_provider = clean_provider_model_identifier(provider)
    if safe_provider is None:
        return
    _registry[safe_provider] = client


def register_provider_clients(providers: Mapping[str, Any]) -> None:
    for provider, client in providers.items():
        register_provider_client(provider, client)


def get_registered_client(provider: str) -> Any | None:
    return _registry.get(provider)


def has_registered_client(provider: str) -> bool:
    return _registry.get(provider) is not None


def _reset_client_registry() -> None:
    """Test-only reset hook."""
    _registry.clear()
