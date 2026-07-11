"""Shared rule fixture builders for the engine + wrapper tests.

Centralized so the 9-field reliability_failover config and the model_routing
shape don't drift across test files. Keep in sync with TS
``packages/sdk-ts/tests/helpers/failover_fixtures.ts``."""

from __future__ import annotations

from typing import Any

FALLBACK_DEFAULT: dict[str, bool] = {
    "on_cross_provider_auth_error": True,
    "on_access_denied": True,
    "on_model_not_found": True,
    "use_original_model": True,
    "skip_same_provider_401": True,
}

FAILOVER_CFG_BASE: dict[str, Any] = {
    "enabled": True,
    "customer_id": "cust_1",
    "primary_provider": "openai",
    "backup_provider": "anthropic",
    "trigger_error_rate_pct": 10,
    "recover_error_rate_pct": 2,
    "window_seconds": 60,
    "recover_after_seconds": 60,
    "recovery_probe_after_seconds": 1800,
    "consent_to_cost_shift": True,
}


def routing_rule(
    *,
    rule_id: str = "r1",
    rule_customer_id: str | None = None,
    match: dict[str, Any] | None = None,
    route_to_provider: str = "openai",
    route_to_model: str = "gpt-4o-mini",
    updated_at: str = "2026-04-26T00:00:00Z",
    fallback: dict[str, bool] | None = None,
) -> dict[str, Any]:
    return {
        "id": rule_id,
        "type": "model_routing",
        "enabled": True,
        "status": "active",
        "customer_id": rule_customer_id,
        "updated_at": updated_at,
        "config": {
            "scope": "per_customer",
            "match": match or {},
            "route_to": {"provider": route_to_provider, "model": route_to_model},
            "fallback": fallback or FALLBACK_DEFAULT,
        },
    }


def failover_rule(
    *,
    rule_id: str = "f1",
    cfg_overrides: dict[str, Any] | None = None,
    envelope_enabled: bool = True,
) -> dict[str, Any]:
    cfg = {**FAILOVER_CFG_BASE, **(cfg_overrides or {})}
    return {
        "id": rule_id,
        "type": "reliability_failover",
        "enabled": envelope_enabled,
        "status": "active",
        "customer_id": cfg["customer_id"],
        "updated_at": "2026-04-26T00:00:00Z",
        "config": cfg,
    }
