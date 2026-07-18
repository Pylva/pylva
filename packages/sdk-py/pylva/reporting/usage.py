"""Non-LLM usage reporting (parity with TS reportUsage)."""

from __future__ import annotations

import uuid

from ..core.context import current_context
from ..core.telemetry import enqueue, utc_now_iso

METRIC_VALUE_MAX = 1_000_000_000


def report_usage(
    *,
    tool: str,
    metric: str,
    value: float,
    customer_id: str | None = None,
    step: str | None = None,
) -> None:
    if value > METRIC_VALUE_MAX:
        print(
            f"[pylva] report_usage value {value} exceeds cap of "
            f"{METRIC_VALUE_MAX}; ingest will reject",
            flush=True,
        )

    ctx = current_context()
    resolved_customer = customer_id or (ctx.customer_id if ctx else None)
    if resolved_customer is None:
        print(
            "[pylva] report_usage: no customer_id (pass customer_id=... "
            "or call inside pylva.track())",
            flush=True,
        )
        return

    enqueue(
        {
            "run_id": ctx.run_id if ctx else str(uuid.uuid4()),
            "parent_run_id": ctx.parent_run_id if ctx else None,
            "trace_id": ctx.trace_id if ctx else str(uuid.uuid4()),
            "span_id": str(uuid.uuid4()),
            "parent_span_id": ctx.span_id if ctx else None,
            "customer_id": resolved_customer,
            "step_name": step or (ctx.step_name if ctx else None),
            "model": None,
            "provider": None,
            "tokens_in": 0,
            "tokens_out": 0,
            "latency_ms": 0,
            "tool_name": tool,
            "status": "success",
            "framework": ctx.framework if ctx else "none",
            "instrumentation_tier": "reported",
            "cost_source": "configured",
            "metric": metric,
            "metric_value": value,
            "stream_aborted": False,
            "abort_savings_usd": 0,
            "timestamp": utc_now_iso(),
        }
    )
