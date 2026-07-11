"""Shared event-factory for LLM wrappers — mirrors TS wrappers/_event.ts.

Fills the constant fields so each wrapper only specifies what it knows.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ..core.context import current_context
from ..core.identifiers import clean_provider_model_identifier


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_llm_event(
    *,
    provider: Any | None,
    model: Any | None,
    tokens_in: int,
    tokens_out: int,
    latency_ms: int,
    status: str,                 # success | failure | aborted
    token_count_source: str | None = None,  # exact | estimated
    tool_name: str | None = None,
    step_name_fallback: str | None = None,
) -> dict[str, Any]:
    """Build a TelemetryEvent-shaped dict ready for enqueue()."""
    ctx = current_context()
    safe_provider = (
        clean_provider_model_identifier(provider) if provider is not None else "other"
    )
    event: dict[str, Any] = {
        "run_id": ctx.run_id if ctx else str(uuid.uuid4()),
        "parent_run_id": ctx.parent_run_id if ctx else None,
        "trace_id": ctx.trace_id if ctx else str(uuid.uuid4()),
        "span_id": str(uuid.uuid4()),
        "parent_span_id": ctx.span_id if ctx else None,
        "customer_id": ctx.customer_id if ctx else "anonymous",
        "step_name": (ctx.step_name if ctx else None) or step_name_fallback,
        "model": clean_provider_model_identifier(model),
        "provider": safe_provider,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "latency_ms": latency_ms,
        "tool_name": tool_name,
        "status": status,
        "framework": ctx.framework if ctx else "none",
        "instrumentation_tier": "sdk_wrapper",
        "cost_source": "auto",
        "metric": None,
        "metric_value": None,
        "stream_aborted": status == "aborted",
        "abort_savings_usd": 0,
        "timestamp": _utc_now_iso(),
    }
    if token_count_source is not None:
        event["metadata"] = {"token_count_source": token_count_source}
    return event
