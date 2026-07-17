"""Authoritative budget-control client with async and true-sync transports.

This module intentionally performs no automatic retries. Operation and
extension identifiers are caller-owned idempotency keys; retrying the exact
same validated request is therefore an explicit caller decision rather than
an SDK transport side effect.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, TypeVar, cast

import httpx
from pydantic import BaseModel, TypeAdapter, ValidationError

from .._version import SDK_VERSION
from ..errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded
from ..errors.control import (
    PylvaControlApiError,
    PylvaControlUnavailableError,
    PylvaControlUnavailableReason,
    PylvaControlValidationError,
)
from .config import ResolvedConfig, _require_config_snapshot, get_config_generation
from .control_ownership import _register_controlled_reservation
from .control_schema import (
    BUDGET_COMMIT_REQUEST_ADAPTER,
    BUDGET_CONTROL_SCHEMA_ADAPTERS,
    BUDGET_RESERVATION_REQUEST_ADAPTER,
    BudgetCapabilitiesResponse,
    BudgetCommitRequest,
    BudgetCommitResponse,
    BudgetControlErrorResponse,
    BudgetExtendRequest,
    BudgetExtendResponse,
    BudgetReleaseRequest,
    BudgetReleaseResponse,
    BudgetReservationRequest,
    BudgetReservationResponse,
    BypassedBudgetDecision,
    DeniedBudgetDecision,
    ReservedBudgetDecision,
    UnavailableBudgetDecision,
    UuidString,
)

_T = TypeVar("_T")
_ControlOperation = Literal[
    "ready",
    "reserve_usage",
    "commit_usage",
    "release_usage",
    "extend_usage",
]

_CAPABILITIES_PATH = "/api/v1/budget/capabilities"
_RESERVATIONS_PATH = "/api/v1/budget/reservations"
_MAX_RESPONSE_BYTES = 64 * 1024
_READY_CACHE_TTL_SECONDS = 30.0

_CAPABILITIES_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetCapabilitiesResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["capabilities_response"],
)
_RESERVATION_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetReservationResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["reservation_response"],
)
_COMMIT_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetCommitResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["commit_response"],
)
_RELEASE_REQUEST_ADAPTER = cast(
    TypeAdapter[BudgetReleaseRequest],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["release_request"],
)
_RELEASE_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetReleaseResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["release_response"],
)
_EXTEND_REQUEST_ADAPTER = cast(
    TypeAdapter[BudgetExtendRequest],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["extend_request"],
)
_EXTEND_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetExtendResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["extend_response"],
)
_ERROR_RESPONSE_ADAPTER = cast(
    TypeAdapter[BudgetControlErrorResponse],
    BUDGET_CONTROL_SCHEMA_ADAPTERS["error_response"],
)
_UUID_ADAPTER: TypeAdapter[str] = TypeAdapter(UuidString)


@dataclass(frozen=True)
class _ReadinessOutcome:
    ready: bool
    reason: PylvaControlUnavailableReason | None = None
    retryable: bool = False


class _UnavailableSignal(Exception):
    def __init__(
        self,
        reason: PylvaControlUnavailableReason,
        *,
        retryable: bool,
        status: int | None = None,
    ) -> None:
        self.reason = reason
        self.retryable = retryable
        self.status = status
        super().__init__(reason.value)


_ready_lock = threading.Lock()
_ready_cache: dict[int, tuple[float, _ReadinessOutcome]] = {}
_async_ready_inflight: dict[
    tuple[int, int], tuple[asyncio.AbstractEventLoop, asyncio.Task[_ReadinessOutcome]]
] = {}
_sync_ready_inflight: dict[int, Future[_ReadinessOutcome]] = {}
_ready_generation = get_config_generation()


def _make_async_client(timeout_seconds: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False)


def _make_sync_client(timeout_seconds: float) -> httpx.Client:
    return httpx.Client(timeout=timeout_seconds, follow_redirects=False)


def _headers(cfg: ResolvedConfig) -> dict[str, str]:
    return {
        "accept": "application/json",
        "content-type": "application/json",
        "X-Pylva-Key": cfg.api_key,
        "X-Pylva-SDK-Version": SDK_VERSION,
        "X-Pylva-SDK-Language": "python",
    }


def _url(cfg: ResolvedConfig, path: str) -> str:
    return f"{cfg.endpoint.rstrip('/')}{path}"


def _request_body(value: BaseModel) -> bytes:
    return json.dumps(
        value.model_dump(mode="json"),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant {value!r}")


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _strict_json(response: httpx.Response) -> Any:
    content = response.content
    if len(content) > _MAX_RESPONSE_BYTES:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
            status=response.status_code,
        )
    try:
        text = content.decode("utf-8", errors="strict")
        return json.loads(
            text,
            parse_constant=_reject_json_constant,
            object_pairs_hook=_object_without_duplicate_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
            status=response.status_code,
        ) from error


def _validate_response(
    adapter: TypeAdapter[_T],
    value: Any,
    status: int,
) -> _T:
    try:
        return adapter.validate_python(value, strict=True)
    except (ValidationError, TypeError, ValueError) as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
            status=status,
        ) from error


def _classify_response(
    response: httpx.Response,
    adapter: TypeAdapter[_T],
    *,
    capabilities: bool,
) -> _T:
    # A pre-control backend can legitimately return its generic 404/405 body.
    # This is the sole response that is intentionally not held to the new
    # control error schema.
    if capabilities and response.status_code in {404, 405}:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.UNSUPPORTED_BACKEND,
            retryable=False,
            status=response.status_code,
        )

    parsed = _strict_json(response)
    if 200 <= response.status_code < 300:
        return _validate_response(adapter, parsed, response.status_code)

    error_response = _validate_response(
        _ERROR_RESPONSE_ADAPTER,
        parsed,
        response.status_code,
    )
    if not _error_status_matches(response.status_code, error_response.error.code):
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
            status=response.status_code,
        )
    if response.status_code == 429:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.RATE_LIMITED,
            retryable=True,
            status=response.status_code,
        )
    if response.status_code >= 500:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.SERVICE_UNAVAILABLE,
            retryable=True,
            status=response.status_code,
        )
    if 400 <= response.status_code < 500:
        raise PylvaControlApiError(
            response.status_code,
            error_response.error.code,
            # ``param`` is backend-controlled free text. Keep the public error
            # typed and useful without crossing the SDK's sanitized boundary.
            None,
        )
    raise _UnavailableSignal(
        PylvaControlUnavailableReason.INVALID_RESPONSE,
        retryable=False,
        status=response.status_code,
    )


def _error_status_matches(status: int, code: str) -> bool:
    expected: set[str]
    if status == 400:
        expected = {"VALIDATION_ERROR"}
    elif status == 401:
        expected = {"INVALID_API_KEY"}
    elif status == 403:
        expected = {"WRONG_SCOPE"}
    elif status == 404:
        expected = {"RESOURCE_NOT_FOUND"}
    elif status == 409:
        expected = {"IDEMPOTENCY_CONFLICT", "RESERVATION_STATE_CONFLICT"}
    elif status == 429:
        expected = {"RATE_LIMIT_EXCEEDED"}
    elif status >= 500:
        expected = {"INTERNAL_ERROR"}
    else:
        return False
    return code in expected


def _ensure_generation(generation: int) -> None:
    if get_config_generation() != generation:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
            retryable=True,
        )


async def _request_async(
    method: str,
    path: str,
    body: BaseModel | None,
    adapter: TypeAdapter[_T],
    cfg: ResolvedConfig,
    generation: int,
    *,
    capabilities: bool = False,
) -> _T:
    _ensure_generation(generation)
    try:
        async with _make_async_client(cfg.control.timeout_ms / 1_000) as client:
            response = await client.request(
                method,
                _url(cfg, path),
                headers=_headers(cfg),
                content=None if body is None else _request_body(body),
            )
    except httpx.TimeoutException as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.TIMEOUT,
            retryable=True,
        ) from error
    except httpx.InvalidURL as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.NETWORK_ERROR,
            retryable=False,
        ) from error
    except httpx.RequestError as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.NETWORK_ERROR,
            retryable=True,
        ) from error
    _ensure_generation(generation)
    return _classify_response(response, adapter, capabilities=capabilities)


def _request_sync(
    method: str,
    path: str,
    body: BaseModel | None,
    adapter: TypeAdapter[_T],
    cfg: ResolvedConfig,
    generation: int,
    *,
    capabilities: bool = False,
) -> _T:
    _ensure_generation(generation)
    try:
        with _make_sync_client(cfg.control.timeout_ms / 1_000) as client:
            response = client.request(
                method,
                _url(cfg, path),
                headers=_headers(cfg),
                content=None if body is None else _request_body(body),
            )
    except httpx.TimeoutException as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.TIMEOUT,
            retryable=True,
        ) from error
    except httpx.InvalidURL as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.NETWORK_ERROR,
            retryable=False,
        ) from error
    except httpx.RequestError as error:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.NETWORK_ERROR,
            retryable=True,
        ) from error
    _ensure_generation(generation)
    return _classify_response(response, adapter, capabilities=capabilities)


def _cached_readiness(generation: int) -> _ReadinessOutcome | None:
    now = time.monotonic()
    with _ready_lock:
        if generation != _ready_generation:
            return None
        entry = _ready_cache.get(generation)
        if entry is None:
            return None
        expires_at, outcome = entry
        if expires_at <= now:
            _ready_cache.pop(generation, None)
            return None
        return outcome


def _cache_readiness(generation: int, outcome: _ReadinessOutcome) -> None:
    with _ready_lock:
        if generation != _ready_generation:
            raise _UnavailableSignal(
                PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
                retryable=True,
            )
        _ready_cache[generation] = (
            time.monotonic() + _READY_CACHE_TTL_SECONDS,
            outcome,
        )


async def _fetch_readiness_async(
    cfg: ResolvedConfig,
    generation: int,
) -> _ReadinessOutcome:
    try:
        capabilities = await _request_async(
            "GET",
            _CAPABILITIES_PATH,
            None,
            _CAPABILITIES_RESPONSE_ADAPTER,
            cfg,
            generation,
            capabilities=True,
        )
    except asyncio.CancelledError:
        if get_config_generation() != generation:
            raise _UnavailableSignal(
                PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
                retryable=True,
            ) from None
        raise
    except _UnavailableSignal as error:
        if error.reason is PylvaControlUnavailableReason.UNSUPPORTED_BACKEND:
            outcome = _ReadinessOutcome(
                ready=False,
                reason=error.reason,
                retryable=False,
            )
            _cache_readiness(generation, outcome)
            return outcome
        raise
    outcome = (
        _ReadinessOutcome(ready=True)
        if capabilities.control_enabled
        else _ReadinessOutcome(
            ready=False,
            reason=PylvaControlUnavailableReason.CONTROL_DISABLED,
            retryable=False,
        )
    )
    _cache_readiness(generation, outcome)
    return outcome


def _fetch_readiness_sync(cfg: ResolvedConfig, generation: int) -> _ReadinessOutcome:
    try:
        capabilities = _request_sync(
            "GET",
            _CAPABILITIES_PATH,
            None,
            _CAPABILITIES_RESPONSE_ADAPTER,
            cfg,
            generation,
            capabilities=True,
        )
    except _UnavailableSignal as error:
        if error.reason is PylvaControlUnavailableReason.UNSUPPORTED_BACKEND:
            outcome = _ReadinessOutcome(
                ready=False,
                reason=error.reason,
                retryable=False,
            )
            _cache_readiness(generation, outcome)
            return outcome
        raise
    outcome = (
        _ReadinessOutcome(ready=True)
        if capabilities.control_enabled
        else _ReadinessOutcome(
            ready=False,
            reason=PylvaControlUnavailableReason.CONTROL_DISABLED,
            retryable=False,
        )
    )
    _cache_readiness(generation, outcome)
    return outcome


async def _readiness_async(cfg: ResolvedConfig, generation: int) -> _ReadinessOutcome:
    cached = _cached_readiness(generation)
    if cached is not None:
        return cached
    loop = asyncio.get_running_loop()
    key = (generation, id(loop))
    with _ready_lock:
        existing = _async_ready_inflight.get(key)
        if existing is None or existing[1].done():
            task = loop.create_task(_fetch_readiness_async(cfg, generation))
            _async_ready_inflight[key] = (loop, task)
        else:
            task = existing[1]
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            with _ready_lock:
                current = _async_ready_inflight.get(key)
                if current is not None and current[1] is task:
                    _async_ready_inflight.pop(key, None)


def _readiness_sync(cfg: ResolvedConfig, generation: int) -> _ReadinessOutcome:
    cached = _cached_readiness(generation)
    if cached is not None:
        return cached
    with _ready_lock:
        future = _sync_ready_inflight.get(generation)
        leader = future is None
        if future is None:
            future = Future()
            _sync_ready_inflight[generation] = future
    if not leader:
        return future.result()
    try:
        outcome = _fetch_readiness_sync(cfg, generation)
    except BaseException as error:
        future.set_exception(error)
        raise
    else:
        future.set_result(outcome)
        return outcome
    finally:
        with _ready_lock:
            if _sync_ready_inflight.get(generation) is future:
                _sync_ready_inflight.pop(generation, None)


def _unavailable_error(
    signal: _UnavailableSignal,
    operation: _ControlOperation,
    *,
    operation_id: str | None = None,
    reservation_id: str | None = None,
    unavailable_response: UnavailableBudgetDecision | None = None,
) -> PylvaControlUnavailableError:
    return PylvaControlUnavailableError(
        signal.reason,
        signal.retryable,
        operation,
        operation_id=operation_id,
        reservation_id=reservation_id,
        unavailable_response=unavailable_response,
        status=signal.status,
    )


def _mapping_value(value: BaseModel | Mapping[str, Any], operation: str) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="python")
    if isinstance(value, Mapping):
        return dict(value)
    raise PylvaControlValidationError(operation)


def _validate_reservation_request(
    value: BudgetReservationRequest | Mapping[str, Any],
    cfg: ResolvedConfig,
) -> BudgetReservationRequest:
    operation = "reserve_usage"
    raw = _mapping_value(cast(BaseModel | Mapping[str, Any], value), operation)
    raw.setdefault("schema_version", "1.0")
    if cfg.control.mode == "legacy":
        # The wire deliberately has no legacy mode because no legacy request
        # is transmitted. Shadow is used only to validate the remaining strict
        # shape before creating the local control-disabled bypass.
        raw["mode"] = "shadow"
    else:
        supplied_mode = raw.get("mode")
        if supplied_mode is not None and supplied_mode != cfg.control.mode:
            raise PylvaControlValidationError(operation)
        raw["mode"] = cfg.control.mode
    try:
        return BUDGET_RESERVATION_REQUEST_ADAPTER.validate_python(raw, strict=True)
    except (ValidationError, TypeError, ValueError) as error:
        raise PylvaControlValidationError(operation) from error


def _validate_lifecycle_request(
    value: BaseModel | Mapping[str, Any],
    adapter: TypeAdapter[_T],
    operation: str,
) -> _T:
    raw = _mapping_value(value, operation)
    raw.setdefault("schema_version", "1.0")
    try:
        return adapter.validate_python(raw, strict=True)
    except (ValidationError, TypeError, ValueError) as error:
        raise PylvaControlValidationError(operation) from error


def _validate_reservation_id(value: str, operation: str) -> str:
    try:
        return _UUID_ADAPTER.validate_python(value, strict=True)
    except (ValidationError, TypeError, ValueError) as error:
        raise PylvaControlValidationError(operation) from error


def _local_legacy_bypass(operation_id: str) -> BypassedBudgetDecision:
    return BypassedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "bypassed",
            "allowed": True,
            "decision_id": None,
            "operation_id": operation_id,
            "reason": "control_disabled",
            "would_have_denied": None,
            "warnings": [],
        },
        strict=True,
    )


def _local_unavailable(operation_id: str, retryable: bool) -> UnavailableBudgetDecision:
    return UnavailableBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "unavailable",
            "allowed": False,
            "decision_id": None,
            "operation_id": operation_id,
            "reason": "control_unavailable",
            "retryable": retryable,
        },
        strict=True,
    )


def _canonical_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _raise_denial(
    response: DeniedBudgetDecision,
    request: BudgetReservationRequest,
) -> None:
    accumulated = (
        Decimal(response.committed_usd)
        + Decimal(response.reserved_usd)
        + Decimal(response.unresolved_usd)
    )
    accumulated_exact = _canonical_decimal(accumulated)
    raise PylvaBudgetExceeded(
        source=BudgetExceededSource.AUTHORITATIVE_CONTROL,
        rule_id=response.deciding_rule.rule_id,
        customer_id=request.customer_id,
        period=response.deciding_rule.period,
        period_start=response.deciding_rule.period_start,
        limit_usd=float(response.limit_usd),
        accumulated_usd=float(accumulated_exact),
        estimated_usd=float(response.requested_usd),
        authoritative_denial=response,
        limit_usd_exact=response.limit_usd,
        accumulated_usd_exact=accumulated_exact,
        estimated_usd_exact=response.requested_usd,
    )


def _check_reservation_correlation(
    response: BudgetReservationResponse,
    operation_id: str,
) -> None:
    if response.operation_id != operation_id:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
        )


def _check_lifecycle_correlation(
    response: BudgetCommitResponse | BudgetReleaseResponse | BudgetExtendResponse,
    reservation_id: str,
    extension_id: str | None = None,
) -> None:
    if response.reservation_id != reservation_id:
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
        )
    if extension_id is not None and (
        not isinstance(response, BudgetExtendResponse) or response.extension_id != extension_id
    ):
        raise _UnavailableSignal(
            PylvaControlUnavailableReason.INVALID_RESPONSE,
            retryable=False,
        )


def _reservation_response_matches_mode(
    mode: Literal["shadow", "enforce"],
    response: BudgetReservationResponse,
) -> bool:
    """Reject a valid wire decision that cannot belong to the request mode."""

    if mode == "shadow":
        return isinstance(response, BypassedBudgetDecision)
    if not isinstance(response, BypassedBudgetDecision):
        return True
    return response.reason in {"no_applicable_budget", "control_disabled"}


def _apply_reservation_unavailable_policy(
    cfg: ResolvedConfig,
    signal: _UnavailableSignal,
    operation_id: str,
    *,
    evidence: UnavailableBudgetDecision | None = None,
) -> UnavailableBudgetDecision:
    unavailable = evidence or _local_unavailable(operation_id, signal.retryable)
    if cfg.control.on_unavailable == "allow":
        return unavailable
    raise _unavailable_error(
        signal,
        "reserve_usage",
        operation_id=operation_id,
        unavailable_response=unavailable,
    )


def _finalize_reservation_response(
    response: BudgetReservationResponse,
    request: BudgetReservationRequest,
    cfg: ResolvedConfig,
    generation: int,
) -> BudgetReservationResponse:
    operation_id = request.operation_id
    mode = cast(Literal["shadow", "enforce"], cfg.control.mode)
    if not _reservation_response_matches_mode(mode, response):
        return _apply_reservation_unavailable_policy(
            cfg,
            _UnavailableSignal(
                PylvaControlUnavailableReason.INVALID_RESPONSE,
                retryable=False,
            ),
            operation_id,
        )

    if isinstance(response, BypassedBudgetDecision) and response.reason in {
        "control_disabled",
        "shadow_control_unavailable",
    }:
        reason = (
            PylvaControlUnavailableReason.CONTROL_DISABLED
            if response.reason == "control_disabled"
            else PylvaControlUnavailableReason.CONTROL_UNAVAILABLE
        )
        return _apply_reservation_unavailable_policy(
            cfg,
            _UnavailableSignal(
                reason,
                retryable=response.reason == "shadow_control_unavailable",
            ),
            operation_id,
        )

    if isinstance(response, UnavailableBudgetDecision):
        return _apply_reservation_unavailable_policy(
            cfg,
            _UnavailableSignal(
                PylvaControlUnavailableReason(response.reason),
                retryable=response.retryable,
            ),
            operation_id,
            evidence=response,
        )
    if isinstance(response, DeniedBudgetDecision):
        _raise_denial(response, request)
    if isinstance(response, ReservedBudgetDecision) and not _register_controlled_reservation(
        response,
        cfg,
        generation,
        request.trace_id,
        request.span_id,
    ):
        return _apply_reservation_unavailable_policy(
            cfg,
            _UnavailableSignal(
                PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
                retryable=True,
            ),
            operation_id,
        )
    return response


async def ready() -> bool:
    """Return whether this backend supports and enables authoritative control."""

    cfg, generation = _require_config_snapshot()
    try:
        return (await _readiness_async(cfg, generation)).ready
    except _UnavailableSignal as signal:
        if cfg.control.on_unavailable == "allow":
            return False
        raise _unavailable_error(signal, "ready") from signal


def ready_sync() -> bool:
    """Synchronous readiness check using :class:`httpx.Client`."""

    cfg, generation = _require_config_snapshot()
    try:
        return _readiness_sync(cfg, generation).ready
    except _UnavailableSignal as signal:
        if cfg.control.on_unavailable == "allow":
            return False
        raise _unavailable_error(signal, "ready") from signal


async def reserve_usage(
    request: BudgetReservationRequest | Mapping[str, Any],
) -> BudgetReservationResponse:
    """Validate and reserve bounded usage immediately before provider dispatch."""

    cfg, generation = _require_config_snapshot()
    validated = _validate_reservation_request(request, cfg)
    operation_id = validated.operation_id
    if cfg.control.mode == "legacy":
        return _local_legacy_bypass(operation_id)

    try:
        readiness = await _readiness_async(cfg, generation)
        if not readiness.ready:
            readiness_signal = _UnavailableSignal(
                readiness.reason or PylvaControlUnavailableReason.CONTROL_UNAVAILABLE,
                retryable=readiness.retryable,
            )
            if cfg.control.on_unavailable == "allow":
                return _local_unavailable(operation_id, readiness_signal.retryable)
            raise _unavailable_error(
                readiness_signal,
                "reserve_usage",
                operation_id=operation_id,
            )
        response = await _request_async(
            "POST",
            _RESERVATIONS_PATH,
            cast(BaseModel, validated),
            _RESERVATION_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_reservation_correlation(response, operation_id)
    except _UnavailableSignal as signal:
        if cfg.control.on_unavailable == "allow":
            return _local_unavailable(operation_id, signal.retryable)
        raise _unavailable_error(
            signal,
            "reserve_usage",
            operation_id=operation_id,
        ) from signal

    return _finalize_reservation_response(response, validated, cfg, generation)


def reserve_usage_sync(
    request: BudgetReservationRequest | Mapping[str, Any],
) -> BudgetReservationResponse:
    """Synchronous reservation using a real synchronous HTTP client."""

    cfg, generation = _require_config_snapshot()
    validated = _validate_reservation_request(request, cfg)
    operation_id = validated.operation_id
    if cfg.control.mode == "legacy":
        return _local_legacy_bypass(operation_id)

    try:
        readiness = _readiness_sync(cfg, generation)
        if not readiness.ready:
            readiness_signal = _UnavailableSignal(
                readiness.reason or PylvaControlUnavailableReason.CONTROL_UNAVAILABLE,
                retryable=readiness.retryable,
            )
            if cfg.control.on_unavailable == "allow":
                return _local_unavailable(operation_id, readiness_signal.retryable)
            raise _unavailable_error(
                readiness_signal,
                "reserve_usage",
                operation_id=operation_id,
            )
        response = _request_sync(
            "POST",
            _RESERVATIONS_PATH,
            cast(BaseModel, validated),
            _RESERVATION_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_reservation_correlation(response, operation_id)
    except _UnavailableSignal as signal:
        if cfg.control.on_unavailable == "allow":
            return _local_unavailable(operation_id, signal.retryable)
        raise _unavailable_error(
            signal,
            "reserve_usage",
            operation_id=operation_id,
        ) from signal

    return _finalize_reservation_response(response, validated, cfg, generation)


async def commit_usage(
    reservation_id: str,
    request: BudgetCommitRequest | Mapping[str, Any],
) -> BudgetCommitResponse:
    operation: _ControlOperation = "commit_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        BUDGET_COMMIT_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = await _request_async(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/commit",
            cast(BaseModel, validated),
            _COMMIT_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


def commit_usage_sync(
    reservation_id: str,
    request: BudgetCommitRequest | Mapping[str, Any],
) -> BudgetCommitResponse:
    operation: _ControlOperation = "commit_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        BUDGET_COMMIT_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = _request_sync(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/commit",
            cast(BaseModel, validated),
            _COMMIT_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


async def release_usage(
    reservation_id: str,
    request: BudgetReleaseRequest | Mapping[str, Any],
) -> BudgetReleaseResponse:
    operation: _ControlOperation = "release_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        _RELEASE_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = await _request_async(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/release",
            cast(BaseModel, validated),
            _RELEASE_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


def release_usage_sync(
    reservation_id: str,
    request: BudgetReleaseRequest | Mapping[str, Any],
) -> BudgetReleaseResponse:
    operation: _ControlOperation = "release_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        _RELEASE_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = _request_sync(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/release",
            cast(BaseModel, validated),
            _RELEASE_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


async def extend_usage(
    reservation_id: str,
    request: BudgetExtendRequest | Mapping[str, Any],
) -> BudgetExtendResponse:
    operation: _ControlOperation = "extend_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        _EXTEND_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = await _request_async(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/extend",
            cast(BaseModel, validated),
            _EXTEND_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id, validated.extension_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


def extend_usage_sync(
    reservation_id: str,
    request: BudgetExtendRequest | Mapping[str, Any],
) -> BudgetExtendResponse:
    operation: _ControlOperation = "extend_usage"
    cfg, generation = _require_config_snapshot()
    validated_id = _validate_reservation_id(reservation_id, operation)
    validated = _validate_lifecycle_request(
        cast(BaseModel | Mapping[str, Any], request),
        _EXTEND_REQUEST_ADAPTER,
        operation,
    )
    try:
        response = _request_sync(
            "POST",
            f"{_RESERVATIONS_PATH}/{validated_id}/extend",
            cast(BaseModel, validated),
            _EXTEND_RESPONSE_ADAPTER,
            cfg,
            generation,
        )
        _check_lifecycle_correlation(response, validated_id, validated.extension_id)
        return response
    except _UnavailableSignal as signal:
        raise _unavailable_error(
            signal,
            operation,
            reservation_id=validated_id,
        ) from signal


def _invalidate_control_client_for_config_change(
    next_config_generation: int | None = None,
) -> None:
    """Clear readiness state and cancel async checks crossing builder identity."""

    global _ready_generation
    with _ready_lock:
        _ready_generation = (
            get_config_generation() + 1
            if next_config_generation is None
            else next_config_generation
        )
        _ready_cache.clear()
        inflight = list(_async_ready_inflight.values())
        _async_ready_inflight.clear()
        # Sync leaders cannot safely be cancelled; their generation check
        # prevents stale results from being cached or returned successfully.
        _sync_ready_inflight.clear()
    for loop, task in inflight:
        if task.done() or loop.is_closed():
            continue
        if loop.is_running():
            loop.call_soon_threadsafe(task.cancel)
        else:
            task.cancel()


def _reset_control_client_for_tests() -> None:
    _invalidate_control_client_for_config_change()
