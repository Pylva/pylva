"""OpenAI Python wrapper — monkey-patches ``openai.resources.chat.completions``
``Completions.create`` (sync + async). R1 isolation: telemetry failures never
surface to the caller. Model is read from the response body to defuse alias
drift (e.g. gpt-4o → gpt-4o-2024-08-06). Pre-call budget enforcement, model
routing, and failover state tracking all live in ``_engine.py`` so anthropic
stays consistent."""

from __future__ import annotations

import time
from importlib import import_module
from typing import Any

from ..core.config import is_initialized
from ..core.telemetry import enqueue
from ._engine import (
    attach_pylva_metadata,
    build_engine_ctx,
    is_intentional_refusal,
    run_with_engine,
    run_with_engine_sync,
)
from ._event import build_llm_event
from ._init_validation import mark_provider_patched
from ._strict_context import is_strict_provider_dispatch

_patched = False


def _event_for(
    *,
    request_model: Any,
    response: Any,
    start: float,
    failure: bool,
    metadata_model: Any | None = None,
) -> dict[str, Any]:
    response_model = getattr(response, "model", None)
    model = response_model or metadata_model or request_model
    usage = getattr(response, "usage", None)
    return build_llm_event(
        provider="openai",
        model=model,
        tokens_in=0 if failure else (getattr(usage, "prompt_tokens", 0) if usage else 0),
        tokens_out=0 if failure else (getattr(usage, "completion_tokens", 0) if usage else 0),
        latency_ms=int((time.time() - start) * 1000),
        status="failure" if failure else "success",
        token_count_source=None if failure else "exact",
    )


def try_patch_openai() -> None:
    """Best-effort monkey-patch. Silently no-ops if the `openai` package is
    not importable. R1: the caller wraps this in try/except (`_patch.py`)."""
    global _patched
    if _patched:
        return
    try:
        provider_module = import_module("openai.resources.chat.completions")
        Completions: Any = provider_module.Completions
    except Exception:
        return
    AsyncCompletions: Any = getattr(provider_module, "AsyncCompletions", None)

    sync_original = Completions.create

    def sync_patched(self: Any, *args: Any, **kwargs: Any) -> Any:
        if not is_initialized():
            return sync_original(self, *args, **kwargs)
        if not kwargs:  # malformed input — let the SDK reject as it would unwrapped
            return sync_original(self, *args, **kwargs)
        # The explicit controlled proxy already resolved the final model,
        # obtained its reservation, and owns rollout telemetry. Re-running the
        # legacy engine here could route to an unreserved model or emit a
        # duplicate event.
        if is_strict_provider_dispatch("openai", kwargs.get("model")):
            return sync_original(self, *args, **kwargs)
        start = time.time()
        request = dict(kwargs)
        ctx = build_engine_ctx("openai", request.get("model"))

        try:
            engine_result = run_with_engine_sync(
                request=request,
                provider_id="openai",
                ctx=ctx,
                call=lambda req: sync_original(self, *args, **req),
            )
            try:
                enqueue(
                    _event_for(
                        request_model=kwargs.get("model"),
                        response=engine_result.result,
                        start=start,
                        failure=False,
                        metadata_model=engine_result.metadata.routed_model
                        or engine_result.metadata.original_model,
                    )
                )
            except Exception as err:
                print(f"[pylva] openai telemetry emit failed: {err}", flush=True)
            return attach_pylva_metadata(engine_result.result, engine_result.metadata)
        except BaseException as err:
            if is_intentional_refusal(err):
                raise
            try:
                enqueue(
                    _event_for(
                        request_model=kwargs.get("model"),
                        response=None,
                        start=start,
                        failure=True,
                    )
                )
            except Exception:
                pass
            raise

    Completions.create = sync_patched

    if AsyncCompletions is not None:
        async_original = AsyncCompletions.create

        async def async_patched(self: Any, *args: Any, **kwargs: Any) -> Any:
            if not is_initialized():
                return await async_original(self, *args, **kwargs)
            if not kwargs:
                return await async_original(self, *args, **kwargs)
            if is_strict_provider_dispatch("openai", kwargs.get("model")):
                return await async_original(self, *args, **kwargs)
            start = time.time()
            request = dict(kwargs)
            ctx = build_engine_ctx("openai", request.get("model"))

            async def call(req: dict[str, Any]) -> Any:
                return await async_original(self, *args, **req)

            try:
                engine_result = await run_with_engine(
                    request=request,
                    provider_id="openai",
                    ctx=ctx,
                    call=call,
                )
                try:
                    enqueue(
                        _event_for(
                            request_model=kwargs.get("model"),
                            response=engine_result.result,
                            start=start,
                            failure=False,
                            metadata_model=engine_result.metadata.routed_model
                            or engine_result.metadata.original_model,
                        )
                    )
                except Exception as err:
                    print(f"[pylva] openai telemetry emit failed: {err}", flush=True)
                return attach_pylva_metadata(engine_result.result, engine_result.metadata)
            except BaseException as err:
                if is_intentional_refusal(err):
                    raise
                try:
                    enqueue(
                        _event_for(
                            request_model=kwargs.get("model"),
                            response=None,
                            start=start,
                            failure=True,
                        )
                    )
                except Exception:
                    pass
                raise

        AsyncCompletions.create = async_patched

    _patched = True
    mark_provider_patched("openai")


def _reset_openai_patch_for_tests() -> None:
    global _patched
    _patched = False
