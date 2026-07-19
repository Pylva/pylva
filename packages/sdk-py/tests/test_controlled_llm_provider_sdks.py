"""No-network integration tests against the supported provider SDK surfaces."""

from __future__ import annotations

import copy
import inspect
import json
import os
import pickle
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

import pylva
from pylva.core import control_client, telemetry
from pylva.core.config import _require_config_snapshot
from pylva.core.control_ownership import _register_controlled_reservation
from pylva.core.control_schema import BypassedBudgetDecision, ReservedBudgetDecision
from pylva.errors.strict_provider import PylvaStrictProviderError
from pylva.wrappers import _controlled_provider as controlled_provider

VALID_KEY = "pv_live_12345678_" + "a" * 32
OPENAI_MODEL = "gpt-provider-shape-test"
ANTHROPIC_MODEL = "claude-provider-shape-test"
_CHILD_ENV = "PYLVA_PROVIDER_SDK_TEST_CHILD"


def _run_in_isolated_provider_process(test_name: str) -> bool:
    """Keep real provider modules separate from legacy fake-module tests."""

    if os.environ.get(_CHILD_ENV) == "1":
        return False
    env = dict(os.environ)
    env[_CHILD_ENV] = "1"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            f"{Path(__file__).resolve()}::{test_name}",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return True


def _init_legacy() -> None:
    pylva.init(
        VALID_KEY,
        endpoint="https://unit.invalid",
        local_mode=True,
        control={"mode": "legacy", "on_unavailable": "allow"},
    )
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]


def _openai_json_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-provider-shape",
            "object": "chat.completion",
            "created": 1,
            "model": OPENAI_MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 2,
                "total_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
            "service_tier": "default",
        },
        request=request,
    )


def _openai_stream_response(request: httpx.Request) -> httpx.Response:
    chunks = [
        {
            "id": "chatcmpl-provider-shape",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": OPENAI_MODEL,
            "service_tier": "default",
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop",
                }
            ],
        },
        {
            "id": "chatcmpl-provider-shape",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": OPENAI_MODEL,
            "service_tier": "default",
            "choices": [],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 2,
                "total_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        },
    ]
    body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
    body += "data: [DONE]\n\n"
    return httpx.Response(
        200,
        text=body,
        headers={"content-type": "text/event-stream"},
        request=request,
    )


def _anthropic_json_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "msg_provider_shape",
            "type": "message",
            "role": "assistant",
            "model": ANTHROPIC_MODEL,
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": 3,
                "output_tokens": 2,
                "service_tier": "standard",
            },
        },
        headers={"request-id": "req_provider_shape"},
        request=request,
    )


def _anthropic_stream_response(request: httpx.Request) -> httpx.Response:
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_provider_shape",
                    "type": "message",
                    "role": "assistant",
                    "model": ANTHROPIC_MODEL,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 0,
                        "service_tier": "standard",
                    },
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": "", "citations": None},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {
                    "output_tokens": 2,
                },
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    body = "".join(
        f"event: {event_name}\ndata: {json.dumps(data)}\n\n" for event_name, data in events
    )
    return httpx.Response(
        200,
        text=body,
        headers={
            "content-type": "text/event-stream",
            "request-id": "req_provider_shape",
        },
        request=request,
    )


def _recording_handler(
    responses: list[dict[str, Any]],
    *,
    json_response: Callable[[httpx.Request], httpx.Response],
    stream_response: Callable[[httpx.Request], httpx.Response],
) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        responses.append(body)
        return stream_response(request) if body.get("stream") is True else json_response(request)

    return handler


def _assert_one_exact_legacy_event() -> None:
    assert telemetry.buffer_size() == 1
    event = telemetry._state.buffer[0]  # type: ignore[attr-defined]
    assert event["tokens_in"] == 3
    assert event["tokens_out"] == 2
    assert event["metadata"]["token_count_source"] == "exact"


def _assert_narrow_stream_surface(
    facade: object,
    *,
    provider: str,
    safe_names: list[str],
) -> None:
    assert dir(facade) == safe_names
    assert {name for name, _value in inspect.getmembers(facade)} == set(safe_names)
    with pytest.raises(AttributeError):
        type(facade).__getattribute__(facade, "__bases__")
    with pytest.raises(AttributeError):
        type(facade).__getattr__(facade, "__bases__")
    assert not hasattr(facade, "__bases__")
    with pytest.raises((TypeError, PylvaStrictProviderError)):
        vars(facade)
    with pytest.raises(AttributeError):
        object.__getattribute__(facade, "__dict__")

    private_names = (
        "_abandon",
        "_client",
        "_decision",
        "_finish_success",
        "_heartbeat",
        "_manager",
        "_resource",
        "_stream",
        "_stream_factory",
        "_transport",
        "api_key",
        "response",
        "with_options",
    )
    sentinel = object()
    for name in private_names:
        assert inspect.getattr_static(facade, name, sentinel) is sentinel
        with pytest.raises(PylvaStrictProviderError) as raised:
            getattr(facade, name)
        assert raised.value.provider == provider
        assert raised.value.reason == "unsupported_pricing_feature"

    for action in (
        lambda: setattr(facade, "_client", object()),
        lambda: delattr(facade, "_stream"),
        lambda: copy.copy(facade),
        lambda: copy.deepcopy(facade),
        lambda: pickle.dumps(facade),
    ):
        with pytest.raises(PylvaStrictProviderError) as raised:
            action()
        assert raised.value.provider == provider
        assert raised.value.reason == "unsupported_pricing_feature"


def _bypassed(operation_id: str) -> BypassedBudgetDecision:
    return BypassedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "bypassed",
            "allowed": True,
            "decision_id": "11111111-1111-4111-8111-111111111111",
            "operation_id": operation_id,
            "reason": "no_applicable_budget",
            "would_have_denied": None,
            "warnings": [],
        },
        strict=True,
    )


def _reserved(operation_id: str) -> ReservedBudgetDecision:
    decision = ReservedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "reserved",
            "allowed": True,
            "decision_id": "11111111-1111-4111-8111-111111111111",
            "operation_id": operation_id,
            "reservation_id": "33333333-3333-4333-8333-333333333333",
            "state": "reserved",
            "reserved_usd": "1",
            "remaining_usd": "2",
            "expires_at": "2026-07-14T10:00:00.000Z",
            "warnings": [],
        },
        strict=True,
    )
    cfg, generation = _require_config_snapshot()
    assert _register_controlled_reservation(decision, cfg, generation)
    return decision


def test_official_openai_sync_response_and_stream_surface() -> None:
    if _run_in_isolated_provider_process("test_official_openai_sync_response_and_stream_surface"):
        return
    import openai

    _init_legacy()
    requests: list[dict[str, Any]] = []
    handler = _recording_handler(
        requests,
        json_response=_openai_json_response,
        stream_response=_openai_stream_response,
    )
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=handler)
        with openai.OpenAI(api_key="test", max_retries=0) as native:
            client = pylva.wrap_openai(native)
            assert not inspect.iscoroutinefunction(client.chat.completions.create)
            response = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
            )
            assert response.choices[0].message.content == "hello"
            _assert_one_exact_legacy_event()

            telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
            with client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
                stream=True,
            ) as stream:
                chunks = list(stream)
            assert chunks[0].choices[0].delta.content == "hello"
            _assert_one_exact_legacy_event()
            client.close()

    assert len(requests) == 2
    assert requests[0]["service_tier"] == "default"
    assert requests[1]["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_official_openai_async_response_and_stream_surface() -> None:
    if _run_in_isolated_provider_process("test_official_openai_async_response_and_stream_surface"):
        return
    import openai

    _init_legacy()
    requests: list[dict[str, Any]] = []
    handler = _recording_handler(
        requests,
        json_response=_openai_json_response,
        stream_response=_openai_stream_response,
    )
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=handler)
        async with openai.AsyncOpenAI(api_key="test", max_retries=0) as native:
            client = pylva.wrap_openai(native)
            assert inspect.iscoroutinefunction(client.chat.completions.create)
            response = await client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
            )
            assert response.choices[0].message.content == "hello"
            _assert_one_exact_legacy_event()

            telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
            stream = await client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
                stream=True,
            )
            async with stream:
                chunks = [chunk async for chunk in stream]
            assert chunks[0].choices[0].delta.content == "hello"
            _assert_one_exact_legacy_event()

            telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
            early_stream = await client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
                stream=True,
            )
            await early_stream.close()
            assert telemetry.buffer_size() == 1
            assert telemetry._state.buffer[0]["status"] == "aborted"  # type: ignore[attr-defined]
            await client.close()

    assert len(requests) == 3
    assert requests[0]["service_tier"] == "default"
    assert requests[1]["stream_options"] == {"include_usage": True}
    assert requests[2]["stream_options"] == {"include_usage": True}


def test_official_anthropic_sync_response_and_native_stream_manager() -> None:
    if _run_in_isolated_provider_process(
        "test_official_anthropic_sync_response_and_native_stream_manager"
    ):
        return
    import anthropic

    _init_legacy()
    requests: list[dict[str, Any]] = []
    handler = _recording_handler(
        requests,
        json_response=_anthropic_json_response,
        stream_response=_anthropic_stream_response,
    )
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages").mock(side_effect=handler)
        with anthropic.Anthropic(api_key="test", max_retries=0) as native:
            client = pylva.wrap_anthropic(native)
            assert not inspect.iscoroutinefunction(client.messages.create)
            response = client.messages.create(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_tokens=8,
            )
            assert response.content[0].text == "hello"
            _assert_one_exact_legacy_event()

            telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
            manager = client.messages.stream(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_tokens=8,
            )
            assert telemetry.buffer_size() == 0
            with manager as stream:
                assert list(stream.text_stream) == ["hello"]
                assert stream.get_final_message().content[0].text == "hello"
            _assert_one_exact_legacy_event()
            client.close()

    assert len(requests) == 2
    assert requests[0]["service_tier"] == "standard_only"
    assert requests[1]["service_tier"] == "standard_only"


@pytest.mark.asyncio
async def test_official_anthropic_async_response_and_native_stream_manager() -> None:
    if _run_in_isolated_provider_process(
        "test_official_anthropic_async_response_and_native_stream_manager"
    ):
        return
    import anthropic

    _init_legacy()
    requests: list[dict[str, Any]] = []
    handler = _recording_handler(
        requests,
        json_response=_anthropic_json_response,
        stream_response=_anthropic_stream_response,
    )
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages").mock(side_effect=handler)
        async with anthropic.AsyncAnthropic(api_key="test", max_retries=0) as native:
            client = pylva.wrap_anthropic(native)
            assert inspect.iscoroutinefunction(client.messages.create)
            response = await client.messages.create(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_tokens=8,
            )
            assert response.content[0].text == "hello"
            _assert_one_exact_legacy_event()

            telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
            manager = client.messages.stream(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_tokens=8,
            )
            assert telemetry.buffer_size() == 0
            async with manager as stream:
                assert [text async for text in stream.text_stream] == ["hello"]
                final_message = await stream.get_final_message()
                assert final_message.content[0].text == "hello"
            _assert_one_exact_legacy_event()
            await client.close()

    assert len(requests) == 2
    assert requests[0]["service_tier"] == "standard_only"
    assert requests[1]["service_tier"] == "standard_only"


def test_official_sync_stream_facades_block_bypass_and_stop_heartbeat_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_official_sync_stream_facades_block_bypass_and_stop_heartbeat_unresolved"
    ):
        return
    import anthropic
    import openai

    _init_legacy()
    requests: list[dict[str, Any]] = []
    starts: list[object] = []
    stops: list[object] = []
    commits: list[object] = []
    releases: list[object] = []
    original_start = controlled_provider._SyncHeartbeat.start
    original_stop = controlled_provider._SyncHeartbeat.stop

    def start(heartbeat: Any) -> None:
        starts.append(heartbeat)
        original_start(heartbeat)

    def stop(heartbeat: Any) -> None:
        stops.append(heartbeat)
        original_stop(heartbeat)

    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "start", start)
    monkeypatch.setattr(controlled_provider._SyncHeartbeat, "stop", stop)
    monkeypatch.setattr(
        control_client,
        "reserve_usage_sync",
        lambda body: _reserved(body["operation_id"]),
    )
    monkeypatch.setattr(control_client, "extend_usage_sync", lambda *_args: None)
    monkeypatch.setattr(control_client, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(control_client, "release_usage_sync", lambda *args: releases.append(args))

    openai_native = openai.OpenAI(api_key="test", max_retries=0)
    anthropic_native = anthropic.Anthropic(api_key="test", max_retries=0)
    openai_client = pylva.wrap_openai(openai_native, heartbeat_interval_seconds=1)
    anthropic_client = pylva.wrap_anthropic(
        anthropic_native,
        heartbeat_interval_seconds=1,
    )
    manager = anthropic_client.messages.stream(
        model=ANTHROPIC_MODEL,
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=8,
    )
    _assert_narrow_stream_surface(manager, provider="anthropic", safe_names=[])
    assert requests == []
    assert starts == []

    handler = _recording_handler(
        requests,
        json_response=lambda request: (
            _openai_json_response(request)
            if request.url.path == "/v1/chat/completions"
            else _anthropic_json_response(request)
        ),
        stream_response=lambda request: (
            _openai_stream_response(request)
            if request.url.path == "/v1/chat/completions"
            else _anthropic_stream_response(request)
        ),
    )
    try:
        with respx.mock(assert_all_called=False) as router:
            router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=handler)
            router.post("https://api.anthropic.com/v1/messages").mock(side_effect=handler)

            openai_stream = openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
                stream=True,
            )
            assert next(openai_stream).choices[0].delta.content == "hello"
            _assert_narrow_stream_surface(
                openai_stream,
                provider="openai",
                safe_names=["close"],
            )
            openai_heartbeat = starts[-1]
            assert openai_heartbeat not in stops
            openai_stream.close()
            assert openai_heartbeat in stops

            with manager as anthropic_stream:
                assert next(anthropic_stream).type == "message_start"
                _assert_narrow_stream_surface(
                    anthropic_stream,
                    provider="anthropic",
                    safe_names=[
                        "close",
                        "get_final_message",
                        "get_final_text",
                        "text_stream",
                        "until_done",
                    ],
                )
                anthropic_heartbeat = starts[-1]
                assert anthropic_heartbeat not in stops
                anthropic_stream.close()
                assert anthropic_heartbeat in stops

            openai_facade_stream = openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello again"}],
                max_completion_tokens=8,
                stream=True,
            )
            assert next(openai_facade_stream).choices[0].delta.content == "hello"
            openai_facade_heartbeat = starts[-1]
            openai_client.close()
            assert openai_facade_heartbeat in stops
            assert list(openai_facade_stream) == []
            with pytest.raises(StopIteration):
                next(openai_facade_stream)
            openai_facade_stream.close()

            facade_manager = anthropic_client.messages.stream(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello again"}],
                max_tokens=8,
            )
            with facade_manager as anthropic_facade_stream:
                assert next(anthropic_facade_stream).type == "message_start"
                anthropic_facade_heartbeat = starts[-1]
                anthropic_client.close()
                assert anthropic_facade_heartbeat in stops
                assert list(anthropic_facade_stream) == []
                with pytest.raises(StopIteration):
                    next(anthropic_facade_stream)
    finally:
        openai_client.close()
        anthropic_client.close()
        openai_native.close()
        anthropic_native.close()

    assert len(starts) == 4
    assert len(requests) == 4
    assert commits == []
    assert releases == []
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_official_async_stream_facades_block_bypass_and_stop_heartbeat_unresolved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_official_async_stream_facades_block_bypass_and_stop_heartbeat_unresolved"
    ):
        return
    import anthropic
    import openai

    _init_legacy()
    requests: list[dict[str, Any]] = []
    starts: list[object] = []
    stops: list[object] = []
    commits: list[object] = []
    releases: list[object] = []
    original_start = controlled_provider._AsyncHeartbeat.start
    original_stop = controlled_provider._AsyncHeartbeat.stop

    def start(heartbeat: Any) -> None:
        starts.append(heartbeat)
        original_start(heartbeat)

    def stop(heartbeat: Any) -> None:
        stops.append(heartbeat)
        original_stop(heartbeat)

    async def reserve(body: dict[str, Any]) -> ReservedBudgetDecision:
        return _reserved(body["operation_id"])

    async def extend(*_args: object) -> None:
        return None

    async def commit(*args: object) -> None:
        commits.append(args)

    async def release(*args: object) -> None:
        releases.append(args)

    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "start", start)
    monkeypatch.setattr(controlled_provider._AsyncHeartbeat, "stop", stop)
    monkeypatch.setattr(control_client, "reserve_usage", reserve)
    monkeypatch.setattr(control_client, "extend_usage", extend)
    monkeypatch.setattr(control_client, "commit_usage", commit)
    monkeypatch.setattr(control_client, "release_usage", release)

    openai_native = openai.AsyncOpenAI(api_key="test", max_retries=0)
    anthropic_native = anthropic.AsyncAnthropic(api_key="test", max_retries=0)
    openai_client = pylva.wrap_openai(openai_native, heartbeat_interval_seconds=1)
    anthropic_client = pylva.wrap_anthropic(
        anthropic_native,
        heartbeat_interval_seconds=1,
    )
    manager = anthropic_client.messages.stream(
        model=ANTHROPIC_MODEL,
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=8,
    )
    _assert_narrow_stream_surface(manager, provider="anthropic", safe_names=[])
    assert requests == []
    assert starts == []

    handler = _recording_handler(
        requests,
        json_response=lambda request: (
            _openai_json_response(request)
            if request.url.path == "/v1/chat/completions"
            else _anthropic_json_response(request)
        ),
        stream_response=lambda request: (
            _openai_stream_response(request)
            if request.url.path == "/v1/chat/completions"
            else _anthropic_stream_response(request)
        ),
    )
    try:
        with respx.mock(assert_all_called=False) as router:
            router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=handler)
            router.post("https://api.anthropic.com/v1/messages").mock(side_effect=handler)

            openai_stream = await openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello"}],
                max_completion_tokens=8,
                stream=True,
            )
            first_openai = await openai_stream.__anext__()
            assert first_openai.choices[0].delta.content == "hello"
            _assert_narrow_stream_surface(
                openai_stream,
                provider="openai",
                safe_names=["aclose", "close"],
            )
            openai_heartbeat = starts[-1]
            assert openai_heartbeat not in stops
            await openai_stream.close()
            assert openai_heartbeat in stops

            async with manager as anthropic_stream:
                assert (await anthropic_stream.__anext__()).type == "message_start"
                _assert_narrow_stream_surface(
                    anthropic_stream,
                    provider="anthropic",
                    safe_names=[
                        "aclose",
                        "close",
                        "get_final_message",
                        "get_final_text",
                        "text_stream",
                        "until_done",
                    ],
                )
                anthropic_heartbeat = starts[-1]
                assert anthropic_heartbeat not in stops
                await anthropic_stream.aclose()
                assert anthropic_heartbeat in stops

            openai_facade_stream = await openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "hello again"}],
                max_completion_tokens=8,
                stream=True,
            )
            first_openai = await openai_facade_stream.__anext__()
            assert first_openai.choices[0].delta.content == "hello"
            openai_facade_heartbeat = starts[-1]
            await openai_client.close()
            assert openai_facade_heartbeat in stops
            assert [chunk async for chunk in openai_facade_stream] == []
            with pytest.raises(StopAsyncIteration):
                await openai_facade_stream.__anext__()
            await openai_facade_stream.close()

            facade_manager = anthropic_client.messages.stream(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "hello again"}],
                max_tokens=8,
            )
            async with facade_manager as anthropic_facade_stream:
                assert (await anthropic_facade_stream.__anext__()).type == "message_start"
                anthropic_facade_heartbeat = starts[-1]
                await anthropic_client.close()
                assert anthropic_facade_heartbeat in stops
                assert [event async for event in anthropic_facade_stream] == []
                with pytest.raises(StopAsyncIteration):
                    await anthropic_facade_stream.__anext__()
    finally:
        await openai_client.close()
        await anthropic_client.close()
        await openai_native.close()
        await anthropic_native.close()

    assert len(starts) == 4
    assert len(requests) == 4
    assert commits == []
    assert releases == []
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_public_wrappers_reject_subclasses_custom_bases_and_mock_transports_zero_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_public_wrappers_reject_subclasses_custom_bases_and_mock_transports_zero_io"
    ):
        return
    import anthropic
    import openai

    control_calls = 0
    transport_calls = 0

    def unexpected_control(*_args: Any, **_kwargs: Any) -> None:
        nonlocal control_calls
        control_calls += 1
        raise AssertionError("control must not run while validating a provider client")

    async def unexpected_async_control(*_args: Any, **_kwargs: Any) -> None:
        unexpected_control()

    def mock_transport(request: httpx.Request) -> httpx.Response:
        nonlocal transport_calls
        transport_calls += 1
        return httpx.Response(500, request=request)

    monkeypatch.setattr(control_client, "reserve_usage_sync", unexpected_control)
    monkeypatch.setattr(control_client, "reserve_usage", unexpected_async_control)

    sync_custom_clients = [
        openai.OpenAI(
            api_key="test",
            http_client=openai.DefaultHttpxClient(transport=httpx.MockTransport(mock_transport)),
        ),
        anthropic.Anthropic(
            api_key="test",
            http_client=anthropic.DefaultHttpxClient(transport=httpx.MockTransport(mock_transport)),
        ),
    ]
    for native, wrapper in zip(
        sync_custom_clients,
        (pylva.wrap_openai, pylva.wrap_anthropic),
        strict=True,
    ):
        with pytest.raises(PylvaStrictProviderError) as raised:
            wrapper(native)
        assert raised.value.reason == "invalid_client"
        native.close()

    async_custom_clients = [
        openai.AsyncOpenAI(
            api_key="test",
            http_client=openai.DefaultAsyncHttpxClient(
                transport=httpx.MockTransport(mock_transport)
            ),
        ),
        anthropic.AsyncAnthropic(
            api_key="test",
            http_client=anthropic.DefaultAsyncHttpxClient(
                transport=httpx.MockTransport(mock_transport)
            ),
        ),
    ]
    for native, wrapper in zip(
        async_custom_clients,
        (pylva.wrap_openai, pylva.wrap_anthropic),
        strict=True,
    ):
        with pytest.raises(PylvaStrictProviderError) as raised:
            wrapper(native)
        assert raised.value.reason == "invalid_client"
        await native.close()

    custom_base_clients = [
        openai.OpenAI(api_key="test", base_url="https://example.invalid/v1"),
        anthropic.Anthropic(api_key="test", base_url="https://example.invalid"),
    ]
    for native, wrapper in zip(
        custom_base_clients,
        (pylva.wrap_openai, pylva.wrap_anthropic),
        strict=True,
    ):
        with pytest.raises(PylvaStrictProviderError) as raised:
            wrapper(native)
        assert raised.value.reason == "invalid_client"
        native.close()

    base_string_calls = 0

    class HostileBaseURL:
        def __str__(self) -> str:
            nonlocal base_string_calls
            base_string_calls += 1
            raise AssertionError("client validation must not stringify arbitrary objects")

    hostile_base_clients = [openai.OpenAI(api_key="test"), anthropic.Anthropic(api_key="test")]
    for native, wrapper in zip(
        hostile_base_clients,
        (pylva.wrap_openai, pylva.wrap_anthropic),
        strict=True,
    ):
        vars(native)["_base_url"] = HostileBaseURL()
        with pytest.raises(PylvaStrictProviderError) as raised:
            wrapper(native)
        assert raised.value.reason == "invalid_client"
        native.close()

    class OpenAISubclass(openai.OpenAI):
        pass

    class AnthropicSubclass(anthropic.Anthropic):
        pass

    subclass_clients = [OpenAISubclass(api_key="test"), AnthropicSubclass(api_key="test")]
    for native, wrapper in zip(
        subclass_clients,
        (pylva.wrap_openai, pylva.wrap_anthropic),
        strict=True,
    ):
        with pytest.raises(PylvaStrictProviderError) as raised:
            wrapper(native)
        assert raised.value.reason == "invalid_client"
        native.close()

    assert control_calls == 0
    assert transport_calls == 0
    assert base_string_calls == 0


def test_public_facades_are_narrow_and_hold_no_provider_bypass_attributes() -> None:
    if _run_in_isolated_provider_process(
        "test_public_facades_are_narrow_and_hold_no_provider_bypass_attributes"
    ):
        return
    import anthropic
    import openai

    openai_native = openai.OpenAI(api_key="test")
    anthropic_native = anthropic.Anthropic(api_key="test")
    openai_client = pylva.wrap_openai(openai_native)
    anthropic_client = pylva.wrap_anthropic(anthropic_native)
    try:
        assert pylva.wrap_openai(openai_client) is openai_client
        assert pylva.wrap_anthropic(anthropic_client) is anthropic_client
        assert dir(openai_client) == ["chat", "close", "max_retries"]
        assert dir(openai_client.chat) == ["completions"]
        assert dir(openai_client.chat.completions) == ["create"]
        assert dir(anthropic_client) == ["close", "max_retries", "messages"]
        assert dir(anthropic_client.messages) == ["create", "stream"]

        for facade in (
            openai_client,
            openai_client.chat,
            openai_client.chat.completions,
            anthropic_client,
            anthropic_client.messages,
        ):
            with pytest.raises(TypeError):
                vars(facade)
            for name in (
                "_pylva_original_client",
                "_client",
                "_resource",
                "_create",
                "_stream",
                "_posture",
                "with_options",
            ):
                with pytest.raises(PylvaStrictProviderError) as raised:
                    getattr(facade, name)
                assert raised.value.reason == "unsupported_pricing_feature"
            for action in (
                lambda facade=facade: setattr(facade, "_client", object()),
                lambda facade=facade: delattr(facade, "_client"),
                lambda facade=facade: copy.copy(facade),
                lambda facade=facade: copy.deepcopy(facade),
                lambda facade=facade: pickle.dumps(facade),
            ):
                with pytest.raises(PylvaStrictProviderError) as raised:
                    action()
                assert raised.value.reason == "unsupported_pricing_feature"
    finally:
        openai_client.close()
        anthropic_client.close()
        openai_native.close()
        anthropic_native.close()


@pytest.mark.asyncio
async def test_async_public_facades_reject_copy_pickle_and_mutation() -> None:
    if _run_in_isolated_provider_process(
        "test_async_public_facades_reject_copy_pickle_and_mutation"
    ):
        return
    import anthropic
    import openai

    openai_native = openai.AsyncOpenAI(api_key="test")
    anthropic_native = anthropic.AsyncAnthropic(api_key="test")
    openai_client = pylva.wrap_openai(openai_native)
    anthropic_client = pylva.wrap_anthropic(anthropic_native)
    try:
        for facade in (
            openai_client,
            openai_client.chat,
            openai_client.chat.completions,
            anthropic_client,
            anthropic_client.messages,
        ):
            for action in (
                lambda facade=facade: setattr(facade, "_client", object()),
                lambda facade=facade: delattr(facade, "_client"),
                lambda facade=facade: copy.copy(facade),
                lambda facade=facade: copy.deepcopy(facade),
                lambda facade=facade: pickle.dumps(facade),
            ):
                with pytest.raises(PylvaStrictProviderError) as raised:
                    action()
                assert raised.value.reason == "unsupported_pricing_feature"
    finally:
        await openai_client.close()
        await anthropic_client.close()
        await openai_native.close()
        await anthropic_native.close()


def test_reservation_gap_uses_detached_snapshot_and_never_rereads_caller_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_reservation_gap_uses_detached_snapshot_and_never_rereads_caller_client"
    ):
        return
    import anthropic
    import openai

    _init_legacy()
    provider_requests: list[dict[str, Any]] = []
    reservation_bodies: list[dict[str, Any]] = []
    openai_messages = [{"role": "user", "content": "openai original"}]
    anthropic_messages = [{"role": "user", "content": "anthropic original"}]
    openai_native = openai.OpenAI(api_key="test")
    anthropic_native = anthropic.Anthropic(api_key="test")
    openai_client = pylva.wrap_openai(openai_native)
    anthropic_client = pylva.wrap_anthropic(anthropic_native)

    def reserve(body: dict[str, Any]) -> BypassedBudgetDecision:
        reservation_bodies.append(dict(body))
        if body["provider"] == "openai":
            openai_messages[0]["content"] = "openai mutated after snapshot"
            openai_messages.append({"role": "user", "content": "late message"})
            vars(openai_native)["_base_url"] = httpx.URL("https://poison.invalid/v1")
            vars(openai_native)["api_key"] = "poisoned-openai-key"
        else:
            anthropic_messages[0]["content"] = "anthropic mutated after snapshot"
            anthropic_messages.append({"role": "user", "content": "late message"})
            vars(anthropic_native)["_base_url"] = httpx.URL("https://poison.invalid")
            vars(anthropic_native)["api_key"] = "poisoned-anthropic-key"
        return _bypassed(body["operation_id"])

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve)
    handler = _recording_handler(
        provider_requests,
        json_response=lambda request: (
            _openai_json_response(request)
            if request.url.path == "/v1/chat/completions"
            else _anthropic_json_response(request)
        ),
        stream_response=lambda request: httpx.Response(500, request=request),
    )
    try:
        with respx.mock(assert_all_called=False) as router:
            router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=handler)
            router.post("https://api.anthropic.com/v1/messages").mock(side_effect=handler)
            openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=openai_messages,
                max_completion_tokens=8,
            )
            anthropic_client.messages.create(
                model=ANTHROPIC_MODEL,
                messages=anthropic_messages,
                max_tokens=8,
            )
    finally:
        openai_client.close()
        anthropic_client.close()
        openai_native.close()
        anthropic_native.close()

    assert [request["messages"] for request in provider_requests] == [
        [{"role": "user", "content": "openai original"}],
        [{"role": "user", "content": "anthropic original"}],
    ]
    for provider_request, reservation_body in zip(
        provider_requests, reservation_bodies, strict=True
    ):
        encoded = json.dumps(
            provider_request,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        assert reservation_body["estimated_input_tokens"] == len(encoded) + 256 + 64
        assert "original" not in json.dumps(reservation_body)


@pytest.mark.asyncio
async def test_closed_facades_refuse_create_and_lazy_stream_before_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_closed_facades_refuse_create_and_lazy_stream_before_reservation"
    ):
        return
    import anthropic
    import openai

    _init_legacy()
    sync_reservations = 0
    async_reservations = 0

    def unexpected_sync_reserve(_body: dict[str, Any]) -> None:
        nonlocal sync_reservations
        sync_reservations += 1
        raise AssertionError("a closed facade must fail before sync reservation")

    async def unexpected_async_reserve(_body: dict[str, Any]) -> None:
        nonlocal async_reservations
        async_reservations += 1
        raise AssertionError("a closed facade must fail before async reservation")

    monkeypatch.setattr(control_client, "reserve_usage_sync", unexpected_sync_reserve)
    monkeypatch.setattr(control_client, "reserve_usage", unexpected_async_reserve)

    openai_native = openai.OpenAI(api_key="test")
    anthropic_native = anthropic.Anthropic(api_key="test")
    async_native = openai.AsyncOpenAI(api_key="test")
    openai_client = pylva.wrap_openai(openai_native)
    anthropic_client = pylva.wrap_anthropic(anthropic_native)
    async_client = pylva.wrap_openai(async_native)
    lazy_manager = anthropic_client.messages.stream(
        model=ANTHROPIC_MODEL,
        messages=[{"role": "user", "content": "never dispatched"}],
        max_tokens=8,
    )
    openai_client.close()
    anthropic_client.close()
    await async_client.close()
    try:
        with pytest.raises(PylvaStrictProviderError) as openai_error:
            openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "never dispatched"}],
                max_completion_tokens=8,
            )
        with pytest.raises(PylvaStrictProviderError) as anthropic_error:
            anthropic_client.messages.create(
                model=ANTHROPIC_MODEL,
                messages=[{"role": "user", "content": "never dispatched"}],
                max_tokens=8,
            )
        with pytest.raises(PylvaStrictProviderError) as stream_error:
            with lazy_manager:
                raise AssertionError("closed lazy stream entered")
        with pytest.raises(PylvaStrictProviderError) as async_error:
            await async_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "never dispatched"}],
                max_completion_tokens=8,
            )
        assert {
            openai_error.value.reason,
            anthropic_error.value.reason,
            stream_error.value.reason,
            async_error.value.reason,
        } == {"invalid_client"}
        # Idempotent close retains the native sync/async close shape.
        assert openai_client.close() is None
        await async_client.close()
    finally:
        openai_native.close()
        anthropic_native.close()
        await async_native.close()

    assert sync_reservations == 0
    assert async_reservations == 0


@pytest.mark.asyncio
async def test_close_during_reservation_rechecks_releases_and_never_dispatches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if _run_in_isolated_provider_process(
        "test_close_during_reservation_rechecks_releases_and_never_dispatches"
    ):
        return
    import anthropic
    import openai

    _init_legacy()
    reserve_calls = 0
    releases: list[str] = []
    commits = 0
    provider_calls = 0
    no_dispatch_attempts: list[object] = []
    local_no_dispatch_calls = 0
    original_no_dispatch = controlled_provider._controlled_no_dispatch
    original_local_no_dispatch = controlled_provider._controlled_local_no_dispatch

    def track_no_dispatch(attempt: object) -> None:
        no_dispatch_attempts.append(attempt)
        original_no_dispatch(attempt)  # type: ignore[arg-type]

    def track_local_no_dispatch(kind: str) -> None:
        nonlocal local_no_dispatch_calls
        local_no_dispatch_calls += 1
        original_local_no_dispatch(kind)  # type: ignore[arg-type]

    monkeypatch.setattr(controlled_provider, "_controlled_no_dispatch", track_no_dispatch)
    monkeypatch.setattr(
        controlled_provider,
        "_controlled_local_no_dispatch",
        track_local_no_dispatch,
    )

    def provider_handler(request: httpx.Request) -> httpx.Response:
        nonlocal provider_calls
        provider_calls += 1
        return httpx.Response(500, request=request)

    def commit(*_args: Any, **_kwargs: Any) -> None:
        nonlocal commits
        commits += 1

    async def async_commit(*_args: Any, **_kwargs: Any) -> None:
        commit()

    def release(_reservation_id: str, _body: dict[str, Any]) -> None:
        releases.append("sync")

    async def async_release(_reservation_id: str, _body: dict[str, Any]) -> None:
        releases.append("async")

    monkeypatch.setattr(control_client, "commit_usage_sync", commit)
    monkeypatch.setattr(control_client, "commit_usage", async_commit)
    monkeypatch.setattr(control_client, "release_usage_sync", release)
    monkeypatch.setattr(control_client, "release_usage", async_release)

    openai_native = openai.OpenAI(api_key="test")
    openai_client = pylva.wrap_openai(openai_native)

    def reserve_openai(body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        openai_client.close()
        return _reserved(body["operation_id"])

    monkeypatch.setattr(control_client, "reserve_usage_sync", reserve_openai)

    async_openai_native = openai.AsyncOpenAI(api_key="test")
    async_openai_client = pylva.wrap_openai(async_openai_native)

    async def reserve_async_openai(body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        await async_openai_client.close()
        return _reserved(body["operation_id"])

    anthropic_native = anthropic.Anthropic(api_key="test")
    anthropic_client = pylva.wrap_anthropic(anthropic_native)
    sync_manager = anthropic_client.messages.stream(
        model=ANTHROPIC_MODEL,
        messages=[{"role": "user", "content": "never dispatched"}],
        max_tokens=8,
    )

    def reserve_anthropic(body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        anthropic_client.close()
        return _reserved(body["operation_id"])

    async_anthropic_native = anthropic.AsyncAnthropic(api_key="test")
    async_anthropic_client = pylva.wrap_anthropic(async_anthropic_native)
    async_manager = async_anthropic_client.messages.stream(
        model=ANTHROPIC_MODEL,
        messages=[{"role": "user", "content": "never dispatched"}],
        max_tokens=8,
    )

    async def reserve_async_anthropic(body: dict[str, Any]) -> ReservedBudgetDecision:
        nonlocal reserve_calls
        reserve_calls += 1
        await async_anthropic_client.close()
        return _reserved(body["operation_id"])

    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.openai.com/v1/chat/completions").mock(side_effect=provider_handler)
        router.post("https://api.anthropic.com/v1/messages").mock(side_effect=provider_handler)

        with pytest.raises(PylvaStrictProviderError):
            openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "never dispatched"}],
                max_completion_tokens=8,
            )

        monkeypatch.setattr(control_client, "reserve_usage", reserve_async_openai)
        with pytest.raises(PylvaStrictProviderError):
            await async_openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": "never dispatched"}],
                max_completion_tokens=8,
            )

        monkeypatch.setattr(control_client, "reserve_usage_sync", reserve_anthropic)
        with pytest.raises(PylvaStrictProviderError):
            with sync_manager:
                raise AssertionError("closed sync manager dispatched")

        monkeypatch.setattr(control_client, "reserve_usage", reserve_async_anthropic)
        with pytest.raises(PylvaStrictProviderError):
            async with async_manager:
                raise AssertionError("closed async manager dispatched")

    openai_native.close()
    await async_openai_native.close()
    anthropic_native.close()
    await async_anthropic_native.close()
    assert reserve_calls == 4
    assert releases == ["sync", "async", "sync", "async"]
    assert provider_calls == 0
    assert commits == 0
    assert len(no_dispatch_attempts) == 4
    assert local_no_dispatch_calls == 0
