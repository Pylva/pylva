"""Private dispatch marker shared by explicit and legacy provider wrappers.

The explicit controlled wrappers resolve and reserve the final provider/model
before dispatch.  Legacy auto-patches must therefore call their captured
provider method directly while this marker is active: re-running model routing
would invalidate the reservation and emitting telemetry would duplicate a
reserved operation.  The explicit wrapper emits legacy telemetry itself for
honest bypass/unavailable rollout decisions.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class _StrictDispatch:
    provider: str
    model: str
    active: bool = True


_current_dispatch: ContextVar[_StrictDispatch | None] = ContextVar(
    "pylva_strict_provider_dispatch",
    default=None,
)


@contextmanager
def strict_provider_dispatch(provider: str, model: str) -> Iterator[None]:
    dispatch = _StrictDispatch(provider=provider, model=model)
    token = _current_dispatch.set(dispatch)
    try:
        yield
    finally:
        # Context variables are copied into child asyncio tasks. Mutating this
        # shared lease before reset prevents an outliving task from treating a
        # later same-model call as part of the completed controlled dispatch.
        dispatch.active = False
        _current_dispatch.reset(token)


def is_strict_provider_dispatch(provider: str, model: object) -> bool:
    current = _current_dispatch.get()
    return (
        current is not None
        and current.active
        and current.provider == provider
        and isinstance(model, str)
        and current.model == model
    )
