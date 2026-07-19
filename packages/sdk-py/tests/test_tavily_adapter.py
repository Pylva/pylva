"""Official one-credit Tavily Search adapter tests."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any, cast

import pytest

from pylva.adapters.tavily import (
    controlled_tavily_search,
    controlled_tavily_search_sync,
)
from pylva.core import controlled_usage as controlled
from pylva.core import telemetry
from pylva.core.config import get_config_generation, require_config
from pylva.core.config import init as init_config
from pylva.core.control_ownership import _register_controlled_reservation
from pylva.core.control_schema import BudgetCommitResponse, ReservedBudgetDecision
from pylva.errors.budget_exceeded import BudgetExceededSource, PylvaBudgetExceeded
from pylva.errors.control import PylvaControlValidationError

KEY = "pv_live_12345678_" + "a" * 32
RESERVATION_ID = "33333333-3333-4333-8333-333333333333"
DECISION_ID = "55555555-5555-4555-8555-555555555555"


def _init() -> None:
    init_config(
        KEY,
        endpoint="https://control.test",
        control={"mode": "enforce", "on_unavailable": "deny"},
    )


def _install_control(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    reserves: list[dict[str, object]] = []
    commits: list[dict[str, object]] = []

    def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        reserves.append(request)
        response = ReservedBudgetDecision.model_validate(
            {
                "schema_version": "1.0",
                "decision": "reserved",
                "allowed": True,
                "decision_id": DECISION_ID,
                "operation_id": request["operation_id"],
                "reservation_id": RESERVATION_ID,
                "state": "reserved",
                "reserved_usd": "1",
                "remaining_usd": "9",
                "expires_at": "2026-07-14T00:05:00Z",
                "warnings": [],
            },
            strict=True,
        )
        assert _register_controlled_reservation(
            response,
            require_config(),
            get_config_generation(),
        )
        return response

    def commit(_reservation_id: str, request: dict[str, object]) -> BudgetCommitResponse:
        commits.append(request)
        actual = str(request["actual_value"])
        overage = "1" if actual == "2" else "0"
        return BudgetCommitResponse.model_validate(
            {
                "schema_version": "1.0",
                "state": "committed",
                "reservation_id": RESERVATION_ID,
                "operation_id": reserves[-1]["operation_id"],
                "reserved_usd": "1",
                "actual_usd": actual,
                "released_usd": "0",
                "overage_usd": overage,
                "budget_exceeded_after_commit": actual == "2",
                "committed_at": "2026-07-14T00:01:00Z",
                "idempotent_replay": False,
                "late": False,
            },
            strict=True,
        )

    async def reserve_async(request: dict[str, object]) -> ReservedBudgetDecision:
        return reserve(request)

    async def commit_async(
        reservation_id: str,
        request: dict[str, object],
    ) -> BudgetCommitResponse:
        return commit(reservation_id, request)

    monkeypatch.setattr(controlled, "reserve_usage_sync", reserve)
    monkeypatch.setattr(controlled, "commit_usage_sync", commit)
    monkeypatch.setattr(controlled, "reserve_usage", reserve_async)
    monkeypatch.setattr(controlled, "commit_usage", commit_async)
    return reserves, commits


class SyncClient:
    def __init__(self, credits: object) -> None:
        self.credits = credits
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def search(self, query: str, **kwargs: Any) -> dict[str, object]:
        self.calls.append((query, kwargs))
        return {
            "query": query,
            "results": [{"url": "https://private.example"}],
            "usage": {"credits": self.credits},
        }


class AsyncClient(SyncClient):
    async def search(self, query: str, **kwargs: Any) -> dict[str, object]:
        return super().search(query, **kwargs)


def _authoritative_denial() -> PylvaBudgetExceeded:
    return PylvaBudgetExceeded(
        source=BudgetExceededSource.AUTHORITATIVE_CONTROL,
        rule_id="rule-denied",
        customer_id="customer_acme",
        period="day",
        period_start="2026-07-14T00:00:00.000Z",
        limit_usd=1.0,
        accumulated_usd=1.0,
        estimated_usd=0.1,
    )


def test_basic_search_uses_exact_identity_and_keeps_query_out_of_control(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _init()
    reserves, commits = _install_control(monkeypatch)
    query = "private research https://secret.example"
    client = SyncClient(1)

    result = controlled_tavily_search_sync(
        client,
        query,
        customer_id="customer_acme",
        search_options={"max_results": 3, "include_usage": False},
    )

    assert client.calls == [
        (
            query,
            {
                "max_results": 3,
                "include_usage": True,
                "search_depth": "basic",
                "auto_parameters": False,
            },
        )
    ]
    assert reserves[0]["cost_source_slug"] == "tavily-search"
    assert reserves[0]["tool_name"] == "Tavily Search"
    assert reserves[0]["metric"] == "credit"
    assert reserves[0]["maximum_value"] == "1"
    assert query not in str(reserves[0])
    assert commits[0]["actual_value"] == "1"
    assert result.control.settlement == "committed"
    assert query not in str(result.control)
    assert query not in capsys.readouterr().out


def test_sync_authoritative_denial_performs_no_provider_or_settlement_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    reserves: list[dict[str, object]] = []
    lifecycle_calls: list[str] = []
    denial = _authoritative_denial()
    client = SyncClient(1)

    def deny(request: dict[str, object]) -> object:
        reserves.append(request)
        raise denial

    monkeypatch.setattr(controlled, "reserve_usage_sync", deny)
    monkeypatch.setattr(
        controlled,
        "commit_usage_sync",
        lambda *_args: lifecycle_calls.append("commit"),
    )
    monkeypatch.setattr(
        controlled,
        "release_usage_sync",
        lambda *_args: lifecycle_calls.append("release"),
    )

    with pytest.raises(PylvaBudgetExceeded) as caught:
        controlled_tavily_search_sync(
            client,
            "private query",
            customer_id="customer_acme",
        )

    assert caught.value is denial
    assert len(reserves) == 1
    assert client.calls == []
    assert lifecycle_calls == []
    assert telemetry.buffer_size() == 0


@pytest.mark.asyncio
async def test_async_authoritative_denial_performs_no_provider_or_settlement_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    telemetry._reset_telemetry_for_tests()  # type: ignore[attr-defined]
    reserves: list[dict[str, object]] = []
    lifecycle_calls: list[str] = []
    denial = _authoritative_denial()
    client = AsyncClient(1)

    async def deny(request: dict[str, object]) -> object:
        reserves.append(request)
        raise denial

    async def unexpected(kind: str, *_args: object) -> None:
        lifecycle_calls.append(kind)

    monkeypatch.setattr(controlled, "reserve_usage", deny)
    monkeypatch.setattr(
        controlled,
        "commit_usage",
        lambda *_args: unexpected("commit"),
    )
    monkeypatch.setattr(
        controlled,
        "release_usage",
        lambda *_args: unexpected("release"),
    )

    with pytest.raises(PylvaBudgetExceeded) as caught:
        await controlled_tavily_search(
            client,
            "private query",
            customer_id="customer_acme",
        )

    assert caught.value is denial
    assert len(reserves) == 1
    assert client.calls == []
    assert lifecycle_calls == []
    assert telemetry.buffer_size() == 0


def test_sync_search_detaches_nested_options_and_binds_transport_before_reserve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _, commits = _install_control(monkeypatch)
    original_reserve = controlled.reserve_usage_sync
    caller_options: dict[str, object] = {
        "max_results": 3,
        "include_domains": ["original.example"],
        "nested": {
            "filters": [{"score": 1.5, "enabled": True, "missing": None}],
        },
    }
    client = SyncClient(1)
    replacement_calls: list[object] = []

    def replacement(*args: object, **kwargs: object) -> dict[str, object]:
        replacement_calls.append((args, kwargs))
        return {"usage": {"credits": 2}}

    def delayed_reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        domains = caller_options["include_domains"]
        assert isinstance(domains, list)
        domains.append("mutated.example")
        caller_options["max_results"] = 99
        nested = caller_options["nested"]
        assert isinstance(nested, dict)
        nested["filters"] = []
        client.search = replacement  # type: ignore[method-assign,assignment]
        return original_reserve(request)

    monkeypatch.setattr(controlled, "reserve_usage_sync", delayed_reserve)
    result = controlled_tavily_search_sync(
        client,
        "private",
        customer_id="customer_acme",
        search_options=caller_options,
    )

    assert replacement_calls == []
    assert client.calls == [
        (
            "private",
            {
                "max_results": 3,
                "include_domains": ["original.example"],
                "nested": {
                    "filters": [{"score": 1.5, "enabled": True, "missing": None}],
                },
                "search_depth": "basic",
                "auto_parameters": False,
                "include_usage": True,
            },
        )
    ]
    assert commits[0]["actual_value"] == "1"
    assert result.control.settlement == "committed"


@pytest.mark.asyncio
async def test_async_search_detaches_nested_options_and_binds_transport_before_reserve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _, commits = _install_control(monkeypatch)
    original_reserve = controlled.reserve_usage
    caller_options: dict[str, object] = {"include_domains": ["original.example"]}
    client = AsyncClient(1)
    replacement_calls: list[object] = []

    async def replacement(*args: object, **kwargs: object) -> dict[str, object]:
        replacement_calls.append((args, kwargs))
        return {"usage": {"credits": 2}}

    async def delayed_reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        domains = caller_options["include_domains"]
        assert isinstance(domains, list)
        domains.append("mutated.example")
        client.search = replacement  # type: ignore[method-assign,assignment]
        return await original_reserve(request)

    monkeypatch.setattr(controlled, "reserve_usage", delayed_reserve)
    result = await controlled_tavily_search(
        client,
        "private",
        customer_id="customer_acme",
        search_options=caller_options,
    )

    assert replacement_calls == []
    assert client.calls == [
        (
            "private",
            {
                "include_domains": ["original.example"],
                "search_depth": "basic",
                "auto_parameters": False,
                "include_usage": True,
            },
        )
    ]
    assert commits[0]["actual_value"] == "1"
    assert result.control.settlement == "committed"


def test_hostile_and_oversized_options_refuse_without_executing_hooks_or_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    control_calls: list[object] = []
    monkeypatch.setattr(
        controlled, "reserve_usage_sync", lambda request: control_calls.append(request)
    )
    client = SyncClient(1)

    hook_calls = 0

    class HostileMapping(Mapping[str, object]):
        def __getitem__(self, _key: str) -> object:
            nonlocal hook_calls
            hook_calls += 1
            raise AssertionError("mapping hook executed")

        def __iter__(self) -> Iterator[str]:
            nonlocal hook_calls
            hook_calls += 1
            raise AssertionError("mapping hook executed")

        def __len__(self) -> int:
            nonlocal hook_calls
            hook_calls += 1
            raise AssertionError("mapping hook executed")

    class DictSubclass(dict[str, object]):
        pass

    class ListSubclass(list[object]):
        pass

    class Uncopyable:
        def __deepcopy__(self, _memo: object) -> object:
            nonlocal hook_calls
            hook_calls += 1
            raise TypeError("cannot detach")

    cycle: dict[str, object] = {}
    cycle["self"] = cycle
    shared_child: dict[str, object] = {"value": "shared"}
    shared = {"first": shared_child, "second": shared_child}
    too_deep: dict[str, object] = {"leaf": True}
    for _depth in range(10):
        too_deep = {"child": too_deep}
    too_many_nodes = {"groups": [[1] * 256 for _group in range(5)]}
    hostile: list[tuple[str, object]] = [
        ("custom mapping", HostileMapping()),
        ("dict subclass", DictSubclass(value="custom")),
        ("list subclass", {"values": ListSubclass([1])}),
        ("custom class", {"opaque": Uncopyable()}),
        ("tuple", {"values": (1, 2)}),
        ("cycle", cycle),
        ("shared graph", shared),
        ("top-level __proto__", {"__proto__": {"polluted": True}}),
        ("nested __proto__", {"nested": {"__proto__": True}}),
        ("too many keys", {f"key{index}": index for index in range(129)}),
        ("array too long", {"values": [1] * 257}),
        ("string too long", {"value": "x" * 16_385}),
        ("key too long", {"x" * 129: True}),
        ("too deep", too_deep),
        ("too many nodes", too_many_nodes),
        ("non-finite", {"value": float("inf")}),
        ("unsafe integer", {"value": 9_007_199_254_740_992}),
    ]

    for _label, search_options in hostile:
        with pytest.raises(PylvaControlValidationError, match="controlled_tavily_search"):
            controlled_tavily_search_sync(
                client,
                "private",
                customer_id="customer_acme",
                search_options=cast(Any, search_options),
            )

    assert hook_calls == 0
    assert control_calls == []
    assert client.calls == []


def test_client_search_descriptor_is_rejected_without_invoking_getter_or_control(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    control_calls: list[object] = []
    monkeypatch.setattr(
        controlled, "reserve_usage_sync", lambda request: control_calls.append(request)
    )
    getter_calls = 0

    class AccessorClient:
        @property
        def search(self) -> object:
            nonlocal getter_calls
            getter_calls += 1
            raise AssertionError("search getter executed")

    with pytest.raises(PylvaControlValidationError):
        controlled_tavily_search_sync(
            cast(Any, AccessorClient()),
            "private",
            customer_id="customer_acme",
        )

    assert getter_calls == 0
    assert control_calls == []


def test_unexpected_two_credits_commit_as_bound_violation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _, commits = _install_control(monkeypatch)
    result = controlled_tavily_search_sync(
        SyncClient(2),
        "private",
        customer_id="customer_acme",
    )
    assert commits[0]["actual_value"] == "2"
    assert result.control.actual_value == "2"
    assert result.control.bound_violated is True


@pytest.mark.parametrize(
    "options",
    [
        {"search_depth": "advanced"},
        {"auto_parameters": True},
        {"search_options": {"search_depth": "advanced"}},
        {"search_options": {"auto_parameters": True}},
        {"search_options": {"searchDepth": "advanced"}},
        {"search_options": {"autoParameters": True}},
        {"search_options": {"includeUsage": False}},
    ],
)
def test_advanced_and_auto_modes_refuse_before_control_and_provider(
    monkeypatch: pytest.MonkeyPatch,
    options: dict[str, object],
) -> None:
    _init()
    control_calls: list[object] = []
    monkeypatch.setattr(
        controlled, "reserve_usage_sync", lambda request: control_calls.append(request)
    )
    client = SyncClient(1)
    with pytest.raises(PylvaControlValidationError):
        controlled_tavily_search_sync(
            client,
            "private",
            customer_id="customer_acme",
            **options,
        )
    assert control_calls == []
    assert client.calls == []


@pytest.mark.parametrize("credits", [None, 0, 1.0])
def test_missing_zero_or_binary_float_usage_leaves_reservation_unresolved(
    monkeypatch: pytest.MonkeyPatch,
    credits: object,
) -> None:
    _init()
    _, commits = _install_control(monkeypatch)
    client = SyncClient(credits)
    result = controlled_tavily_search_sync(
        client,
        "private",
        customer_id="customer_acme",
    )
    assert result.value["query"] == "private"
    assert result.control.settlement == "unresolved"
    assert result.control.issue == "usage_extraction_failed"
    assert commits == []


@pytest.mark.asyncio
async def test_async_tavily_client_uses_same_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    _init()
    reserves, commits = _install_control(monkeypatch)
    result = await controlled_tavily_search(
        AsyncClient(1),
        "private",
        customer_id="customer_acme",
    )
    assert result.control.settlement == "committed"
    assert reserves[0]["cost_source_slug"] == "tavily-search"
    assert commits[0]["actual_value"] == "1"
