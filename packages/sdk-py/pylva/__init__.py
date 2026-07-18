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

from ._version import SDK_VERSION
from .adapters.tavily import (
    TAVILY_BASIC_SEARCH_CREDITS,
    TAVILY_SEARCH_COST_SOURCE_SLUG,
    TAVILY_SEARCH_METRIC,
    TAVILY_SEARCH_TOOL_NAME,
    TavilyAsyncSearchClient,
    TavilySyncSearchClient,
    controlled_tavily_search,
    controlled_tavily_search_sync,
)
from .core.budget_accumulator import init_accumulator as _init_accumulator
from .core.client_registry import (
    get_registered_client,
    has_registered_client,
)
from .core.config import (
    ControlConfig,
    ControlMode,
    ControlUnavailablePolicy,
    InvalidApiKeyError,
    InvalidControlConfigError,
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
from .core.control_client import (
    commit_usage,
    commit_usage_sync,
    extend_usage,
    extend_usage_sync,
    ready,
    ready_sync,
    release_usage,
    release_usage_sync,
    reserve_usage,
    reserve_usage_sync,
)
from .core.control_ownership import (
    ControlledAttemptContext,
    ControlledOperationOwnership,
    controlled_operation_ownership,
    current_controlled_attempt,
    current_controlled_operation,
    should_suppress_legacy_telemetry,
)
from .core.control_schema import (
    BudgetCapabilitiesResponse,
    BudgetCommitRequest,
    BudgetCommitResponse,
    BudgetControlError,
    BudgetControlErrorResponse,
    BudgetControlWarning,
    BudgetExtendRequest,
    BudgetExtendResponse,
    BudgetReleaseRequest,
    BudgetReleaseResponse,
    BudgetReservationRequest,
    BudgetReservationResponse,
    BudgetRuleSnapshot,
    BypassedBudgetDecision,
    DeniedBudgetDecision,
    LlmBudgetCommitRequest,
    LlmBudgetReservationRequest,
    ReservedBudgetDecision,
    ToolBudgetCommitRequest,
    ToolBudgetReservationRequest,
    UnavailableBudgetDecision,
)
from .core.controlled_usage import (
    ControlledUsageDecision,
    ControlledUsageIssue,
    ControlledUsageOutcome,
    ControlledUsageResult,
    ControlledUsageSettlement,
    ExactDecimalInput,
    controlled_exact_usage,
    controlled_exact_usage_sync,
    controlled_usage,
    controlled_usage_sync,
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
from .errors.control import (
    PYLVA_CONTROL_UNAVAILABLE_CODE,
    PylvaControlApiError,
    PylvaControlUnavailableError,
    PylvaControlUnavailableReason,
    PylvaControlValidationError,
)
from .errors.strict_provider import (
    PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE,
    PylvaStrictProviderError,
    StrictProviderReason,
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
from .wrappers.anthropic_controlled import ControlledAnthropic, wrap_anthropic
from .wrappers.openai_controlled import ControlledOpenAI, wrap_openai

__version__ = SDK_VERSION

__all__ = [
    "__version__",
    "init",
    "Pylva",
    "get_registered_client",
    "has_registered_client",
    "is_initialized",
    "InvalidApiKeyError",
    "InvalidControlConfigError",
    "ControlConfig",
    "ControlMode",
    "ControlUnavailablePolicy",
    "track",
    "track_context",
    "current_context",
    "TrackContext",
    "enqueue",
    "flush",
    "buffer_size",
    "is_degraded",
    "report_usage",
    "ready",
    "ready_sync",
    "reserve_usage",
    "reserve_usage_sync",
    "commit_usage",
    "commit_usage_sync",
    "release_usage",
    "release_usage_sync",
    "extend_usage",
    "extend_usage_sync",
    "ControlledAttemptContext",
    "ControlledOperationOwnership",
    "controlled_operation_ownership",
    "current_controlled_attempt",
    "current_controlled_operation",
    "should_suppress_legacy_telemetry",
    "ControlledUsageDecision",
    "ControlledUsageIssue",
    "ControlledUsageOutcome",
    "ControlledUsageResult",
    "ControlledUsageSettlement",
    "ExactDecimalInput",
    "controlled_exact_usage",
    "controlled_exact_usage_sync",
    "controlled_usage",
    "controlled_usage_sync",
    "ControlledOpenAI",
    "ControlledAnthropic",
    "wrap_openai",
    "wrap_anthropic",
    "flush_non_llm_discoveries",
    "normalize_non_llm_matcher",
    "NonLlmConfig",
    "NonLlmPolicyOverride",
    "NonLlmPolicyOverrideSource",
    "NonLlmToolContext",
    "NonLlmUsageExtractor",
    "TAVILY_BASIC_SEARCH_CREDITS",
    "TAVILY_SEARCH_COST_SOURCE_SLUG",
    "TAVILY_SEARCH_METRIC",
    "TAVILY_SEARCH_TOOL_NAME",
    "TavilyAsyncSearchClient",
    "TavilySyncSearchClient",
    "controlled_tavily_search",
    "controlled_tavily_search_sync",
    "verify_webhook",
    "sign_webhook",
    "SignWebhookResult",
    "InvalidSignatureFormat",
    "TelemetryEvent",
    "IngestRequest",
    "IngestResponse",
    "IngestError",
    "IngestWarning",
    # Authoritative-control wire models
    "BudgetCapabilitiesResponse",
    "BudgetReservationRequest",
    "BudgetReservationResponse",
    "LlmBudgetReservationRequest",
    "ToolBudgetReservationRequest",
    "ReservedBudgetDecision",
    "DeniedBudgetDecision",
    "BypassedBudgetDecision",
    "UnavailableBudgetDecision",
    "BudgetRuleSnapshot",
    "BudgetControlWarning",
    "BudgetCommitRequest",
    "LlmBudgetCommitRequest",
    "ToolBudgetCommitRequest",
    "BudgetCommitResponse",
    "BudgetReleaseRequest",
    "BudgetReleaseResponse",
    "BudgetExtendRequest",
    "BudgetExtendResponse",
    "BudgetControlError",
    "BudgetControlErrorResponse",
    "PylvaControlUnavailableError",
    "PylvaControlUnavailableReason",
    "PylvaControlApiError",
    "PylvaControlValidationError",
    "PYLVA_CONTROL_UNAVAILABLE_CODE",
    "PylvaStrictProviderError",
    "StrictProviderReason",
    "PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE",
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
    control: ControlConfig | Mapping[str, Any] | None = None,
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
        control=control,
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
