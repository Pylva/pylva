"""Cross-tenant cache isolation for Python SDK builder identity changes."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from pylva.core import budget_accumulator as accumulator
from pylva.core import non_llm_policy, pricing_cache, rules_cache
from pylva.core.config import get_config_generation
from pylva.core.config import init as init_config

KEY_A = "pv_live_12345678_" + "a" * 32
KEY_B = "pv_live_87654321_" + "b" * 32
ENDPOINT_A = "https://builder-a.example"
ENDPOINT_B = "https://builder-b.example"
PERIOD_START = "2026-07-14T00:00:00.000Z"


class _Response:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> dict[str, Any]:
        return self._payload


class _BlockingSyncClient:
    def __init__(
        self,
        entered: threading.Event,
        release: threading.Event,
        response: _Response,
    ) -> None:
        self._entered = entered
        self._release = release
        self._response = response

    def __enter__(self) -> _BlockingSyncClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def get(self, *_args: object, **_kwargs: object) -> _Response:
        self._entered.set()
        assert self._release.wait(timeout=2)
        return self._response

    def post(self, *_args: object, **_kwargs: object) -> _Response:
        self._entered.set()
        assert self._release.wait(timeout=2)
        return self._response


class _BlockingAsyncClient:
    def __init__(
        self,
        entered: asyncio.Event,
        release: asyncio.Event,
        response: _Response,
        exited: asyncio.Event | None = None,
    ) -> None:
        self._entered = entered
        self._release = release
        self._response = response
        self._exited = exited

    async def __aenter__(self) -> _BlockingAsyncClient:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def get(self, *_args: object, **_kwargs: object) -> _Response:
        self._entered.set()
        try:
            await self._release.wait()
            return self._response
        finally:
            if self._exited is not None:
                self._exited.set()


@pytest.fixture(autouse=True)
def _reset_owned_cache_state() -> Iterator[None]:
    accumulator._reset_accumulator_for_tests()
    pricing_cache._reset_pricing_cache_for_tests()
    rules_cache._reset_rules_cache_for_tests()
    non_llm_policy._reset_non_llm_policy_for_tests()
    yield
    accumulator._reset_accumulator_for_tests()
    pricing_cache._reset_pricing_cache_for_tests()
    rules_cache._reset_rules_cache_for_tests()
    non_llm_policy._reset_non_llm_policy_for_tests()


def _accumulator_key() -> accumulator.AccumulatorKey:
    return accumulator.AccumulatorKey(
        rule_id="rule-a",
        scope="per_customer",
        customer_id="customer-a",
        period_start=PERIOD_START,
    )


def _pricing_entry() -> pricing_cache.PricingEntry:
    return {
        "provider": "openai",
        "model": "builder-a-model",
        "input_per_1m": 1.0,
        "output_per_1m": 2.0,
    }


def _local_non_llm_policy() -> dict[str, Any]:
    return {
        "mode": "policy",
        "policy": {
            "sources": [
                {
                    "slug": "builder-a-tool",
                    "status": "tracked",
                    "matchers": ["builder_a_tool"],
                    "metric": "calls",
                    "default_metric_value": 1,
                }
            ]
        },
    }


def test_identity_change_clears_all_caches_and_cancels_timers() -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    accumulator.add(_accumulator_key(), 3.0)
    accumulator.start_sync_loop()
    rules_cache._rules.append({"id": "builder-a-rule"})
    pricing_cache._set_pricing_for_tests([_pricing_entry()])
    non_llm_policy.configure_non_llm_policy(_local_non_llm_policy())
    non_llm_policy.record_non_llm_discovery(
        tool_name="Builder A Tool",
        matcher="builder_a_tool",
        step_name="tools",
        framework="langgraph",
        status="success",
    )
    generation_a = get_config_generation()

    init_config(KEY_B, endpoint=ENDPOINT_B)

    assert get_config_generation() == generation_a + 1
    assert accumulator.get(_accumulator_key()).total_usd == 0
    assert accumulator._sync_timer is None
    assert rules_cache.get_cached_rules() == []
    assert pricing_cache.get_pricing("openai", "builder-a-model") is None
    assert non_llm_policy.decide_non_llm_tool(["builder_a_tool"]).kind == "unknown"
    assert non_llm_policy._discovery_buffer == []
    assert non_llm_policy._discovery_timer is None


def test_same_identity_reinit_preserves_builder_scoped_state() -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    generation = get_config_generation()
    accumulator.add(_accumulator_key(), 3.0)
    rules_cache._rules.append({"id": "builder-a-rule"})
    pricing_cache._set_pricing_for_tests([_pricing_entry()])
    non_llm_policy.configure_non_llm_policy(_local_non_llm_policy())

    init_config(KEY_A, endpoint=ENDPOINT_A, batch_size=17, flush_interval=1.5)

    assert get_config_generation() == generation
    assert accumulator.get(_accumulator_key()).total_usd == 3.0
    assert rules_cache.get_cached_rules() == [{"id": "builder-a-rule"}]
    assert pricing_cache.get_pricing("openai", "builder-a-model") is not None
    assert non_llm_policy.decide_non_llm_tool(["builder_a_tool"]).kind == "tracked"


def test_accumulator_rejects_old_generation_write_after_identity_change() -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    old_generation = get_config_generation()

    init_config(KEY_B, endpoint=ENDPOINT_B)
    accumulator.add(
        _accumulator_key(),
        3.0,
        expected_config_generation=old_generation,
    )

    assert accumulator.get(_accumulator_key()).total_usd == 0


def test_late_budget_sync_response_cannot_repopulate_new_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    accumulator.add(_accumulator_key(), 3.0)
    entered = threading.Event()
    release = threading.Event()
    response = _Response(
        {
            "entries": [
                {
                    "rule_id": "rule-a",
                    "scope": "per_customer",
                    "customer_id": "customer-a",
                    "period_start": PERIOD_START,
                    "server_total_usd": 99.0,
                }
            ]
        }
    )
    fake = _BlockingSyncClient(entered, release, response)
    monkeypatch.setattr(httpx, "Client", lambda **_kwargs: fake)
    thread = threading.Thread(target=accumulator.run_sync_now)
    thread.start()
    assert entered.wait(timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    release.set()
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert accumulator.get(_accumulator_key()).total_usd == 0


@pytest.mark.asyncio
async def test_late_rules_response_cannot_repopulate_new_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    entered = asyncio.Event()
    release = asyncio.Event()
    fake = _BlockingAsyncClient(
        entered,
        release,
        _Response({"rules": [{"id": "builder-a-rule"}]}),
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fake)
    epoch = rules_cache._cache_epoch
    generation = get_config_generation()
    task = asyncio.create_task(
        rules_cache._refresh(
            100.0,
            epoch=epoch,
            config_generation=generation,
            api_key=KEY_A,
            endpoint=ENDPOINT_A,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    release.set()
    await asyncio.wait_for(task, timeout=2)

    assert rules_cache.get_cached_rules() == []
    assert rules_cache.is_passthrough() is False


@pytest.mark.asyncio
async def test_rules_hook_cancels_registered_refresh_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    entered = asyncio.Event()
    release = asyncio.Event()
    exited = asyncio.Event()
    fake = _BlockingAsyncClient(
        entered,
        release,
        _Response({"rules": [{"id": "builder-a-rule"}]}),
        exited,
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fake)
    task = asyncio.create_task(rules_cache.ensure_rules_cache())
    await asyncio.wait_for(entered.wait(), timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    await asyncio.wait_for(task, timeout=2)
    await asyncio.wait_for(exited.wait(), timeout=2)

    assert rules_cache._in_flight is None
    assert rules_cache.get_cached_rules() == []


@pytest.mark.asyncio
async def test_late_pricing_response_cannot_repopulate_new_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    entered = asyncio.Event()
    release = asyncio.Event()
    fake = _BlockingAsyncClient(
        entered,
        release,
        _Response(
            {
                "models": [
                    {
                        "provider": "openai",
                        "model": "builder-a-model",
                        "input_per_1m": 1,
                        "output_per_1m": 2,
                    }
                ]
            }
        ),
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fake)
    task = asyncio.create_task(pricing_cache.ensure_pricing_cache())
    await asyncio.wait_for(entered.wait(), timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    release.set()
    await asyncio.wait_for(task, timeout=2)

    assert pricing_cache.get_pricing("openai", "builder-a-model") is None


@pytest.mark.asyncio
async def test_pricing_hook_cancels_background_refresh_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    entered = asyncio.Event()
    release = asyncio.Event()
    exited = asyncio.Event()
    fake = _BlockingAsyncClient(
        entered,
        release,
        _Response({"models": []}),
        exited,
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fake)
    pricing_cache.ensure_pricing_cache_background()
    await asyncio.wait_for(entered.wait(), timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    await asyncio.wait_for(exited.wait(), timeout=2)
    await asyncio.sleep(0)

    assert pricing_cache._refresh_task is None
    assert pricing_cache._refresh_in_flight is False


def test_late_non_llm_policy_response_cannot_repopulate_new_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_config(KEY_A, endpoint=ENDPOINT_A)
    entered = threading.Event()
    release = threading.Event()
    response = _Response(
        {
            "version": "builder-a",
            "refresh_after_ms": 60_000,
            "unknown_behavior": "discover_only",
            "sources": [
                {
                    "slug": "builder-a-tool",
                    "status": "tracked",
                    "matchers": ["builder_a_tool"],
                    "metric": "calls",
                    "default_metric_value": 1,
                }
            ],
        }
    )
    fake = _BlockingSyncClient(entered, release, response)
    monkeypatch.setattr(httpx, "Client", lambda **_kwargs: fake)
    thread = threading.Thread(target=non_llm_policy.ensure_non_llm_policy)
    thread.start()
    assert entered.wait(timeout=2)

    init_config(KEY_B, endpoint=ENDPOINT_B)
    release.set()
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert non_llm_policy.decide_non_llm_tool(["builder_a_tool"]).kind == "unknown"
