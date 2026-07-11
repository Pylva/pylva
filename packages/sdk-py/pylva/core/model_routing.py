"""Wrapper-level helper that classifies provider errors and decides whether
to retry with the original model.

  - Cross-provider routing (rule.route_to.provider != request.provider) and
    the response is 401/403/404: retry with original model.
  - Same-provider routing and the response is 401: DO NOT retry — the same
    key would fail again (D25).
  - 429/500 are provider failures, not routing failures: do not retry.

Generic over the wrapper-specific call shape — wrappers pass a
``call(model)`` callable and the helper either returns the result or invokes
the fallback path.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

T = TypeVar("T")

FallbackKind = Literal["auth_401", "access_403", "not_found_404", "other"]

# All warning codes the engine + wrappers can surface to the host app.
# Co-located here (not in rules_engine.py) so model_routing stays upstream
# of rules_engine in the import graph; rules_engine imports this Literal
# back to type its own RuleWarning.code.
RuleWarningCode = Literal[
    "routing_cross_provider_skipped",
    "routing_fallback_auth_401",
    "routing_fallback_access_403",
    "routing_fallback_not_found_404",
    "failover_missing_backup",
    # PR #84 review (bug_028) — emitted while the failover state machine
    # says "primary failing, route to backup" but cross-provider dispatch
    # is not yet implemented. Mirrors the TS RuleWarningCode constant.
    "failover_dispatch_not_implemented",
]


def _classify_status(status: int | None) -> FallbackKind:
    if status == 401:
        return "auth_401"
    if status == 403:
        return "access_403"
    if status == 404:
        return "not_found_404"
    return "other"


_FALLBACK_REASON_BY_KIND: dict[FallbackKind, RuleWarningCode] = {
    "auth_401": "routing_fallback_auth_401",
    "access_403": "routing_fallback_access_403",
    "not_found_404": "routing_fallback_not_found_404",
}


@dataclass(frozen=True)
class ModelRoutingFallback:
    on_cross_provider_auth_error: bool
    on_access_denied: bool
    on_model_not_found: bool
    use_original_model: bool
    skip_same_provider_401: bool


def should_fallback(
    err_status: int | None,
    fallback: ModelRoutingFallback,
    is_same_provider: bool,
) -> bool:
    """Pure classifier: given a provider error status + fallback config, return
    True iff the wrapper should retry with the original model."""
    kind = _classify_status(err_status)

    if kind == "auth_401":
        if is_same_provider:
            return False if fallback.skip_same_provider_401 else fallback.use_original_model
        return fallback.on_cross_provider_auth_error and fallback.use_original_model
    if kind == "access_403":
        return fallback.on_access_denied and fallback.use_original_model
    if kind == "not_found_404":
        return fallback.on_model_not_found and fallback.use_original_model
    return False


@dataclass(frozen=True)
class ModelRoutingAttemptResult(Generic[T]):
    result: T
    model_used: str
    fell_back: bool
    fallback_reason: RuleWarningCode | None = None


def _extract_status(err: BaseException) -> int | None:
    """Provider SDKs surface HTTP errors with various attribute names. We
    check the common ones (status, status_code, response.status_code) so the
    classifier sees a consistent integer."""
    raw = getattr(err, "status", None)
    if isinstance(raw, int):
        return raw
    raw = getattr(err, "status_code", None)
    if isinstance(raw, int):
        return raw
    response = getattr(err, "response", None)
    if response is not None:
        raw = getattr(response, "status_code", None)
        if isinstance(raw, int):
            return raw
        raw = getattr(response, "status", None)
        if isinstance(raw, int):
            return raw
    return None


async def attempt_with_fallback(
    *,
    call: Callable[[str], Awaitable[T]],
    routed_model: str,
    original_model: str,
    is_same_provider: bool,
    fallback: ModelRoutingFallback,
) -> ModelRoutingAttemptResult[T]:
    """Try the routed model first; if the provider error is fallback-eligible
    auth/access/not-found and the rule's fallback flags allow it, retry with
    the original model. Other errors propagate unchanged."""
    try:
        result = await call(routed_model)
        return ModelRoutingAttemptResult(result=result, model_used=routed_model, fell_back=False)
    except BaseException as err:  # noqa: BLE001 — we re-raise unmatched errors
        status = _extract_status(err)
        if not should_fallback(status, fallback, is_same_provider):
            raise

        result = await call(original_model)
        kind = _classify_status(status)
        reason = _FALLBACK_REASON_BY_KIND[kind] if kind != "other" else None
        return ModelRoutingAttemptResult(
            result=result,
            model_used=original_model,
            fell_back=True,
            fallback_reason=reason,
        )


def attempt_with_fallback_sync(
    *,
    call: Callable[[str], T],
    routed_model: str,
    original_model: str,
    is_same_provider: bool,
    fallback: ModelRoutingFallback,
) -> ModelRoutingAttemptResult[T]:
    """Sync sibling of :func:`attempt_with_fallback` for the OpenAI/Anthropic
    Python SDK's synchronous create() paths. Same classification + fallback
    semantics; just no `await`."""
    try:
        result = call(routed_model)
        return ModelRoutingAttemptResult(result=result, model_used=routed_model, fell_back=False)
    except BaseException as err:  # noqa: BLE001
        status = _extract_status(err)
        if not should_fallback(status, fallback, is_same_provider):
            raise

        result = call(original_model)
        kind = _classify_status(status)
        reason = _FALLBACK_REASON_BY_KIND[kind] if kind != "other" else None
        return ModelRoutingAttemptResult(
            result=result,
            model_used=original_model,
            fell_back=True,
            fallback_reason=reason,
        )
