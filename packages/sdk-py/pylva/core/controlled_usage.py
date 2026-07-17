"""Authoritative control for one bounded, non-LLM provider attempt.

The helper owns the complete lifecycle for a single tool invocation.  Only
content-free pricing identity and exact decimal quantities cross the control
transport; arguments, queries, URLs, provider responses, and exception text
stay inside the caller's process.
"""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Generic, Literal, TypeAlias, TypeVar, cast

from ..errors.control import (
    PylvaControlApiError,
    PylvaControlUnavailableError,
    PylvaControlUnavailableReason,
    PylvaControlValidationError,
)
from .config import _require_config_snapshot, get_config_generation
from .context import current_context
from .control_client import (
    commit_usage,
    commit_usage_sync,
    extend_usage,
    extend_usage_sync,
    release_usage,
    release_usage_sync,
    reserve_usage,
    reserve_usage_sync,
)
from .control_ownership import (
    ControlledAttemptContext,
    _controlled_attempt_scope,
    _controlled_local_no_dispatch,
    _controlled_no_dispatch,
    controlled_operation_ownership,
    should_suppress_legacy_telemetry,
)
from .control_schema import (
    BudgetCommitResponse,
    BudgetReservationResponse,
    BypassedBudgetDecision,
    ReservedBudgetDecision,
    UnavailableBudgetDecision,
)

T = TypeVar("T")
ExactDecimalInput: TypeAlias = str | int | Decimal
ActualUsageExtractor: TypeAlias = Callable[[T], ExactDecimalInput]
AsyncActualUsageExtractor: TypeAlias = Callable[
    [T], ExactDecimalInput | Awaitable[ExactDecimalInput]
]

ControlledUsageDecision: TypeAlias = Literal["reserved", "bypassed", "unavailable"]
ControlledUsageSettlement: TypeAlias = Literal["committed", "bypassed", "unavailable", "unresolved"]
ControlledUsageIssue: TypeAlias = Literal[
    "usage_extraction_failed",
    "commit_failed",
    "configuration_changed",
    "extension_failed",
    "legacy_report_failed",
]

_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$")
_UINT32_MAX = 4_294_967_295


@dataclass(frozen=True)
class ControlledUsageOutcome:
    """Content-free lifecycle evidence returned beside the provider result."""

    operation_id: str
    reservation_id: str | None
    decision: ControlledUsageDecision
    decision_reason: str | None
    settlement: ControlledUsageSettlement
    maximum_value: str
    actual_value: str | None
    bound_violated: bool | None
    authoritative_ownership: bool
    legacy_telemetry_emitted: bool
    issue: ControlledUsageIssue | None
    commit: BudgetCommitResponse | None = None


@dataclass(frozen=True)
class ControlledUsageResult(Generic[T]):
    """The untouched provider value plus sanitized control evidence."""

    value: T
    control: ControlledUsageOutcome


def _canonical_decimal(value: object, operation: str) -> str:
    if isinstance(value, bool):
        raise PylvaControlValidationError(operation)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise PylvaControlValidationError(operation)
        if value.is_zero():
            return "0"
        if value.is_signed():
            raise PylvaControlValidationError(operation)
        raw = value.as_tuple()
        exponent = raw.exponent
        if not isinstance(exponent, int):
            raise PylvaControlValidationError(operation)
        digits = list(raw.digits)
        while digits and digits[-1] == 0:
            digits.pop()
            exponent += 1
        if not digits:
            return "0"
        if exponent >= 0:
            if len(digits) + exponent > 20:
                raise PylvaControlValidationError(operation)
            return "".join(str(digit) for digit in digits) + "0" * exponent
        if -exponent > 18 or len(digits) + exponent > 20:
            raise PylvaControlValidationError(operation)
        split = len(digits) + exponent
        digit_text = "".join(str(digit) for digit in digits)
        if split > 0:
            return f"{digit_text[:split]}.{digit_text[split:]}"
        return f"0.{('0' * -split)}{digit_text}"
    elif isinstance(value, int):
        if value < 0 or value > 99_999_999_999_999_999_999:
            raise PylvaControlValidationError(operation)
        text: object = str(value)
    else:
        text = value
    if not isinstance(text, str) or len(text) > 39 or _DECIMAL_RE.fullmatch(text) is None:
        raise PylvaControlValidationError(operation)
    if "." not in text:
        return text
    canonical = text.rstrip("0").rstrip(".")
    return canonical or "0"


def _validate_callable(value: object, operation: str) -> None:
    if not callable(value):
        raise PylvaControlValidationError(operation)


@dataclass(frozen=True)
class _Attempt:
    operation_id: str
    customer_id: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    step_name: str | None
    framework: str
    generation: int


def _attempt(customer_id: str | None, step: str | None) -> _Attempt:
    ctx = current_context()
    resolved_customer = customer_id or (ctx.customer_id if ctx else None)
    if resolved_customer is None:
        raise PylvaControlValidationError("controlled_usage")
    _, generation = _require_config_snapshot()
    return _Attempt(
        operation_id=str(uuid.uuid4()),
        customer_id=resolved_customer,
        trace_id=ctx.trace_id if ctx else str(uuid.uuid4()),
        span_id=str(uuid.uuid4()),
        parent_span_id=ctx.span_id if ctx else None,
        step_name=step or (ctx.step_name if ctx else None),
        framework=ctx.framework if ctx else "none",
        generation=generation,
    )


def _reservation_request(
    attempt: _Attempt,
    *,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    maximum_value: str,
    reservation_ttl_seconds: int,
) -> dict[str, object]:
    return {
        "kind": "tool",
        "operation_id": attempt.operation_id,
        "customer_id": attempt.customer_id,
        "trace_id": attempt.trace_id,
        "span_id": attempt.span_id,
        "parent_span_id": attempt.parent_span_id,
        "step_name": attempt.step_name,
        "framework": attempt.framework,
        "reservation_ttl_seconds": reservation_ttl_seconds,
        "cost_source_slug": cost_source_slug,
        "tool_name": tool_name,
        "metric": metric,
        "maximum_value": maximum_value,
    }


def _tool_attempt_context(
    attempt: _Attempt,
    *,
    reservation_id: str | None,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    owns_reservation: bool,
    legacy_telemetry_required: bool | None = None,
) -> ControlledAttemptContext:
    return ControlledAttemptContext(
        kind="tool",
        operation_id=attempt.operation_id,
        reservation_id=reservation_id,
        trace_id=attempt.trace_id,
        span_id=attempt.span_id,
        parent_span_id=attempt.parent_span_id,
        customer_id=attempt.customer_id,
        owns_reservation=owns_reservation,
        legacy_telemetry_required=(
            not owns_reservation if legacy_telemetry_required is None else legacy_telemetry_required
        ),
        config_generation=attempt.generation,
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
    )


def _configuration_changed(attempt: _Attempt) -> bool:
    return get_config_generation() != attempt.generation


def _configuration_changed_error(operation_id: str) -> PylvaControlUnavailableError:
    return PylvaControlUnavailableError(
        PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
        True,
        "reserve_usage",
        operation_id=operation_id,
    )


def _latency_ms(start_ns: int) -> int:
    elapsed = max((time.monotonic_ns() - start_ns) // 1_000_000, 0)
    return min(elapsed, _UINT32_MAX)


def _heartbeat_interval(
    reservation_ttl_seconds: int,
    heartbeat_interval_seconds: float | None,
) -> float:
    operation = "controlled_usage"
    if (
        isinstance(reservation_ttl_seconds, bool)
        or not isinstance(reservation_ttl_seconds, int)
        or reservation_ttl_seconds < 30
        or reservation_ttl_seconds > 3_600
    ):
        raise PylvaControlValidationError(operation)
    interval = (
        max(min(reservation_ttl_seconds / 2, reservation_ttl_seconds - 5), 1.0)
        if heartbeat_interval_seconds is None
        else heartbeat_interval_seconds
    )
    if (
        isinstance(interval, bool)
        or not isinstance(interval, (int, float))
        or not math.isfinite(interval)
        or interval <= 0
        or interval >= reservation_ttl_seconds
    ):
        raise PylvaControlValidationError(operation)
    return float(interval)


class _SyncHeartbeat:
    def __init__(
        self,
        reservation_id: str,
        *,
        interval_seconds: float,
        extend_by_seconds: int,
    ) -> None:
        self._reservation_id = reservation_id
        self._interval_seconds = interval_seconds
        self._extend_by_seconds = extend_by_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.failed = False

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run,
            name="pylva-controlled-usage-heartbeat",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            try:
                extend_usage_sync(
                    self._reservation_id,
                    {
                        "extension_id": str(uuid.uuid4()),
                        "extend_by_seconds": self._extend_by_seconds,
                    },
                )
            except Exception:
                self.failed = True
                return

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            # Do not settle the reservation while an extension request is still
            # in flight.  The control transport already has its own bounded
            # timeout, so this wait cannot outlive that request indefinitely.
            thread.join()


class _AsyncHeartbeat:
    def __init__(
        self,
        reservation_id: str,
        *,
        interval_seconds: float,
        extend_by_seconds: int,
    ) -> None:
        self._reservation_id = reservation_id
        self._interval_seconds = interval_seconds
        self._extend_by_seconds = extend_by_seconds
        self._task: asyncio.Task[None] | None = None
        self.failed = False

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            while True:
                await asyncio.sleep(self._interval_seconds)
                try:
                    await extend_usage(
                        self._reservation_id,
                        {
                            "extension_id": str(uuid.uuid4()),
                            "extend_by_seconds": self._extend_by_seconds,
                        },
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.failed = True
                    return
        except asyncio.CancelledError:
            return

    async def stop(self) -> None:
        task = self._task
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def _release_before_dispatch_sync(reservation: ReservedBudgetDecision) -> None:
    try:
        release_usage_sync(
            reservation.reservation_id,
            {"reason": "provider_not_called"},
        )
    except Exception:
        # Preserve the caller's pre-dispatch exception. The hold safely expires.
        pass


async def _release_before_dispatch(reservation: ReservedBudgetDecision) -> None:
    try:
        await release_usage(
            reservation.reservation_id,
            {"reason": "provider_not_called"},
        )
    except Exception:
        pass


def _decision_reason(reservation: BudgetReservationResponse) -> str | None:
    if isinstance(reservation, (BypassedBudgetDecision, UnavailableBudgetDecision)):
        return reservation.reason
    return None


def _warn(issue: ControlledUsageIssue) -> None:
    # Do not include provider exception text: it can contain URLs or arguments.
    print(
        f"[pylva] controlled_usage settlement={issue}; authoritative usage may remain unresolved",
        flush=True,
    )


def _legacy_report(
    *,
    tool_name: str,
    metric: str,
    actual_value: str,
    customer_id: str,
    step: str | None,
) -> bool:
    try:
        numeric = float(Decimal(actual_value))
        if not math.isfinite(numeric):
            raise ValueError("non-finite legacy quantity")
        from ..reporting.usage import report_usage

        report_usage(
            tool=tool_name,
            metric=metric,
            value=numeric,
            customer_id=customer_id,
            step=step,
        )
        return True
    except Exception:
        _warn("legacy_report_failed")
        return False


def _uncontrolled_outcome(
    *,
    reservation: BudgetReservationResponse | None,
    attempt: _Attempt,
    maximum_value: str,
    actual_value: str | None,
    issue: ControlledUsageIssue | None,
    legacy_emitted: bool,
) -> ControlledUsageOutcome:
    reason: str | None
    if reservation is None:
        decision: ControlledUsageDecision = "unavailable"
        reason = "shadow_control_unavailable"
    else:
        decision = cast(ControlledUsageDecision, reservation.decision)
        reason = _decision_reason(reservation)
    settlement: ControlledUsageSettlement
    if issue in {"usage_extraction_failed", "configuration_changed"}:
        settlement = "unresolved"
    else:
        settlement = "bypassed" if decision == "bypassed" else "unavailable"
    return ControlledUsageOutcome(
        operation_id=attempt.operation_id,
        reservation_id=None,
        decision=decision,
        decision_reason=reason,
        settlement=settlement,
        maximum_value=maximum_value,
        actual_value=actual_value,
        bound_violated=(
            Decimal(actual_value) > Decimal(maximum_value) if actual_value is not None else None
        ),
        authoritative_ownership=False,
        legacy_telemetry_emitted=legacy_emitted,
        issue=issue,
    )


def _reserved_outcome(
    *,
    reservation: ReservedBudgetDecision,
    maximum_value: str,
    actual_value: str | None,
    settlement: Literal["committed", "unresolved"],
    issue: ControlledUsageIssue | None,
    commit: BudgetCommitResponse | None = None,
) -> ControlledUsageOutcome:
    return ControlledUsageOutcome(
        operation_id=reservation.operation_id,
        reservation_id=reservation.reservation_id,
        decision="reserved",
        decision_reason=None,
        settlement=settlement,
        maximum_value=maximum_value,
        actual_value=actual_value,
        bound_violated=(
            Decimal(actual_value) > Decimal(maximum_value) if actual_value is not None else None
        ),
        authoritative_ownership=True,
        legacy_telemetry_emitted=False,
        issue=issue,
        commit=commit,
    )


def _shadow_reserve_sync(
    request: dict[str, object],
    *,
    mode: str,
) -> BudgetReservationResponse | None:
    try:
        return reserve_usage_sync(request)
    except (PylvaControlUnavailableError, PylvaControlApiError):
        if mode != "shadow":
            raise
        return None


async def _shadow_reserve(
    request: dict[str, object],
    *,
    mode: str,
) -> BudgetReservationResponse | None:
    try:
        return await reserve_usage(request)
    except (PylvaControlUnavailableError, PylvaControlApiError):
        if mode != "shadow":
            raise
        return None


def controlled_usage_sync(
    *,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    maximum_value: ExactDecimalInput,
    invoke: Callable[[], T],
    extract_actual: ActualUsageExtractor[T],
    customer_id: str | None = None,
    step: str | None = None,
    before_invoke: Callable[[], None] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Run one synchronous bounded tool call under authoritative control."""

    operation = "controlled_usage"
    try:
        _validate_callable(invoke, operation)
        _validate_callable(extract_actual, operation)
        if before_invoke is not None:
            _validate_callable(before_invoke, operation)
        maximum = _canonical_decimal(maximum_value, operation)
        heartbeat_interval = _heartbeat_interval(
            reservation_ttl_seconds,
            heartbeat_interval_seconds,
        )
        attempt = _attempt(customer_id, step)
        cfg, _ = _require_config_snapshot()
    except BaseException:
        _controlled_local_no_dispatch("tool")
        raise
    request = _reservation_request(
        attempt,
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        maximum_value=maximum,
        reservation_ttl_seconds=reservation_ttl_seconds,
    )
    callback_attempt = _tool_attempt_context(
        attempt,
        reservation_id=None,
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        owns_reservation=False,
        legacy_telemetry_required=False,
    )
    try:
        reservation = _shadow_reserve_sync(request, mode=cfg.control.mode)
        if _configuration_changed(attempt):
            raise _configuration_changed_error(attempt.operation_id)
    except BaseException:
        _controlled_no_dispatch(callback_attempt)
        raise

    if isinstance(reservation, ReservedBudgetDecision):
        if not should_suppress_legacy_telemetry(
            reservation,
            operation_id=reservation.operation_id,
            reservation_id=reservation.reservation_id,
        ):
            _controlled_no_dispatch(callback_attempt)
            raise PylvaControlValidationError(operation)
        with controlled_operation_ownership(reservation):
            heartbeat = _SyncHeartbeat(
                reservation.reservation_id,
                interval_seconds=heartbeat_interval,
                extend_by_seconds=reservation_ttl_seconds,
            )
            try:
                if before_invoke is not None and before_invoke() is not None:
                    raise PylvaControlValidationError(operation)
                if _configuration_changed(attempt):
                    raise _configuration_changed_error(attempt.operation_id)
                heartbeat.start()
            except BaseException:
                _controlled_no_dispatch(callback_attempt)
                if not _configuration_changed(attempt):
                    _release_before_dispatch_sync(reservation)
                raise
            start_ns = time.monotonic_ns()
            actual: str | None = None
            extraction_failed = False
            changed_after_provider = False
            try:
                with _controlled_attempt_scope(
                    _tool_attempt_context(
                        attempt,
                        reservation_id=reservation.reservation_id,
                        cost_source_slug=cost_source_slug,
                        tool_name=tool_name,
                        metric=metric,
                        owns_reservation=True,
                    )
                ):
                    value = invoke()  # dispatch begins immediately before this expression
                latency_ms = _latency_ms(start_ns)
                changed_after_provider = _configuration_changed(attempt)
                if not changed_after_provider:
                    try:
                        actual = _canonical_decimal(extract_actual(value), operation)
                    except Exception:
                        extraction_failed = True
            finally:
                heartbeat.stop()
            if changed_after_provider or _configuration_changed(attempt):
                _warn("configuration_changed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=None,
                        settlement="unresolved",
                        issue="configuration_changed",
                    ),
                )
            heartbeat_issue: ControlledUsageIssue | None = None
            if heartbeat.failed:
                heartbeat_issue = "extension_failed"
                _warn(heartbeat_issue)
            if extraction_failed:
                _warn("usage_extraction_failed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=None,
                        settlement="unresolved",
                        issue="usage_extraction_failed",
                    ),
                )
            if actual is None:  # pragma: no cover - defensive type narrowing
                raise PylvaControlValidationError(operation)
            try:
                committed = commit_usage_sync(
                    reservation.reservation_id,
                    {
                        "kind": "tool",
                        "actual_value": actual,
                        "status": "success",
                        "latency_ms": latency_ms,
                        "stream_aborted": False,
                    },
                )
            except Exception:
                _warn("commit_failed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=actual,
                        settlement="unresolved",
                        issue="commit_failed",
                    ),
                )
            return ControlledUsageResult(
                value,
                _reserved_outcome(
                    reservation=reservation,
                    maximum_value=maximum,
                    actual_value=actual,
                    settlement="committed",
                    issue=heartbeat_issue,
                    commit=committed,
                ),
            )

    # Legacy, shadow, no-budget, and enforce+allow calls remain tracking-only.
    try:
        if before_invoke is not None and before_invoke() is not None:
            raise PylvaControlValidationError(operation)
    except BaseException:
        _controlled_no_dispatch(callback_attempt)
        raise
    start_ns = time.monotonic_ns()
    with _controlled_attempt_scope(
        _tool_attempt_context(
            attempt,
            reservation_id=None,
            cost_source_slug=cost_source_slug,
            tool_name=tool_name,
            metric=metric,
            owns_reservation=False,
        )
    ):
        value = invoke()
    _ = _latency_ms(start_ns)
    if _configuration_changed(attempt):
        _warn("configuration_changed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="configuration_changed",
                legacy_emitted=False,
            ),
        )
    try:
        actual = _canonical_decimal(extract_actual(value), operation)
    except Exception:
        _warn("usage_extraction_failed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="usage_extraction_failed",
                legacy_emitted=False,
            ),
        )
    if _configuration_changed(attempt):
        _warn("configuration_changed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="configuration_changed",
                legacy_emitted=False,
            ),
        )
    emitted = _legacy_report(
        tool_name=tool_name,
        metric=metric,
        actual_value=actual,
        customer_id=attempt.customer_id,
        step=attempt.step_name,
    )
    return ControlledUsageResult(
        value,
        _uncontrolled_outcome(
            reservation=reservation,
            attempt=attempt,
            maximum_value=maximum,
            actual_value=actual,
            issue=None if emitted else "legacy_report_failed",
            legacy_emitted=emitted,
        ),
    )


async def controlled_usage(
    *,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    maximum_value: ExactDecimalInput,
    invoke: Callable[[], Awaitable[T]],
    extract_actual: AsyncActualUsageExtractor[T],
    customer_id: str | None = None,
    step: str | None = None,
    before_invoke: Callable[[], None] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Run one asynchronous bounded tool call under authoritative control."""

    operation = "controlled_usage"
    try:
        _validate_callable(invoke, operation)
        _validate_callable(extract_actual, operation)
        if before_invoke is not None:
            _validate_callable(before_invoke, operation)
        maximum = _canonical_decimal(maximum_value, operation)
        heartbeat_interval = _heartbeat_interval(
            reservation_ttl_seconds,
            heartbeat_interval_seconds,
        )
        attempt = _attempt(customer_id, step)
        cfg, _ = _require_config_snapshot()
    except BaseException:
        _controlled_local_no_dispatch("tool")
        raise
    request = _reservation_request(
        attempt,
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        maximum_value=maximum,
        reservation_ttl_seconds=reservation_ttl_seconds,
    )
    callback_attempt = _tool_attempt_context(
        attempt,
        reservation_id=None,
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        owns_reservation=False,
        legacy_telemetry_required=False,
    )
    try:
        reservation = await _shadow_reserve(request, mode=cfg.control.mode)
        if _configuration_changed(attempt):
            raise _configuration_changed_error(attempt.operation_id)
    except BaseException:
        _controlled_no_dispatch(callback_attempt)
        raise

    if isinstance(reservation, ReservedBudgetDecision):
        if not should_suppress_legacy_telemetry(
            reservation,
            operation_id=reservation.operation_id,
            reservation_id=reservation.reservation_id,
        ):
            _controlled_no_dispatch(callback_attempt)
            raise PylvaControlValidationError(operation)
        with controlled_operation_ownership(reservation):
            heartbeat = _AsyncHeartbeat(
                reservation.reservation_id,
                interval_seconds=heartbeat_interval,
                extend_by_seconds=reservation_ttl_seconds,
            )
            try:
                if before_invoke is not None and before_invoke() is not None:
                    raise PylvaControlValidationError(operation)
                if _configuration_changed(attempt):
                    raise _configuration_changed_error(attempt.operation_id)
                heartbeat.start()
            except BaseException:
                _controlled_no_dispatch(callback_attempt)
                if not _configuration_changed(attempt):
                    await _release_before_dispatch(reservation)
                raise
            start_ns = time.monotonic_ns()
            actual: str | None = None
            extraction_failed = False
            changed_after_provider = False
            try:
                with _controlled_attempt_scope(
                    _tool_attempt_context(
                        attempt,
                        reservation_id=reservation.reservation_id,
                        cost_source_slug=cost_source_slug,
                        tool_name=tool_name,
                        metric=metric,
                        owns_reservation=True,
                    )
                ):
                    value = await invoke()  # dispatch begins immediately before this expression
                latency_ms = _latency_ms(start_ns)
                changed_after_provider = _configuration_changed(attempt)
                if not changed_after_provider:
                    try:
                        extracted = extract_actual(value)
                        actual_input = (
                            await extracted if inspect.isawaitable(extracted) else extracted
                        )
                        actual = _canonical_decimal(actual_input, operation)
                    except Exception:
                        extraction_failed = True
            finally:
                await heartbeat.stop()
            if changed_after_provider or _configuration_changed(attempt):
                _warn("configuration_changed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=None,
                        settlement="unresolved",
                        issue="configuration_changed",
                    ),
                )
            heartbeat_issue: ControlledUsageIssue | None = None
            if heartbeat.failed:
                heartbeat_issue = "extension_failed"
                _warn(heartbeat_issue)
            if extraction_failed:
                _warn("usage_extraction_failed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=None,
                        settlement="unresolved",
                        issue="usage_extraction_failed",
                    ),
                )
            if actual is None:  # pragma: no cover - defensive type narrowing
                raise PylvaControlValidationError(operation)
            try:
                committed = await commit_usage(
                    reservation.reservation_id,
                    {
                        "kind": "tool",
                        "actual_value": actual,
                        "status": "success",
                        "latency_ms": latency_ms,
                        "stream_aborted": False,
                    },
                )
            except Exception:
                _warn("commit_failed")
                return ControlledUsageResult(
                    value,
                    _reserved_outcome(
                        reservation=reservation,
                        maximum_value=maximum,
                        actual_value=actual,
                        settlement="unresolved",
                        issue="commit_failed",
                    ),
                )
            return ControlledUsageResult(
                value,
                _reserved_outcome(
                    reservation=reservation,
                    maximum_value=maximum,
                    actual_value=actual,
                    settlement="committed",
                    issue=heartbeat_issue,
                    commit=committed,
                ),
            )

    try:
        if before_invoke is not None and before_invoke() is not None:
            raise PylvaControlValidationError(operation)
    except BaseException:
        _controlled_no_dispatch(callback_attempt)
        raise
    start_ns = time.monotonic_ns()
    with _controlled_attempt_scope(
        _tool_attempt_context(
            attempt,
            reservation_id=None,
            cost_source_slug=cost_source_slug,
            tool_name=tool_name,
            metric=metric,
            owns_reservation=False,
        )
    ):
        value = await invoke()
    _ = _latency_ms(start_ns)
    if _configuration_changed(attempt):
        _warn("configuration_changed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="configuration_changed",
                legacy_emitted=False,
            ),
        )
    try:
        extracted = extract_actual(value)
        actual_input = await extracted if inspect.isawaitable(extracted) else extracted
        actual = _canonical_decimal(actual_input, operation)
    except Exception:
        _warn("usage_extraction_failed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="usage_extraction_failed",
                legacy_emitted=False,
            ),
        )
    if _configuration_changed(attempt):
        _warn("configuration_changed")
        return ControlledUsageResult(
            value,
            _uncontrolled_outcome(
                reservation=reservation,
                attempt=attempt,
                maximum_value=maximum,
                actual_value=None,
                issue="configuration_changed",
                legacy_emitted=False,
            ),
        )
    emitted = _legacy_report(
        tool_name=tool_name,
        metric=metric,
        actual_value=actual,
        customer_id=attempt.customer_id,
        step=attempt.step_name,
    )
    return ControlledUsageResult(
        value,
        _uncontrolled_outcome(
            reservation=reservation,
            attempt=attempt,
            maximum_value=maximum,
            actual_value=actual,
            issue=None if emitted else "legacy_report_failed",
            legacy_emitted=emitted,
        ),
    )


def controlled_exact_usage_sync(
    *,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    value: ExactDecimalInput,
    invoke: Callable[[], T],
    customer_id: str | None = None,
    step: str | None = None,
    before_invoke: Callable[[], None] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Control a synchronous call whose exact quantity is known pre-dispatch."""

    try:
        exact = _canonical_decimal(value, "controlled_exact_usage")
    except BaseException:
        _controlled_local_no_dispatch("tool")
        raise
    return controlled_usage_sync(
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        maximum_value=exact,
        invoke=invoke,
        extract_actual=lambda _result: exact,
        customer_id=customer_id,
        step=step,
        before_invoke=before_invoke,
        reservation_ttl_seconds=reservation_ttl_seconds,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
    )


async def controlled_exact_usage(
    *,
    cost_source_slug: str,
    tool_name: str,
    metric: str,
    value: ExactDecimalInput,
    invoke: Callable[[], Awaitable[T]],
    customer_id: str | None = None,
    step: str | None = None,
    before_invoke: Callable[[], None] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Control an asynchronous call whose exact quantity is known pre-dispatch."""

    try:
        exact = _canonical_decimal(value, "controlled_exact_usage")
    except BaseException:
        _controlled_local_no_dispatch("tool")
        raise
    return await controlled_usage(
        cost_source_slug=cost_source_slug,
        tool_name=tool_name,
        metric=metric,
        maximum_value=exact,
        invoke=invoke,
        extract_actual=lambda _result: exact,
        customer_id=customer_id,
        step=step,
        before_invoke=before_invoke,
        reservation_ttl_seconds=reservation_ttl_seconds,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
    )
