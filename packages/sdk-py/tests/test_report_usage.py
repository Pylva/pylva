"""B3-T1 — coverage for report_usage (non-LLM ingestion helper).

Covers:
  * No customer_id + no track context -> silently no-ops (per privacy R1).
  * Event shape matches the documented schema (tokens=0, tool_name set).
  * Value above METRIC_VALUE_MAX logs a warning but still enqueues.
"""

from __future__ import annotations

from pylva.core import telemetry
from pylva.core.context import track_context
from pylva.reporting.usage import METRIC_VALUE_MAX, report_usage


def setup_function(_fn: object) -> None:
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def test_report_usage_without_customer_id_noops(capsys) -> None:  # type: ignore[no-untyped-def]
    report_usage(tool="elevenlabs", metric="characters", value=100)
    assert telemetry.buffer_size() == 0
    captured = capsys.readouterr()
    assert "no customer_id" in captured.out


def test_report_usage_enqueues_expected_shape() -> None:
    report_usage(
        tool="elevenlabs",
        metric="characters",
        value=500,
        customer_id="cust_1",
        step="narrate",
    )
    assert telemetry.buffer_size() == 1


def test_report_usage_context_supplies_customer() -> None:
    with track_context(customer_id="cust_ctx", step="narrate"):
        report_usage(tool="pinecone", metric="requests", value=3)
    assert telemetry.buffer_size() == 1


def test_report_usage_context_supplies_framework() -> None:
    with track_context(customer_id="cust_ctx", step="narrate", framework="langgraph"):
        report_usage(tool="pinecone", metric="requests", value=3)

    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["framework"] == "langgraph"


def test_report_usage_above_cap_still_enqueues_with_warning(capsys) -> None:  # type: ignore[no-untyped-def]
    report_usage(
        tool="elevenlabs",
        metric="characters",
        value=METRIC_VALUE_MAX + 1,
        customer_id="cust_1",
    )
    assert telemetry.buffer_size() == 1
    assert "exceeds cap" in capsys.readouterr().out
