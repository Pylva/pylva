"""Anthropic Python wrapper — monkey-patches ``anthropic.resources.messages``
``Messages.create`` (sync + async). Same R1 isolation + model-from-response
pattern as the OpenAI wrapper. Pre-call budget enforcement, model routing,
and failover state tracking live in ``_engine.py``."""

from __future__ import annotations

import time
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

_patched = False


def _event_for(
    *,
    request_model: Any,
    response: Any,
    start: float,
    failure: bool,
    metadata_model: Any | None = None,
) -> dict:
    response_model = getattr(response, "model", None)
    model = response_model or metadata_model or request_model
    usage = getattr(response, "usage", None)
    return build_llm_event(
        provider="anthropic",
        model=model,
        tokens_in=0 if failure else (getattr(usage, "input_tokens", 0) if usage else 0),
        tokens_out=0 if failure else (getattr(usage, "output_tokens", 0) if usage else 0),
        latency_ms=int((time.time() - start) * 1000),
        status="failure" if failure else "success",
        token_count_source=None if failure else "exact",
    )


def try_patch_anthropic() -> None:
    global _patched
    if _patched:
        return
    try:
        from anthropic.resources.messages import Messages  # type: ignore
    except Exception:
        return

    try:
        from anthropic.resources.messages import AsyncMessages  # type: ignore
    except Exception:
        AsyncMessages = None  # type: ignore

    sync_original = Messages.create

    def sync_patched(self: Any, *args: Any, **kwargs: Any) -> Any:
        if not is_initialized():
            return sync_original(self, *args, **kwargs)
        if not kwargs:
            return sync_original(self, *args, **kwargs)
        start = time.time()
        request = dict(kwargs)
        ctx = build_engine_ctx("anthropic", request.get("model"))

        try:
            engine_result = run_with_engine_sync(
                request=request,
                provider_id="anthropic",
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
                print(f"[pylva] anthropic telemetry emit failed: {err}", flush=True)
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

    Messages.create = sync_patched  # type: ignore[assignment]

    if AsyncMessages is not None:
        async_original = AsyncMessages.create

        async def async_patched(self: Any, *args: Any, **kwargs: Any) -> Any:
            if not is_initialized():
                return await async_original(self, *args, **kwargs)
            if not kwargs:
                return await async_original(self, *args, **kwargs)
            start = time.time()
            request = dict(kwargs)
            ctx = build_engine_ctx("anthropic", request.get("model"))

            async def call(req: dict[str, Any]) -> Any:
                return await async_original(self, *args, **req)

            try:
                engine_result = await run_with_engine(
                    request=request,
                    provider_id="anthropic",
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
                    print(f"[pylva] anthropic telemetry emit failed: {err}", flush=True)
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

        AsyncMessages.create = async_patched  # type: ignore[assignment]

    _patched = True
    mark_provider_patched("anthropic")


def _reset_anthropic_patch_for_tests() -> None:
    global _patched
    _patched = False
