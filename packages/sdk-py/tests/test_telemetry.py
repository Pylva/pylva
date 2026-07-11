"""B3-T1 — coverage for the telemetry buffer.

Covers:
  * enqueue grows the buffer.
  * buffer_size reports accurately.
  * degraded mode surfaces via is_degraded.
  * 10K buffer overflow drops the oldest event (FIFO).
  * 401 response enters degraded mode and clears the buffer.
  * 5xx persists across retries -> batch is reinserted at the head of the buffer.
  * span_id LRU dedup: a second flush with a span already sent does not POST.
  * _reset_telemetry_for_tests clears degraded mode + sent cache.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import httpx
import pytest

import pylva
from pylva.core import budget_accumulator as ba
from pylva.core import telemetry

VALID_KEY = "pv_live_12345678_" + "a" * 32


def setup_function(_fn: object) -> None:
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    ba._reset_accumulator_for_tests()  # type: ignore[attr-defined]
    from pylva.core.config import _reset_config_for_tests

    _reset_config_for_tests()
    # Reset config each time so flush() sees a fresh endpoint + credentials.
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=1000,
        flush_interval=60.0,
    )


def _ev(i: int = 0) -> dict[str, object]:
    return {
        "span_id": f"span-{i}",
        "trace_id": f"trace-{i}",
        "run_id": f"run-{i}",
        "parent_span_id": None,
        "customer_id": "c",
        "step_name": None,
        "model": None,
        "provider": None,
        "tokens_in": 0,
        "tokens_out": 0,
        "latency_ms": 0,
        "tool_name": None,
        "status": "success",
        "framework": "none",
        "instrumentation_tier": "sdk",
        "cost_source": "llm",
        "metric": None,
        "metric_value": 0,
        "stream_aborted": False,
        "abort_savings_usd": 0,
        "timestamp": telemetry.utc_now_iso(),
        "parent_run_id": None,
    }


# ---------------------------------------------------------------------------
# Basic sanity
# ---------------------------------------------------------------------------


def test_enqueue_and_size() -> None:
    telemetry.enqueue(_ev(0))
    telemetry.enqueue(_ev(1))
    assert telemetry.buffer_size() == 2


def test_default_not_degraded() -> None:
    assert telemetry.is_degraded() is False


def test_reset_helper_clears_state() -> None:
    telemetry.enqueue(_ev(0))
    telemetry._state.degraded = True  # type: ignore[attr-defined]
    telemetry._state.sent_span_ids["span-x"] = None  # type: ignore[attr-defined]

    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]

    assert telemetry.buffer_size() == 0
    assert telemetry.is_degraded() is False
    assert "span-x" not in telemetry._state.sent_span_ids  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Buffer overflow (D1)
# ---------------------------------------------------------------------------


def test_buffer_overflow_drops_oldest() -> None:
    # Enqueue BUFFER_CAP + 3 distinct events. First three should be dropped.
    overflow = 3
    for i in range(telemetry.BUFFER_CAP + overflow):
        telemetry.enqueue(_ev(i))

    assert telemetry.buffer_size() == telemetry.BUFFER_CAP
    span_ids = [e["span_id"] for e in telemetry._state.buffer]  # type: ignore[attr-defined]
    # Oldest three (span-0, span-1, span-2) should have been evicted.
    for i in range(overflow):
        assert f"span-{i}" not in span_ids
    # Newest event must still be present.
    assert f"span-{telemetry.BUFFER_CAP + overflow - 1}" in span_ids


# ---------------------------------------------------------------------------
# HTTP exporter — fakes httpx.AsyncClient.post
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int, body: dict[str, Any] | str = "") -> None:
        self.status_code = status_code
        self._body = body
        self.is_success = 200 <= status_code < 300

    def json(self) -> dict[str, Any]:
        return self._body if isinstance(self._body, dict) else {}


class _FakeClient:
    """Counts POSTs; each call pops the next response from `queue`.

    If `queue` is exhausted the last response is replayed, which models an
    endpoint that keeps returning the same error across retries.
    """

    def __init__(self, queue: list[_FakeResponse | Exception]) -> None:
        self.queue = queue
        self.posts = 0
        self.bodies: list[str] = []

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def post(self, *_args: Any, **kwargs: Any) -> _FakeResponse:
        self.posts += 1
        self.bodies.append(kwargs.get("content", ""))
        if not self.queue:
            raise RuntimeError("fake client queue exhausted")
        item = self.queue[0] if len(self.queue) == 1 else self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def patched_httpx() -> Iterator[dict[str, _FakeClient]]:
    holder: dict[str, _FakeClient] = {}

    def factory(*_a: Any, **_kw: Any) -> _FakeClient:
        return holder["client"]

    # Telemetry sleeps between retries (1/2/4s). Short-circuit them.
    async def noop_sleep(_seconds: float) -> None:
        return None

    with (
        patch.object(httpx, "AsyncClient", side_effect=factory),
        patch("pylva.core.telemetry.asyncio.sleep", side_effect=noop_sleep),
    ):
        yield holder


async def test_flush_401_enters_degraded(
    patched_httpx: dict[str, _FakeClient],
    capsys: pytest.CaptureFixture[str],
) -> None:
    patched_httpx["client"] = _FakeClient([_FakeResponse(401)])
    telemetry.enqueue(_ev(0))
    await telemetry.flush()
    assert telemetry.is_degraded() is True
    assert telemetry.buffer_size() == 0
    assert "https://pylva.com/settings/keys" in capsys.readouterr().out


async def test_flush_5xx_retries_and_reinserts(patched_httpx: dict[str, _FakeClient]) -> None:
    # Four attempts total: initial + 3 retries. All 500 -> batch goes back into
    # the buffer.
    patched_httpx["client"] = _FakeClient([_FakeResponse(500)])
    telemetry.enqueue(_ev(99))
    await telemetry.flush()

    client = patched_httpx["client"]
    assert client.posts == 1 + len(telemetry.RETRY_DELAYS_SEC)
    assert telemetry.is_degraded() is False
    # Event survived the failed flush and remains at the head for the next one.
    assert telemetry.buffer_size() == 1
    assert telemetry._state.buffer[0]["span_id"] == "span-99"  # type: ignore[attr-defined]


async def test_span_id_lru_dedup(patched_httpx: dict[str, _FakeClient]) -> None:
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )

    telemetry.enqueue(_ev(1))
    await telemetry.flush()
    assert patched_httpx["client"].posts == 1

    # Re-enqueue the same span_id — the next flush must not POST it.
    telemetry.enqueue(_ev(1))
    await telemetry.flush()
    # Second flush sees a batch of 1 but filters it by sent_span_ids, so no
    # network call is made.
    assert patched_httpx["client"].posts == 1
    # Buffer is drained by flush() pulling up to batch_size then discarding
    # the already-sent span. Either outcome is acceptable; the key guarantee
    # is the POST count.


async def test_successful_flush_drains_buffer(patched_httpx: dict[str, _FakeClient]) -> None:
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )
    for i in range(3):
        telemetry.enqueue(_ev(i))
    await telemetry.flush()
    assert telemetry.buffer_size() == 0
    assert patched_httpx["client"].posts == 1


async def test_flush_serializes_flexible_provider_model_exactly(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )
    event = _ev(42)
    event["provider"] = "ollama"
    event["model"] = "ollama/llama3.1-8b"

    telemetry.enqueue(event)
    await telemetry.flush()

    body = json.loads(patched_httpx["client"].bodies[0])
    sent = body["events"][0]
    assert sent["provider"] == "ollama"
    assert sent["model"] == "ollama/llama3.1-8b"


async def test_explicit_flush_drains_multiple_batches(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )
    for i in range(5):
        telemetry.enqueue(_ev(i))

    await telemetry.flush()

    assert telemetry.buffer_size() == 0
    assert patched_httpx["client"].posts == 3


# ---------------------------------------------------------------------------
# Auto-flush scheduling (TS parity) — enqueue must export without the host
# ever calling flush()
# ---------------------------------------------------------------------------


async def test_enqueue_auto_flushes_on_running_loop(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    """Regression: enqueue() previously never scheduled a flush — telemetry
    sat in the buffer forever unless the host manually awaited flush()."""
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )
    telemetry.enqueue(_ev(0))
    task = telemetry._state.flush_task  # type: ignore[attr-defined]
    assert task is not None
    await task
    assert telemetry.buffer_size() == 0
    assert patched_httpx["client"].posts == 1


async def test_enqueue_full_batch_wakes_sleeping_flush_task() -> None:
    """Regression: a pending interval sleep must not delay a now-full batch."""
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )
    holder = {
        "client": _FakeClient(
            [_FakeResponse(200, {"errors": [], "warnings": []})],
        ),
    }
    sleep_started = asyncio.Event()
    release_sleep = asyncio.Event()

    def factory(*_a: Any, **_kw: Any) -> _FakeClient:
        return holder["client"]

    async def blocked_sleep(_seconds: float) -> None:
        sleep_started.set()
        await release_sleep.wait()

    with (
        patch.object(httpx, "AsyncClient", side_effect=factory),
        patch("pylva.core.telemetry.asyncio.sleep", side_effect=blocked_sleep),
    ):
        telemetry.enqueue(_ev(1))
        sleeping_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert sleeping_task is not None
        await sleep_started.wait()

        telemetry.enqueue(_ev(2))
        replacement_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert replacement_task is not None
        assert replacement_task is not sleeping_task
        await replacement_task
        try:
            await sleeping_task
        except asyncio.CancelledError:
            pass

        assert telemetry.buffer_size() == 0
        assert holder["client"].posts == 1
        assert sleeping_task.cancelled() is True


async def test_sleeping_flush_task_exits_if_buffer_drained_externally() -> None:
    """Regression: after interval sleep, avoid a no-op flush on an empty buffer."""
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )
    holder = {
        "client": _FakeClient(
            [_FakeResponse(200, {"errors": [], "warnings": []})],
        ),
    }
    sleep_started = asyncio.Event()
    release_sleep = asyncio.Event()
    flush_calls = 0
    real_flush = telemetry.flush

    def factory(*_a: Any, **_kw: Any) -> _FakeClient:
        return holder["client"]

    async def blocked_sleep(_seconds: float) -> None:
        sleep_started.set()
        await release_sleep.wait()

    async def counted_flush() -> None:
        nonlocal flush_calls
        flush_calls += 1
        await real_flush()

    with (
        patch.object(httpx, "AsyncClient", side_effect=factory),
        patch("pylva.core.telemetry.asyncio.sleep", side_effect=blocked_sleep),
        patch("pylva.core.telemetry.flush", side_effect=counted_flush),
    ):
        telemetry.enqueue(_ev(1))
        sleeping_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert sleeping_task is not None
        await sleep_started.wait()

        await telemetry.flush()
        assert telemetry.buffer_size() == 0
        assert holder["client"].posts == 1
        assert flush_calls == 1

        release_sleep.set()
        await sleeping_task
        assert flush_calls == 1
        assert telemetry.buffer_size() == 0


async def test_enqueue_full_batch_during_post_does_not_cancel_in_flight_flush() -> None:
    """Regression: never cancel a flush task after it has dequeued its batch."""
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )

    class BlockingClient:
        def __init__(self) -> None:
            self.bodies: list[str] = []
            self.posts = 0
            self.post_started = asyncio.Event()
            self.release_post = asyncio.Event()

        async def __aenter__(self) -> BlockingClient:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: Any, **kwargs: Any) -> _FakeResponse:
            self.posts += 1
            self.bodies.append(kwargs.get("content", ""))
            self.post_started.set()
            await self.release_post.wait()
            return _FakeResponse(200, {"errors": [], "warnings": []})

    client = BlockingClient()

    def factory(*_a: Any, **_kw: Any) -> BlockingClient:
        return client

    with patch.object(httpx, "AsyncClient", side_effect=factory):
        telemetry.enqueue(_ev(1))
        telemetry.enqueue(_ev(2))
        flush_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert flush_task is not None
        await client.post_started.wait()
        assert telemetry.buffer_size() == 0

        telemetry.enqueue(_ev(3))
        telemetry.enqueue(_ev(4))
        assert telemetry._state.flush_task is flush_task  # type: ignore[attr-defined]
        assert flush_task.cancelled() is False

        client.release_post.set()
        await flush_task

    assert telemetry.buffer_size() == 0
    assert client.posts == 2
    assert '"span_id": "span-1"' in client.bodies[0]
    assert '"span_id": "span-2"' in client.bodies[0]
    assert '"span_id": "span-3"' in client.bodies[1]
    assert '"span_id": "span-4"' in client.bodies[1]


async def test_lru_saturation_does_not_hide_flush_loop_progress() -> None:
    """Regression: capped sent_span_ids length must not mask a successful send."""
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )
    for i in range(telemetry.LRU_CAP):
        telemetry._state.sent_span_ids[f"old-{i}"] = None  # type: ignore[attr-defined]
    telemetry._state.sent_count = telemetry.LRU_CAP  # type: ignore[attr-defined]

    class RefillingClient:
        def __init__(self) -> None:
            self.bodies: list[str] = []
            self.posts = 0

        async def __aenter__(self) -> RefillingClient:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: Any, **kwargs: Any) -> _FakeResponse:
            self.posts += 1
            self.bodies.append(kwargs.get("content", ""))
            if self.posts == 1:
                telemetry.enqueue(_ev(3))
                telemetry.enqueue(_ev(4))
            return _FakeResponse(200, {"errors": [], "warnings": []})

    client = RefillingClient()

    def factory(*_a: Any, **_kw: Any) -> RefillingClient:
        return client

    with patch.object(httpx, "AsyncClient", side_effect=factory):
        telemetry.enqueue(_ev(1))
        telemetry.enqueue(_ev(2))
        flush_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert flush_task is not None
        await flush_task

    assert telemetry.buffer_size() == 0
    assert client.posts == 2
    assert len(telemetry._state.sent_span_ids) == telemetry.LRU_CAP  # type: ignore[attr-defined]
    assert telemetry._state.sent_count == telemetry.LRU_CAP + 4  # type: ignore[attr-defined]
    assert '"span_id": "span-1"' in client.bodies[0]
    assert '"span_id": "span-2"' in client.bodies[0]
    assert '"span_id": "span-3"' in client.bodies[1]
    assert '"span_id": "span-4"' in client.bodies[1]


async def test_enqueue_full_batch_during_retry_backoff_does_not_cancel_flush() -> None:
    """Regression: retry sleep is not the interval sleep that may be replaced."""
    pylva.init(
        api_key=VALID_KEY,
        endpoint="https://example.test",
        batch_size=2,
        flush_interval=60.0,
    )

    class RetryClient:
        def __init__(self) -> None:
            self.bodies: list[str] = []
            self.posts = 0

        async def __aenter__(self) -> RetryClient:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: Any, **kwargs: Any) -> _FakeResponse:
            self.posts += 1
            self.bodies.append(kwargs.get("content", ""))
            if self.posts == 1:
                return _FakeResponse(500)
            return _FakeResponse(200, {"errors": [], "warnings": []})

    client = RetryClient()
    retry_sleep_started = asyncio.Event()
    release_retry_sleep = asyncio.Event()

    def factory(*_a: Any, **_kw: Any) -> RetryClient:
        return client

    async def blocked_sleep(_seconds: float) -> None:
        retry_sleep_started.set()
        await release_retry_sleep.wait()

    with (
        patch.object(httpx, "AsyncClient", side_effect=factory),
        patch("pylva.core.telemetry.asyncio.sleep", side_effect=blocked_sleep),
    ):
        telemetry.enqueue(_ev(1))
        telemetry.enqueue(_ev(2))
        flush_task = telemetry._state.flush_task  # type: ignore[attr-defined]
        assert flush_task is not None
        await retry_sleep_started.wait()

        telemetry.enqueue(_ev(3))
        telemetry.enqueue(_ev(4))
        assert telemetry._state.flush_task is flush_task  # type: ignore[attr-defined]
        assert flush_task.cancelled() is False

        release_retry_sleep.set()
        await flush_task

    assert telemetry.buffer_size() == 0
    assert client.posts == 3
    assert '"span_id": "span-1"' in client.bodies[0]
    assert '"span_id": "span-2"' in client.bodies[0]
    assert '"span_id": "span-1"' in client.bodies[1]
    assert '"span_id": "span-2"' in client.bodies[1]
    assert '"span_id": "span-3"' in client.bodies[2]
    assert '"span_id": "span-4"' in client.bodies[2]


def test_enqueue_without_loop_buffers_and_atexit_drains(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    patched_httpx["client"] = _FakeClient(
        [_FakeResponse(200, {"errors": [], "warnings": []})],
    )
    telemetry.enqueue(_ev(0))
    # Sync host: no running loop, so no background task — atexit is the backstop.
    assert telemetry._state.flush_task is None  # type: ignore[attr-defined]
    assert telemetry.buffer_size() == 1

    telemetry._drain_at_exit()  # type: ignore[attr-defined]
    assert telemetry.buffer_size() == 0
    assert patched_httpx["client"].posts == 1


def test_atexit_drain_gives_up_without_progress(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    patched_httpx["client"] = _FakeClient([_FakeResponse(500)])
    telemetry.enqueue(_ev(0))
    telemetry._drain_at_exit()  # type: ignore[attr-defined]
    # Batch re-queued by flush(); drain must not spin on a dead backend.
    assert telemetry.buffer_size() == 1
    assert patched_httpx["client"].posts == 1 + len(telemetry.RETRY_DELAYS_SEC)


async def test_flush_applies_backend_budget_exceeded_flag(
    patched_httpx: dict[str, _FakeClient],
) -> None:
    period_start = "2026-04-01T00:00:00Z"
    patched_httpx["client"] = _FakeClient(
        [
            _FakeResponse(
                200,
                {
                    "accepted": 1,
                    "rejected": 0,
                    "budget_exceeded": [
                        {
                            "rule_id": "rule-1",
                            "customer_id": "cust_test",
                            "limit_usd": 10,
                            "accumulated_usd": 12,
                            "period": "day",
                            "period_start": period_start,
                        }
                    ],
                },
            )
        ],
    )
    telemetry.enqueue(_ev(7))

    await telemetry.flush()

    result = ba.check(
        rule_id="rule-1",
        scope="per_customer",
        customer_id="cust_test",
        period_start=period_start,
        estimated_usd=0,
        limit_usd=10,
    )
    assert result.over_limit is True
    assert result.source == "backend_ingest_flag"
