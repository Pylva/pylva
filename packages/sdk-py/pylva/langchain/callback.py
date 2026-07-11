"""LangChain/LangGraph callback handler for Pylva cost telemetry.

The handler is observer-only: every callback body is isolated so Pylva cannot
break the host graph. It records token counts and LangGraph run metadata, but
never stores prompts, completions, tool arguments, or tool outputs.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, cast

try:  # Optional dependency: provided by the ``pylva-sdk[langchain]`` extra.
    from langchain_core.callbacks import (  # type: ignore[import-not-found, unused-ignore]
        AsyncCallbackHandler,
        BaseCallbackHandler,
    )
except Exception:  # pragma: no cover - exercised by SDK tests without LangChain installed.

    class BaseCallbackHandler:  # type: ignore[no-redef]
        """Fallback base so unit tests can exercise the observer logic."""

    class AsyncCallbackHandler:  # type: ignore[no-redef]
        """Fallback base so unit tests can exercise the observer logic."""


from ..core.budget_accumulator import init_accumulator as _init_accumulator
from ..core.config import init as _init_config
from ..core.context import current_context
from ..core.identifiers import clean_provider_model_identifier
from ..core.non_llm_policy import (
    NonLlmConfig,
    NonLlmMode,
    NonLlmToolContext,
    NonLlmUsageExtractor,
    configure_non_llm_policy,
    decide_non_llm_tool,
    metric_value_for_source,
    non_llm_mode,
    record_non_llm_discovery,
    schedule_non_llm_policy_refresh,
    warn_legacy_tool_tracking_once,
)
from ..core.telemetry import enqueue, flush, utc_now_iso

_CUSTOMER_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,255}$")
_STEP_RE = re.compile(r"[^a-zA-Z0-9 _\-.:/]")
_METADATA_STEP_LABEL_RE = re.compile(r"^[A-Za-z0-9_.:/-]{1,100}$")


@dataclass
class _RunState:
    run_id: str
    parent_run_id: str | None
    trace_id: str
    customer_id: str | None
    step_name: str | None
    provider: str | None
    model: str | None
    run_name: str | None
    started_at: float
    metadata: dict[str, Any]
    kind: str
    tool_input: Any | None = None


@dataclass(frozen=True)
class _Usage:
    tokens_in: int
    tokens_out: int
    model: str | None
    provider: str | None
    found: bool


class _PylvaCallbackMixin:
    """Shared implementation for sync and async callback handlers."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        endpoint: str | None = None,
        customer_id: str | None = None,
        track_tool_calls: bool = False,
        non_llm: NonLlmConfig | dict[str, Any] | None = None,
        flush_on_chain_end: bool = False,
        batch_size: int = 100,
        flush_interval: float = 5.0,
        local_mode: bool = False,
    ) -> None:
        self.customer_id = _clean_customer_id(customer_id)
        self.non_llm_config = non_llm
        self.non_llm_mode: NonLlmMode = non_llm_mode(non_llm, track_tool_calls)
        self.track_tool_calls = self.non_llm_mode != "off"
        self.flush_on_chain_end = flush_on_chain_end
        self._runs: dict[str, _RunState] = {}
        self._completed_tool_runs: set[str] = set()
        configure_non_llm_policy(non_llm)
        if self.non_llm_mode == "legacy_all":
            warn_legacy_tool_tracking_once()

        if api_key is not None:
            try:
                _init_config(
                    api_key,
                    endpoint=endpoint,
                    batch_size=batch_size,
                    flush_interval=flush_interval,
                    local_mode=local_mode,
                    non_llm=non_llm,
                )
                _init_accumulator()
                if self.non_llm_mode == "policy":
                    schedule_non_llm_policy_refresh()
            except Exception:
                raise

    def _handle_start(
        self,
        *,
        run_id: Any,
        parent_run_id: Any,
        serialized: dict[str, Any] | None,
        metadata: dict[str, Any] | None,
        kind: str,
        name: str | None = None,
        kwargs: dict[str, Any] | None = None,
        tool_input: Any | None = None,
    ) -> None:
        try:
            run_id_str = _id(run_id)
            if run_id_str is None:
                return
            parent_run_id_str = _id(parent_run_id)
            safe_metadata = _safe_run_metadata(metadata)
            parent = self._runs.get(parent_run_id_str) if parent_run_id_str else None
            ctx = current_context()
            run_name = _resolve_run_name(serialized, name)
            customer_id = self._resolve_customer_id(safe_metadata)
            step_name = _resolve_step_name(safe_metadata, run_name)
            provider = _resolve_provider(serialized, safe_metadata, kwargs or {})
            model = _resolve_model(serialized, safe_metadata, kwargs or {})

            self._runs[run_id_str] = _RunState(
                run_id=run_id_str,
                parent_run_id=parent_run_id_str,
                trace_id=(
                    parent.trace_id
                    if parent
                    else (ctx.trace_id if ctx else (parent_run_id_str or run_id_str))
                ),
                customer_id=customer_id,
                step_name=step_name,
                provider=provider,
                model=model,
                run_name=run_name,
                started_at=time.time(),
                metadata=safe_metadata,
                kind=kind,
                tool_input=tool_input if kind == "tool" else None,
            )
        except Exception:
            pass

    def _handle_llm_end(self, *, response: Any, run_id: Any, parent_run_id: Any) -> None:
        try:
            run_id_str = _id(run_id)
            if run_id_str is None:
                return
            parent_run_id_str = _id(parent_run_id)
            state = self._runs.pop(run_id_str, None) or self._fallback_state(
                run_id=run_id_str,
                parent_run_id=parent_run_id_str,
                kind="llm",
            )
            usage = _extract_usage(response)
            metadata = dict(state.metadata)
            if usage.found:
                metadata["token_count_source"] = "exact"
            else:
                metadata["usage_missing"] = True

            enqueue(
                self._event_from_state(
                    state,
                    tokens_in=usage.tokens_in,
                    tokens_out=usage.tokens_out,
                    status="success",
                    model=usage.model or state.model,
                    provider=usage.provider or state.provider,
                    metadata=metadata,
                )
            )
        except Exception:
            pass

    def _handle_llm_error(self, *, error: BaseException, run_id: Any, parent_run_id: Any) -> None:
        try:
            run_id_str = _id(run_id)
            if run_id_str is None:
                return
            parent_run_id_str = _id(parent_run_id)
            state = self._runs.pop(run_id_str, None) or self._fallback_state(
                run_id=run_id_str,
                parent_run_id=parent_run_id_str,
                kind="llm",
            )
            metadata = dict(state.metadata)
            metadata["error_type"] = type(error).__name__
            enqueue(
                self._event_from_state(
                    state,
                    tokens_in=0,
                    tokens_out=0,
                    status="failure",
                    model=state.model,
                    provider=state.provider,
                    metadata=metadata,
                )
            )
        except Exception:
            pass

    def _handle_tool_end(
        self,
        *,
        run_id: Any,
        parent_run_id: Any,
        name: str | None = None,
        output: Any | None = None,
    ) -> None:
        if not self.track_tool_calls:
            return
        try:
            run_id_str = _id(run_id)
            if run_id_str is None:
                return
            if run_id_str in self._completed_tool_runs:
                return
            self._completed_tool_runs.add(run_id_str)
            parent_run_id_str = _id(parent_run_id)
            state = self._runs.pop(run_id_str, None) or self._fallback_state(
                run_id=run_id_str,
                parent_run_id=parent_run_id_str,
                kind="tool",
            )
            tool_name = _clean_step(name or state.run_name or state.step_name or "tool")
            if self.non_llm_mode == "policy":
                self._handle_policy_tool(
                    state=state,
                    tool_name=tool_name or "tool",
                    status="success",
                    output=output,
                )
                return
            event = self._event_from_state(
                state,
                tokens_in=0,
                tokens_out=0,
                status="success",
                model=None,
                provider=None,
                metadata=state.metadata,
            )
            event.update(
                {
                    "provider": None,
                    "tool_name": tool_name,
                    "instrumentation_tier": "reported",
                    "cost_source": "configured",
                    "metric": "calls",
                    "metric_value": 1,
                }
            )
            enqueue(event)
        except Exception:
            pass

    def _handle_tool_error(
        self, *, error: BaseException, run_id: Any, parent_run_id: Any, name: str | None = None
    ) -> None:
        if not self.track_tool_calls:
            return
        try:
            run_id_str = _id(run_id)
            if run_id_str is None:
                return
            if run_id_str in self._completed_tool_runs:
                return
            self._completed_tool_runs.add(run_id_str)
            parent_run_id_str = _id(parent_run_id)
            state = self._runs.pop(run_id_str, None) or self._fallback_state(
                run_id=run_id_str,
                parent_run_id=parent_run_id_str,
                kind="tool",
            )
            tool_name = _clean_step(name or state.run_name or state.step_name or "tool")
            metadata = dict(state.metadata)
            metadata["error_type"] = type(error).__name__
            if self.non_llm_mode == "policy":
                self._handle_policy_tool(
                    state=state,
                    tool_name=tool_name or "tool",
                    status="failure",
                    metadata=metadata,
                )
                return
            event = self._event_from_state(
                state,
                tokens_in=0,
                tokens_out=0,
                status="failure",
                model=None,
                provider=None,
                metadata=metadata,
            )
            event.update(
                {
                    "provider": None,
                    "tool_name": tool_name,
                    "instrumentation_tier": "reported",
                    "cost_source": "configured",
                    "metric": "calls",
                    "metric_value": 1,
                }
            )
            enqueue(event)
        except Exception:
            pass

    def _handle_chain_end(self, *, run_id: Any) -> None:
        try:
            run_id_str = _id(run_id)
            if run_id_str is not None:
                self._runs.pop(run_id_str, None)
        except Exception:
            pass

    def _fallback_state(self, *, run_id: str, parent_run_id: str | None, kind: str) -> _RunState:
        ctx = current_context()
        return _RunState(
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=ctx.trace_id if ctx else (parent_run_id or run_id),
            customer_id=self.customer_id or (ctx.customer_id if ctx else "anonymous"),
            step_name=ctx.step_name if ctx else None,
            provider=None,
            model=None,
            run_name=None,
            started_at=time.time(),
            metadata={},
            kind=kind,
        )

    def _handle_policy_tool(
        self,
        *,
        state: _RunState,
        tool_name: str,
        status: str,
        output: Any | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        schedule_non_llm_policy_refresh()
        resolved_metadata = metadata or state.metadata
        candidates = [
            tool_name,
            state.run_name,
            state.step_name,
            resolved_metadata.get("pylva_tool"),
            resolved_metadata.get("tool_name"),
        ]
        decision = decide_non_llm_tool(
            [candidate for candidate in candidates if isinstance(candidate, str)]
        )
        if decision.kind == "ignored":
            return
        if decision.kind == "unknown":
            record_non_llm_discovery(
                tool_name=tool_name,
                matcher=decision.matcher,
                step_name=state.step_name,
                framework="langgraph",
                status=status,
            )
            return
        source = decision.source
        if source is None or source.metric is None:
            return
        customer_id = _clean_customer_id(state.customer_id) or "anonymous"
        extractors: dict[str, NonLlmUsageExtractor] | None = None
        if isinstance(self.non_llm_config, dict):
            raw_extractors = self.non_llm_config.get("usage_extractors")
            if isinstance(raw_extractors, dict):
                extractors = {
                    key: cast(NonLlmUsageExtractor, value)
                    for key, value in raw_extractors.items()
                    if isinstance(key, str) and callable(value)
                }
        value = metric_value_for_source(
            source,
            NonLlmToolContext(
                tool_name=tool_name,
                matcher=decision.matcher,
                customer_id=customer_id,
                step_name=state.step_name,
                status=status,
                framework="langgraph",
                input=state.tool_input,
                output=output,
                metadata=resolved_metadata,
            ),
            extractors,
        )
        if value is None:
            return
        event = self._event_from_state(
            state,
            tokens_in=0,
            tokens_out=0,
            status=status,
            model=None,
            provider=None,
            metadata=resolved_metadata,
        )
        event.update(
            {
                "provider": None,
                "tool_name": tool_name,
                "instrumentation_tier": "reported",
                "cost_source": "configured",
                "metric": source.metric,
                "metric_value": value,
            }
        )
        enqueue(event)

    def _resolve_customer_id(self, metadata: dict[str, Any]) -> str:
        if self.customer_id:
            return self.customer_id
        for key in ("pylva_customer_id", "customer_id"):
            value = _clean_customer_id(metadata.get(key))
            if value:
                return value
        ctx = current_context()
        return _clean_customer_id(ctx.customer_id if ctx else None) or "anonymous"

    def _event_from_state(
        self,
        state: _RunState,
        *,
        tokens_in: int,
        tokens_out: int,
        status: str,
        model: str | None,
        provider: str | None,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "run_id": state.run_id,
            "parent_run_id": state.parent_run_id,
            "trace_id": state.trace_id,
            "span_id": state.run_id,
            "parent_span_id": state.parent_run_id,
            "customer_id": _clean_customer_id(state.customer_id) or "anonymous",
            "step_name": _clean_step(state.step_name),
            "model": _clean_model(model),
            "provider": _clean_provider(provider) or "other",
            "tokens_in": max(0, int(tokens_in)),
            "tokens_out": max(0, int(tokens_out)),
            "latency_ms": max(0, int((time.time() - state.started_at) * 1000)),
            "tool_name": None,
            "status": status,
            "framework": "langgraph",
            "instrumentation_tier": "sdk_wrapper",
            "cost_source": "auto",
            "metric": None,
            "metric_value": None,
            "stream_aborted": False,
            "abort_savings_usd": 0,
            "timestamp": utc_now_iso(),
            "metadata": _safe_event_metadata(metadata),
        }


class PylvaCallbackHandler(_PylvaCallbackMixin, BaseCallbackHandler):
    """Sync LangChain callback handler for Pylva cost telemetry."""

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="chain",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="llm",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="llm",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_llm_end(response=response, run_id=run_id, parent_run_id=parent_run_id)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_llm_error(error=error, run_id=run_id, parent_run_id=parent_run_id)

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if not self.track_tool_calls:
            return
        if self.non_llm_mode == "policy":
            schedule_non_llm_policy_refresh()
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="tool",
            name=kwargs.get("name"),
            kwargs=kwargs,
            tool_input=input_str,
        )

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_tool_end(
            run_id=run_id,
            parent_run_id=parent_run_id,
            name=kwargs.get("name"),
            output=output,
        )

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_tool_error(
            error=error,
            run_id=run_id,
            parent_run_id=parent_run_id,
            name=kwargs.get("name"),
        )

    def on_chain_end(self, outputs: dict[str, Any], *, run_id: Any, **kwargs: Any) -> None:
        self._handle_chain_end(run_id=run_id)
        if self.flush_on_chain_end:
            _flush_best_effort()

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_chain_end(run_id=run_id)
        if self.flush_on_chain_end:
            _flush_best_effort()


class AsyncPylvaCallbackHandler(_PylvaCallbackMixin, AsyncCallbackHandler):
    """Async LangChain callback handler for Pylva cost telemetry."""

    async def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="chain",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    async def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="llm",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    async def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="llm",
            name=kwargs.get("name"),
            kwargs=kwargs,
        )

    async def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_llm_end(response=response, run_id=run_id, parent_run_id=parent_run_id)

    async def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_llm_error(error=error, run_id=run_id, parent_run_id=parent_run_id)

    async def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if not self.track_tool_calls:
            return
        if self.non_llm_mode == "policy":
            schedule_non_llm_policy_refresh()
        self._handle_start(
            run_id=run_id,
            parent_run_id=parent_run_id,
            serialized=serialized,
            metadata=metadata,
            kind="tool",
            name=kwargs.get("name"),
            kwargs=kwargs,
            tool_input=input_str,
        )

    async def on_tool_end(
        self,
        output: Any,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_tool_end(
            run_id=run_id,
            parent_run_id=parent_run_id,
            name=kwargs.get("name"),
            output=output,
        )

    async def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_tool_error(
            error=error,
            run_id=run_id,
            parent_run_id=parent_run_id,
            name=kwargs.get("name"),
        )

    async def on_chain_end(self, outputs: dict[str, Any], *, run_id: Any, **kwargs: Any) -> None:
        self._handle_chain_end(run_id=run_id)
        if self.flush_on_chain_end:
            try:
                await flush()
            except Exception:
                pass

    async def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        self._handle_chain_end(run_id=run_id)
        if self.flush_on_chain_end:
            try:
                await flush()
            except Exception:
                pass


def _id(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _uuid(value: str | None) -> str:
    if value:
        try:
            uuid.UUID(value)
            return value
        except Exception:
            pass
    return str(uuid.uuid4())


def _dict_value(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _first_str(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def _safe_run_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    safe: dict[str, Any] = {}
    for key in ("pylva_customer_id", "customer_id"):
        value = _clean_customer_id(metadata.get(key))
        if value:
            safe[key] = value
    for key in ("langgraph_node", "langgraph_step", "pylva_step"):
        value = _clean_metadata_step_label(metadata.get(key))
        if value:
            safe[key] = value
    for key in ("pylva_tool", "tool_name"):
        value = _clean_metadata_step_label(metadata.get(key))
        if value:
            safe[key] = value
    provider = _clean_provider(metadata.get("ls_provider"))
    if provider:
        safe["ls_provider"] = provider
    model = _clean_model(metadata.get("ls_model_name"))
    if model:
        safe["ls_model_name"] = model
    return safe


def _safe_event_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in ("langgraph_node", "langgraph_step", "pylva_step"):
        value = _clean_metadata_step_label(metadata.get(key))
        if value:
            safe[key] = value
    provider = _clean_provider(metadata.get("ls_provider"))
    if provider:
        safe["ls_provider"] = provider
    model = _clean_model(metadata.get("ls_model_name"))
    if model:
        safe["ls_model_name"] = model
    if metadata.get("token_count_source") == "exact":
        safe["token_count_source"] = "exact"
    if metadata.get("usage_missing") is True:
        safe["usage_missing"] = True
    error_type = _clean_step(metadata.get("error_type"))
    if error_type:
        safe["error_type"] = error_type
    return safe


def _resolve_run_name(serialized: dict[str, Any] | None, name: Any) -> str | None:
    if isinstance(name, str) and name:
        return _clean_step(name)
    if not isinstance(serialized, dict):
        return None
    serialized_name = serialized.get("name")
    if isinstance(serialized_name, str):
        return _clean_step(serialized_name)
    serialized_id = serialized.get("id")
    if isinstance(serialized_id, list) and serialized_id:
        last = serialized_id[-1]
        if isinstance(last, str):
            return _clean_step(last)
    return None


def _resolve_step_name(metadata: dict[str, Any], run_name: str | None) -> str | None:
    return _clean_step(
        _first_str(
            metadata.get("langgraph_node"),
            metadata.get("pylva_step"),
            metadata.get("langgraph_step"),
            run_name,
        )
    )


def _resolve_provider(
    serialized: dict[str, Any] | None,
    metadata: dict[str, Any],
    kwargs: dict[str, Any],
) -> str | None:
    invocation = _invocation_params(kwargs)
    raw = _first_str(
        metadata.get("ls_provider"),
        _dict_value(invocation, "provider"),
        _dict_value(invocation, "model_provider"),
        _dict_value(invocation, "modelProvider"),
        _dict_value(serialized, "provider") if serialized else None,
        _dict_value(serialized, "name") if serialized else None,
    )
    return _clean_provider(raw)


def _resolve_model(
    serialized: dict[str, Any] | None,
    metadata: dict[str, Any],
    kwargs: dict[str, Any],
) -> str | None:
    invocation = _invocation_params(kwargs)
    raw = _first_str(
        metadata.get("ls_model_name"),
        _dict_value(invocation, "model"),
        _dict_value(invocation, "model_name"),
        _dict_value(serialized, "model") if serialized else None,
        _dict_value(serialized, "model_name") if serialized else None,
    )
    return _clean_model(raw)


def _invocation_params(kwargs: dict[str, Any]) -> Any:
    return kwargs.get("invocation_params") or kwargs.get("invocationParams") or kwargs


def _clean_provider(raw: Any) -> str | None:
    return clean_provider_model_identifier(raw)


def _clean_customer_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value if _CUSTOMER_RE.match(value) else None


def _clean_step(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    cleaned = _STEP_RE.sub("_", value)[:200].strip()
    return cleaned or None


def _clean_metadata_step_label(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value != value.strip():
        return None
    return value if _METADATA_STEP_LABEL_RE.fullmatch(value) else None


def _clean_model(value: Any) -> str | None:
    return clean_provider_model_identifier(value)


def _extract_usage(response: Any) -> _Usage:
    generation = _first_generation(response)
    message = getattr(generation, "message", generation)
    usage_metadata = getattr(message, "usage_metadata", None)
    model = _model_from_message(message)
    provider = _provider_from_message(message)

    tokens_in = _usage_int(usage_metadata, "input_tokens", "prompt_tokens")
    tokens_out = _usage_int(usage_metadata, "output_tokens", "completion_tokens")
    total = _usage_int(usage_metadata, "total_tokens")
    if tokens_in is not None or tokens_out is not None or total is not None:
        resolved_in = tokens_in or 0
        resolved_out = tokens_out if tokens_out is not None else max((total or 0) - resolved_in, 0)
        return _Usage(
            tokens_in=resolved_in,
            tokens_out=resolved_out,
            model=model,
            provider=provider,
            found=True,
        )

    llm_output = getattr(response, "llm_output", None)
    token_usage = _dict_value(llm_output, "token_usage")
    tokens_in = _usage_int(token_usage, "prompt_tokens", "input_tokens")
    tokens_out = _usage_int(token_usage, "completion_tokens", "output_tokens")
    total = _usage_int(token_usage, "total_tokens")
    if tokens_in is not None or tokens_out is not None or total is not None:
        resolved_in = tokens_in or 0
        resolved_out = tokens_out if tokens_out is not None else max((total or 0) - resolved_in, 0)
        return _Usage(
            tokens_in=resolved_in,
            tokens_out=resolved_out,
            model=model or _clean_model(_dict_value(llm_output, "model_name")),
            provider=provider,
            found=True,
        )

    return _Usage(tokens_in=0, tokens_out=0, model=model, provider=provider, found=False)


def _first_generation(response: Any) -> Any:
    generations = getattr(response, "generations", None)
    if not isinstance(generations, list) or not generations:
        return None
    first_row = generations[0]
    if isinstance(first_row, list):
        return first_row[0] if first_row else None
    return first_row


def _usage_int(usage: Any, *keys: str) -> int | None:
    for key in keys:
        value = _dict_value(usage, key)
        if isinstance(value, int) and value >= 0:
            return value
        if isinstance(value, float) and value >= 0 and value.is_integer():
            return int(value)
    return None


def _model_from_message(message: Any) -> str | None:
    response_metadata = getattr(message, "response_metadata", None)
    return _clean_model(
        _first_str(
            _dict_value(response_metadata, "model_name"),
            _dict_value(response_metadata, "model"),
            _dict_value(message, "model"),
        )
    )


def _provider_from_message(message: Any) -> str | None:
    response_metadata = getattr(message, "response_metadata", None)
    raw = _first_str(
        _dict_value(response_metadata, "provider"),
        _dict_value(response_metadata, "model_provider"),
    )
    if raw is None:
        return None
    return _clean_provider(raw)


def _flush_best_effort() -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            asyncio.run(flush())
        except Exception:
            pass
        return
    try:
        loop.create_task(flush())
    except Exception:
        pass
