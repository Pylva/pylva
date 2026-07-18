"""Authoritative one-credit Tavily Search adapter.

Only ``search_depth="basic"`` with ``auto_parameters=False`` is accepted by
this adapter.  Advanced or automatic search belongs on the generic bounded
helper with an explicit two-credit maximum and a response usage extractor.
"""

from __future__ import annotations

import inspect
import math
from collections.abc import Awaitable, Callable, Mapping
from types import FunctionType, MethodType
from typing import Any, Protocol, TypeVar, cast

from ..core.control_ownership import _controlled_local_no_dispatch
from ..core.controlled_usage import (
    ControlledUsageResult,
    controlled_usage,
    controlled_usage_sync,
)
from ..errors.control import PylvaControlValidationError

T = TypeVar("T")
T_co = TypeVar("T_co", covariant=True)

TAVILY_SEARCH_COST_SOURCE_SLUG = "tavily-search"
TAVILY_SEARCH_TOOL_NAME = "Tavily Search"
TAVILY_SEARCH_METRIC = "credit"
TAVILY_BASIC_SEARCH_CREDITS = "1"
_MAX_OPTION_DEPTH = 8
_MAX_OPTION_NODES = 1_024
_MAX_OPTION_KEYS = 128
_MAX_OPTION_KEY_LENGTH = 128
_MAX_OPTION_ARRAY_LENGTH = 256
_MAX_OPTION_STRING_LENGTH = 16_384
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MISSING = object()


def _validation_error() -> PylvaControlValidationError:
    _controlled_local_no_dispatch("tool")
    return PylvaControlValidationError("controlled_tavily_search")


class TavilySyncSearchClient(Protocol[T_co]):
    def search(self, query: str, **kwargs: Any) -> T_co: ...


class TavilyAsyncSearchClient(Protocol[T_co]):
    def search(self, query: str, **kwargs: Any) -> Awaitable[T_co]: ...


def _snapshot_plain_json(
    value: object,
    *,
    seen: set[int],
    nodes: list[int],
    depth: int = 0,
) -> object:
    """Copy one bounded tree without invoking custom container hooks."""

    nodes[0] += 1
    if nodes[0] > _MAX_OPTION_NODES or depth > _MAX_OPTION_DEPTH:
        raise _validation_error()
    value_type = type(value)
    if value is None or value_type is bool:
        return value
    if value_type is str:
        if len(cast(str, value)) > _MAX_OPTION_STRING_LENGTH:
            raise _validation_error()
        return value
    if value_type is int:
        if abs(cast(int, value)) > _MAX_SAFE_INTEGER:
            raise _validation_error()
        return value
    if value_type is float:
        if not math.isfinite(cast(float, value)):
            raise _validation_error()
        return value
    if value_type not in {dict, list}:
        raise _validation_error()

    identity = id(value)
    if identity in seen:
        raise _validation_error()
    seen.add(identity)
    if value_type is list:
        source = cast(list[object], value)
        if len(source) > _MAX_OPTION_ARRAY_LENGTH:
            raise _validation_error()
        return [
            _snapshot_plain_json(item, seen=seen, nodes=nodes, depth=depth + 1) for item in source
        ]

    source_record = cast(dict[object, object], value)
    if len(source_record) > _MAX_OPTION_KEYS:
        raise _validation_error()
    snapshot: dict[str, object] = {}
    for key, item in source_record.items():
        if type(key) is not str or key == "__proto__" or len(key) > _MAX_OPTION_KEY_LENGTH:
            raise _validation_error()
        snapshot[key] = _snapshot_plain_json(
            item,
            seen=seen,
            nodes=nodes,
            depth=depth + 1,
        )
    return snapshot


def _options(
    search_options: Mapping[str, Any] | None,
    *,
    search_depth: str,
    auto_parameters: bool,
) -> dict[str, Any]:
    if search_depth != "basic" or auto_parameters is not False:
        raise _validation_error()
    # Do not iterate arbitrary Mapping implementations or subclasses: their
    # hooks can execute user code during the authoritative validation boundary.
    if search_options is not None and type(search_options) is not dict:
        raise _validation_error()
    detached = _snapshot_plain_json(
        search_options if search_options is not None else {},
        seen=set(),
        nodes=[0],
    )
    if type(detached) is not dict:  # pragma: no cover - defensive narrowing
        raise _validation_error()
    options = cast(dict[str, Any], detached)
    supplied_depth = options.get("search_depth", "basic")
    supplied_auto = options.get("auto_parameters", False)
    # Reject JavaScript aliases as well: structural/custom clients may forward
    # unknown keys after their native fields and thereby override the bound.
    if (
        supplied_depth != "basic"
        or supplied_auto is not False
        or "query" in options
        or "searchDepth" in options
        or "autoParameters" in options
        or "includeUsage" in options
    ):
        raise _validation_error()
    # These values make the one-credit bound explicit and provide exact usage
    # evidence. Caller values cannot weaken them.
    options["search_depth"] = "basic"
    options["auto_parameters"] = False
    options["include_usage"] = True
    return options


def _search_method(client: object) -> Callable[..., Any]:
    """Bind the validated transport before reservation can yield."""

    try:
        static_search = inspect.getattr_static(client, "search")
    except Exception as error:
        raise _validation_error() from error
    if type(static_search) is MethodType:
        return cast(Callable[..., Any], static_search)
    if type(static_search) is not FunctionType:
        # Properties and custom descriptors/callables can execute hooks during
        # validation or change behavior across the reservation boundary.
        raise _validation_error()
    try:
        instance_state = object.__getattribute__(client, "__dict__")
    except Exception:
        instance_state = None
    if (
        type(instance_state) is dict
        and cast(dict[object, object], instance_state).get("search", _MISSING) is static_search
    ):
        # A plain function stored directly on the instance is already unbound.
        return cast(Callable[..., Any], static_search)
    return cast(Callable[..., Any], MethodType(static_search, client))


def _credits(response: object) -> str:
    try:
        if not isinstance(response, Mapping):
            raise TypeError
        usage = response.get("usage")
        if not isinstance(usage, Mapping):
            raise TypeError
        credits = usage.get("credits")
        if isinstance(credits, bool):
            raise TypeError
        if isinstance(credits, float):
            # Provider JSON decoded as a binary float cannot participate in
            # authoritative quantity hashing, even when mathematically integral.
            raise TypeError
        if isinstance(credits, int):
            if credits <= 0:
                raise TypeError
            return str(credits)
        if isinstance(credits, str) and credits.isascii() and credits.isdigit():
            normalized = str(int(credits))
            if normalized != "0":
                return normalized
    except Exception as error:
        raise ValueError("Tavily response did not contain exact positive credit usage") from error
    raise ValueError("Tavily response did not contain exact positive credit usage")


def controlled_tavily_search_sync(
    client: TavilySyncSearchClient[T],
    query: str,
    *,
    customer_id: str | None = None,
    step: str | None = None,
    search_depth: str = "basic",
    auto_parameters: bool = False,
    search_options: Mapping[str, Any] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Call ``TavilyClient.search`` with an exact one-credit reservation."""

    if type(query) is not str or not query:
        raise _validation_error()
    options = _options(
        search_options,
        search_depth=search_depth,
        auto_parameters=auto_parameters,
    )
    search = _search_method(client)
    return controlled_usage_sync(
        cost_source_slug=TAVILY_SEARCH_COST_SOURCE_SLUG,
        tool_name=TAVILY_SEARCH_TOOL_NAME,
        metric=TAVILY_SEARCH_METRIC,
        maximum_value=TAVILY_BASIC_SEARCH_CREDITS,
        invoke=lambda: search(query, **options),
        extract_actual=_credits,
        customer_id=customer_id,
        step=step,
        reservation_ttl_seconds=reservation_ttl_seconds,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
    )


async def controlled_tavily_search(
    client: TavilyAsyncSearchClient[T],
    query: str,
    *,
    customer_id: str | None = None,
    step: str | None = None,
    search_depth: str = "basic",
    auto_parameters: bool = False,
    search_options: Mapping[str, Any] | None = None,
    reservation_ttl_seconds: int = 300,
    heartbeat_interval_seconds: float | None = None,
) -> ControlledUsageResult[T]:
    """Call ``AsyncTavilyClient.search`` with a one-credit reservation."""

    if type(query) is not str or not query:
        raise _validation_error()
    options = _options(
        search_options,
        search_depth=search_depth,
        auto_parameters=auto_parameters,
    )
    search = _search_method(client)

    async def invoke() -> T:
        pending = search(query, **options)
        if not inspect.isawaitable(pending):
            raise TypeError("Tavily async client search must return an awaitable")
        return cast(T, await pending)

    return await controlled_usage(
        cost_source_slug=TAVILY_SEARCH_COST_SOURCE_SLUG,
        tool_name=TAVILY_SEARCH_TOOL_NAME,
        metric=TAVILY_SEARCH_METRIC,
        maximum_value=TAVILY_BASIC_SEARCH_CREDITS,
        invoke=invoke,
        extract_actual=_credits,
        customer_id=customer_id,
        step=step,
        reservation_ttl_seconds=reservation_ttl_seconds,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
    )
