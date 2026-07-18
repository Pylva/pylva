"""Authoritative-control client behavior, transport, and public API tests."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import pytest

import pylva
from pylva import Pylva
from pylva.core import control_client
from pylva.core.config import (
    DEFAULT_CONTROL_TIMEOUT_MS,
    MAX_CONTROL_TIMEOUT_MS,
    MIN_CONTROL_TIMEOUT_MS,
    ControlConfig,
    InvalidControlConfigError,
    get_config,
    get_config_generation,
)
from pylva.core.config import (
    init as init_config,
)
from pylva.core.control_schema import UnavailableBudgetDecision
from pylva.errors import (
    BudgetExceededSource,
    PylvaBudgetExceeded,
    PylvaControlApiError,
    PylvaControlUnavailableError,
    PylvaControlUnavailableReason,
    PylvaControlValidationError,
)

KEY_A = "pv_live_12345678_" + "a" * 32
KEY_B = "pv_live_12345678_" + "b" * 32
OPERATION_ID = "11111111-1111-4111-8111-111111111111"
DECISION_ID = "22222222-2222-4222-8222-222222222222"
RESERVATION_ID = "33333333-3333-4333-8333-333333333333"
TRACE_ID = "44444444-4444-4444-8444-444444444444"
SPAN_ID = "55555555-5555-4555-8555-555555555555"
RULE_ID = "66666666-6666-4666-8666-666666666666"
EXTENSION_ID = "77777777-7777-4777-8777-777777777777"


def _init(
    *,
    mode: str = "enforce",
    on_unavailable: str = "deny",
    key: str = KEY_A,
    endpoint: str = "https://control.test",
    timeout_ms: int = 321,
) -> None:
    init_config(
        key,
        endpoint=endpoint,
        control={
            "mode": mode,
            "on_unavailable": on_unavailable,
            "timeout_ms": timeout_ms,
        },
    )


def _capabilities(*, enabled: bool = True) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "control_enabled": enabled,
        "min_reservation_ttl_seconds": 30,
        "default_reservation_ttl_seconds": 300,
        "max_reservation_ttl_seconds": 3600,
        "server_time": "2026-07-14T00:00:00Z",
    }


def _llm_request(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "kind": "llm",
        "operation_id": OPERATION_ID,
        "customer_id": "customer-original",
        "trace_id": TRACE_ID,
        "span_id": SPAN_ID,
        "parent_span_id": None,
        "step_name": "answer",
        "framework": "none",
        "reservation_ttl_seconds": 300,
        "provider": "openai",
        "model": "gpt-4o-mini",
        "estimated_input_tokens": 10,
        "max_output_tokens": 20,
    }
    value.update(overrides)
    return value


def _reserved(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema_version": "1.0",
        "decision": "reserved",
        "allowed": True,
        "decision_id": DECISION_ID,
        "operation_id": OPERATION_ID,
        "reservation_id": RESERVATION_ID,
        "state": "reserved",
        "reserved_usd": "0.01",
        "remaining_usd": "9.99",
        "expires_at": "2026-07-14T00:05:00Z",
        "warnings": [],
    }
    value.update(overrides)
    return value


def _denied() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "decision": "denied",
        "allowed": False,
        "decision_id": DECISION_ID,
        "operation_id": OPERATION_ID,
        "state": "refused",
        "deciding_rule": {
            "rule_id": RULE_ID,
            "scope": "per_customer",
            "customer_id": "customer-original",
            "period": "day",
            "period_start": "2026-07-14T00:00:00Z",
            "period_end": "2026-07-15T00:00:00Z",
        },
        "committed_usd": "1.1",
        "reserved_usd": "2.2",
        "unresolved_usd": "3.3",
        "requested_usd": "4.000000000000000001",
        "limit_usd": "10",
        "remaining_usd": "3.4",
        "warnings": [],
    }


def _unavailable() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "decision": "unavailable",
        "allowed": False,
        "decision_id": None,
        "operation_id": OPERATION_ID,
        "reason": "pricing_unavailable",
        "retryable": False,
    }


def _bypassed(reason: str = "shadow_would_allow") -> dict[str, Any]:
    unavailable_reason = reason in {"control_disabled", "shadow_control_unavailable"}
    would_have_denied: bool | None
    if reason == "shadow_would_allow":
        would_have_denied = False
    elif reason == "shadow_would_deny":
        would_have_denied = True
    else:
        would_have_denied = None
    return {
        "schema_version": "1.0",
        "decision": "bypassed",
        "allowed": True,
        "decision_id": None if unavailable_reason else DECISION_ID,
        "operation_id": OPERATION_ID,
        "reason": reason,
        "would_have_denied": would_have_denied,
        "warnings": [],
    }


def _commit_request() -> dict[str, Any]:
    return {
        "kind": "llm",
        "actual_input_tokens": 10,
        "actual_output_tokens": 20,
        "status": "success",
        "latency_ms": 25,
        "stream_aborted": False,
    }


def _commit_response(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema_version": "1.0",
        "state": "committed",
        "reservation_id": RESERVATION_ID,
        "operation_id": OPERATION_ID,
        "reserved_usd": "1",
        "actual_usd": "1.25",
        "released_usd": "0",
        "overage_usd": "0.25",
        "budget_exceeded_after_commit": True,
        "committed_at": "2026-07-14T00:01:00Z",
        "idempotent_replay": False,
        "late": False,
    }
    value.update(overrides)
    return value


def _release_response(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema_version": "1.0",
        "state": "released",
        "reservation_id": RESERVATION_ID,
        "operation_id": OPERATION_ID,
        "released_usd": "1",
        "released_at": "2026-07-14T00:01:00Z",
        "idempotent_replay": False,
    }
    value.update(overrides)
    return value


def _extend_response(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema_version": "1.0",
        "state": "reserved",
        "reservation_id": RESERVATION_ID,
        "operation_id": OPERATION_ID,
        "extension_id": EXTENSION_ID,
        "expires_at": "2026-07-14T00:10:00Z",
        "idempotent_replay": False,
    }
    value.update(overrides)
    return value


def _error(
    *,
    code: str = "INVALID_API_KEY",
    error_type: str = "authentication_error",
    message: str = "backend secret must never be reflected",
    param: str | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"type": error_type, "code": code, "message": message}
    if param is not None:
        error["param"] = param
    return {"error": error}


class _Router:
    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


def _install_transports(
    monkeypatch: pytest.MonkeyPatch,
    router: _Router,
) -> list[float]:
    timeouts: list[float] = []

    def sync_factory(timeout: float) -> httpx.Client:
        timeouts.append(timeout)
        return httpx.Client(transport=httpx.MockTransport(router), timeout=timeout)

    def async_factory(timeout: float) -> httpx.AsyncClient:
        timeouts.append(timeout)
        return httpx.AsyncClient(transport=httpx.MockTransport(router), timeout=timeout)

    monkeypatch.setattr(control_client, "_make_sync_client", sync_factory)
    monkeypatch.setattr(control_client, "_make_async_client", async_factory)
    return timeouts


def _capability_then(value: dict[str, Any], status: int = 200) -> _Router:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _capabilities() if request.url.path.endswith("/capabilities") else value
        return httpx.Response(status, json=body)

    return _Router(handler)


def test_control_config_defaults_validation_and_generation() -> None:
    init_config(KEY_A)
    cfg = get_config()
    assert cfg is not None
    assert cfg.control.mode == "legacy"
    assert cfg.control.on_unavailable == "allow"
    assert cfg.control.timeout_ms == DEFAULT_CONTROL_TIMEOUT_MS
    generation = get_config_generation()

    init_config(KEY_A, control=ControlConfig(mode="enforce", on_unavailable="deny"))
    assert get_config_generation() == generation
    init_config(KEY_B)
    assert get_config_generation() == generation + 1


@pytest.mark.parametrize(
    "control",
    [
        {"mode": "invalid"},
        {"on_unavailable": "invalid"},
        {"timeout_ms": True},
        {"timeout_ms": MIN_CONTROL_TIMEOUT_MS - 1},
        {"timeout_ms": MAX_CONTROL_TIMEOUT_MS + 1},
        {"unknown": 1},
        [],
    ],
)
def test_control_config_rejects_invalid_values(control: Any) -> None:
    with pytest.raises(InvalidControlConfigError):
        init_config(KEY_A, control=control)


def test_legacy_reservation_validates_but_never_touches_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="legacy", on_unavailable="deny")
    monkeypatch.setattr(
        control_client,
        "_make_sync_client",
        lambda _timeout: pytest.fail("legacy mode must not create a client"),
    )
    result = control_client.reserve_usage_sync(_llm_request(mode="enforce"))
    assert result.decision == "bypassed"
    assert result.allowed is True
    assert result.reason == "control_disabled"
    assert result.decision_id is None
    assert result.operation_id == OPERATION_ID


@pytest.mark.parametrize(
    "bad_request",
    [
        _llm_request(mode="shadow"),
        _llm_request(estimated_input_tokens=True),
        _llm_request(extra="forbidden"),
        _llm_request(operation_id="not-a-uuid"),
    ],
)
def test_reservation_rejects_invalid_local_values_before_network(
    bad_request: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    monkeypatch.setattr(
        control_client,
        "_make_sync_client",
        lambda _timeout: pytest.fail("invalid input must not create a client"),
    )
    with pytest.raises(PylvaControlValidationError) as caught:
        control_client.reserve_usage_sync(bad_request)
    assert caught.value.operation == "reserve_usage"


def test_sync_readiness_caches_headers_timeout_and_uses_no_asyncio_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(timeout_ms=321)
    router = _Router(lambda _request: httpx.Response(200, json=_capabilities()))
    timeouts = _install_transports(monkeypatch, router)
    monkeypatch.setattr(asyncio, "run", lambda *_args: pytest.fail("asyncio.run used"))

    assert control_client.ready_sync() is True
    assert control_client.ready_sync() is True
    assert len(router.requests) == 1
    request = router.requests[0]
    assert request.headers["X-Pylva-Key"] == KEY_A
    assert request.headers["X-Pylva-SDK-Version"] == pylva.__version__
    assert request.headers["X-Pylva-SDK-Language"] == "python"
    assert timeouts == [0.321]


@pytest.mark.asyncio
async def test_async_readiness_coalesces_and_survives_one_waiter_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()

    class BlockingTransport(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.calls = 0
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            self.calls += 1
            self.entered.set()
            await self.release.wait()
            return httpx.Response(200, json=_capabilities(), request=request)

    transport = BlockingTransport()
    monkeypatch.setattr(
        control_client,
        "_make_async_client",
        lambda timeout: httpx.AsyncClient(transport=transport, timeout=timeout),
    )
    first = asyncio.create_task(control_client.ready())
    second = asyncio.create_task(control_client.ready())
    await transport.entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    transport.release.set()
    assert await second is True
    assert transport.calls == 1


def test_sync_readiness_coalesces_across_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    _init()
    entered = threading.Event()
    release = threading.Event()
    count_lock = threading.Lock()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        with count_lock:
            calls += 1
        entered.set()
        assert release.wait(2)
        return httpx.Response(200, json=_capabilities(), request=request)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(control_client.ready_sync) for _ in range(6)]
        assert entered.wait(2)
        release.set()
        assert [future.result(timeout=2) for future in futures] == [True] * 6
    assert calls == 1


@pytest.mark.parametrize("status", [404, 405])
@pytest.mark.parametrize("policy", ["allow", "deny"])
def test_old_backend_readiness_is_false(
    status: int,
    policy: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable=policy)
    router = _Router(lambda _request: httpx.Response(status, text="old backend"))
    _install_transports(monkeypatch, router)
    assert control_client.ready_sync() is False


@pytest.mark.parametrize("policy", ["allow", "deny"])
def test_disabled_capability_readiness_is_false(
    policy: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable=policy)
    router = _Router(lambda _request: httpx.Response(200, json=_capabilities(enabled=False)))
    _install_transports(monkeypatch, router)
    assert control_client.ready_sync() is False


def test_network_unavailability_obeys_policy_without_leaking_transport_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("PRIVATE proxy.example.internal", request=request)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    _init(on_unavailable="allow")
    assert control_client.ready_sync() is False

    _init(on_unavailable="deny")
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.ready_sync()
    error = caught.value
    assert error.reason is PylvaControlUnavailableReason.NETWORK_ERROR
    assert error.retryable is True
    assert error.operation == "ready"
    assert "PRIVATE" not in str(error)


@pytest.mark.asyncio
async def test_async_network_unavailability_returns_false_or_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("PRIVATE", request=request)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    _init(on_unavailable="allow")
    allowed_result = await control_client.ready()
    assert allowed_result is False
    assert isinstance(allowed_result, bool)

    _init(on_unavailable="deny")
    with pytest.raises(PylvaControlUnavailableError) as caught:
        await control_client.ready()
    assert caught.value.reason is PylvaControlUnavailableReason.NETWORK_ERROR
    assert caught.value.operation == "ready"


@pytest.mark.parametrize("use_sync", [False, True])
@pytest.mark.asyncio
async def test_invalid_endpoint_is_sanitized_nonretryable_network_unavailability(
    use_sync: bool,
) -> None:
    _init(endpoint="http://[::1", on_unavailable="allow")
    result = control_client.ready_sync() if use_sync else await control_client.ready()
    assert result is False

    _init(endpoint="http://[::2", key=KEY_B, on_unavailable="deny")
    with pytest.raises(PylvaControlUnavailableError) as caught:
        if use_sync:
            control_client.ready_sync()
        else:
            await control_client.ready()
    assert caught.value.reason is PylvaControlUnavailableReason.NETWORK_ERROR
    assert caught.value.retryable is False
    assert "::2" not in str(caught.value)


@pytest.mark.asyncio
async def test_reserve_injects_wire_defaults_and_returns_validated_decision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="shadow")
    router = _capability_then(_bypassed())
    _install_transports(monkeypatch, router)

    result = await control_client.reserve_usage(_llm_request())
    assert result.decision == "bypassed"
    assert result.reason == "shadow_would_allow"
    reserve_request = router.requests[-1]
    sent = json.loads(reserve_request.content)
    assert sent["schema_version"] == "1.0"
    assert sent["mode"] == "shadow"
    assert reserve_request.url.path == "/api/v1/budget/reservations"


def test_sync_reserve_maps_denial_with_exact_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    router = _capability_then(_denied())
    _install_transports(monkeypatch, router)

    with pytest.raises(PylvaBudgetExceeded) as caught:
        control_client.reserve_usage_sync(_llm_request())
    error = caught.value
    assert error.source is BudgetExceededSource.AUTHORITATIVE_CONTROL
    assert error.customer_id == "customer-original"
    assert error.rule_id == RULE_ID
    assert error.limit_usd_exact == "10"
    assert error.accumulated_usd_exact == "6.6"
    assert error.estimated_usd_exact == "4.000000000000000001"
    assert error.authoritative_denial is error.control_decision
    denial = error.authoritative_denial
    assert denial is not None
    assert denial.decision_id == DECISION_ID
    assert error.accumulated_usd == pytest.approx(6.6)


def test_server_unavailable_decision_is_returned_or_raised_with_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _capability_then(_unavailable())
    _install_transports(monkeypatch, router)
    _init(on_unavailable="allow")
    result = control_client.reserve_usage_sync(_llm_request())
    assert isinstance(result, UnavailableBudgetDecision)
    assert result.allowed is False
    assert result.reason == "pricing_unavailable"

    # Identity change invalidates the prior readiness result and exercises the
    # same response under fail-closed behavior.
    _init(on_unavailable="deny", key=KEY_B)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.reserve_usage_sync(_llm_request())
    error = caught.value
    assert error.reason is PylvaControlUnavailableReason.PRICING_UNAVAILABLE
    assert error.operation == "reserve_usage"
    assert error.operation_id == OPERATION_ID
    assert error.unavailable_response is not None
    assert error.unavailable_response.reason == "pricing_unavailable"


@pytest.mark.parametrize(
    ("mode", "body"),
    [
        ("shadow", _reserved()),
        ("shadow", _unavailable()),
        ("enforce", _bypassed("shadow_would_allow")),
        ("enforce", _bypassed("shadow_would_deny")),
        ("enforce", _bypassed("shadow_control_unavailable")),
    ],
)
@pytest.mark.parametrize("use_sync", [False, True])
@pytest.mark.asyncio
async def test_sync_and_async_reject_responses_from_the_wrong_control_mode(
    mode: str,
    body: dict[str, Any],
    use_sync: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode=mode, on_unavailable="allow")
    router = _capability_then(body)
    _install_transports(monkeypatch, router)

    result = (
        control_client.reserve_usage_sync(_llm_request())
        if use_sync
        else await control_client.reserve_usage(_llm_request())
    )
    assert result.decision == "unavailable"
    assert result.allowed is False
    assert result.operation_id == OPERATION_ID
    assert result.retryable is False


@pytest.mark.parametrize(
    ("mode", "reason", "expected_reason", "retryable"),
    [
        ("enforce", "control_disabled", "control_disabled", False),
        ("shadow", "shadow_control_unavailable", "control_unavailable", True),
    ],
)
@pytest.mark.parametrize("use_sync", [False, True])
@pytest.mark.asyncio
async def test_sync_and_async_never_leak_availability_bypass_as_approval(
    mode: str,
    reason: str,
    expected_reason: str,
    retryable: bool,
    use_sync: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode=mode, on_unavailable="allow")
    router = _capability_then(_bypassed(reason))
    _install_transports(monkeypatch, router)
    result = (
        control_client.reserve_usage_sync(_llm_request())
        if use_sync
        else await control_client.reserve_usage(_llm_request())
    )
    assert result.decision == "unavailable"
    assert result.allowed is False
    assert result.reason == "control_unavailable"
    assert result.retryable is retryable

    _init(mode=mode, on_unavailable="deny", key=KEY_B)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        if use_sync:
            control_client.reserve_usage_sync(_llm_request())
        else:
            await control_client.reserve_usage(_llm_request())
    assert caught.value.reason.value == expected_reason
    assert caught.value.retryable is retryable
    assert caught.value.unavailable_response is not None
    assert caught.value.unavailable_response.allowed is False


@pytest.mark.parametrize(
    ("response", "expected_reason"),
    [
        (httpx.Response(200, content=b'{"control_enabled": NaN}'), "invalid_response"),
        (httpx.Response(200, content=b'{"x":1,"x":2}'), "invalid_response"),
        (httpx.Response(200, content=b"\xff"), "invalid_response"),
        (httpx.Response(200, content=b"x" * (64 * 1024 + 1)), "invalid_response"),
        (
            httpx.Response(503, json=_error(code="INTERNAL_ERROR", error_type="api_error")),
            "service_unavailable",
        ),
        (
            httpx.Response(
                429,
                json=_error(code="RATE_LIMIT_EXCEEDED", error_type="rate_limit_error"),
            ),
            "rate_limited",
        ),
    ],
)
def test_readiness_strict_response_and_service_failures(
    response: httpx.Response,
    expected_reason: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="deny")
    router = _Router(lambda _request: response)
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.ready_sync()
    assert caught.value.reason.value == expected_reason


def test_validated_api_error_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    _init()
    router = _Router(
        lambda _request: httpx.Response(
            401,
            json=_error(
                message="PRIVATE database hostname",
                param="PRIVATE_BACKEND_PARAM_SECRET",
            ),
        )
    )
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlApiError) as caught:
        control_client.ready_sync()
    assert caught.value.status == 401
    assert caught.value.code == "INVALID_API_KEY"
    assert caught.value.param is None
    assert "PRIVATE" not in str(caught.value)
    assert "PRIVATE" not in repr(vars(caught.value))


def test_sync_rejects_http_error_code_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    _init(on_unavailable="deny")
    router = _Router(
        lambda _request: httpx.Response(
            401,
            json=_error(code="WRONG_SCOPE", error_type="authentication_error"),
        )
    )
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.ready_sync()
    assert caught.value.reason is PylvaControlUnavailableReason.INVALID_RESPONSE
    assert caught.value.retryable is False
    assert caught.value.status == 401


@pytest.mark.asyncio
async def test_async_rejects_http_error_code_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="deny")
    router = _Router(
        lambda _request: httpx.Response(
            503,
            json=_error(code="RATE_LIMIT_EXCEEDED", error_type="rate_limit_error"),
        )
    )
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        await control_client.ready()
    assert caught.value.reason is PylvaControlUnavailableReason.INVALID_RESPONSE
    assert caught.value.retryable is False
    assert caught.value.status == 503


def test_invalid_reservation_response_fails_open_honestly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="allow")
    router = _capability_then(_reserved(operation_id=TRACE_ID))
    _install_transports(monkeypatch, router)
    result = control_client.reserve_usage_sync(_llm_request())
    assert result.decision == "unavailable"
    assert result.allowed is False
    assert result.operation_id == OPERATION_ID


@pytest.mark.asyncio
async def test_commit_release_extend_async_and_sync_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="allow")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/capabilities"):
            return httpx.Response(200, json=_capabilities())
        if request.url.path.endswith("/reservations"):
            return httpx.Response(200, json=_reserved())
        if request.url.path.endswith("/commit"):
            return httpx.Response(200, json=_commit_response())
        if request.url.path.endswith("/release"):
            return httpx.Response(200, json=_release_response())
        if request.url.path.endswith("/extend"):
            return httpx.Response(200, json=_extend_response())
        raise AssertionError(request.url.path)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    reservation = await control_client.reserve_usage(_llm_request())
    committed = await control_client.commit_usage(RESERVATION_ID, _commit_request())
    committed_sync = control_client.commit_usage_sync(RESERVATION_ID, _commit_request())
    released = control_client.release_usage_sync(
        RESERVATION_ID,
        {"reason": "provider_not_called"},
    )
    released_async = await control_client.release_usage(
        RESERVATION_ID,
        {"reason": "provider_not_called"},
    )
    extended = await control_client.extend_usage(
        RESERVATION_ID,
        {"extension_id": EXTENSION_ID, "extend_by_seconds": 300},
    )
    extended_sync = control_client.extend_usage_sync(
        RESERVATION_ID,
        {"extension_id": EXTENSION_ID, "extend_by_seconds": 300},
    )
    assert committed.state == "committed"
    assert committed_sync == committed
    assert pylva.should_suppress_legacy_telemetry(
        reservation,
        operation_id=OPERATION_ID,
        reservation_id=RESERVATION_ID,
    )
    assert released.state == "released"
    assert released_async == released
    assert extended.extension_id == EXTENSION_ID
    assert extended_sync == extended
    assert [request.url.path.rsplit("/", 1)[-1] for request in router.requests] == [
        "capabilities",
        "reservations",
        "commit",
        "commit",
        "release",
        "release",
        "extend",
        "extend",
    ]
    for request in router.requests[1:]:
        assert json.loads(request.content)["schema_version"] == "1.0"


def test_lifecycle_unavailability_always_raises_and_never_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="allow")
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("PRIVATE", request=request)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.commit_usage_sync(RESERVATION_ID, _commit_request())
    assert caught.value.reason is PylvaControlUnavailableReason.TIMEOUT
    assert caught.value.operation == "commit_usage"
    assert caught.value.reservation_id == RESERVATION_ID
    assert calls == 1


@pytest.mark.parametrize(
    ("failure", "expected_reason"),
    [
        ("lost_ack", PylvaControlUnavailableReason.TIMEOUT),
        ("network", PylvaControlUnavailableReason.NETWORK_ERROR),
        ("malformed", PylvaControlUnavailableReason.INVALID_RESPONSE),
    ],
)
def test_reservation_ownership_survives_every_commit_failure(
    failure: str,
    expected_reason: PylvaControlUnavailableReason,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(on_unavailable="allow")
    commit_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal commit_calls
        if request.url.path.endswith("/capabilities"):
            return httpx.Response(200, json=_capabilities())
        if request.url.path.endswith("/reservations"):
            return httpx.Response(200, json=_reserved())
        if request.url.path.endswith("/commit"):
            commit_calls += 1
            if failure == "lost_ack":
                # The server may have committed before the response was lost.
                raise httpx.ReadTimeout("private lost acknowledgement", request=request)
            if failure == "network":
                raise httpx.ConnectError("private network path", request=request)
            return httpx.Response(200, json={"schema_version": "1.0"})
        raise AssertionError(request.url.path)

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    reservation = control_client.reserve_usage_sync(_llm_request())
    assert reservation.decision == "reserved"
    assert pylva.should_suppress_legacy_telemetry(
        reservation,
        operation_id=OPERATION_ID,
        reservation_id=RESERVATION_ID,
    )

    with pylva.controlled_operation_ownership(reservation):
        with pytest.raises(PylvaControlUnavailableError) as caught:
            control_client.commit_usage_sync(RESERVATION_ID, _commit_request())
        assert caught.value.reason is expected_reason
        assert pylva.should_suppress_legacy_telemetry(
            operation_id=OPERATION_ID,
            reservation_id=RESERVATION_ID,
        )
    assert commit_calls == 1


@pytest.mark.parametrize(
    ("operation", "body"),
    [
        ("commit_usage_sync", _commit_request()),
        ("release_usage_sync", {"reason": "not-valid"}),
        ("extend_usage_sync", {"extension_id": "bad", "extend_by_seconds": True}),
    ],
)
def test_lifecycle_rejects_bad_ids_and_bodies(
    operation: str,
    body: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    monkeypatch.setattr(
        control_client,
        "_make_sync_client",
        lambda _timeout: pytest.fail("invalid input must not create a client"),
    )
    function = getattr(control_client, operation)
    with pytest.raises(PylvaControlValidationError):
        function("bad-reservation-id", body)


def test_lifecycle_response_correlation_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    _init()
    router = _Router(
        lambda _request: httpx.Response(
            200,
            json=_release_response(reservation_id=TRACE_ID),
        )
    )
    _install_transports(monkeypatch, router)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        control_client.release_usage_sync(
            RESERVATION_ID,
            {"reason": "provider_confirmed_uncharged"},
        )
    assert caught.value.reason is PylvaControlUnavailableReason.INVALID_RESPONSE


def test_same_identity_preserves_readiness_and_new_identity_invalidates_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_keys.append(request.headers["X-Pylva-Key"])
        return httpx.Response(200, json=_capabilities())

    router = _Router(handler)
    _install_transports(monkeypatch, router)
    _init(key=KEY_A)
    assert control_client.ready_sync() is True
    _init(key=KEY_A, on_unavailable="allow")
    assert control_client.ready_sync() is True
    _init(key=KEY_B)
    assert control_client.ready_sync() is True
    assert seen_keys == [KEY_A, KEY_B]


@pytest.mark.asyncio
async def test_identity_change_cancels_old_readiness_with_typed_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(key=KEY_A)

    class BlockingTransport(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.entered = asyncio.Event()

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            self.entered.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    transport = BlockingTransport()
    monkeypatch.setattr(
        control_client,
        "_make_async_client",
        lambda timeout: httpx.AsyncClient(transport=transport, timeout=timeout),
    )
    task = asyncio.create_task(control_client.ready())
    await transport.entered.wait()
    _init(key=KEY_B)
    with pytest.raises(PylvaControlUnavailableError) as caught:
        await task
    assert caught.value.reason is PylvaControlUnavailableReason.CONFIGURATION_CHANGED


def test_pylva_instance_methods_match_module_facade(monkeypatch: pytest.MonkeyPatch) -> None:
    _init(mode="legacy")
    instance = object.__new__(Pylva)
    module_result = control_client.reserve_usage_sync(_llm_request())
    instance_result = instance.reserve_usage_sync(_llm_request())
    assert instance_result == module_result
    assert instance_result.decision == "bypassed"


def test_public_control_symbols_are_exported() -> None:
    expected = {
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
        "ControlConfig",
        "PylvaControlUnavailableError",
        "BudgetReservationRequest",
        "controlled_operation_ownership",
        "current_controlled_operation",
        "should_suppress_legacy_telemetry",
    }
    assert expected <= set(pylva.__all__)
    assert all(hasattr(pylva, name) for name in expected)


def test_client_boundary_never_enqueues_legacy_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="legacy")
    enqueued: list[dict[str, Any]] = []
    monkeypatch.setattr("pylva.core.telemetry.enqueue", enqueued.append)
    result = control_client.reserve_usage_sync(_llm_request())
    router = _Router(lambda _request: httpx.Response(200, json=_commit_response()))
    _install_transports(monkeypatch, router)
    committed = control_client.commit_usage_sync(RESERVATION_ID, _commit_request())
    assert result.decision == "bypassed"
    assert committed.state == "committed"
    assert enqueued == []
