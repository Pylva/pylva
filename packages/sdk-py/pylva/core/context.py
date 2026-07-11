"""Propagation context via contextvars — D25.

``track(customer_id, ...)`` nests cleanly for both sync and async callers.
The context is async-safe without the caller using ``copy_context`` — the
common Python async pattern.
"""

from __future__ import annotations

import inspect
import re
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TypeVar


@dataclass(frozen=True)
class TrackContext:
    customer_id: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    step_name: str | None
    framework: str
    run_id: str
    parent_run_id: str | None


_context: ContextVar[TrackContext | None] = ContextVar("pylva_context", default=None)

T = TypeVar("T")


def current_context() -> TrackContext | None:
    return _context.get()


# Matches the backend's per-event customer_id schema. track() warns (never
# raises — R1) so builders learn at dev time instead of discovering that the
# backend rejected the events: rejected traffic is unbilled AND budget rules
# never apply to it.
_CUSTOMER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,255}$")
_warned_invalid_customer_ids: set[str] = set()


def _warn_invalid_customer_id(customer_id: object) -> None:
    key = str(customer_id)[:64]
    if key in _warned_invalid_customer_ids or len(_warned_invalid_customer_ids) > 1000:
        return
    _warned_invalid_customer_ids.add(key)
    print(
        f"[pylva] track(): customer_id {key!r} does not match ^[a-zA-Z0-9_-]{{1,255}}$ — "
        "the backend will reject its events, so this traffic is unbilled and budget rules "
        "will not apply to it. Use a stable alphanumeric/_/- id.",
        flush=True,
    )


@contextmanager
def track_context(
    customer_id: str,
    step: str | None = None,
    framework: str | None = None,
) -> Iterator[TrackContext]:
    if not isinstance(customer_id, str) or not _CUSTOMER_ID_RE.match(customer_id):
        _warn_invalid_customer_id(customer_id)
    parent = _context.get()
    ctx = TrackContext(
        customer_id=customer_id,
        trace_id=parent.trace_id if parent else str(uuid.uuid4()),
        span_id=str(uuid.uuid4()),
        parent_span_id=parent.span_id if parent else None,
        step_name=step or (parent.step_name if parent else None),
        framework=framework or (parent.framework if parent else "none"),
        run_id=str(uuid.uuid4()),
        parent_run_id=parent.run_id if parent else None,
    )
    token: Token[TrackContext | None] = _context.set(ctx)
    try:
        yield ctx
    finally:
        _context.reset(token)


def track(
    customer_id: str,
    fn: Callable[[], T | Awaitable[T]],
    *,
    step: str | None = None,
    framework: str | None = None,
) -> T | Awaitable[T]:
    """Run ``fn`` inside a track context. ``fn`` may be sync or async.

    Usage:
        result = track("cust_123", lambda: do_work())
        # async:
        result = await track("cust_123", async_do_work)
    """
    with track_context(customer_id, step, framework) as ctx:
        result = fn()
        if not inspect.isawaitable(result):
            return result
    # Async fn: ``fn()`` only created the coroutine — its body runs when the
    # caller awaits, *after* this function has returned and the ``with`` block
    # reset the contextvar. Re-enter the context for the awaited execution so
    # LLM calls inside attribute to ``customer_id`` instead of "anonymous"
    # (and customer-scoped budget rules still match). Mirrors TS
    # ``AsyncLocalStorage.run()``, which keeps context across awaits.
    return _await_in_context(ctx, result)


async def _await_in_context(ctx: TrackContext, awaitable: Awaitable[T]) -> T:
    token = _context.set(ctx)
    try:
        return await awaitable
    finally:
        _context.reset(token)


def _run_in_context(ctx: TrackContext, fn: Callable[[], T]) -> T:
    token = _context.set(ctx)
    try:
        return fn()
    finally:
        _context.reset(token)
