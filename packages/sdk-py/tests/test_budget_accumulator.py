"""B3-T1 — coverage for the SDK-side budget accumulator.

Covers:
  * Pre-call `check()` returns the accumulated + projected amounts.
  * `add()` increments and is idempotent per call.
  * LRU eviction fires above LRU_MAX.
  * `set_from_sync()` replaces local state (I-T3-3 reconciliation).
"""

from __future__ import annotations

from pylva.core import budget_accumulator as ba
from pylva.core.config import init


def setup_function(_fn: object) -> None:
    ba._reset_accumulator_for_tests()  # type: ignore[attr-defined]


def _key(rule_id: str = "r1", customer_id: str | None = "c1") -> ba.AccumulatorKey:
    return ba.AccumulatorKey(
        rule_id=rule_id,
        scope="per_customer" if customer_id else "pooled",
        customer_id=customer_id,
        period_start="2026-04-01T00:00:00Z",
    )


def test_check_allows_under_limit() -> None:
    res = ba.check(
        rule_id="r1",
        scope="per_customer",
        customer_id="c1",
        period_start="2026-04-01T00:00:00Z",
        estimated_usd=0.5,
        limit_usd=10.0,
    )
    assert res.over_limit is False
    assert res.accumulated_usd == 0.0
    assert res.projected_usd == 0.5


def test_check_blocks_over_limit_after_add() -> None:
    k = _key()
    ba.add(k, 9.9)
    res = ba.check(
        rule_id="r1",
        scope="per_customer",
        customer_id="c1",
        period_start="2026-04-01T00:00:00Z",
        estimated_usd=0.5,
        limit_usd=10.0,
    )
    assert res.over_limit is True
    assert res.accumulated_usd == 9.9


def test_set_from_sync_replaces_local() -> None:
    k = _key()
    ba.add(k, 5.0)
    ba.set_from_sync(k, 2.0)
    entry = ba.get(k)
    assert entry.total_usd == 2.0
    assert entry.exceeded_source is None


def test_backend_flag_marks_source() -> None:
    ba.mark_exceeded_from_backend(
        rule_id="r1",
        customer_id="c1",
        limit_usd=10,
        period_start="2026-04-01T00:00:00Z",
    )
    res = ba.check(
        rule_id="r1",
        scope="per_customer",
        customer_id="c1",
        period_start="2026-04-01T00:00:00Z",
        estimated_usd=0,
        limit_usd=10,
    )
    assert res.over_limit is True
    assert res.source == "backend_ingest_flag"


def test_backend_flag_period_start_matches_python_no_ms_key() -> None:
    ba.mark_exceeded_from_backend(
        rule_id="r1",
        customer_id="c1",
        limit_usd=10,
        period_start="2026-06-29T00:00:00.000Z",
    )
    res = ba.check(
        rule_id="r1",
        scope="per_customer",
        customer_id="c1",
        period_start="2026-06-29T00:00:00Z",
        estimated_usd=0,
        limit_usd=10,
    )
    assert res.over_limit is True
    assert res.source == "backend_ingest_flag"


def test_period_start_key_canonicalizes_utc_offsets() -> None:
    ba.add(
        ba.AccumulatorKey(
            rule_id="r1",
            scope="per_customer",
            customer_id="c1",
            period_start="2026-06-29T03:00:00+03:00",
        ),
        3.0,
    )
    entry = ba.get(
        ba.AccumulatorKey(
            rule_id="r1",
            scope="per_customer",
            customer_id="c1",
            period_start="2026-06-29T00:00:00.000Z",
        )
    )
    assert entry.total_usd == 3.0


def test_period_start_key_leaves_invalid_strings_unchanged() -> None:
    assert ba._canonical_period_start("not-a-date") == "not-a-date"  # type: ignore[attr-defined]


def test_lru_eviction_above_cap(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(ba, "LRU_MAX", 3)
    for i in range(5):
        ba.add(
            ba.AccumulatorKey(
                rule_id=f"r{i}",
                scope="per_customer",
                customer_id="c",
                period_start="2026-04-01T00:00:00Z",
            ),
            1.0,
        )
    # After eviction size stays at the cap.
    assert len(ba._accum) == 3  # type: ignore[attr-defined]


def test_run_sync_now_matches_responses_by_period_start(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    current = _key(customer_id=None)
    prior = ba.AccumulatorKey(
        rule_id="r1",
        scope="pooled",
        customer_id=None,
        period_start="2026-03-01T00:00:00Z",
    )
    ba.add(prior, 1.0)
    ba.add(current, 2.0)
    init(
        "pv_live_aabbccdd_" + "a" * 32,
        endpoint="http://mock",
    )

    class FakeResponse:
        is_success = True

        def json(self) -> dict[str, object]:
            return {
                "entries": [
                    {
                        "rule_id": "r1",
                        "scope": "pooled",
                        "customer_id": None,
                        "period_start": current.period_start,
                        "server_total_usd": 200.0,
                    },
                    {
                        "rule_id": "r1",
                        "scope": "pooled",
                        "customer_id": None,
                        "period_start": prior.period_start,
                        "server_total_usd": 100.0,
                    },
                ],
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def post(self, *_args: object, **_kwargs: object) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(ba.httpx, "Client", FakeClient)

    ba.run_sync_now()

    assert ba.get(prior).total_usd == 100.0
    assert ba.get(current).total_usd == 200.0


def test_run_sync_now_falls_back_without_period_start_when_unambiguous(monkeypatch, capsys) -> None:  # type: ignore[no-untyped-def]
    current = _key(customer_id=None)
    ba.add(current, 5.0)
    init(
        "pv_live_aabbccdd_" + "a" * 32,
        endpoint="http://mock",
    )

    class FakeResponse:
        is_success = True

        def json(self) -> dict[str, object]:
            return {
                "entries": [
                    {
                        "rule_id": "r1",
                        "scope": "pooled",
                        "customer_id": None,
                        "server_total_usd": 42.0,
                    },
                ],
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def post(self, *_args: object, **_kwargs: object) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(ba.httpx, "Client", FakeClient)

    ba.run_sync_now()

    assert ba.get(current).total_usd == 42.0
    assert "missing period_start" in capsys.readouterr().out


def test_run_sync_now_skips_without_period_start_when_ambiguous(monkeypatch, capsys) -> None:  # type: ignore[no-untyped-def]
    current = _key(customer_id=None)
    prior = ba.AccumulatorKey(
        rule_id="r1",
        scope="pooled",
        customer_id=None,
        period_start="2026-03-01T00:00:00Z",
    )
    ba.add(prior, 1.0)
    ba.add(current, 2.0)
    init(
        "pv_live_aabbccdd_" + "a" * 32,
        endpoint="http://mock",
    )

    class FakeResponse:
        is_success = True

        def json(self) -> dict[str, object]:
            return {
                "entries": [
                    {
                        "rule_id": "r1",
                        "scope": "pooled",
                        "customer_id": None,
                        "server_total_usd": 200.0,
                    },
                ],
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def post(self, *_args: object, **_kwargs: object) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(ba.httpx, "Client", FakeClient)

    ba.run_sync_now()

    assert ba.get(prior).total_usd == 1.0
    assert ba.get(current).total_usd == 2.0
    assert "multiple local periods" in capsys.readouterr().out


def test_run_sync_now_batches_above_server_entry_cap(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    keys = [
        ba.AccumulatorKey(
            rule_id="large-audience-rule",
            scope="per_customer",
            customer_id=f"customer-{index}",
            period_start="2026-04-01T00:00:00Z",
        )
        for index in range(501)
    ]
    for key in keys:
        ba.add(key, 1.0)
    init(
        "pv_live_aabbccdd_" + "a" * 32,
        endpoint="http://mock",
    )

    posted_batch_sizes: list[int] = []

    class FakeResponse:
        def __init__(self, entries: list[dict[str, object]]) -> None:
            self._entries = entries
            self.is_success = len(entries) <= 500

        def json(self) -> dict[str, object]:
            return {
                "entries": [
                    {
                        **entry,
                        "server_total_usd": (
                            99.0 if entry["customer_id"] == "customer-500" else 2.0
                        ),
                    }
                    for entry in self._entries
                ],
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def post(self, *_args: object, **kwargs: object) -> FakeResponse:
            payload = kwargs["json"]
            assert isinstance(payload, dict)
            entries = payload["entries"]
            assert isinstance(entries, list)
            posted_batch_sizes.append(len(entries))
            return FakeResponse(entries)

    monkeypatch.setattr(ba.httpx, "Client", FakeClient)

    ba.run_sync_now()

    assert posted_batch_sizes == [500, 1]
    assert ba.get(keys[0]).total_usd == 2.0
    assert ba.get(keys[500]).total_usd == 99.0


def test_run_sync_now_stops_batch_cycle_after_transport_failure(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    keys = [
        ba.AccumulatorKey(
            rule_id="large-audience-rule",
            scope="per_customer",
            customer_id=f"customer-{index}",
            period_start="2026-04-01T00:00:00Z",
        )
        for index in range(501)
    ]
    for key in keys:
        ba.add(key, 1.0)
    init(
        "pv_live_aabbccdd_" + "a" * 32,
        endpoint="http://mock",
    )

    post_calls = 0

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def post(self, *_args: object, **_kwargs: object) -> None:
            nonlocal post_calls
            post_calls += 1
            raise ba.httpx.RequestError(
                "backend unavailable",
                request=ba.httpx.Request("POST", "http://mock/api/v1/budget/sync"),
            )

    monkeypatch.setattr(ba.httpx, "Client", FakeClient)

    ba.run_sync_now()

    assert post_calls == 1
