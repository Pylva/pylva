"""Fail-closed network boundary for packaged Python service runners."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit

import httpx


_BACKEND_ROUTES = frozenset(
    {
        ("GET", "/api/v1/budget/capabilities"),
        ("GET", "/api/v1/pricing"),
        ("GET", "/api/v1/rules"),
        ("GET", "/api/v1/sdk/non-llm-policy"),
        ("POST", "/api/v1/budget/reservations"),
        ("POST", "/api/v1/budget/sync"),
        ("POST", "/api/v1/events"),
        ("POST", "/api/v1/sdk/non-llm-discoveries"),
    }
)
_RESERVATION_MUTATION = re.compile(
    r"^/api/v1/budget/reservations/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    r"/(?:commit|extend|release)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _BackendBoundary:
    base_path: str
    host: str
    port: int
    scheme: str


def _parse_backend(endpoint: str) -> _BackendBoundary:
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            "service runner backend endpoint must be an exact loopback HTTP origin"
        )
    default_port = 443 if parsed.scheme == "https" else 80
    return _BackendBoundary(
        base_path="" if parsed.path == "/" else parsed.path.rstrip("/"),
        host=parsed.hostname,
        port=parsed.port or default_port,
        scheme=parsed.scheme,
    )


def _request_path(request: httpx.Request, boundary: _BackendBoundary) -> str | None:
    path = request.url.path
    if not boundary.base_path:
        return path
    prefix = f"{boundary.base_path}/"
    if not path.startswith(prefix):
        return None
    return path[len(boundary.base_path) :]


def _assert_allowed(request: httpx.Request, boundary: _BackendBoundary) -> None:
    default_port = 443 if request.url.scheme == "https" else 80
    if (
        request.url.scheme != boundary.scheme
        or request.url.host != boundary.host
        or (request.url.port or default_port) != boundary.port
        or request.url.username != ""
        or request.url.password != ""
        or request.url.query
        or request.url.fragment
    ):
        raise RuntimeError(
            f"unexpected external request: {request.method} {request.url.scheme}://"
            f"{request.url.host}{request.url.path}"
        )
    path = _request_path(request, boundary)
    method = request.method.upper()
    if path is None or (
        (method, path) not in _BACKEND_ROUTES
        and not (method == "POST" and _RESERVATION_MUTATION.fullmatch(path))
    ):
        raise RuntimeError(f"unexpected external request: {method} {request.url}")


def install_service_runner_egress_guard(endpoint: str) -> Callable[[], None]:
    """Guard every default HTTPX transport hop, including redirect targets."""

    boundary = _parse_backend(endpoint)
    original_sync = httpx.HTTPTransport.handle_request
    original_async = httpx.AsyncHTTPTransport.handle_async_request

    def guarded_sync(
        transport: httpx.HTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        _assert_allowed(request, boundary)
        response = original_sync(transport, request)
        if 300 <= response.status_code < 400:
            response.close()
            raise RuntimeError(
                f"unexpected redirect from allowed service route: "
                f"{request.method} {request.url.path}"
            )
        return response

    async def guarded_async(
        transport: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        _assert_allowed(request, boundary)
        response = await original_async(transport, request)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise RuntimeError(
                f"unexpected redirect from allowed service route: "
                f"{request.method} {request.url.path}"
            )
        return response

    httpx.HTTPTransport.handle_request = guarded_sync
    httpx.AsyncHTTPTransport.handle_async_request = guarded_async

    def restore() -> None:
        httpx.HTTPTransport.handle_request = original_sync
        httpx.AsyncHTTPTransport.handle_async_request = original_async

    return restore


def assert_egress_sentinel_blocked(sentinel_url: str | None) -> None:
    if not sentinel_url:
        return
    try:
        httpx.get(sentinel_url, timeout=1.0)
    except RuntimeError as error:
        if str(error).startswith("unexpected external request:"):
            return
        raise
    raise RuntimeError("service runner egress sentinel reached native transport")
