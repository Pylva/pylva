"""Per-SDK-instance reliability failover state machine.

No shared state across processes (D19: split-brain is acceptable because
partial failover is safer than coordinating).

Per Rev-2 O32, the sliding error window is keyed by ``primary_provider``
only — one counter per ``(builder, primary_provider)``. Each SDK process
already represents one builder, so ``primary_provider`` is sufficient.
Earlier per-customer keying meant a high-volume builder with thousands
of customers would never trip for sparse-traffic customers because their
per-customer window stayed empty. Plan accepted "OK to over-failover for
v1" in exchange for a single fast-tripping counter.

Trigger: error rate > ``trigger_pct`` over ``window_seconds``. While active,
``record_outcome()`` returns the backup provider so the wrapper routes there.
Recovery: error rate stays below ``recover_pct`` for ``recover_after_seconds``
→ flip back. Sparse-traffic probe (D24): after ``recovery_probe_after_seconds``
on backup, the wrapper attempts one primary call.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class ReliabilityFailoverConfig:
    enabled: bool
    customer_id: str
    primary_provider: str
    backup_provider: str
    trigger_error_rate_pct: float
    recover_error_rate_pct: float
    window_seconds: float
    recover_after_seconds: float
    recovery_probe_after_seconds: float
    consent_to_cost_shift: bool


@dataclass
class FailoverEventResult:
    """Mirrors the TS interface."""

    provider: str
    triggered: bool
    recovered: bool


@dataclass
class _WindowSample:
    ts: float
    ok: bool


@dataclass
class _InstanceState:
    active: bool = False
    entered_at: float = 0.0
    last_probe_at: float = 0.0
    below_since: float | None = None  # start of consecutive < recover_pct period
    samples: deque[_WindowSample] = field(default_factory=deque)


_STATE: dict[str, _InstanceState] = {}


def _key(cfg: ReliabilityFailoverConfig) -> str:
    # PR #70 follow-up — per O32 the trip key is primary_provider only
    # for one (builder, primary_provider) counter. customer_id stays in
    # cfg for the matching/scope layer but is not part of the trip key.
    # See packages/sdk-ts/src/core/failover.ts for the parity rationale.
    return cfg.primary_provider


def _prune_window(samples: deque[_WindowSample], window_sec: float, now: float) -> None:
    cutoff = now - window_sec
    while samples and samples[0].ts < cutoff:
        samples.popleft()


def _error_rate(samples: deque[_WindowSample]) -> float:
    if not samples:
        return 0.0
    errors = sum(1 for s in samples if not s.ok)
    return errors / len(samples)


def ensure_state(cfg: ReliabilityFailoverConfig) -> _InstanceState:
    k = _key(cfg)
    s = _STATE.get(k)
    if s is None:
        s = _InstanceState()
        _STATE[k] = s
    return s


def select_provider(cfg: ReliabilityFailoverConfig, now: float | None = None) -> str:
    """Returns the provider the wrapper should target.

    Not strictly pure: when the probe window has elapsed it advances
    ``last_probe_at`` so concurrent calls don't all probe simultaneously. Use
    :func:`is_active` for a pure-read check.

    Uses ``time.time()`` (wall clock) for parity with the TS ``Date.now()``
    implementation; clock skew on a long recovery window can prematurely flip
    state, but matching cross-language behavior is the priority.
    """
    if now is None:
        now = time.time()
    s = ensure_state(cfg)
    if not s.active:
        return cfg.primary_provider

    probe_after = cfg.recovery_probe_after_seconds
    since_entered = now - s.entered_at
    since_last_probe = now - s.last_probe_at
    if since_entered > probe_after and since_last_probe > probe_after:
        s.last_probe_at = now
        return cfg.primary_provider  # probe call goes to primary
    return cfg.backup_provider


def record_outcome(
    cfg: ReliabilityFailoverConfig, ok: bool, now: float | None = None
) -> FailoverEventResult:
    """Record the outcome of a call. Returns whether a state transition happened."""
    if now is None:
        now = time.time()
    s = ensure_state(cfg)
    s.samples.append(_WindowSample(ts=now, ok=ok))
    _prune_window(s.samples, cfg.window_seconds, now)

    rate_pct = _error_rate(s.samples) * 100
    triggered = False
    recovered = False

    if not s.active:
        if rate_pct > cfg.trigger_error_rate_pct:
            s.active = True
            s.entered_at = now
            s.last_probe_at = now  # start the probe clock from entry
            s.below_since = None
            triggered = True
    else:
        if rate_pct <= cfg.recover_error_rate_pct:
            if s.below_since is None:
                s.below_since = now
            below_sec = now - s.below_since
            if below_sec >= cfg.recover_after_seconds:
                s.active = False
                s.below_since = None
                s.samples = deque()  # fresh window for next trigger
                recovered = True
        else:
            s.below_since = None  # streak broken

    return FailoverEventResult(
        provider=cfg.backup_provider if s.active else cfg.primary_provider,
        triggered=triggered,
        recovered=recovered,
    )


def is_active(cfg: ReliabilityFailoverConfig) -> bool:
    """Pure-read check — does NOT mutate probe state."""
    return ensure_state(cfg).active


def _reset_failover_for_tests() -> None:
    _STATE.clear()
