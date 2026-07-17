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
from .core.config import ControlConfig
from .core.control_schema import (
    BudgetCommitRequest,
    BudgetCommitResponse,
    BudgetExtendRequest,
    BudgetExtendResponse,
    BudgetReleaseRequest,
    BudgetReleaseResponse,
    BudgetReservationRequest,
    BudgetReservationResponse,
)


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
        control: ControlConfig | Mapping[str, Any] | None = None,
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
            control=control,
        )

        if openai is not None:
            register_provider_client("openai", openai)
        if anthropic is not None:
            register_provider_client("anthropic", anthropic)
        if providers is not None:
            register_provider_clients(providers)

        self.has_openai = openai is not None
        self.has_anthropic = anthropic is not None

    async def ready(self) -> bool:
        from .core.control_client import ready

        return await ready()

    def ready_sync(self) -> bool:
        from .core.control_client import ready_sync

        return ready_sync()

    async def reserve_usage(
        self,
        request: BudgetReservationRequest | Mapping[str, Any],
    ) -> BudgetReservationResponse:
        from .core.control_client import reserve_usage

        return await reserve_usage(request)

    def reserve_usage_sync(
        self,
        request: BudgetReservationRequest | Mapping[str, Any],
    ) -> BudgetReservationResponse:
        from .core.control_client import reserve_usage_sync

        return reserve_usage_sync(request)

    async def commit_usage(
        self,
        reservation_id: str,
        request: BudgetCommitRequest | Mapping[str, Any],
    ) -> BudgetCommitResponse:
        from .core.control_client import commit_usage

        return await commit_usage(reservation_id, request)

    def commit_usage_sync(
        self,
        reservation_id: str,
        request: BudgetCommitRequest | Mapping[str, Any],
    ) -> BudgetCommitResponse:
        from .core.control_client import commit_usage_sync

        return commit_usage_sync(reservation_id, request)

    async def release_usage(
        self,
        reservation_id: str,
        request: BudgetReleaseRequest | Mapping[str, Any],
    ) -> BudgetReleaseResponse:
        from .core.control_client import release_usage

        return await release_usage(reservation_id, request)

    def release_usage_sync(
        self,
        reservation_id: str,
        request: BudgetReleaseRequest | Mapping[str, Any],
    ) -> BudgetReleaseResponse:
        from .core.control_client import release_usage_sync

        return release_usage_sync(reservation_id, request)

    async def extend_usage(
        self,
        reservation_id: str,
        request: BudgetExtendRequest | Mapping[str, Any],
    ) -> BudgetExtendResponse:
        from .core.control_client import extend_usage

        return await extend_usage(reservation_id, request)

    def extend_usage_sync(
        self,
        reservation_id: str,
        request: BudgetExtendRequest | Mapping[str, Any],
    ) -> BudgetExtendResponse:
        from .core.control_client import extend_usage_sync

        return extend_usage_sync(reservation_id, request)
