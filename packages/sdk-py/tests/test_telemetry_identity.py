"""Cross-tenant telemetry isolation at SDK reinitialization boundaries."""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import httpx
import pytest

from pylva.core import telemetry
from pylva.core.config import init as init_config

KEY_A = "pv_live_12345678_" + "a" * 32
KEY_B = "pv_live_12345678_" + "b" * 32


def _event(span_id: str, customer_id: str) -> dict[str, Any]:
    return {
        "span_id": span_id,
        "trace_id": f"trace-{span_id}",
        "run_id": f"run-{span_id}",
        "parent_span_id": None,
        "customer_id": customer_id,
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


def test_identity_change_discards_buffer_with_content_free_count_diagnostic(
    caplog: pytest.LogCaptureFixture,
) -> None:
    init_config(KEY_A, endpoint="https://a.test")
    telemetry.enqueue(_event("private-span", "private-customer"))
    assert telemetry.buffer_size() == 1

    with caplog.at_level("WARNING", logger="pylva"):
        init_config(KEY_B, endpoint="https://b.test")

    assert telemetry.buffer_size() == 0
    message = caplog.messages[-1]
    assert "discarded 1 buffered telemetry event(s)" in message
    assert "private-span" not in message
    assert "private-customer" not in message


def test_same_identity_reinitialization_preserves_buffer() -> None:
    init_config(KEY_A, endpoint="https://a.test")
    telemetry.enqueue(_event("span-a", "customer-a"))
    init_config(KEY_A, endpoint="https://a.test", batch_size=5)
    assert telemetry.buffer_size() == 1
    assert telemetry._state.buffer[0]["span_id"] == "span-a"


@pytest.mark.asyncio
async def test_inflight_old_flush_cannot_requeue_into_new_builder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint="https://a.test")
    entered = asyncio.Event()
    release = asyncio.Event()
    sent_keys: list[str] = []

    class Response:
        status_code = 500
        is_success = False

        def json(self) -> dict[str, Any]:
            return {}

    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, *_args: Any, **kwargs: Any) -> Response:
            sent_keys.append(kwargs["headers"]["X-Pylva-Key"])
            entered.set()
            await release.wait()
            return Response()

    monkeypatch.setattr(telemetry, "_schedule_flush", lambda _state=None: None)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: Client())
    telemetry.enqueue(_event("span-a", "customer-a"))
    old_flush = asyncio.create_task(telemetry.flush())
    await entered.wait()

    init_config(KEY_B, endpoint="https://b.test")
    telemetry.enqueue(_event("span-b", "customer-b"))
    release.set()
    await old_flush

    assert sent_keys == [KEY_A]
    assert [event["span_id"] for event in telemetry._state.buffer] == ["span-b"]


def test_enqueue_started_under_old_identity_cannot_enter_new_buffer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint="https://a.test")
    entered = threading.Event()
    release = threading.Event()

    def blocked_record(**_kwargs: Any) -> None:
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(telemetry, "record_llm_spend", blocked_record)
    monkeypatch.setattr(telemetry, "_schedule_flush", lambda _state=None: None)
    thread = threading.Thread(
        target=telemetry.enqueue,
        args=(_event("span-a", "customer-a"),),
    )
    thread.start()
    assert entered.wait(2)
    init_config(KEY_B, endpoint="https://b.test")
    release.set()
    thread.join(timeout=2)
    assert not thread.is_alive()

    telemetry.enqueue(_event("span-b", "customer-b"))
    assert [event["span_id"] for event in telemetry._state.buffer] == ["span-b"]
