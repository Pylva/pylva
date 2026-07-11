"""run_with_engine integration tests. Mirrors
``packages/sdk-ts/tests/wrappers_engine.test.ts`` — drives the wrapper-side
engine glue without booting a real provider SDK."""

from __future__ import annotations

from typing import Any

import pytest

from pylva.core import budget_accumulator as ba
from pylva.core import rules_cache
from pylva.core.failover import ensure_state, record_outcome
from pylva.core.rules_engine import PreCallContext
from pylva.errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded
from pylva.wrappers._budget import _period_start_utc
from pylva.wrappers._engine import (
    PylvaResponseMetadata,
    attach_pylva_metadata,
    is_intentional_refusal,
    run_with_engine,
    run_with_engine_sync,
)

from ._fixtures import failover_rule, routing_rule


def _ctx(
    *,
    customer_id: str | None = "cust_1",
    step_name: str | None = "summarize",
    provider: str = "openai",
    model: str | None = "gpt-4o",
) -> PreCallContext:
    return PreCallContext(
        customer_id=customer_id, step_name=step_name, provider=provider, model=model
    )


def _push_rule(rule: dict[str, Any]) -> None:
    rules_cache._rules.append(rule)  # type: ignore[attr-defined]


def _budget_rule(rule_id: str = "budget-1") -> dict[str, Any]:
    return {
        "id": rule_id,
        "type": "budget_limit",
        "enabled": True,
        "status": "active",
        "customer_id": "cust_1",
        "config": {
            "limit_usd": 10,
            "period": "day",
            "hard_stop": True,
            "scope": "per_customer",
        },
    }


def _mark_budget_exceeded(rule_id: str = "budget-1") -> None:
    ba._reset_accumulator_for_tests()  # type: ignore[attr-defined]
    ba.mark_exceeded_from_backend(
        rule_id=rule_id,
        customer_id="cust_1",
        limit_usd=10,
        period_start=_period_start_utc("day"),
    )


# ---------- run_with_engine_sync — pass-through (no rules) -----------------


def test_sync_pass_through_returns_minimal_metadata() -> None:
    calls: list[dict[str, Any]] = []

    def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True, "model": req["model"]}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-4o"
    assert out.metadata.routing_applied is False
    assert out.metadata.original_model == "gpt-4o"
    assert out.metadata.warnings == []


# ---------- run_with_engine_sync — same-provider model routing -------------


def test_sync_same_provider_routing_mutates_request_model() -> None:
    _push_rule(
        routing_rule(
            match={"step_name": "summarize", "provider": "openai", "model": "gpt-4o"},
            route_to_model="gpt-4o-mini",
        )
    )
    calls: list[dict[str, Any]] = []

    def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True, "model": req["model"]}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert calls[0]["model"] == "gpt-4o-mini"
    assert out.metadata.routing_applied is True
    assert out.metadata.routed_model == "gpt-4o-mini"
    assert out.metadata.original_model == "gpt-4o"


def test_sync_non_string_route_to_model_is_not_forwarded() -> None:
    """R1 regression: a malformed cached rule whose `route_to.model` is a
    truthy non-string (e.g. a JSON number) must NOT be forwarded into the
    provider call. Before the engine coerced non-string models to None, the
    `decision.model and decision.fallback` guard let `123` through, the
    provider 400'd, and the error raised to the host agent. The host's
    original model must be used and the call must not raise. TS degrades the
    same input to ALLOW (rules_engine.ts:146)."""
    rule = routing_rule(match={"step_name": "summarize"})
    rule["config"]["route_to"] = {"provider": "openai", "model": 123}
    _push_rule(rule)
    calls: list[Any] = []

    class _BadRequest(Exception):  # noqa: N818 — synthetic test fixture
        status = 400

    def call(req: dict[str, Any]) -> dict:
        m = req["model"]
        calls.append(m)
        # A real provider rejects a non-string model with a 400 that is NOT
        # fallback-eligible (only 401/403/404 are) — so forwarding it raises.
        if not isinstance(m, str):
            raise _BadRequest("model must be a string")
        return {"ok": True, "model": m}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert calls == ["gpt-4o"]  # original model used, garbage never forwarded
    assert out.metadata.routing_applied is False
    assert out.metadata.original_model == "gpt-4o"


def test_sync_same_provider_falls_back_on_404() -> None:
    _push_rule(
        routing_rule(
            match={"step_name": "summarize", "model": "gpt-4o"},
            route_to_model="gpt-future",
        )
    )
    calls: list[str] = []

    class _NotFound(Exception):  # noqa: N818 — synthetic test fixture
        status = 404

    def call(req: dict[str, Any]) -> dict:
        m = req["model"]
        calls.append(m)
        if m == "gpt-future":
            raise _NotFound("model not found")
        return {"ok": True, "model": m}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert calls == ["gpt-future", "gpt-4o"]
    assert out.metadata.routing_applied is False
    assert out.metadata.warnings[0].code == "routing_fallback_not_found_404"


def test_sync_same_provider_does_not_retry_on_401() -> None:
    """D25 — same-provider routing on 401 means same key would fail again."""
    _push_rule(
        routing_rule(
            match={"step_name": "summarize"},
            route_to_model="gpt-4o-mini",
        )
    )
    calls: list[str] = []

    class _Auth(Exception):  # noqa: N818 — synthetic test fixture
        status = 401

    def call(req: dict[str, Any]) -> dict:
        calls.append(req["model"])
        raise _Auth("auth")

    with pytest.raises(_Auth):
        run_with_engine_sync(
            request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
        )
    assert calls == ["gpt-4o-mini"]


# ---------- cross-provider routing skipped --------------------------------


def test_sync_cross_provider_routing_skipped_with_warning() -> None:
    _push_rule(
        routing_rule(
            match={"step_name": "summarize"},
            route_to_provider="anthropic",
            route_to_model="claude-sonnet",
        )
    )
    calls: list[dict[str, Any]] = []

    def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True, "model": req["model"]}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert calls[0]["model"] == "gpt-4o"
    assert out.metadata.routing_applied is False
    assert any(w.code == "routing_cross_provider_skipped" for w in out.metadata.warnings)


# ---------- budget hard-block ---------------------------------------------


def test_sync_budget_block_throws_before_call() -> None:
    _push_rule(_budget_rule())
    _mark_budget_exceeded()
    calls: list[Any] = []

    def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True}

    with pytest.raises(PylvaBudgetExceeded):
        run_with_engine_sync(
            request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
        )
    assert calls == []


# ---------- failover outcome recording ------------------------------------


def _failover_cfg_obj() -> Any:
    """Build the dataclass form of the shared failover rule config so we
    can inspect ensure_state's per-pair window."""
    from pylva.core.failover import ReliabilityFailoverConfig

    cfg = failover_rule()["config"]
    return ReliabilityFailoverConfig(
        enabled=cfg["enabled"],
        customer_id=cfg["customer_id"],
        primary_provider=cfg["primary_provider"],
        backup_provider=cfg["backup_provider"],
        trigger_error_rate_pct=float(cfg["trigger_error_rate_pct"]),
        recover_error_rate_pct=float(cfg["recover_error_rate_pct"]),
        window_seconds=float(cfg["window_seconds"]),
        recover_after_seconds=float(cfg["recover_after_seconds"]),
        recovery_probe_after_seconds=float(cfg["recovery_probe_after_seconds"]),
        consent_to_cost_shift=bool(cfg["consent_to_cost_shift"]),
    )


def test_sync_records_ok_true_on_success() -> None:
    _push_rule(failover_rule())

    def call(req: dict[str, Any]) -> dict:
        return {"ok": True}

    run_with_engine_sync(request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call)
    samples = ensure_state(_failover_cfg_obj()).samples
    assert len(samples) == 1
    assert samples[0].ok is True


def test_sync_records_ok_false_when_call_throws() -> None:
    _push_rule(failover_rule())

    def call(req: dict[str, Any]) -> dict:
        raise RuntimeError("upstream 500")

    with pytest.raises(RuntimeError):
        run_with_engine_sync(
            request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
        )
    samples = ensure_state(_failover_cfg_obj()).samples
    assert len(samples) == 1
    assert samples[0].ok is False


def test_sync_malformed_numeric_failover_does_not_raise_to_host() -> None:
    """R1 regression: a reliability_failover rule whose `float()`-coerced
    field is a non-numeric string / JSON null raised ValueError/TypeError out
    of `_setup_engine` — which runs BEFORE `run_with_engine`'s try — straight
    into the host wrapper, which re-raises any non-refusal error to the host
    agent. The malformed rule must be skipped and the host's own call must
    still execute and succeed. Sibling of #297 (route_to coercion)."""
    _push_rule(failover_rule(cfg_overrides={"trigger_error_rate_pct": "high"}))
    calls: list[str] = []

    def call(req: dict[str, Any]) -> dict:
        calls.append(req["model"])
        return {"ok": True, "model": req["model"]}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )

    assert calls == ["gpt-4o"]  # host call ran, unrouted, not crashed
    assert out.metadata.original_model == "gpt-4o"


def test_sync_missing_backup_warning_mentions_pylva_alias() -> None:
    _push_rule(failover_rule())
    record_outcome(_failover_cfg_obj(), ok=False, now=0)

    def call(req: dict[str, Any]) -> dict:
        return {"ok": True}

    out = run_with_engine_sync(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )

    warning = next(w for w in out.metadata.warnings if w.code == "failover_missing_backup")
    assert 'Pylva(..., providers={"anthropic": client})' in warning.message
    assert "constructor alias" not in warning.message


# ---------- async parity --------------------------------------------------


@pytest.mark.asyncio
async def test_async_malformed_numeric_failover_does_not_raise_to_host() -> None:
    """Async R1 regression witness for the malformed numeric failover path.

    The sync test above covers today's shared `_setup_engine` path; this keeps
    the async wrapper path guarded if setup ever diverges.
    """
    _push_rule(failover_rule(cfg_overrides={"trigger_error_rate_pct": "high"}))
    calls: list[str] = []

    async def call(req: dict[str, Any]) -> dict[str, Any]:
        calls.append(req["model"])
        return {"ok": True, "model": req["model"]}

    out = await run_with_engine(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )

    assert calls == ["gpt-4o"]  # host call ran, unrouted, not crashed
    assert out.metadata.original_model == "gpt-4o"
    assert out.metadata.routing_applied is False


@pytest.mark.asyncio
async def test_async_same_provider_routing_mutates_request_model() -> None:
    _push_rule(
        routing_rule(
            match={"step_name": "summarize", "model": "gpt-4o"},
            route_to_model="gpt-4o-mini",
        )
    )
    calls: list[dict[str, Any]] = []

    async def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True, "model": req["model"]}

    out = await run_with_engine(
        request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
    )
    assert calls[0]["model"] == "gpt-4o-mini"
    assert out.metadata.routing_applied is True
    assert out.metadata.routed_model == "gpt-4o-mini"


@pytest.mark.asyncio
async def test_async_budget_block_throws_before_call() -> None:
    _push_rule(_budget_rule())
    _mark_budget_exceeded()
    calls: list[Any] = []

    async def call(req: dict[str, Any]) -> dict:
        calls.append(req)
        return {"ok": True}

    with pytest.raises(PylvaBudgetExceeded):
        await run_with_engine(
            request={"model": "gpt-4o"}, provider_id="openai", ctx=_ctx(), call=call
        )
    assert calls == []


# ---------- helpers -------------------------------------------------------


def test_attach_metadata_sets_attribute_when_writable() -> None:
    class _Resp:
        pass

    resp = _Resp()
    metadata = PylvaResponseMetadata(
        original_model="gpt-4o", routing_applied=False, failover_active=False
    )
    out = attach_pylva_metadata(resp, metadata)
    assert out is resp
    assert out._pylva is metadata


def test_attach_metadata_swallows_setattr_errors() -> None:
    """Some Pydantic / __slots__ objects reject setattr — the helper must
    not break the host's call path."""

    class _Frozen:
        __slots__ = ()  # blocks attribute setting

    resp = _Frozen()
    metadata = PylvaResponseMetadata(
        original_model="gpt-4o", routing_applied=False, failover_active=False
    )
    # Should not raise
    out = attach_pylva_metadata(resp, metadata)
    assert out is resp


def test_is_intentional_refusal_true_for_budget() -> None:
    err = PylvaBudgetExceeded(
        source=BudgetExceededSource.SDK_PRECALL,
        rule_id="r1",
        customer_id="c1",
        period="day",
        period_start="2026-04-26T00:00:00Z",
        limit_usd=10.0,
        accumulated_usd=10.5,
        estimated_usd=0.0,
    )
    assert is_intentional_refusal(err) is True


def test_is_intentional_refusal_false_for_other_errors() -> None:
    assert is_intentional_refusal(RuntimeError("upstream 500")) is False
    assert is_intentional_refusal(ValueError("bad input")) is False
