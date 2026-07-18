"""Explicit Anthropic client wrapper with authoritative cost control."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import threading
import weakref
from collections.abc import Callable
from dataclasses import dataclass, field
from types import MethodType
from typing import Any, NoReturn, SupportsIndex, cast

import httpx

from ..errors.strict_provider import PylvaStrictProviderError
from ._controlled_provider import (
    AsyncControlledStreamManager,
    SyncControlledStreamManager,
    _AsyncLoopAffinity,
    _ControlledClientLifecycle,
    _local_strict_error,
    _strict_error,
    default_heartbeat_interval,
    is_async_provider_method,
    prepare_anthropic_request,
    run_async_create,
    run_sync_create,
    validate_heartbeat_interval,
)

_CANONICAL_BASE_URL = "https://api.anthropic.com"


def _reject_args(args: tuple[Any, ...]) -> None:
    if args:
        raise _local_strict_error("anthropic", "unsupported_request_shape")


def _noop_close() -> None:
    return None


async def _noop_async_close() -> None:
    return None


def _invalid_stream_for_tests(**_kwargs: Any) -> NoReturn:
    _invalid_client()


def _invalid_client(error: BaseException | None = None) -> NoReturn:
    strict = _local_strict_error("anthropic", "invalid_client")
    if error is None:
        raise strict
    raise strict from error


def _object_dict(value: object) -> dict[str, Any]:
    try:
        data = vars(value)
    except BaseException as error:
        _invalid_client(error)
    if type(data) is not dict:
        _invalid_client()
    return data


def _optional_string(value: object) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        _invalid_client()
    return value


def _validate_client_shell(
    client: object,
    *,
    is_async: bool,
    sync_http_type: type[object],
    async_http_type: type[object],
    require_zero_retries: bool,
) -> dict[str, Any]:
    data = _object_dict(client)
    retries = data.get("max_retries")
    if type(retries) is not int or retries < 0:
        _invalid_client()
    if require_zero_retries and retries != 0:
        _invalid_client()
    base_url = data.get("_base_url")
    if type(base_url) is not httpx.URL or str(base_url).rstrip("/") != _CANONICAL_BASE_URL:
        _invalid_client()
    if type(data.get("_custom_headers")) is not dict or data["_custom_headers"]:
        _invalid_client()
    if type(data.get("_custom_query")) is not dict or data["_custom_query"]:
        _invalid_client()

    http_client = data.get("_client")
    expected_http_type = async_http_type if is_async else sync_http_type
    expected_transport_type: type[object] = (
        httpx.AsyncHTTPTransport if is_async else httpx.HTTPTransport
    )
    if type(http_client) is not expected_http_type:
        _invalid_client()
    http_data = _object_dict(http_client)
    if type(http_data.get("_transport")) is not expected_transport_type:
        _invalid_client()
    return data


def _exact_bound_method(
    resource: object, resource_type: type[object], name: str
) -> Callable[..., Any]:
    try:
        descriptor = inspect.getattr_static(resource_type, name)
        method = getattr(resource, name)
    except BaseException as error:
        _invalid_client(error)
    if (
        type(method) is not MethodType
        or getattr(method, "__self__", None) is not resource
        or getattr(method, "__func__", None) is not descriptor
    ):
        _invalid_client()
    return cast(Callable[..., Any], method)


@dataclass
class _ClientState:
    close: Callable[[], Any]
    messages: object
    lifecycle: _ControlledClientLifecycle
    is_async: bool
    affinity: _AsyncLoopAffinity | None
    close_task: asyncio.Task[Any] | None = None
    sync_close_condition: threading.Condition = field(
        default_factory=threading.Condition,
        repr=False,
    )
    sync_close_started: bool = False
    sync_close_finished: bool = False
    sync_close_owner: int | None = None
    sync_close_result: Any = None
    sync_close_error: BaseException | None = None


@dataclass(frozen=True)
class _MessagesState:
    create: Callable[..., Any]
    stream: Callable[..., Any]
    heartbeat_interval: float | None
    lifecycle: _ControlledClientLifecycle
    affinity: _AsyncLoopAffinity | None


def _ensure_open(lifecycle: _ControlledClientLifecycle) -> None:
    if lifecycle.closed:
        _invalid_client()


def _ensure_dispatch_open(lifecycle: _ControlledClientLifecycle) -> None:
    if lifecycle.closed:
        raise _strict_error("anthropic", "invalid_client")


def _ensure_async_open(
    lifecycle: _ControlledClientLifecycle,
    affinity: _AsyncLoopAffinity,
) -> None:
    affinity.bind()
    _ensure_open(lifecycle)


def _ensure_async_dispatch_open(
    lifecycle: _ControlledClientLifecycle,
    affinity: _AsyncLoopAffinity,
) -> None:
    affinity.bind()
    _ensure_dispatch_open(lifecycle)


async def _run_async_client_close(state: _ClientState) -> Any:
    lifecycle_error: BaseException | None = None
    try:
        await state.lifecycle.close_async()
    except BaseException as error:
        lifecycle_error = error.with_traceback(None)
    result = state.close()
    result = await result if inspect.isawaitable(result) else result
    if lifecycle_error is not None:
        raise lifecycle_error
    return result


def _consume_client_close_task(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except BaseException:
        pass


async def _close_async_client(state: _ClientState) -> Any:
    affinity = state.affinity
    if affinity is None:
        _invalid_client()
    affinity.bind()
    task = state.close_task
    if task is None:
        task = asyncio.create_task(_run_async_client_close(state))
        task.add_done_callback(_consume_client_close_task)
        state.close_task = task
    if task is asyncio.current_task():
        return None
    return await asyncio.shield(task)


def _close_sync_client(state: _ClientState) -> Any:
    condition = state.sync_close_condition
    owner = threading.get_ident()
    with condition:
        if state.sync_close_started:
            if state.sync_close_owner == owner and not state.sync_close_finished:
                return None
            while not state.sync_close_finished:
                condition.wait()
            if state.sync_close_error is not None:
                raise state.sync_close_error
            return state.sync_close_result
        state.sync_close_started = True
        state.sync_close_owner = owner

    result: Any = None
    error: BaseException | None = None
    try:
        state.lifecycle.close()
        result = state.close()
    except BaseException as caught:
        error = caught.with_traceback(None)
    finally:
        with condition:
            state.sync_close_result = result
            state.sync_close_error = error
            state.sync_close_finished = True
            condition.notify_all()
    if error is not None:
        raise error
    return result


class _AnthropicFacadeGuard:
    __slots__ = ()

    def __setattr__(self, _name: str, _value: object) -> None:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __delattr__(self, _name: str) -> None:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __copy__(self) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __reduce__(self) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")


class _SyncAnthropicMessages(_AnthropicFacadeGuard):
    __slots__ = ("__weakref__",)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        _reject_args(args)
        state = _sync_messages_state(self)
        _ensure_open(state.lifecycle)
        prepared = prepare_anthropic_request(kwargs)
        return run_sync_create(
            state.create,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_dispatch_open(state.lifecycle),
            state.lifecycle,
        )

    def stream(self, *args: Any, **kwargs: Any) -> SyncControlledStreamManager:
        _reject_args(args)
        state = _sync_messages_state(self)
        _ensure_open(state.lifecycle)
        prepared = prepare_anthropic_request({**kwargs, "stream": True})
        manager_kwargs = {key: value for key, value in prepared.kwargs.items() if key != "stream"}
        return SyncControlledStreamManager(
            state.stream,
            manager_kwargs,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_open(state.lifecycle),
            lambda: _ensure_dispatch_open(state.lifecycle),
            state.lifecycle,
        )

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["create", "stream"]


class _AsyncAnthropicMessages(_AnthropicFacadeGuard):
    __slots__ = ("__weakref__",)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        _reject_args(args)
        state = _async_messages_state(self)
        affinity = state.affinity
        if affinity is None:
            _invalid_client()
        _ensure_async_open(state.lifecycle, affinity)
        prepared = prepare_anthropic_request(kwargs)
        return await run_async_create(
            state.create,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_async_dispatch_open(state.lifecycle, affinity),
            state.lifecycle,
        )

    def stream(self, *args: Any, **kwargs: Any) -> AsyncControlledStreamManager:
        _reject_args(args)
        state = _async_messages_state(self)
        affinity = state.affinity
        if affinity is None:
            _invalid_client()
        _ensure_open(state.lifecycle)
        prepared = prepare_anthropic_request({**kwargs, "stream": True})
        manager_kwargs = {key: value for key, value in prepared.kwargs.items() if key != "stream"}
        return AsyncControlledStreamManager(
            state.stream,
            manager_kwargs,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_async_open(state.lifecycle, affinity),
            lambda: _ensure_async_dispatch_open(state.lifecycle, affinity),
            state.lifecycle,
        )

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["create", "stream"]


class ControlledAnthropic(_AnthropicFacadeGuard):
    """Narrow facade exposing only controlled message dispatch."""

    __slots__ = ("__weakref__",)

    @property
    def messages(self) -> object:
        return _client_state(self).messages

    @property
    def max_retries(self) -> int:
        return 0

    def close(self) -> Any:
        state = _client_state(self)
        if state.is_async:
            return _close_async_client(state)
        return _close_sync_client(state)

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("anthropic", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["close", "max_retries", "messages"]


_CLIENT_STATES: weakref.WeakKeyDictionary[ControlledAnthropic, _ClientState] = (
    weakref.WeakKeyDictionary()
)
_SYNC_MESSAGES_STATES: weakref.WeakKeyDictionary[_SyncAnthropicMessages, _MessagesState] = (
    weakref.WeakKeyDictionary()
)
_ASYNC_MESSAGES_STATES: weakref.WeakKeyDictionary[_AsyncAnthropicMessages, _MessagesState] = (
    weakref.WeakKeyDictionary()
)


def _client_state(facade: ControlledAnthropic) -> _ClientState:
    try:
        return _CLIENT_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _sync_messages_state(facade: _SyncAnthropicMessages) -> _MessagesState:
    try:
        return _SYNC_MESSAGES_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _async_messages_state(facade: _AsyncAnthropicMessages) -> _MessagesState:
    try:
        return _ASYNC_MESSAGES_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _build_facade(
    close: Callable[[], Any],
    create: Callable[..., Any],
    stream: Callable[..., Any],
    heartbeat_interval: float | None,
    *,
    is_async: bool,
) -> ControlledAnthropic:
    lifecycle = _ControlledClientLifecycle()
    affinity = _AsyncLoopAffinity("anthropic") if is_async else None
    messages: object
    if is_async:
        async_messages = _AsyncAnthropicMessages()
        _ASYNC_MESSAGES_STATES[async_messages] = _MessagesState(
            create, stream, heartbeat_interval, lifecycle, affinity
        )
        messages = async_messages
    else:
        sync_messages = _SyncAnthropicMessages()
        _SYNC_MESSAGES_STATES[sync_messages] = _MessagesState(
            create, stream, heartbeat_interval, lifecycle, affinity
        )
        messages = sync_messages
    facade = ControlledAnthropic()
    _CLIENT_STATES[facade] = _ClientState(
        close,
        messages,
        lifecycle,
        is_async,
        affinity,
    )
    return facade


def _official_private_dispatch(
    client: object,
) -> tuple[Callable[[], Any], Callable[..., Any], Callable[..., Any], bool]:
    try:
        anthropic = importlib.import_module("anthropic")
        base_client = importlib.import_module("anthropic._base_client")
        resources = importlib.import_module("anthropic.resources.messages.messages")
    except BaseException as error:
        _invalid_client(error)

    sync_client_type = cast(type[object], getattr(anthropic, "Anthropic", None))
    async_client_type = cast(type[object], getattr(anthropic, "AsyncAnthropic", None))
    sync_http_type = cast(type[object], getattr(base_client, "SyncHttpxClientWrapper", None))
    async_http_type = cast(type[object], getattr(base_client, "AsyncHttpxClientWrapper", None))
    sync_resource_type = cast(type[object], getattr(resources, "Messages", None))
    async_resource_type = cast(type[object], getattr(resources, "AsyncMessages", None))
    is_async = type(client) is async_client_type
    if type(client) is not sync_client_type and not is_async:
        _invalid_client()
    if not all(
        isinstance(item, type)
        for item in (
            sync_client_type,
            async_client_type,
            sync_http_type,
            async_http_type,
            sync_resource_type,
            async_resource_type,
        )
    ):
        _invalid_client()

    caller_data = _validate_client_shell(
        client,
        is_async=is_async,
        sync_http_type=sync_http_type,
        async_http_type=async_http_type,
        require_zero_retries=False,
    )
    caller_resource_type = async_resource_type if is_async else sync_resource_type
    try:
        caller_resource = cast(Any, client).messages
    except BaseException as error:
        _invalid_client(error)
    if (
        type(caller_resource) is not caller_resource_type
        or _object_dict(caller_resource).get("_client") is not client
    ):
        _invalid_client()
    _exact_bound_method(caller_resource, caller_resource_type, "create")
    _exact_bound_method(caller_resource, caller_resource_type, "stream")
    api_key = _optional_string(caller_data.get("api_key"))
    auth_token = _optional_string(caller_data.get("auth_token"))
    if not api_key and not auth_token:
        _invalid_client()
    if (
        caller_data.get("credentials") is not None
        or caller_data.get("_custom_auth") is not None
        or caller_data.get("_token_cache") is not None
        or caller_data.get("_middleware") != ()
    ):
        _invalid_client()

    constructor = async_client_type if is_async else sync_client_type
    try:
        private = cast(Any, constructor)(
            api_key=api_key,
            auth_token=auth_token,
            base_url=_CANONICAL_BASE_URL,
            max_retries=0,
        )
        private_data = _validate_client_shell(
            private,
            is_async=is_async,
            sync_http_type=sync_http_type,
            async_http_type=async_http_type,
            require_zero_retries=True,
        )
        if (
            private is client
            or private_data.get("_client") is caller_data.get("_client")
            or private_data.get("api_key") != api_key
            or private_data.get("auth_token") != auth_token
        ):
            _invalid_client()
        resource = private.messages
        resource_type = async_resource_type if is_async else sync_resource_type
        if (
            type(resource) is not resource_type
            or _object_dict(resource).get("_client") is not private
        ):
            _invalid_client()
        create = _exact_bound_method(resource, resource_type, "create")
        stream = _exact_bound_method(resource, resource_type, "stream")
        close = _exact_bound_method(private, constructor, "close")
    except PylvaStrictProviderError:
        raise
    except BaseException as error:
        _invalid_client(error)
    return close, create, stream, is_async


def wrap_anthropic(
    client: object,
    *,
    heartbeat_interval_seconds: float | None = default_heartbeat_interval(),
) -> ControlledAnthropic:
    """Build an isolated, zero-retry controlled Anthropic client facade.

    The supplied object must be an exact official ``Anthropic`` or
    ``AsyncAnthropic`` instance using the canonical API base and SDK default
    transport. It is never used for provider dispatch.
    """

    if type(client) is ControlledAnthropic:
        facade = client
        _client_state(facade)
        return facade
    heartbeat = validate_heartbeat_interval(heartbeat_interval_seconds, "anthropic")
    close, create, stream, is_async = _official_private_dispatch(client)
    return _build_facade(close, create, stream, heartbeat, is_async=is_async)


def _test_zero_retry_client(client: object) -> object:
    try:
        retries = cast(Any, client).max_retries
        if retries == 0 and type(retries) is int:
            return client
        with_options = cast(Any, client).with_options
        candidate = with_options(max_retries=0)
        candidate_retries = cast(Any, candidate).max_retries
    except BaseException as error:
        raise _local_strict_error("anthropic", "provider_retries_enabled") from error
    if candidate_retries != 0 or type(candidate_retries) is not int:
        raise _local_strict_error("anthropic", "provider_retries_enabled")
    return candidate


def _wrap_anthropic_for_tests(
    client: object,
    *,
    heartbeat_interval_seconds: float | None = default_heartbeat_interval(),
) -> ControlledAnthropic:
    """Internal structural-double seam; never exported by ``pylva``."""

    if type(client) is ControlledAnthropic:
        facade = client
        _client_state(facade)
        return facade
    controlled = _test_zero_retry_client(client)
    heartbeat = validate_heartbeat_interval(heartbeat_interval_seconds, "anthropic")
    try:
        resource = controlled.messages  # type: ignore[attr-defined]
        create = resource.create
        stream = getattr(resource, "stream", None)
    except BaseException as error:
        _invalid_client(error)
    if not callable(create):
        _invalid_client()
    if not callable(stream):
        stream = _invalid_stream_for_tests
    close = getattr(controlled, "close", None)
    if not callable(close):
        close = _noop_close
    is_async = is_async_provider_method(create, "anthropic")
    if close is _noop_close and is_async:
        close = _noop_async_close
    return _build_facade(close, create, stream, heartbeat, is_async=is_async)
