"""Proof that an operation is owned by authoritative budget control.

The reserve transport attaches an SDK-private token only after a ``reserved``
response is schema-valid, mode-valid, and correlated to the request. Provider
wrappers bind that receipt across the provider/tool attempt and suppress only
the matching legacy billable event. Ownership begins at reservation: a lost
commit acknowledgement must not make the wrapper emit a duplicate legacy
event while the authoritative reservation remains unresolved or later settles.
"""

from __future__ import annotations

import threading
import uuid
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

from .config import ResolvedConfig, _require_config_snapshot, get_config_generation
from .control_schema import ReservedBudgetDecision


@dataclass(frozen=True)
class ControlledOperationOwnership:
    operation_id: str
    reservation_id: str
    trace_id: str
    span_id: str
    config_generation: int


@dataclass(frozen=True)
class ControlledAttemptContext:
    """Exact provider attempt correlation for framework callback deduplication."""

    kind: Literal["llm", "tool"]
    operation_id: str
    reservation_id: str | None
    trace_id: str
    span_id: str
    parent_span_id: str | None
    customer_id: str
    owns_reservation: bool
    legacy_telemetry_required: bool
    config_generation: int
    provider: Literal["openai", "anthropic"] | None = None
    model: str | None = None
    cost_source_slug: str | None = None
    tool_name: str | None = None
    metric: str | None = None

    def __post_init__(self) -> None:
        llm_fields = self.provider is not None and self.model is not None
        tool_fields = (
            self.cost_source_slug is not None
            and self.tool_name is not None
            and self.metric is not None
        )
        if self.kind == "llm" and (not llm_fields or tool_fields):
            raise ValueError("llm controlled attempts require only provider/model fields")
        if self.kind == "tool" and (not tool_fields or llm_fields):
            raise ValueError("tool controlled attempts require only cost-source/tool fields")


@dataclass(frozen=True)
class ControlledNoDispatchContext:
    """Exact ownership marker for a local refusal before provider/tool dispatch."""

    kind: Literal["llm", "tool"]
    operation_id: str
    config_generation: int


@dataclass(eq=False)
class ControlledCallbackLink:
    """Mutable exact rendezvous between one callback run and provider attempt."""

    kind: Literal["llm", "tool"]
    config_generation: int
    controlled_attempt: ControlledAttemptContext | None = None
    controlled_no_dispatch: ControlledNoDispatchContext | None = None
    ambiguous: bool = False
    _scope: _ControlledCallbackScope | None = None


@dataclass
class _ControlledCallbackScope:
    pending: list[ControlledCallbackLink]
    warned: set[Literal["llm", "tool"]]
    inherited_attempt: ControlledAttemptContext | None
    active: bool = True


@dataclass
class _ControlledAttemptLease:
    attempt: ControlledAttemptContext
    active: bool = True


@dataclass(frozen=True)
class _ReservationOwnershipToken:
    ownership: ControlledOperationOwnership
    api_key: str
    endpoint: str
    response_identity: int


@dataclass
class _ReservationOwnershipLease:
    token: _ReservationOwnershipToken
    active: bool = True


_ownership: ContextVar[_ReservationOwnershipLease | None] = ContextVar(
    "pylva_controlled_operation_ownership",
    default=None,
)
_attempt: ContextVar[_ControlledAttemptLease | None] = ContextVar(
    "pylva_controlled_provider_attempt",
    default=None,
)
_callback_scope: ContextVar[_ControlledCallbackScope | None] = ContextVar(
    "pylva_controlled_callback_scope",
    default=None,
)
_ownership_lock = threading.Lock()
_accepted_generation = get_config_generation()


def _token_is_current(token: _ReservationOwnershipToken) -> bool:
    try:
        cfg, generation = _require_config_snapshot()
    except RuntimeError:
        return False
    with _ownership_lock:
        accepted = _accepted_generation
    return (
        generation == accepted == token.ownership.config_generation
        and cfg.api_key == token.api_key
        and cfg.endpoint == token.endpoint
    )


def _receipt_token(reservation: object) -> _ReservationOwnershipToken | None:
    if not isinstance(reservation, ReservedBudgetDecision):
        return None
    token = reservation._pylva_control_ownership
    if not isinstance(token, _ReservationOwnershipToken):
        return None
    if token.response_identity != id(reservation) or not _token_is_current(token):
        return None
    if (
        token.ownership.operation_id != reservation.operation_id
        or token.ownership.reservation_id != reservation.reservation_id
    ):
        return None
    return token


def _register_controlled_reservation(
    response: ReservedBudgetDecision,
    cfg: ResolvedConfig,
    generation: int,
    trace_id: str = "00000000-0000-4000-8000-000000000000",
    span_id: str = "00000000-0000-4000-8000-000000000000",
) -> bool:
    """Attach ownership only if the same builder identity is still current."""

    try:
        current, current_generation = _require_config_snapshot()
    except RuntimeError:
        return False
    with _ownership_lock:
        if (
            generation != _accepted_generation
            or current_generation != generation
            or current.api_key != cfg.api_key
            or current.endpoint != cfg.endpoint
        ):
            return False
        response._pylva_control_ownership = _ReservationOwnershipToken(
            ownership=ControlledOperationOwnership(
                operation_id=response.operation_id,
                reservation_id=response.reservation_id,
                trace_id=trace_id,
                span_id=span_id,
                config_generation=generation,
            ),
            api_key=cfg.api_key,
            endpoint=cfg.endpoint,
            response_identity=id(response),
        )
    return True


@contextmanager
def controlled_operation_ownership(
    reservation: ReservedBudgetDecision,
) -> Iterator[ControlledOperationOwnership]:
    """Bind one SDK-owned reservation across the matching provider attempt."""

    token = _receipt_token(reservation)
    if token is None:
        raise TypeError(
            "[pylva] controlled operation ownership requires an SDK-owned reserved decision"
        )
    lease = _ReservationOwnershipLease(token=token)
    reset_token = _ownership.set(lease)
    try:
        yield token.ownership
    finally:
        lease.active = False
        _ownership.reset(reset_token)


def current_controlled_operation() -> ControlledOperationOwnership | None:
    lease = _ownership.get()
    if lease is None or not lease.active or not _token_is_current(lease.token):
        return None
    return lease.token.ownership


@contextmanager
def _controlled_attempt_scope(attempt: ControlledAttemptContext) -> Iterator[None]:
    try:
        _link_pending_callback(attempt)
    except Exception:
        # Framework correlation is observer-only and cannot block dispatch.
        pass
    lease = _ControlledAttemptLease(attempt=attempt)
    token = _attempt.set(lease)
    try:
        yield
    finally:
        lease.active = False
        _attempt.reset(token)


def _controlled_no_dispatch(attempt: ControlledAttemptContext) -> None:
    """Link a callback to a controlled refusal before provider dispatch.

    LangChain starts its callback before a model/tool implementation invokes
    Pylva. A reserve denial therefore has no provider-attempt scope to perform
    the usual rendezvous. Linking the exact pending callback here prevents its
    later error callback from inventing a legacy billable failure event for a
    provider/tool that was never called.
    """

    if (
        attempt.reservation_id is not None
        or attempt.owns_reservation
        or attempt.legacy_telemetry_required
    ):
        return
    try:
        _link_pending_no_dispatch(
            ControlledNoDispatchContext(
                kind=attempt.kind,
                operation_id=attempt.operation_id,
                config_generation=attempt.config_generation,
            )
        )
    except Exception:
        # Callback correlation is observer-only and cannot replace the
        # original denial/control exception.
        pass


def _controlled_local_no_dispatch(kind: Literal["llm", "tool"]) -> None:
    """Link a callback to a validation refusal that happens before an attempt exists."""

    try:
        _link_pending_no_dispatch(
            ControlledNoDispatchContext(
                kind=kind,
                operation_id=str(uuid.uuid4()),
                config_generation=get_config_generation(),
            )
        )
    except Exception:
        # Correlation is observer-only and must never replace the local error.
        pass


def current_controlled_attempt() -> ControlledAttemptContext | None:
    """Return exact attempt correlation only while its provider is executing."""

    lease = _attempt.get()
    if (
        lease is None
        or not lease.active
        or lease.attempt.config_generation != get_config_generation()
    ):
        return None
    return lease.attempt


@contextmanager
def _controlled_callback_scope() -> Iterator[None]:
    """Create one callback-to-provider rendezvous for a model/tool invocation."""

    scope = _ControlledCallbackScope(
        pending=[],
        warned=set(),
        inherited_attempt=current_controlled_attempt(),
    )
    token = _callback_scope.set(scope)
    try:
        yield
    finally:
        scope.active = False
        for link in scope.pending:
            link.ambiguous = True
            link._scope = None
        scope.pending.clear()
        _callback_scope.reset(token)


def _register_controlled_callback(
    kind: Literal["llm", "tool"],
) -> ControlledCallbackLink | None:
    scope = _callback_scope.get()
    if scope is None or not scope.active:
        return None
    link = ControlledCallbackLink(
        kind=kind,
        config_generation=get_config_generation(),
        _scope=scope,
    )
    scope.pending.append(link)
    return link


def _controlled_attempt_for_callback_start(
    kind: Literal["llm", "tool"],
) -> ControlledAttemptContext | None:
    """Return only a same-kind attempt that began inside this invocation."""

    attempt = current_controlled_attempt()
    if attempt is None or attempt.kind != kind:
        return None
    scope = _callback_scope.get()
    if scope is not None and scope.active and scope.inherited_attempt is attempt:
        # The attempt was already active outside this public scope. It cannot
        # own a nested callback unless an inner provider dispatch links later.
        return None
    return attempt


def _complete_controlled_callback(link: ControlledCallbackLink | None) -> None:
    if link is None or link._scope is None:
        return
    try:
        link._scope.pending.remove(link)
    except ValueError:
        pass
    link._scope = None


def _warn_ambiguous_scope(
    scope: _ControlledCallbackScope,
    kind: Literal["llm", "tool"],
    count: int,
) -> None:
    if kind in scope.warned:
        return
    scope.warned.add(kind)
    try:
        warnings.warn(
            f"[pylva] LangGraph control scope found {count} pending {kind} callbacks; "
            "exact auto-deduplication was not linked. Use one control scope per "
            "billable invocation.",
            RuntimeWarning,
            stacklevel=4,
        )
    except Exception:
        # Warning filters and custom warning hooks must not block the provider.
        pass


def _link_pending_callback(attempt: ControlledAttemptContext) -> None:
    scope = _callback_scope.get()
    if scope is None or not scope.active:
        return
    candidates = [
        link
        for link in scope.pending
        if not link.ambiguous
        and link.controlled_attempt is None
        and link.controlled_no_dispatch is None
        and link.kind == attempt.kind
        and link.config_generation == attempt.config_generation
    ]
    if len(candidates) != 1:
        _warn_ambiguous_scope(scope, attempt.kind, len(candidates))
        for candidate in candidates:
            candidate.ambiguous = True
            scope.pending.remove(candidate)
            candidate._scope = None
        return
    candidate = candidates[0]
    candidate.controlled_attempt = attempt
    scope.pending.remove(candidate)
    candidate._scope = None


def _link_pending_no_dispatch(no_dispatch: ControlledNoDispatchContext) -> None:
    scope = _callback_scope.get()
    if scope is None or not scope.active:
        return
    candidates = [
        link
        for link in scope.pending
        if not link.ambiguous
        and link.controlled_attempt is None
        and link.controlled_no_dispatch is None
        and link.kind == no_dispatch.kind
        and link.config_generation == no_dispatch.config_generation
    ]
    if not candidates:
        return
    if len(candidates) > 1:
        _warn_ambiguous_scope(scope, no_dispatch.kind, len(candidates))
        for candidate in candidates:
            candidate.ambiguous = True
            scope.pending.remove(candidate)
            candidate._scope = None
        return
    candidate = candidates[0]
    candidate.controlled_no_dispatch = no_dispatch
    scope.pending.remove(candidate)
    candidate._scope = None


def should_suppress_legacy_telemetry(
    reservation: ReservedBudgetDecision | None = None,
    *,
    operation_id: str | None = None,
    reservation_id: str | None = None,
) -> bool:
    """Prove an SDK-owned reservation and both telemetry identifiers match."""

    if operation_id is None or reservation_id is None:
        return False
    if reservation is None:
        lease = _ownership.get()
        token = lease.token if lease is not None and lease.active else None
    else:
        token = _receipt_token(reservation)
    if token is None or not _token_is_current(token):
        return False
    return (
        token.ownership.operation_id == operation_id
        and token.ownership.reservation_id == reservation_id
    )


def _invalidate_control_ownership_for_config_change(
    next_config_generation: int | None = None,
) -> None:
    """Make every previously issued receipt/context inert on identity change."""

    global _accepted_generation
    with _ownership_lock:
        _accepted_generation = (
            get_config_generation() + 1
            if next_config_generation is None
            else next_config_generation
        )


def _reset_control_ownership_for_tests() -> None:
    _invalidate_control_ownership_for_config_change()
