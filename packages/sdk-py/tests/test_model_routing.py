"""B4-T1 model_routing — Python parity tests for the TS suite in
``packages/sdk-ts/tests/model_routing.test.ts``."""

from __future__ import annotations

import pytest

from pylva.core.model_routing import (
    ModelRoutingFallback,
    attempt_with_fallback,
    should_fallback,
)

ALL_FALLBACK = ModelRoutingFallback(
    on_cross_provider_auth_error=True,
    on_access_denied=True,
    on_model_not_found=True,
    use_original_model=True,
    skip_same_provider_401=True,
)


# ---------- shouldFallback (status classification) -----------------------------


def test_cross_provider_401_falls_back() -> None:
    assert should_fallback(401, ALL_FALLBACK, is_same_provider=False) is True


def test_same_provider_401_does_not_fall_back_when_skip_set() -> None:
    assert should_fallback(401, ALL_FALLBACK, is_same_provider=True) is False


def test_403_always_falls_back_when_on_access_denied() -> None:
    assert should_fallback(403, ALL_FALLBACK, is_same_provider=False) is True
    assert should_fallback(403, ALL_FALLBACK, is_same_provider=True) is True


def test_404_always_falls_back_when_on_model_not_found() -> None:
    assert should_fallback(404, ALL_FALLBACK, is_same_provider=False) is True
    assert should_fallback(404, ALL_FALLBACK, is_same_provider=True) is True


def test_429_does_not_fall_back() -> None:
    assert should_fallback(429, ALL_FALLBACK, is_same_provider=False) is False
    assert should_fallback(429, ALL_FALLBACK, is_same_provider=True) is False


def test_500_does_not_fall_back() -> None:
    assert should_fallback(500, ALL_FALLBACK, is_same_provider=False) is False


def test_use_original_model_false_blocks_all_paths() -> None:
    cfg = ModelRoutingFallback(
        on_cross_provider_auth_error=True,
        on_access_denied=True,
        on_model_not_found=True,
        use_original_model=False,
        skip_same_provider_401=True,
    )
    assert should_fallback(401, cfg, is_same_provider=False) is False
    assert should_fallback(403, cfg, is_same_provider=False) is False
    assert should_fallback(404, cfg, is_same_provider=False) is False


def test_per_status_flags_respected() -> None:
    cfg = ModelRoutingFallback(
        on_cross_provider_auth_error=False,
        on_access_denied=False,
        on_model_not_found=True,
        use_original_model=True,
        skip_same_provider_401=True,
    )
    assert should_fallback(401, cfg, is_same_provider=False) is False
    assert should_fallback(403, cfg, is_same_provider=False) is False
    assert should_fallback(404, cfg, is_same_provider=False) is True


# ---------- attempt_with_fallback (orchestration) ------------------------------


class _ProviderError(Exception):
    def __init__(self, status: int, message: str = "err") -> None:
        super().__init__(message)
        self.status = status


@pytest.mark.asyncio
async def test_returns_routed_result_on_success() -> None:
    calls: list[str] = []

    async def call(model: str) -> dict:
        calls.append(model)
        return {"value": model}

    out = await attempt_with_fallback(
        call=call,
        routed_model="gpt-4o-mini",
        original_model="gpt-4o",
        is_same_provider=True,
        fallback=ALL_FALLBACK,
    )
    assert out.fell_back is False
    assert out.model_used == "gpt-4o-mini"
    assert out.result == {"value": "gpt-4o-mini"}
    assert calls == ["gpt-4o-mini"]


@pytest.mark.asyncio
async def test_falls_back_on_cross_provider_401() -> None:
    calls: list[str] = []

    async def call(model: str) -> dict:
        calls.append(model)
        if model == "mistral-small":
            raise _ProviderError(401, "auth")
        return {"value": model}

    out = await attempt_with_fallback(
        call=call,
        routed_model="mistral-small",
        original_model="gpt-4o",
        is_same_provider=False,
        fallback=ALL_FALLBACK,
    )
    assert out.fell_back is True
    assert out.model_used == "gpt-4o"
    assert out.fallback_reason == "routing_fallback_auth_401"
    assert calls == ["mistral-small", "gpt-4o"]


@pytest.mark.asyncio
async def test_does_not_retry_on_same_provider_401() -> None:
    calls: list[str] = []

    async def call(model: str) -> dict:
        calls.append(model)
        raise _ProviderError(401, "auth")

    with pytest.raises(_ProviderError):
        await attempt_with_fallback(
            call=call,
            routed_model="gpt-4o-mini",
            original_model="gpt-4o",
            is_same_provider=True,
            fallback=ALL_FALLBACK,
        )
    assert calls == ["gpt-4o-mini"]


@pytest.mark.asyncio
async def test_does_not_retry_on_429() -> None:
    calls: list[str] = []

    async def call(model: str) -> dict:
        calls.append(model)
        raise _ProviderError(429, "rate limit")

    with pytest.raises(_ProviderError):
        await attempt_with_fallback(
            call=call,
            routed_model="gpt-4o-mini",
            original_model="gpt-4o",
            is_same_provider=False,
            fallback=ALL_FALLBACK,
        )
    assert calls == ["gpt-4o-mini"]


@pytest.mark.asyncio
async def test_does_not_retry_on_500() -> None:
    calls: list[str] = []

    async def call(model: str) -> dict:
        calls.append(model)
        raise _ProviderError(500, "server error")

    with pytest.raises(_ProviderError):
        await attempt_with_fallback(
            call=call,
            routed_model="gpt-4o-mini",
            original_model="gpt-4o",
            is_same_provider=True,
            fallback=ALL_FALLBACK,
        )
    assert calls == ["gpt-4o-mini"]


@pytest.mark.asyncio
async def test_falls_back_on_403() -> None:
    async def call(model: str) -> dict:
        if model == "gpt-4o-mini":
            raise _ProviderError(403, "access denied")
        return {"value": model}

    out = await attempt_with_fallback(
        call=call,
        routed_model="gpt-4o-mini",
        original_model="gpt-4o",
        is_same_provider=True,
        fallback=ALL_FALLBACK,
    )
    assert out.fell_back is True
    assert out.fallback_reason == "routing_fallback_access_403"


@pytest.mark.asyncio
async def test_falls_back_on_404() -> None:
    async def call(model: str) -> dict:
        if model == "gpt-4o-mini":
            raise _ProviderError(404, "not found")
        return {"value": model}

    out = await attempt_with_fallback(
        call=call,
        routed_model="gpt-4o-mini",
        original_model="gpt-4o",
        is_same_provider=True,
        fallback=ALL_FALLBACK,
    )
    assert out.fell_back is True
    assert out.fallback_reason == "routing_fallback_not_found_404"


@pytest.mark.asyncio
async def test_propagates_fallback_call_errors() -> None:
    attempt = {"n": 0}

    async def call(model: str) -> dict:
        attempt["n"] += 1
        status = 403 if attempt["n"] == 1 else 500
        raise _ProviderError(status, "always fails")

    with pytest.raises(_ProviderError):
        await attempt_with_fallback(
            call=call,
            routed_model="gpt-4o-mini",
            original_model="gpt-4o",
            is_same_provider=True,
            fallback=ALL_FALLBACK,
        )
    assert attempt["n"] == 2


# ---------- _extract_status: provider SDK shape variance ---------------------


@pytest.mark.asyncio
async def test_extracts_status_from_response_attribute() -> None:
    """Anthropic's APIError surfaces status_code under .response.status_code,
    not .status. The extractor should still classify."""

    class _Response:
        def __init__(self, code: int) -> None:
            self.status_code = code

    class _AnthropicLikeError(Exception):
        def __init__(self, code: int) -> None:
            super().__init__("err")
            self.response = _Response(code)

    async def call(model: str) -> dict:
        if model == "claude-future":
            raise _AnthropicLikeError(404)
        return {"value": model}

    out = await attempt_with_fallback(
        call=call,
        routed_model="claude-future",
        original_model="claude-sonnet",
        is_same_provider=True,
        fallback=ALL_FALLBACK,
    )
    assert out.fell_back is True
    assert out.fallback_reason == "routing_fallback_not_found_404"
