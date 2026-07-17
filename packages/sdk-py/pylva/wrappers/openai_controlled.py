"""Explicit OpenAI client wrapper with authoritative cost control."""

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
    _AsyncLoopAffinity,
    _ControlledClientLifecycle,
    _local_strict_error,
    _strict_error,
    default_heartbeat_interval,
    is_async_provider_method,
    prepare_openai_request,
    run_async_create,
    run_sync_create,
    validate_heartbeat_interval,
)

_CANONICAL_BASE_URL = "https://api.openai.com/v1"


def _reject_args(args: tuple[Any, ...]) -> None:
    if args:
        raise _local_strict_error("openai", "unsupported_request_shape")


def _noop_close() -> None:
    return None


async def _noop_async_close() -> None:
    return None


def _invalid_client(error: BaseException | None = None) -> NoReturn:
    strict = _local_strict_error("openai", "invalid_client")
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
    chat: _OpenAIChat
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
class _ChatState:
    completions: object


@dataclass(frozen=True)
class _CompletionsState:
    create: Callable[..., Any]
    heartbeat_interval: float | None
    lifecycle: _ControlledClientLifecycle
    affinity: _AsyncLoopAffinity | None


def _ensure_open(lifecycle: _ControlledClientLifecycle) -> None:
    if lifecycle.closed:
        _invalid_client()


def _ensure_dispatch_open(lifecycle: _ControlledClientLifecycle) -> None:
    if lifecycle.closed:
        raise _strict_error("openai", "invalid_client")


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


class _OpenAIFacadeGuard:
    __slots__ = ()

    def __setattr__(self, _name: str, _value: object) -> None:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __delattr__(self, _name: str) -> None:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __copy__(self) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __reduce__(self) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")


class _SyncOpenAICompletions(_OpenAIFacadeGuard):
    __slots__ = ("__weakref__",)

    def create(self, *args: Any, **kwargs: Any) -> Any:
        _reject_args(args)
        state = _sync_completions_state(self)
        _ensure_open(state.lifecycle)
        prepared = prepare_openai_request(kwargs)
        return run_sync_create(
            state.create,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_dispatch_open(state.lifecycle),
            state.lifecycle,
        )

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["create"]


class _AsyncOpenAICompletions(_OpenAIFacadeGuard):
    __slots__ = ("__weakref__",)

    async def create(self, *args: Any, **kwargs: Any) -> Any:
        _reject_args(args)
        state = _async_completions_state(self)
        affinity = state.affinity
        if affinity is None:
            _invalid_client()
        _ensure_async_open(state.lifecycle, affinity)
        prepared = prepare_openai_request(kwargs)
        return await run_async_create(
            state.create,
            prepared,
            state.heartbeat_interval,
            lambda: _ensure_async_dispatch_open(state.lifecycle, affinity),
            state.lifecycle,
        )

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["create"]


class _OpenAIChat(_OpenAIFacadeGuard):
    __slots__ = ("__weakref__",)

    @property
    def completions(self) -> object:
        return _chat_state(self).completions

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["completions"]


class ControlledOpenAI(_OpenAIFacadeGuard):
    """Narrow facade exposing only controlled chat-completion dispatch."""

    __slots__ = ("__weakref__",)

    @property
    def chat(self) -> _OpenAIChat:
        return _client_state(self).chat

    @property
    def max_retries(self) -> int:
        return 0

    def close(self) -> Any:
        state = _client_state(self)
        if state.is_async:
            return _close_async_client(state)
        return _close_sync_client(state)

    def __getattr__(self, name: str) -> Any:
        raise _local_strict_error("openai", "unsupported_pricing_feature")

    def __dir__(self) -> list[str]:
        return ["chat", "close", "max_retries"]


_CLIENT_STATES: weakref.WeakKeyDictionary[ControlledOpenAI, _ClientState] = (
    weakref.WeakKeyDictionary()
)
_CHAT_STATES: weakref.WeakKeyDictionary[_OpenAIChat, _ChatState] = weakref.WeakKeyDictionary()
_SYNC_COMPLETIONS_STATES: weakref.WeakKeyDictionary[_SyncOpenAICompletions, _CompletionsState] = (
    weakref.WeakKeyDictionary()
)
_ASYNC_COMPLETIONS_STATES: weakref.WeakKeyDictionary[_AsyncOpenAICompletions, _CompletionsState] = (
    weakref.WeakKeyDictionary()
)


def _client_state(facade: ControlledOpenAI) -> _ClientState:
    try:
        return _CLIENT_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _chat_state(facade: _OpenAIChat) -> _ChatState:
    try:
        return _CHAT_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _sync_completions_state(facade: _SyncOpenAICompletions) -> _CompletionsState:
    try:
        return _SYNC_COMPLETIONS_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _async_completions_state(facade: _AsyncOpenAICompletions) -> _CompletionsState:
    try:
        return _ASYNC_COMPLETIONS_STATES[facade]
    except (KeyError, TypeError) as error:
        _invalid_client(error)


def _build_facade(
    close: Callable[[], Any],
    create: Callable[..., Any],
    heartbeat_interval: float | None,
    *,
    is_async: bool,
) -> ControlledOpenAI:
    lifecycle = _ControlledClientLifecycle()
    affinity = _AsyncLoopAffinity("openai") if is_async else None
    completions: object
    if is_async:
        async_completions = _AsyncOpenAICompletions()
        _ASYNC_COMPLETIONS_STATES[async_completions] = _CompletionsState(
            create, heartbeat_interval, lifecycle, affinity
        )
        completions = async_completions
    else:
        sync_completions = _SyncOpenAICompletions()
        _SYNC_COMPLETIONS_STATES[sync_completions] = _CompletionsState(
            create, heartbeat_interval, lifecycle, affinity
        )
        completions = sync_completions
    chat = _OpenAIChat()
    _CHAT_STATES[chat] = _ChatState(completions)
    facade = ControlledOpenAI()
    _CLIENT_STATES[facade] = _ClientState(close, chat, lifecycle, is_async, affinity)
    return facade


def _official_private_dispatch(
    client: object,
) -> tuple[Callable[[], Any], Callable[..., Any], bool]:
    try:
        openai = importlib.import_module("openai")
        base_client = importlib.import_module("openai._base_client")
        chat_resources = importlib.import_module("openai.resources.chat.chat")
        resources = importlib.import_module("openai.resources.chat.completions.completions")
    except BaseException as error:
        _invalid_client(error)

    sync_client_type = cast(type[object], getattr(openai, "OpenAI", None))
    async_client_type = cast(type[object], getattr(openai, "AsyncOpenAI", None))
    sync_http_type = cast(type[object], getattr(base_client, "SyncHttpxClientWrapper", None))
    async_http_type = cast(type[object], getattr(base_client, "AsyncHttpxClientWrapper", None))
    sync_chat_type = cast(type[object], getattr(chat_resources, "Chat", None))
    async_chat_type = cast(type[object], getattr(chat_resources, "AsyncChat", None))
    sync_resource_type = cast(type[object], getattr(resources, "Completions", None))
    async_resource_type = cast(type[object], getattr(resources, "AsyncCompletions", None))
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
            sync_chat_type,
            async_chat_type,
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
    caller_chat_type = async_chat_type if is_async else sync_chat_type
    try:
        caller_chat = cast(Any, client).chat
    except BaseException as error:
        _invalid_client(error)
    if (
        type(caller_chat) is not caller_chat_type
        or _object_dict(caller_chat).get("_client") is not client
    ):
        _invalid_client()
    caller_resource = cast(Any, caller_chat).completions
    if (
        type(caller_resource) is not caller_resource_type
        or _object_dict(caller_resource).get("_client") is not client
    ):
        _invalid_client()
    _exact_bound_method(caller_resource, caller_resource_type, "create")
    api_key = caller_data.get("api_key")
    if type(api_key) is not str or not api_key:
        _invalid_client()
    organization = _optional_string(caller_data.get("organization"))
    project = _optional_string(caller_data.get("project"))
    if any(
        caller_data.get(name) is not None
        for name in (
            "_provider",
            "_provider_runtime",
            "workload_identity",
            "_api_key_provider",
            "_workload_identity_auth",
        )
    ):
        _invalid_client()

    constructor = async_client_type if is_async else sync_client_type
    try:
        private = cast(Any, constructor)(
            api_key=api_key,
            organization=organization,
            project=project,
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
            or private_data.get("organization") != organization
            or private_data.get("project") != project
        ):
            _invalid_client()
        chat = private.chat
        chat_type = async_chat_type if is_async else sync_chat_type
        if type(chat) is not chat_type or _object_dict(chat).get("_client") is not private:
            _invalid_client()
        resource = cast(Any, chat).completions
        resource_type = async_resource_type if is_async else sync_resource_type
        if (
            type(resource) is not resource_type
            or _object_dict(resource).get("_client") is not private
        ):
            _invalid_client()
        create = _exact_bound_method(resource, resource_type, "create")
        close = _exact_bound_method(private, constructor, "close")
    except PylvaStrictProviderError:
        raise
    except BaseException as error:
        _invalid_client(error)
    return close, create, is_async


def wrap_openai(
    client: object,
    *,
    heartbeat_interval_seconds: float | None = default_heartbeat_interval(),
) -> ControlledOpenAI:
    """Build an isolated, zero-retry controlled OpenAI client facade.

    The supplied object must be an exact official ``OpenAI`` or ``AsyncOpenAI``
    instance using the canonical API base and the SDK's default transport. It
    is treated only as a credential/configuration carrier; provider dispatch is
    performed by a newly constructed private official client.
    """

    if type(client) is ControlledOpenAI:
        facade = client
        _client_state(facade)
        return facade
    heartbeat = validate_heartbeat_interval(heartbeat_interval_seconds, "openai")
    close, create, is_async = _official_private_dispatch(client)
    return _build_facade(close, create, heartbeat, is_async=is_async)


def _test_zero_retry_client(client: object) -> object:
    try:
        retries = cast(Any, client).max_retries
        if retries == 0 and type(retries) is int:
            return client
        with_options = cast(Any, client).with_options
        candidate = with_options(max_retries=0)
        candidate_retries = cast(Any, candidate).max_retries
    except BaseException as error:
        raise _local_strict_error("openai", "provider_retries_enabled") from error
    if candidate_retries != 0 or type(candidate_retries) is not int:
        raise _local_strict_error("openai", "provider_retries_enabled")
    return candidate


def _wrap_openai_for_tests(
    client: object,
    *,
    heartbeat_interval_seconds: float | None = default_heartbeat_interval(),
) -> ControlledOpenAI:
    """Internal structural-double seam; never exported by ``pylva``."""

    if type(client) is ControlledOpenAI:
        facade = client
        _client_state(facade)
        return facade
    controlled = _test_zero_retry_client(client)
    heartbeat = validate_heartbeat_interval(heartbeat_interval_seconds, "openai")
    try:
        resource = controlled.chat.completions  # type: ignore[attr-defined]
        create = resource.create
    except BaseException as error:
        _invalid_client(error)
    close = getattr(controlled, "close", None)
    if not callable(create):
        _invalid_client()
    if not callable(close):
        close = _noop_close
    is_async = is_async_provider_method(create, "openai")
    if close is _noop_close and is_async:
        close = _noop_async_close
    return _build_facade(close, create, heartbeat, is_async=is_async)
