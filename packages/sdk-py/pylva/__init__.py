"""Pylva SDK — cost infrastructure for AI agent businesses.

Importing ``pylva`` auto-patches any already-imported ``openai`` and
``anthropic`` packages. Call :func:`init` with your API key to enable telemetry;
every subsequent LLM call emits a server-priced event.

Privacy: this SDK NEVER sends prompt, completion, tool-argument, or message
body text. Telemetry is tokens + model + latency + status + step_name +
customer_id only. See packages/sdk-py/README.md.

Stability contract (D26): wire format (v1.6, POST /api/v1/events) is LOCKED.
Python SDK public API is SemVer-stable from 1.0.0.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from .core.budget_accumulator import init_accumulator as _init_accumulator
from .core.client_registry import (
    get_registered_client,
    has_registered_client,
)
from .core.config import (
    InvalidApiKeyError,
    is_initialized,
)
from .core.config import (
    init as _init_config,
)
from .core.context import (
    TrackContext,
    current_context,
    track,
    track_context,
)
from .core.non_llm_policy import (
    NonLlmConfig,
    NonLlmPolicyOverride,
    NonLlmPolicyOverrideSource,
    NonLlmToolContext,
    NonLlmUsageExtractor,
    configure_non_llm_policy,
    flush_non_llm_discoveries,
    normalize_non_llm_matcher,
)
from .core.pricing_cache import ensure_pricing_cache_background as _ensure_pricing_cache_background
from .core.schema import (
    IngestError,
    IngestRequest,
    IngestResponse,
    IngestWarning,
    TelemetryEvent,
)
from .core.telemetry import (
    buffer_size,
    enqueue,
    flush,
    is_degraded,
)
from .errors.budget_exceeded import (
    PYLVA_BUDGET_EXCEEDED_CODE,
    BudgetExceededSource,
    PylvaBudgetExceeded,
)
from .pylva import Pylva
from .reporting.usage import report_usage
from .webhooks.verify import (
    InvalidSignatureFormat,
    SignWebhookResult,
    sign_webhook,
    verify_webhook,
)
from .wrappers._init_validation import refresh_and_validate_once
from .wrappers._patch import apply_all_patches

__version__ = "1.1.0"

__all__ = [
    "__version__",
    "init",
    "Pylva",
    "get_registered_client",
    "has_registered_client",
    "is_initialized",
    "InvalidApiKeyError",
    "track",
    "track_context",
    "current_context",
    "TrackContext",
    "enqueue",
    "flush",
    "buffer_size",
    "is_degraded",
    "report_usage",
    "flush_non_llm_discoveries",
    "normalize_non_llm_matcher",
    "NonLlmConfig",
    "NonLlmPolicyOverride",
    "NonLlmPolicyOverrideSource",
    "NonLlmToolContext",
    "NonLlmUsageExtractor",
    "verify_webhook",
    "sign_webhook",
    "SignWebhookResult",
    "InvalidSignatureFormat",
    "TelemetryEvent",
    "IngestRequest",
    "IngestResponse",
    "IngestError",
    "IngestWarning",
    # B2a budget primitives
    "PylvaBudgetExceeded",
    "BudgetExceededSource",
    "PYLVA_BUDGET_EXCEEDED_CODE",
]


def init(
    api_key: str,
    *,
    endpoint: str | None = None,
    batch_size: int = 100,
    flush_interval: float = 5.0,
    local_mode: bool = False,
    non_llm: NonLlmConfig | Mapping[str, Any] | None = None,
) -> None:
    """Configure the SDK and (re-)apply provider patches.

    Raises :class:`InvalidApiKeyError` on malformed key. Safe to call multiple
    times; the second call re-applies patches defensively for HMR / Jupyter
    / ``importlib.reload`` scenarios.
    """
    _init_config(
        api_key,
        endpoint=endpoint,
        batch_size=batch_size,
        flush_interval=flush_interval,
        local_mode=local_mode,
        non_llm=non_llm,
    )
    configure_non_llm_policy(non_llm)
    try:
        apply_all_patches()
    except Exception:
        # R1 — never surface patch errors from init()
        pass
    # Prime the budget accumulator — fresh-boot passthrough is safe.
    try:
        _init_accumulator()
    except Exception:
        pass
    # Warm the pricing cache so local budget accounting (record_llm_spend)
    # can price calls from the first flush onward.
    try:
        _ensure_pricing_cache_background()
    except Exception:
        pass
    # D52 — schedule a fire-and-forget failover-wrapper validation. If a
    # loop is running (FastAPI, async scripts), it runs after the first
    # rules-cache fetch resolves. If no loop, the first wrapper call's
    # `_schedule_rules_refresh` triggers it instead — `refresh_and_validate_once`
    # gates on a module flag so validation only runs once per process.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop — wrapper hot path will pick this up
    loop.create_task(refresh_and_validate_once())


# Auto-patch on import (D18). Silent if openai / anthropic are absent.
apply_all_patches()
