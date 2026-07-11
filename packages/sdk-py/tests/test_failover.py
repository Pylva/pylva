"""B4-T1 failover state machine — Python parity tests for the TS suite in
``packages/sdk-ts/tests/failover.test.ts``."""

from __future__ import annotations

from pylva.core.failover import (
    ReliabilityFailoverConfig,
    _reset_failover_for_tests,
    is_active,
    record_outcome,
    select_provider,
)


def _cfg(
    *,
    primary: str = "openai",
    backup: str = "anthropic",
    customer_id: str = "cust_1",
    trigger_pct: float = 10.0,
    recover_pct: float = 2.0,
    window: float = 60.0,
    recover_after: float = 60.0,
    recovery_probe_after: float = 1800.0,
) -> ReliabilityFailoverConfig:
    return ReliabilityFailoverConfig(
        enabled=True,
        customer_id=customer_id,
        primary_provider=primary,
        backup_provider=backup,
        trigger_error_rate_pct=trigger_pct,
        recover_error_rate_pct=recover_pct,
        window_seconds=window,
        recover_after_seconds=recover_after,
        recovery_probe_after_seconds=recovery_probe_after,
        consent_to_cost_shift=True,
    )


def setup_function(_fn: object) -> None:
    _reset_failover_for_tests()


def test_initial_state_inactive_returns_primary() -> None:
    cfg = _cfg()
    assert is_active(cfg) is False
    assert select_provider(cfg) == "openai"


def test_triggers_failover_when_error_rate_exceeds_threshold() -> None:
    cfg = _cfg(trigger_pct=10.0, window=100.0)
    now = 1000.0
    # 11 samples, 2 errors → 18% > 10%
    for i in range(9):
        record_outcome(cfg, ok=True, now=now + i)
    record_outcome(cfg, ok=False, now=now + 9)
    out = record_outcome(cfg, ok=False, now=now + 10)
    assert out.triggered is True
    assert out.provider == "anthropic"
    assert is_active(cfg) is True


def test_no_trigger_below_threshold() -> None:
    cfg = _cfg(trigger_pct=20.0)
    now = 1000.0
    for i in range(9):
        record_outcome(cfg, ok=True, now=now + i)
    out = record_outcome(cfg, ok=False, now=now + 9)  # 10% < 20%
    assert out.triggered is False
    assert is_active(cfg) is False


def test_recovery_requires_sustained_below_observation() -> None:
    """B4-2a Lessons: recovery clock only advances on sample arrival; sparse
    traffic depends on the probe (D24), high-traffic on the recovery window.

    Recovery fires on the call where (rate ≤ recover_pct) has been sustained
    for ``recover_after_seconds``. We track ``recovered`` via is_active rather
    than the last call's flag, since recovery may fire mid-loop."""
    cfg = _cfg(trigger_pct=10.0, recover_pct=5.0, recover_after=60.0, window=600.0)
    now = 1000.0
    # Trigger: 11 samples, 2 errors → 18%
    for i in range(9):
        record_outcome(cfg, ok=True, now=now + i)
    record_outcome(cfg, ok=False, now=now + 9)
    record_outcome(cfg, ok=False, now=now + 10)
    assert is_active(cfg) is True

    # Pump ok samples until the rate dips and stays below 5% for >= 60s.
    recovered_at: float | None = None
    for i in range(120):
        out = record_outcome(cfg, ok=True, now=now + 11 + i)
        if out.recovered:
            recovered_at = now + 11 + i
            break
    assert recovered_at is not None
    assert is_active(cfg) is False


def test_recovery_does_not_fire_without_sustained_below_streak() -> None:
    cfg = _cfg(trigger_pct=10.0, recover_pct=5.0, recover_after=60.0, window=600.0)
    now = 1000.0
    for i in range(9):
        record_outcome(cfg, ok=True, now=now + i)
    record_outcome(cfg, ok=False, now=now + 9)
    record_outcome(cfg, ok=False, now=now + 10)

    # Below briefly, then a single error breaks the streak.
    for i in range(50):
        record_outcome(cfg, ok=True, now=now + 11 + i)
    out = record_outcome(cfg, ok=False, now=now + 80)
    assert out.recovered is False
    assert is_active(cfg) is True


def test_select_provider_returns_backup_while_active() -> None:
    cfg = _cfg(trigger_pct=10.0, window=100.0)
    now = 1000.0
    for i in range(9):
        record_outcome(cfg, ok=True, now=now + i)
    record_outcome(cfg, ok=False, now=now + 9)
    record_outcome(cfg, ok=False, now=now + 10)
    assert select_provider(cfg, now=now + 11) == "anthropic"


def test_probe_returns_primary_after_window() -> None:
    """D24 sparse-traffic probe: after recovery_probe_after_seconds, one
    probe call goes to primary."""
    cfg = _cfg(recovery_probe_after=100.0, window=10.0)
    now = 1000.0
    # Trigger
    record_outcome(cfg, ok=False, now=now)
    record_outcome(cfg, ok=False, now=now + 1)
    assert is_active(cfg) is True
    # Within probe window — backup
    assert select_provider(cfg, now=now + 50) == "anthropic"
    # After probe window — primary (probe)
    assert select_provider(cfg, now=now + 200) == "openai"
    # Subsequent call within probe window of last probe — backup again
    assert select_provider(cfg, now=now + 250) == "anthropic"


def test_shares_state_across_customers_within_same_primary() -> None:
    # PR #84 follow-up — per O32 the trip key is primary_provider only.
    # Two customers on the same primary share the sliding error window;
    # when one trips, both fail over (single counter; over-failover for
    # v1). Mirrors the TS test in packages/sdk-ts/tests/failover.test.ts.
    cfg_a = _cfg(customer_id="cust_a")
    cfg_b = _cfg(customer_id="cust_b")
    now = 1000.0
    record_outcome(cfg_a, ok=False, now=now)
    record_outcome(cfg_a, ok=False, now=now + 1)
    assert is_active(cfg_a) is True
    # Same primary_provider → same key → same active state.
    assert is_active(cfg_b) is True


def test_isolates_state_across_distinct_primary_providers() -> None:
    # Two failover configs targeting different primaries get independent
    # sliding windows; tripping one does not trip the other.
    cfg_a = _cfg(primary="openai", backup="anthropic")
    cfg_b = _cfg(primary="anthropic", backup="openai")
    now = 1000.0
    record_outcome(cfg_a, ok=False, now=now)
    record_outcome(cfg_a, ok=False, now=now + 1)
    assert is_active(cfg_a) is True
    assert is_active(cfg_b) is False
