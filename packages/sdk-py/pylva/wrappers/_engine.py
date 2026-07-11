"""Wrapper-side engine glue. Provider wrappers call ``run_with_engine``
(async) or ``run_with_engine_sync`` (sync) instead of invoking the original
SDK directly so that pre-call enforcement, model routing, and failover
state recording all run in one place. Cross-provider routing/failover is
intentionally not executed here — the wrapper for the routed/backup
provider must be loaded; this wrapper records the gap as a warning instead.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from ..core.client_registry import has_registered_client
from ..core.context import current_context
from ..core.failover import ReliabilityFailoverConfig, is_active, record_outcome
from ..core.model_routing import attempt_with_fallback, attempt_with_fallback_sync
from ..core.rules_cache import get_cached_rules
from ..core.rules_engine import (
    EngineEvaluation,
    PreCallContext,
    RuleWarning,
    evaluate_pre_call,
)
from ..errors.budget_exceeded import PylvaBudgetExceeded
from ._budget import maybe_enforce_pre_call

T = TypeVar("T")


@dataclass
class PylvaResponseMetadata:
    original_model: str | None
    routing_applied: bool
    failover_active: bool
    routed_model: str | None = None
    warnings: list[RuleWarning] = field(default_factory=list)


@dataclass
class EngineResult(Generic[T]):
    result: T
    metadata: PylvaResponseMetadata


def build_engine_ctx(provider_id: str, model: str | None) -> PreCallContext:
    """Read AsyncLocalStorage-equivalent context + the request's model into
    a PreCallContext. Centralized so openai/anthropic wrappers don't drift on
    `or None` vs `if ctx else None` spellings."""
    ctx = current_context()
    return PreCallContext(
        # Telemetry attributes untracked calls to 'anonymous' (_event.py), so
        # enforcement must use the same identity — a None here landed on a
        # different accumulator key than the backend's budget_exceeded flags,
        # leaving untracked traffic permanently unblockable.
        customer_id=(ctx.customer_id if ctx and ctx.customer_id is not None else "anonymous"),
        step_name=ctx.step_name if ctx else None,
        provider=provider_id,
        model=model,
    )


def is_intentional_refusal(err: BaseException) -> bool:
    """SDK-thrown budget refusals shouldn't emit FAILURE telemetry.

    They are not provider failures, so wrappers skip FAILURE telemetry
    for them in their catch paths.
    """
    return isinstance(err, PylvaBudgetExceeded)


def attach_pylva_metadata(response: Any, metadata: PylvaResponseMetadata) -> Any:
    """Tag the response so host apps can introspect routing/failover decisions.
    Mutates in place. Some Pydantic / __slots__ objects reject setattr —
    swallow silently rather than break the host's call (R1)."""
    try:
        response._pylva = metadata
    except (AttributeError, TypeError):
        pass
    return response


def _build_metadata(
    *,
    original_model: str | None,
    routing_applied: bool,
    routed_model: str | None,
    failover_active: bool,
    warnings: list[RuleWarning],
) -> PylvaResponseMetadata:
    return PylvaResponseMetadata(
        original_model=original_model,
        routing_applied=routing_applied,
        failover_active=failover_active,
        routed_model=routed_model,
        warnings=warnings,
    )


@dataclass
class _EngineSetup:
    """Common pre-call setup result. Bundling these prevents the
    positional-misread risk of unpacking a 4-tuple in two places."""

    evaluation: EngineEvaluation
    failover_cfg: ReliabilityFailoverConfig | None
    failover_active: bool
    warnings: list[RuleWarning]


def _setup_engine(ctx: PreCallContext, provider_id: str) -> _EngineSetup:
    """Pre-call setup shared by sync + async paths."""
    maybe_enforce_pre_call(customer_id=ctx.customer_id, estimated_usd=0)
    evaluation = evaluate_pre_call(get_cached_rules(), ctx)
    failover_cfg = evaluation.failover.cfg if evaluation.failover else None
    failover_active = is_active(failover_cfg) if failover_cfg else False

    warnings: list[RuleWarning] = []
    # PR #84 review (bug_028) — emit a warning on EVERY active-failover
    # call, but distinguish:
    #   - failover_missing_backup: builder hasn't registered the backup
    #     client at all (tells them what to do).
    #   - failover_dispatch_not_implemented: builder has registered the
    #     backup but v1 doesn't route there yet (tells them this is a
    #     known gap).
    # Without the second signal, builders who do the right thing see
    # `failover_active=True` with zero warnings while every call still
    # hits the failing primary — silent broken state.
    if failover_cfg and failover_active:
        if has_registered_client(failover_cfg.backup_provider):
            warnings.append(
                RuleWarning(
                    code="failover_dispatch_not_implemented",
                    message=(
                        f"Failover active for {failover_cfg.primary_provider} "
                        f"→ {failover_cfg.backup_provider}; backup client is "
                        f"registered but cross-provider dispatch is not yet "
                        f"implemented. Calls continue on the failing primary "
                        f"until the v2 follow-up lands."
                    ),
                )
            )
        else:
            warnings.append(
                RuleWarning(
                    code="failover_missing_backup",
                    message=(
                        f"Failover active for {failover_cfg.primary_provider} "
                        f"→ {failover_cfg.backup_provider}, but no "
                        f"{failover_cfg.backup_provider} client is registered. "
                        f"Pass one via "
                        f"`Pylva(..., providers={{\"{failover_cfg.backup_provider}\": client}})` "
                        f"so failover can route there."
                    ),
                )
            )
    return _EngineSetup(
        evaluation=evaluation,
        failover_cfg=failover_cfg,
        failover_active=failover_active,
        warnings=warnings,
    )


async def run_with_engine(
    *,
    request: dict[str, Any],
    provider_id: str,
    ctx: PreCallContext,
    call: Callable[[dict[str, Any]], Awaitable[T]],
) -> EngineResult[T]:
    """Async entry point. Throws PylvaBudgetExceeded before any provider call
    when the pre-call hook hard-blocks. Records failover outcome on both
    success and provider-call failure paths."""
    setup = _setup_engine(ctx, provider_id)
    failover_cfg = setup.failover_cfg
    warnings = setup.warnings
    decision = setup.evaluation.decision

    original_model = request.get("model")
    routing_applied = False
    routed_model: str | None = None

    try:
        if decision.action == "route_model" and decision.model and decision.fallback:
            is_same_provider = decision.provider == provider_id
            if not is_same_provider:
                warnings.append(
                    RuleWarning(
                        code="routing_cross_provider_skipped",
                        message=(
                            f"Cross-provider routing ({provider_id} → "
                            f"{decision.provider}) requires the "
                            f"{decision.provider} wrapper. Routing skipped; "
                            f"original model used."
                        ),
                    )
                )
                result = await call(request)
            else:

                async def routed_call(model: str) -> T:
                    return await call({**request, "model": model})

                attempt = await attempt_with_fallback(
                    call=routed_call,
                    routed_model=decision.model,
                    original_model=decision.original_model or (original_model or ""),
                    is_same_provider=True,
                    fallback=decision.fallback,
                )
                result = attempt.result
                routing_applied = not attempt.fell_back
                routed_model = attempt.model_used
                if attempt.fell_back and attempt.fallback_reason:
                    warnings.append(
                        RuleWarning(
                            code=attempt.fallback_reason,
                            message=(
                                f"Routed model failed; fell back to original "
                                f"{decision.original_model}."
                            ),
                        )
                    )
        else:
            result = await call(request)
    except BaseException:
        if failover_cfg:
            record_outcome(failover_cfg, ok=False)
        raise

    if failover_cfg:
        record_outcome(failover_cfg, ok=True)

    metadata = _build_metadata(
        original_model=original_model,
        routing_applied=routing_applied,
        routed_model=routed_model,
        failover_active=setup.failover_active,
        warnings=warnings,
    )
    return EngineResult(result=result, metadata=metadata)


def run_with_engine_sync(
    *,
    request: dict[str, Any],
    provider_id: str,
    ctx: PreCallContext,
    call: Callable[[dict[str, Any]], T],
) -> EngineResult[T]:
    """Sync sibling of :func:`run_with_engine` — same orchestration without
    `await`. Used by `Completions.create` (sync) / `Messages.create` (sync)."""
    setup = _setup_engine(ctx, provider_id)
    failover_cfg = setup.failover_cfg
    warnings = setup.warnings
    decision = setup.evaluation.decision

    original_model = request.get("model")
    routing_applied = False
    routed_model: str | None = None

    try:
        if decision.action == "route_model" and decision.model and decision.fallback:
            is_same_provider = decision.provider == provider_id
            if not is_same_provider:
                warnings.append(
                    RuleWarning(
                        code="routing_cross_provider_skipped",
                        message=(
                            f"Cross-provider routing ({provider_id} → "
                            f"{decision.provider}) requires the "
                            f"{decision.provider} wrapper. Routing skipped; "
                            f"original model used."
                        ),
                    )
                )
                result = call(request)
            else:

                def routed_call(model: str) -> T:
                    return call({**request, "model": model})

                attempt = attempt_with_fallback_sync(
                    call=routed_call,
                    routed_model=decision.model,
                    original_model=decision.original_model or (original_model or ""),
                    is_same_provider=True,
                    fallback=decision.fallback,
                )
                result = attempt.result
                routing_applied = not attempt.fell_back
                routed_model = attempt.model_used
                if attempt.fell_back and attempt.fallback_reason:
                    warnings.append(
                        RuleWarning(
                            code=attempt.fallback_reason,
                            message=(
                                f"Routed model failed; fell back to original "
                                f"{decision.original_model}."
                            ),
                        )
                    )
        else:
            result = call(request)
    except BaseException:
        if failover_cfg:
            record_outcome(failover_cfg, ok=False)
        raise

    if failover_cfg:
        record_outcome(failover_cfg, ok=True)

    metadata = _build_metadata(
        original_model=original_model,
        routing_applied=routing_applied,
        routed_model=routed_model,
        failover_active=setup.failover_active,
        warnings=warnings,
    )
    return EngineResult(result=result, metadata=metadata)
