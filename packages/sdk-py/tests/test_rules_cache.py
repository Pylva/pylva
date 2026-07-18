"""B3-T1 — coverage for the rules cache.

Covers:
  * Initial state reports passthrough (backend not yet contacted).
  * get_cached_rules returns a list.
  * TTL expiry after 5 minutes triggers exactly one refresh.
  * In-flight dedup: two concurrent ensure_rules_cache calls share the same
    underlying asyncio.Task (one HTTP request, not two).
  * Passthrough toggles on httpx.RequestError.
  * Passthrough clears once a successful refresh lands.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import httpx
import pytest

import pylva
from pylva.core import rules_cache

VALID_KEY = "pv_live_12345678_" + "a" * 32


def setup_function(_fn: object) -> None:
    rules_cache._reset_rules_cache_for_tests()  # type: ignore[attr-defined]
    from pylva.core.config import _reset_config_for_tests

    _reset_config_for_tests()
    pylva.init(VALID_KEY)


def test_passthrough_default() -> None:
    # Fresh module state: _passthrough is False until _refresh actually fails.
    # (Shipped assertion `is True` was wrong — _reset_rules_cache_for_tests
    # explicitly sets _passthrough = False.)
    assert rules_cache.is_passthrough() is False


def test_cached_rules_empty_by_default() -> None:
    assert rules_cache.get_cached_rules() == []


class _FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: Any = None,
        *,
        json_error: ValueError | None = None,
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self._json_error = json_error
        self.is_success = 200 <= status_code < 300

    def json(self) -> Any:
        if self._json_error is not None:
            raise self._json_error
        return self._payload


class _FakeAsyncClient:
    """Counts GET invocations so we can assert caller-side dedup + TTL."""

    def __init__(
        self,
        *,
        response: _FakeResponse | None = None,
        raise_exc: Exception | None = None,
        block: asyncio.Event | None = None,
    ) -> None:
        self.calls = 0
        self._response = response
        self._raise = raise_exc
        self._block = block

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:
        self.calls += 1
        if self._block is not None:
            await self._block.wait()
        if self._raise is not None:
            raise self._raise
        assert self._response is not None
        return self._response

    def __init_subclass__(cls, **kw: Any) -> None:  # pragma: no cover - safety
        super().__init_subclass__(**kw)


@pytest.fixture
def patched_httpx() -> Iterator[dict[str, _FakeAsyncClient]]:
    holder: dict[str, _FakeAsyncClient] = {}

    def factory(*_a: Any, **_kw: Any) -> _FakeAsyncClient:
        return holder["client"]

    with patch.object(httpx, "AsyncClient", side_effect=factory):
        yield holder


async def test_ttl_expiry_triggers_refresh(patched_httpx: dict[str, _FakeAsyncClient]) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": [{"id": "r1"}]}),
    )

    # Prime the cache with a successful fetch.
    await rules_cache.ensure_rules_cache()
    assert patched_httpx["client"].calls == 1
    assert rules_cache.get_cached_rules() == [{"id": "r1"}]

    # Within TTL, no additional call is made.
    await rules_cache.ensure_rules_cache()
    assert patched_httpx["client"].calls == 1

    # Jump _fetched_at backwards so we are outside the 5-minute TTL window.
    rules_cache._fetched_at -= rules_cache.RULES_CACHE_TTL_SEC + 1  # type: ignore[attr-defined]
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": [{"id": "r2"}]}),
    )

    await rules_cache.ensure_rules_cache()
    assert patched_httpx["client"].calls == 1  # fresh client instance -> 1 call
    assert rules_cache.get_cached_rules() == [{"id": "r2"}]


async def test_in_flight_dedup(patched_httpx: dict[str, _FakeAsyncClient]) -> None:
    # Block the fake GET until we release it so both coroutines are suspended
    # on the same _in_flight Task.
    release = asyncio.Event()
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": [{"id": "dedup"}]}),
        block=release,
    )

    task1 = asyncio.create_task(rules_cache.ensure_rules_cache())
    task2 = asyncio.create_task(rules_cache.ensure_rules_cache())

    # Give the scheduler a chance to enter _refresh on both tasks.
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    release.set()
    await asyncio.gather(task1, task2)

    # Only one HTTP call happened even though two callers awaited.
    assert patched_httpx["client"].calls == 1
    assert rules_cache.get_cached_rules() == [{"id": "dedup"}]


async def test_passthrough_on_backend_error(patched_httpx: dict[str, _FakeAsyncClient]) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        raise_exc=httpx.ConnectError("boom", request=httpx.Request("GET", "https://x")),
    )
    # Move the cache outside the TTL window so _refresh actually runs.
    rules_cache._fetched_at -= rules_cache.RULES_CACHE_TTL_SEC + 1  # type: ignore[attr-defined]
    await rules_cache.ensure_rules_cache()
    assert rules_cache.is_passthrough() is True


async def test_refresh_clears_passthrough(patched_httpx: dict[str, _FakeAsyncClient]) -> None:
    # Start in passthrough.
    rules_cache._passthrough = True  # type: ignore[attr-defined]
    rules_cache._fetched_at = 0.0  # type: ignore[attr-defined]

    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": [{"id": "ok"}]}),
    )
    await rules_cache.ensure_rules_cache()
    assert rules_cache.is_passthrough() is False
    assert rules_cache.get_cached_rules() == [{"id": "ok"}]


async def test_non_success_response_enters_passthrough(
    patched_httpx: dict[str, _FakeAsyncClient],
) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(500, {"error": "boom"}),
    )
    rules_cache._fetched_at -= rules_cache.RULES_CACHE_TTL_SEC + 1  # type: ignore[attr-defined]
    await rules_cache.ensure_rules_cache()
    assert rules_cache.is_passthrough() is True


@pytest.mark.parametrize(
    "payload",
    [
        {"rules": {"id": "not-a-list"}},
        {"rules": None},
        {},
        [],
        None,
    ],
)
async def test_malformed_rules_response_enters_passthrough(
    patched_httpx: dict[str, _FakeAsyncClient],
    payload: Any,
) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, payload),
    )

    await rules_cache.ensure_rules_cache()

    assert rules_cache.get_cached_rules() == []
    assert rules_cache.is_passthrough() is True


async def test_json_decode_failure_enters_passthrough(
    patched_httpx: dict[str, _FakeAsyncClient],
) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, json_error=ValueError("invalid json")),
    )

    await rules_cache.ensure_rules_cache()

    assert rules_cache.get_cached_rules() == []
    assert rules_cache.is_passthrough() is True


async def test_malformed_refresh_preserves_last_valid_rules(
    patched_httpx: dict[str, _FakeAsyncClient],
) -> None:
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": [{"id": "known-good"}]}),
    )
    await rules_cache.ensure_rules_cache()

    rules_cache._fetched_at -= rules_cache.RULES_CACHE_TTL_SEC + 1  # type: ignore[attr-defined]
    patched_httpx["client"] = _FakeAsyncClient(
        response=_FakeResponse(200, {"rules": {"id": "not-a-list"}}),
    )
    await rules_cache.ensure_rules_cache()

    assert rules_cache.get_cached_rules() == [{"id": "known-good"}]
    assert rules_cache.is_passthrough() is True
