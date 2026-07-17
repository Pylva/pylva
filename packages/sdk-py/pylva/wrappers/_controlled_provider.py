"""Shared machinery for explicit authoritative provider wrappers.

This module is intentionally provider-SDK agnostic.  It accepts plain Python
objects, validates a deliberately small priceable request subset, sends only
content-free bounds to Pylva, and settles a reservation only when the provider
returns complete pricing evidence.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import threading
import time
import uuid
import weakref
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, SupportsIndex, cast

from ..core import control_client
from ..core.config import get_config_generation, require_config
from ..core.context import current_context
from ..core.control_ownership import (
    ControlledAttemptContext,
    _controlled_attempt_scope,
    _controlled_local_no_dispatch,
    _controlled_no_dispatch,
    controlled_operation_ownership,
)
from ..core.control_schema import (
    BypassedBudgetDecision,
    ReservedBudgetDecision,
    UnavailableBudgetDecision,
)
from ..core.telemetry import enqueue
from ..errors.strict_provider import PylvaStrictProviderError, StrictProviderReason
from ._event import build_llm_event
from ._strict_context import strict_provider_dispatch

Provider = Literal["openai", "anthropic"]
_MISSING = object()
_UINT32_MAX = 4_294_967_295
_SUPPORTED_FRAMEWORKS = {
    "langgraph",
    "crewai",
    "mastra",
    "openai-agents",
    "pydantic-ai",
    "none",
}
_OPENAI_CACHE_THRESHOLD_TOKENS = 1_024
_ANTHROPIC_LONG_CONTEXT_GUARD_TOKENS = 190_000
_DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 100.0
_MAX_HEARTBEAT_INTERVAL_SECONDS = 100.0
_EXTEND_BY_SECONDS = 300
_MAX_CONTROLLED_LIFETIME_SECONDS = 3_600.0
_MAX_REQUEST_DEPTH = 20
_MAX_REQUEST_NODES = 10_000
_MAX_CONTAINER_ITEMS = 4_096
_MAX_LOCAL_SCALAR_BYTES = 2 * 1024 * 1024
_MAX_EVIDENCE_RECORD_ENTRIES = 256


@dataclass(frozen=True)
class PreparedProviderRequest:
    provider: Provider
    model: str
    kwargs: dict[str, Any]
    estimated_input_tokens: int
    max_output_tokens: int
    stream: bool


@dataclass
class UsageEvidence:
    provider: Provider
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_seen: bool = False
    cache_read_zero: bool = True
    cache_write_seen: bool = False
    cache_write_zero: bool = True
    tier_seen: bool = False
    tier_valid: bool = True
    server_tool_usage_zero: bool = True
    model_seen: bool = False
    model_valid: bool = True
    observed_model: str | None = None
    token_counts_valid: bool = True
    evidence_safe: bool = True

    def __post_init__(self) -> None:
        # These facts are guaranteed by the validated outbound request. OpenAI
        # automatic caching is ineligible below 1024 tokens, making cache reads
        # and writes impossible. Anthropic receives no cache_control anywhere,
        # making both cache creation/read ineligible. Explicit non-zero response
        # evidence still invalidates these local proofs. Both tiers are fixed in
        # the request, with a conflicting response tier invalidating settlement.
        self.tier_seen = True
        self.cache_read_seen = True
        self.cache_write_seen = True

    def observe(self, value: object, expected_model: str) -> None:
        try:
            self._observe_unchecked(value, expected_model)
        except BaseException:
            # Provider objects may expose hostile/custom getters. Evidence is
            # optional after dispatch: never replace a successful response;
            # simply retain the reservation for expiry/unresolved accounting.
            self.evidence_safe = False

    def _observe_unchecked(self, value: object, expected_model: str) -> None:
        usage = _get(value, "usage")
        if usage is not _MISSING and usage is not None:
            if self.provider == "openai":
                self._observe_openai_usage(usage)
            else:
                self._observe_anthropic_usage(usage)

        # Anthropic message_start carries usage/model inside ``message``;
        # parsed streaming events may expose a snapshot similarly. Bound the
        # recursion to these two known fields rather than walking arbitrary
        # provider objects.
        for nested_name in ("message", "message_snapshot"):
            nested = _get(value, nested_name)
            if nested is not _MISSING and nested is not value:
                nested_usage = _get(nested, "usage")
                if nested_usage is not _MISSING and nested_usage is not None:
                    if self.provider == "openai":
                        self._observe_openai_usage(nested_usage)
                    else:
                        self._observe_anthropic_usage(nested_usage)
                nested_model = _get(nested, "model")
                if nested_model is not _MISSING and nested_model is not None:
                    self._observe_model(nested_model, expected_model)

        model = _get(value, "model")
        if model is not _MISSING and model is not None:
            self._observe_model(model, expected_model)

        tier = _get(value, "service_tier")
        if tier is not _MISSING and tier is not None:
            self._observe_tier(tier)

    def _observe_model(self, model: object, expected_model: str) -> None:
        # Alias-family prefix guesses can cross pricing boundaries. Until the
        # backend supplies a canonical priced-model identity, only exact/pinned
        # response evidence may settle.
        self.model_seen = True
        if not isinstance(model, str) or not model:
            self.model_valid = False
            return
        if self.observed_model is None:
            self.observed_model = model
        elif self.observed_model != model:
            self.model_valid = False
        self.model_valid = self.model_valid and model == expected_model

    def _observe_openai_usage(self, usage: object) -> None:
        self.input_tokens, valid = _merge_token_count(
            self.input_tokens,
            _get_first(usage, "prompt_tokens", "input_tokens"),
            monotonic=False,
        )
        self.token_counts_valid = self.token_counts_valid and valid
        self.output_tokens, valid = _merge_token_count(
            self.output_tokens,
            _get_first(usage, "completion_tokens", "output_tokens"),
            monotonic=True,
        )
        self.token_counts_valid = self.token_counts_valid and valid
        details = _get_first(
            usage,
            "prompt_tokens_details",
            "input_tokens_details",
            default=_MISSING,
        )
        cached = _get_first(
            details,
            "cached_tokens",
            default=_get(usage, "cached_tokens"),
        )
        cache_write = _get_first(
            details,
            "cache_write_tokens",
            "cache_creation_tokens",
            default=_get_first(
                usage,
                "cache_write_tokens",
                "cache_creation_tokens",
                default=_MISSING,
            ),
        )
        self.cache_read_seen, self.cache_read_zero = _merge_zero_evidence(
            self.cache_read_seen,
            self.cache_read_zero,
            cached,
        )
        self.cache_write_seen, self.cache_write_zero = _merge_zero_evidence(
            self.cache_write_seen,
            self.cache_write_zero,
            cache_write,
        )
        tier = _get(usage, "service_tier")
        if tier is not _MISSING and tier is not None:
            self._observe_tier(tier)
        self.evidence_safe = self.evidence_safe and _openai_usage_is_base_only(usage)

    def _observe_anthropic_usage(self, usage: object) -> None:
        self.input_tokens, valid = _merge_token_count(
            self.input_tokens,
            _get(usage, "input_tokens"),
            monotonic=False,
        )
        self.token_counts_valid = self.token_counts_valid and valid
        self.output_tokens, valid = _merge_token_count(
            self.output_tokens,
            _get(usage, "output_tokens"),
            monotonic=True,
        )
        self.token_counts_valid = self.token_counts_valid and valid
        self.cache_read_seen, self.cache_read_zero = _merge_zero_evidence(
            self.cache_read_seen,
            self.cache_read_zero,
            _get(usage, "cache_read_input_tokens"),
        )
        self.cache_write_seen, self.cache_write_zero = _merge_zero_evidence(
            self.cache_write_seen,
            self.cache_write_zero,
            _get(usage, "cache_creation_input_tokens"),
        )
        self.cache_write_zero = self.cache_write_zero and _zero_paid_evidence(
            _get(usage, "cache_creation")
        )
        tier = _get(usage, "service_tier")
        if tier is not _MISSING and tier is not None:
            self._observe_tier(tier)
        self.server_tool_usage_zero = self.server_tool_usage_zero and _server_tool_usage_is_zero(
            usage
        )
        self.evidence_safe = self.evidence_safe and _anthropic_usage_is_base_only(usage)

    def _observe_tier(self, value: object) -> None:
        self.tier_seen = True
        expected = "default" if self.provider == "openai" else "standard"
        self.tier_valid = self.tier_valid and value == expected

    @property
    def exact(self) -> bool:
        return (
            self.input_tokens is not None
            and self.output_tokens is not None
            and self.cache_read_seen
            and self.cache_read_zero
            and self.cache_write_seen
            and self.cache_write_zero
            and self.tier_seen
            and self.tier_valid
            and self.server_tool_usage_zero
            and self.model_seen
            and self.model_valid
            and self.token_counts_valid
            and self.evidence_safe
        )


def _strict_error(provider: Provider, reason: StrictProviderReason) -> PylvaStrictProviderError:
    return PylvaStrictProviderError(provider, reason)


def _local_strict_error(
    provider: Provider, reason: StrictProviderReason
) -> PylvaStrictProviderError:
    _controlled_local_no_dispatch("llm")
    return _strict_error(provider, reason)


def _get(value: object, name: str) -> object:
    if value is _MISSING or value is None:
        return _MISSING
    if type(value) is dict:
        value = cast(dict[str, object], value)
        return value.get(name, _MISSING)
    try:
        return getattr(value, name)
    except (AttributeError, TypeError):
        return _MISSING


def _get_first(value: object, *names: str, default: object = _MISSING) -> object:
    for name in names:
        candidate = _get(value, name)
        if candidate is not _MISSING:
            return candidate
    return default


def _as_uint32(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > _UINT32_MAX:
        return None
    return value


def _merge_token_count(
    current: int | None,
    value: object,
    *,
    monotonic: bool,
) -> tuple[int | None, bool]:
    # Provider SDK models commonly materialize an omitted optional field as
    # ``None``. It contributes no new evidence; it must not contradict a
    # previously observed required count from another stream event.
    if value is _MISSING or value is None:
        return current, True
    parsed = _as_uint32(value)
    if parsed is None:
        return current, False
    if current is None:
        return parsed, True
    if monotonic:
        return max(current, parsed), parsed >= current
    return current, parsed == current


def _merge_zero_evidence(
    seen: bool,
    zero: bool,
    value: object,
) -> tuple[bool, bool]:
    # Cache counters are optional in both official SDK models. The validated
    # request proves caching ineligible, while an explicit non-zero counter
    # still invalidates exact settlement.
    if value is _MISSING or value is None:
        return seen, zero
    parsed = _as_uint32(value)
    return True, zero and parsed == 0


_OPENAI_BASE_USAGE_KEYS = {
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
}
_OPENAI_BASE_COMPLETION_DETAIL_KEYS = {
    "accepted_prediction_tokens",
    "reasoning_tokens",
    "rejected_prediction_tokens",
    "text_tokens",
}
_OPENAI_SEPARATELY_PRICED_DETAIL_KEYS = {
    "audio_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "cache_creation_tokens",
}


def _evidence_record(value: object) -> dict[object, object] | None:
    if type(value) is dict:
        record = cast(dict[object, object], value)
        return record if len(record) <= _MAX_EVIDENCE_RECORD_ENTRIES else None
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(mode="python")
        except TypeError:
            dumped = model_dump()
        if type(dumped) is not dict:
            return None
        record = cast(dict[object, object], dumped)
        return record if len(record) <= _MAX_EVIDENCE_RECORD_ENTRIES else None
    data = getattr(value, "__dict__", None)
    if type(data) is not dict or len(data) > _MAX_EVIDENCE_RECORD_ENTRIES:
        return None
    # Plain test doubles may store provider fields directly in __dict__. A
    # class-level public property/descriptor could hide additional paid usage,
    # so such shapes are not exact enough to settle.
    class_data = vars(type(value))
    if len(class_data) > _MAX_EVIDENCE_RECORD_ENTRIES:
        return None
    if any(
        isinstance(name, str) and not name.startswith("_") and name not in data
        for name in class_data
    ):
        return None
    return cast(dict[object, object], data)


def _optional_token_count_is_valid(value: object) -> bool:
    return (
        value is _MISSING
        or value is None
        or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)
    )


def _zero_paid_evidence(
    value: object,
    *,
    depth: int = 0,
    seen: set[int] | None = None,
) -> bool:
    if value is _MISSING or value is None or value is False:
        return True
    if isinstance(value, int) and not isinstance(value, bool) and value == 0:
        return True
    if isinstance(value, str) and value == "":
        return True
    if depth >= 8:
        return False
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return False
    seen.add(identity)
    if isinstance(value, (list, tuple)):
        if len(value) > 256:
            return False
        return all(_zero_paid_evidence(item, depth=depth + 1, seen=seen) for item in value)
    record = _evidence_record(value)
    if record is None or len(record) > 256:
        return False
    return all(_zero_paid_evidence(item, depth=depth + 1, seen=seen) for item in record.values())


def _openai_usage_details_are_base_only(
    value: object,
    base_keys: set[str],
    aggregate: int | None = None,
) -> bool:
    if value is _MISSING or value is None:
        return True
    record = _evidence_record(value)
    if record is None:
        return False
    for raw_key, item in record.items():
        if not isinstance(raw_key, str):
            return False
        if raw_key in base_keys:
            if not _optional_token_count_is_valid(item):
                return False
            if item is not None and (aggregate is None or cast(int, item) > aggregate):
                return False
            continue
        if raw_key in _OPENAI_SEPARATELY_PRICED_DETAIL_KEYS:
            if not _zero_paid_evidence(item):
                return False
            continue
        if not _zero_paid_evidence(item):
            return False
    return True


def _openai_usage_is_base_only(usage: object) -> bool:
    record = _evidence_record(usage)
    if record is None:
        return False
    prompt_tokens = record.get("prompt_tokens", _MISSING)
    input_tokens = record.get("input_tokens", _MISSING)
    completion_tokens = record.get("completion_tokens", _MISSING)
    output_tokens = record.get("output_tokens", _MISSING)
    exact_input = (
        cast(int, prompt_tokens)
        if _optional_token_count_is_valid(prompt_tokens) and prompt_tokens not in (_MISSING, None)
        else cast(int, input_tokens)
        if _optional_token_count_is_valid(input_tokens) and input_tokens not in (_MISSING, None)
        else None
    )
    exact_output = (
        cast(int, completion_tokens)
        if _optional_token_count_is_valid(completion_tokens)
        and completion_tokens not in (_MISSING, None)
        else cast(int, output_tokens)
        if _optional_token_count_is_valid(output_tokens) and output_tokens not in (_MISSING, None)
        else None
    )
    for raw_key, item in record.items():
        if not isinstance(raw_key, str):
            return False
        if raw_key in _OPENAI_BASE_USAGE_KEYS:
            if not _optional_token_count_is_valid(item):
                return False
            continue
        if raw_key in {"prompt_tokens_details", "input_tokens_details"}:
            if not _openai_usage_details_are_base_only(item, set(), exact_input):
                return False
            continue
        if raw_key in {"completion_tokens_details", "output_tokens_details"}:
            if not _openai_usage_details_are_base_only(
                item,
                _OPENAI_BASE_COMPLETION_DETAIL_KEYS,
                exact_output,
            ):
                return False
            continue
        if raw_key == "service_tier":
            if item not in (_MISSING, None, "default"):
                return False
            continue
        # Unknown non-zero usage can represent a separately billed component.
        if not _zero_paid_evidence(item):
            return False
    if (
        prompt_tokens not in (_MISSING, None)
        and input_tokens not in (_MISSING, None)
        and prompt_tokens != input_tokens
    ):
        return False
    if (
        completion_tokens not in (_MISSING, None)
        and output_tokens not in (_MISSING, None)
        and completion_tokens != output_tokens
    ):
        return False
    total_tokens = record.get("total_tokens", _MISSING)
    if total_tokens not in (_MISSING, None) and (
        exact_input is None or exact_output is None or total_tokens != exact_input + exact_output
    ):
        return False
    return True


def _anthropic_usage_is_base_only(usage: object) -> bool:
    record = _evidence_record(usage)
    if record is None:
        return False
    output_tokens = record.get("output_tokens", _MISSING)
    exact_output = (
        cast(int, output_tokens)
        if _optional_token_count_is_valid(output_tokens) and output_tokens not in (_MISSING, None)
        else None
    )
    for raw_key, item in record.items():
        if not isinstance(raw_key, str):
            return False
        if raw_key in {"input_tokens", "output_tokens"}:
            if not _optional_token_count_is_valid(item):
                return False
            continue
        if raw_key in {
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "cache_creation",
            "server_tool_use",
        }:
            if not _zero_paid_evidence(item):
                return False
            continue
        if raw_key == "output_tokens_details":
            if not _openai_usage_details_are_base_only(item, {"thinking_tokens"}, exact_output):
                return False
            continue
        if raw_key == "service_tier":
            if item not in (_MISSING, None, "standard"):
                return False
            continue
        if raw_key == "inference_geo":
            if item is not _MISSING and item is not None and not isinstance(item, str):
                return False
            continue
        # Unknown zero-valued additive fields are harmless; unknown non-zero
        # usage remains unresolved until the ledger explicitly prices it.
        if not _zero_paid_evidence(item):
            return False
    return True


def _server_tool_usage_is_zero(value: object, *, depth: int = 0) -> bool:
    if depth > 6 or value is None or value is _MISSING:
        return True
    if type(value) is dict:
        value = cast(dict[object, object], value)
        if len(value) > _MAX_EVIDENCE_RECORD_ENTRIES:
            return False
        for key, item in value.items():
            normalized = str(key).lower()
            if "server_tool" in normalized:
                if type(item) is dict:
                    if not _all_numeric_leaves_zero(item, depth=depth + 1):
                        return False
                elif item not in (None, 0, False, [], {}):
                    return False
            if not _server_tool_usage_is_zero(item, depth=depth + 1):
                return False
        return True
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _server_tool_usage_is_zero(model_dump(mode="python"), depth=depth + 1)
        except (TypeError, ValueError):
            return False
    data = getattr(value, "__dict__", None)
    if type(data) is dict:
        if len(data) > _MAX_EVIDENCE_RECORD_ENTRIES:
            return False
        return _server_tool_usage_is_zero(data, depth=depth + 1)
    if isinstance(value, (list, tuple)):
        if len(value) > _MAX_EVIDENCE_RECORD_ENTRIES:
            return False
        return all(_server_tool_usage_is_zero(item, depth=depth + 1) for item in value)
    return True


def _all_numeric_leaves_zero(value: object, *, depth: int) -> bool:
    if depth > 7:
        return False
    if type(value) is dict:
        value = cast(dict[object, object], value)
        if len(value) > _MAX_EVIDENCE_RECORD_ENTRIES:
            return False
        return all(_all_numeric_leaves_zero(item, depth=depth + 1) for item in value.values())
    if isinstance(value, (list, tuple)):
        if len(value) > _MAX_EVIDENCE_RECORD_ENTRIES:
            return False
        return all(_all_numeric_leaves_zero(item, depth=depth + 1) for item in value)
    if value is None:
        return True
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0


def _json_bytes(value: object, provider: Provider) -> int:
    return len(_encode_json(value, provider))


def _encode_json(value: object, provider: Provider) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (UnicodeEncodeError, TypeError, ValueError, OverflowError) as error:
        raise _strict_error(provider, "unsupported_request_shape") from error


def _detached_json_record(value: object, provider: Provider) -> tuple[dict[str, Any], int]:
    _validate_bounded_plain_json(value, provider)
    encoded = _encode_json(value, provider)
    try:
        snapshot = json.loads(encoded)
    except (UnicodeDecodeError, TypeError, ValueError) as error:
        raise _strict_error(provider, "unsupported_request_shape") from error
    if type(snapshot) is not dict:
        raise _strict_error(provider, "unsupported_request_shape")
    detached = cast(dict[str, Any], snapshot)
    return detached, len(_encode_json(detached, provider))


def _validate_bounded_plain_json(value: object, provider: Provider) -> None:
    """Reject cycles, shared aliases, custom containers, and hostile payloads.

    Provider request types are JSON-shaped TypedDicts. Accepting arbitrary
    ``Mapping`` implementations here would execute user callbacks during a
    budget check and could turn local bounding into an unbounded traversal.
    """

    seen: set[int] = set()
    nodes = 0
    scalar_bytes = 0

    def visit(item: object, depth: int) -> None:
        nonlocal nodes, scalar_bytes
        nodes += 1
        if nodes > _MAX_REQUEST_NODES or depth > _MAX_REQUEST_DEPTH:
            raise _strict_error(provider, "unsupported_request_shape")
        if item is None or type(item) is bool:
            return
        if type(item) is str:
            try:
                scalar_bytes += len(item.encode("utf-8", errors="strict"))
            except UnicodeEncodeError as error:
                raise _strict_error(provider, "unsupported_request_shape") from error
            if scalar_bytes > _MAX_LOCAL_SCALAR_BYTES:
                raise _strict_error(provider, "unsupported_request_shape")
            return
        if type(item) is int:
            return
        if type(item) is float:
            if not math.isfinite(item):
                raise _strict_error(provider, "unsupported_request_shape")
            return
        if type(item) not in {dict, list}:
            raise _strict_error(provider, "unsupported_request_shape")
        object_id = id(item)
        if object_id in seen:
            raise _strict_error(provider, "unsupported_request_shape")
        seen.add(object_id)
        if len(cast(Any, item)) > _MAX_CONTAINER_ITEMS:
            raise _strict_error(provider, "unsupported_request_shape")
        if type(item) is dict:
            for key, nested in cast(dict[object, object], item).items():
                if type(key) is not str:
                    raise _strict_error(provider, "unsupported_request_shape")
                visit(key, depth + 1)
                visit(nested, depth + 1)
        else:
            for nested in cast(list[object], item):
                visit(nested, depth + 1)

    visit(value, 0)


def _positive_uint32(value: object, provider: Provider) -> int:
    parsed = _as_uint32(value)
    if parsed is None or parsed == 0:
        raise _strict_error(provider, "usage_bound_required")
    return parsed


def _validate_number(value: object, provider: Provider) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _strict_error(provider, "unsupported_request_shape")
    if isinstance(value, float) and not math.isfinite(value):
        raise _strict_error(provider, "unsupported_request_shape")


def _contains_key(value: object, rejected: set[str], *, depth: int = 0) -> bool:
    if depth > 20:
        return True
    if isinstance(value, Mapping):
        return any(
            str(key) in rejected or _contains_key(item, rejected, depth=depth + 1)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_key(item, rejected, depth=depth + 1) for item in value)
    return False


def _validate_json_schema(value: object, provider: Provider) -> None:
    if not isinstance(value, Mapping):
        raise _strict_error(provider, "unsupported_request_shape")
    _json_bytes(value, provider)


def _validate_openai_messages(value: object) -> int:
    provider: Provider = "openai"
    if not isinstance(value, list) or not value:
        raise _strict_error(provider, "unsupported_request_shape")
    for message in value:
        if not isinstance(message, Mapping):
            raise _strict_error(provider, "unsupported_request_shape")
        allowed = {
            "role",
            "content",
            "name",
            "tool_call_id",
            "tool_calls",
            "function_call",
        }
        if any(key not in allowed for key in message):
            raise _strict_error(provider, "unsupported_pricing_feature")
        if message.get("role") not in {
            "developer",
            "system",
            "user",
            "assistant",
            "tool",
            "function",
        }:
            raise _strict_error(provider, "unsupported_request_shape")
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            if not isinstance(content, list):
                raise _strict_error(provider, "unsupported_request_shape")
            for part in content:
                if (
                    not isinstance(part, Mapping)
                    or set(part) - {"type", "text"}
                    or part.get("type") != "text"
                    or not isinstance(part.get("text"), str)
                ):
                    raise _strict_error(provider, "unsupported_pricing_feature")
        tool_calls = message.get("tool_calls")
        if tool_calls is not None:
            if not isinstance(tool_calls, list):
                raise _strict_error(provider, "unsupported_request_shape")
            for call in tool_calls:
                function = call.get("function") if isinstance(call, Mapping) else None
                if (
                    not isinstance(call, Mapping)
                    or set(call) - {"id", "type", "function"}
                    or call.get("type") != "function"
                    or not isinstance(function, Mapping)
                    or set(function) - {"name", "arguments"}
                    or not isinstance(function.get("name"), str)
                    or not isinstance(function.get("arguments"), str)
                ):
                    raise _strict_error(provider, "unsupported_request_shape")
    return len(value)


def _validate_openai_tools(value: object) -> int:
    provider: Provider = "openai"
    if not isinstance(value, list):
        raise _strict_error(provider, "unsupported_request_shape")
    for tool in value:
        function = tool.get("function") if isinstance(tool, Mapping) else None
        if (
            not isinstance(tool, Mapping)
            or set(tool) - {"type", "function"}
            or tool.get("type") != "function"
            or not isinstance(function, Mapping)
            or set(function) - {"name", "description", "parameters", "strict"}
            or not isinstance(function.get("name"), str)
        ):
            raise _strict_error(provider, "unsupported_pricing_feature")
        if "parameters" in function:
            _validate_json_schema(function["parameters"], provider)
        if "strict" in function and not isinstance(function["strict"], bool):
            raise _strict_error(provider, "unsupported_request_shape")
    return len(value)


def _prepare_openai_request(kwargs: Mapping[str, Any]) -> PreparedProviderRequest:
    provider: Provider = "openai"
    if type(kwargs) is not dict:
        raise _strict_error(provider, "unsupported_request_shape")
    request, _ = _detached_json_record(kwargs, provider)
    per_call_retries = request.pop("max_retries", 0)
    if per_call_retries != 0 or isinstance(per_call_retries, bool):
        raise _strict_error(provider, "provider_retries_enabled")
    allowed = {
        "model",
        "messages",
        "max_completion_tokens",
        "max_tokens",
        "stream",
        "stream_options",
        "tools",
        "tool_choice",
        "functions",
        "function_call",
        "response_format",
        "temperature",
        "top_p",
        "stop",
        "seed",
        "presence_penalty",
        "frequency_penalty",
        "logit_bias",
        "user",
        "service_tier",
        "n",
        "store",
        "timeout",
    }
    if set(request) - allowed:
        raise _strict_error(provider, "unsupported_pricing_feature")
    model = request.get("model")
    if not isinstance(model, str) or not model or len(model) > 255:
        raise _strict_error(provider, "unsupported_request_shape")
    message_count = _validate_openai_messages(request.get("messages"))

    cap_fields = [name for name in ("max_completion_tokens", "max_tokens") if name in request]
    if len(cap_fields) != 1:
        raise _strict_error(provider, "usage_bound_required")
    max_output_tokens = _positive_uint32(request[cap_fields[0]], provider)

    stream = request.get("stream", False)
    if not isinstance(stream, bool):
        raise _strict_error(provider, "unsupported_request_shape")
    request["stream"] = stream
    if stream:
        stream_options = request.get("stream_options", {})
        if not isinstance(stream_options, Mapping) or set(stream_options) - {"include_usage"}:
            raise _strict_error(provider, "unsupported_request_shape")
        if stream_options.get("include_usage", True) is not True:
            raise _strict_error(provider, "usage_bound_required")
        request["stream_options"] = {"include_usage": True}
    elif "stream_options" in request:
        raise _strict_error(provider, "unsupported_request_shape")

    if request.get("service_tier", "default") != "default":
        raise _strict_error(provider, "unsupported_pricing_feature")
    request["service_tier"] = "default"
    if request.get("n", 1) != 1 or isinstance(request.get("n", 1), bool):
        raise _strict_error(provider, "unsupported_pricing_feature")
    request["n"] = 1
    if request.get("store", False) is not False:
        raise _strict_error(provider, "unsupported_pricing_feature")
    request["store"] = False

    for name in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
        if name in request:
            _validate_number(request[name], provider)
    if "tools" in request:
        tool_count = _validate_openai_tools(request["tools"])
    else:
        tool_count = 0
    if "functions" in request:
        functions = request["functions"]
        if not isinstance(functions, list):
            raise _strict_error(provider, "unsupported_request_shape")
        _validate_openai_tools([{"type": "function", "function": item} for item in functions])
        tool_count += len(functions)
    if "response_format" in request:
        response_format = request["response_format"]
        if not isinstance(response_format, Mapping) or response_format.get("type") not in {
            "text",
            "json_object",
            "json_schema",
        }:
            raise _strict_error(provider, "unsupported_request_shape")
        if response_format.get("type") == "json_schema":
            json_schema = response_format.get("json_schema")
            if not isinstance(json_schema, Mapping):
                raise _strict_error(provider, "unsupported_request_shape")
            schema = json_schema.get("schema")
            _validate_json_schema(schema, provider)

    # UTF-8 bytes upper-bound tokenizer pieces; the explicit framing allowance
    # covers provider message/tool protocol tokens without transmitting text.
    request, request_bytes = _detached_json_record(request, provider)
    estimated_input_tokens = request_bytes + 256 + message_count * 64 + tool_count * 128
    if estimated_input_tokens >= _OPENAI_CACHE_THRESHOLD_TOKENS:
        # OpenAI prompt caching is automatic at this threshold.  Until the
        # provider offers a stable disable switch, the strict subset refuses
        # larger prompts rather than guessing cache write/read pricing.
        raise _strict_error(provider, "unsupported_pricing_feature")
    return PreparedProviderRequest(
        provider=provider,
        model=model,
        kwargs=request,
        estimated_input_tokens=estimated_input_tokens,
        max_output_tokens=max_output_tokens,
        stream=stream,
    )


def prepare_openai_request(kwargs: Mapping[str, Any]) -> PreparedProviderRequest:
    try:
        return _prepare_openai_request(kwargs)
    except PylvaStrictProviderError:
        _controlled_local_no_dispatch("llm")
        raise


_ANTHROPIC_SERVER_TOOL_NAMES = {
    "web_search",
    "web_fetch",
    "code_execution",
    "bash",
    "text_editor",
    "computer",
    "memory",
}


def _validate_anthropic_content(value: object, *, allow_tool_blocks: bool) -> None:
    provider: Provider = "anthropic"
    if isinstance(value, str):
        return
    if not isinstance(value, list):
        raise _strict_error(provider, "unsupported_request_shape")
    for block in value:
        if not isinstance(block, Mapping):
            raise _strict_error(provider, "unsupported_request_shape")
        kind = block.get("type")
        if kind == "text":
            if set(block) - {"type", "text", "citations"} or not isinstance(block.get("text"), str):
                raise _strict_error(provider, "unsupported_request_shape")
            if block.get("citations") not in (None, []):
                raise _strict_error(provider, "unsupported_pricing_feature")
        elif allow_tool_blocks and kind == "tool_use":
            if (
                set(block) - {"type", "id", "name", "input"}
                or not isinstance(block.get("id"), str)
                or not isinstance(block.get("name"), str)
                or not isinstance(block.get("input"), Mapping)
            ):
                raise _strict_error(provider, "unsupported_request_shape")
        elif allow_tool_blocks and kind == "tool_result":
            if set(block) - {"type", "tool_use_id", "content", "is_error"}:
                raise _strict_error(provider, "unsupported_request_shape")
            _validate_anthropic_content(block.get("content", ""), allow_tool_blocks=False)
        else:
            raise _strict_error(provider, "unsupported_pricing_feature")


def _validate_anthropic_messages(value: object) -> int:
    provider: Provider = "anthropic"
    if not isinstance(value, list) or not value:
        raise _strict_error(provider, "unsupported_request_shape")
    for message in value:
        if (
            not isinstance(message, Mapping)
            or set(message) - {"role", "content"}
            or message.get("role") not in {"user", "assistant"}
        ):
            raise _strict_error(provider, "unsupported_request_shape")
        _validate_anthropic_content(message.get("content"), allow_tool_blocks=True)
    return len(value)


def _validate_anthropic_tools(value: object) -> int:
    provider: Provider = "anthropic"
    if not isinstance(value, list):
        raise _strict_error(provider, "unsupported_request_shape")
    for tool in value:
        if not isinstance(tool, Mapping):
            raise _strict_error(provider, "unsupported_request_shape")
        kind = tool.get("type", "custom")
        name = tool.get("name")
        if (
            kind not in {"custom", None}
            or not isinstance(name, str)
            or name.lower() in _ANTHROPIC_SERVER_TOOL_NAMES
            or any(server_name in str(kind).lower() for server_name in _ANTHROPIC_SERVER_TOOL_NAMES)
            or set(tool) - {"type", "name", "description", "input_schema", "strict"}
        ):
            raise _strict_error(provider, "unsupported_pricing_feature")
        _validate_json_schema(tool.get("input_schema"), provider)
    return len(value)


def _prepare_anthropic_request(kwargs: Mapping[str, Any]) -> PreparedProviderRequest:
    provider: Provider = "anthropic"
    if type(kwargs) is not dict:
        raise _strict_error(provider, "unsupported_request_shape")
    request, _ = _detached_json_record(kwargs, provider)
    per_call_retries = request.pop("max_retries", 0)
    if per_call_retries != 0 or isinstance(per_call_retries, bool):
        raise _strict_error(provider, "provider_retries_enabled")
    allowed = {
        "model",
        "messages",
        "max_tokens",
        "system",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "top_k",
        "stop_sequences",
        "metadata",
        "stream",
        "service_tier",
        "timeout",
    }
    if set(request) - allowed:
        raise _strict_error(provider, "unsupported_pricing_feature")
    if _contains_key(request, {"cache_control"}):
        raise _strict_error(provider, "unsupported_pricing_feature")
    model = request.get("model")
    if not isinstance(model, str) or not model or len(model) > 255:
        raise _strict_error(provider, "unsupported_request_shape")
    message_count = _validate_anthropic_messages(request.get("messages"))
    max_output_tokens = _positive_uint32(request.get("max_tokens"), provider)
    if "system" in request:
        _validate_anthropic_content(request["system"], allow_tool_blocks=False)
    if "tools" in request:
        tool_count = _validate_anthropic_tools(request["tools"])
    else:
        tool_count = 0
    if request.get("service_tier", "standard_only") != "standard_only":
        raise _strict_error(provider, "unsupported_pricing_feature")
    request["service_tier"] = "standard_only"
    stream = request.get("stream", False)
    if not isinstance(stream, bool):
        raise _strict_error(provider, "unsupported_request_shape")
    request["stream"] = stream
    for name in ("temperature", "top_p", "top_k"):
        if name in request:
            _validate_number(request[name], provider)
    if "metadata" in request:
        metadata = request["metadata"]
        if not isinstance(metadata, Mapping) or set(metadata) - {"user_id"}:
            raise _strict_error(provider, "unsupported_request_shape")

    request, request_bytes = _detached_json_record(request, provider)
    estimated_input_tokens = request_bytes + 256 + message_count * 64 + tool_count * 128
    if estimated_input_tokens >= _ANTHROPIC_LONG_CONTEXT_GUARD_TOKENS:
        raise _strict_error(provider, "unsupported_pricing_feature")
    return PreparedProviderRequest(
        provider=provider,
        model=model,
        kwargs=request,
        estimated_input_tokens=estimated_input_tokens,
        max_output_tokens=max_output_tokens,
        stream=stream,
    )


def prepare_anthropic_request(kwargs: Mapping[str, Any]) -> PreparedProviderRequest:
    try:
        return _prepare_anthropic_request(kwargs)
    except PylvaStrictProviderError:
        _controlled_local_no_dispatch("llm")
        raise


def is_async_provider_method(method: Callable[..., Any], provider: Provider) -> bool:
    """Classify generated provider methods without invoking them.

    Current OpenAI and Anthropic async methods are wrapped by generated
    decorators whose outer callable is synchronous. ``inspect.unwrap`` reaches
    the SDK coroutine through standard ``__wrapped__`` metadata, so the
    controlled wrapper selects the async path before reserving or dispatching.
    """

    if inspect.iscoroutinefunction(method):
        return True
    try:
        unwrapped = inspect.unwrap(method)
    except Exception as error:
        raise _local_strict_error(provider, "invalid_client") from error
    return inspect.iscoroutinefunction(unwrapped)


def validate_heartbeat_interval(value: float | None, provider: Provider) -> float | None:
    if value is None:
        return _DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _local_strict_error(provider, "unsupported_request_shape")
    interval = float(value)
    if not math.isfinite(interval) or interval < 1 or interval > _MAX_HEARTBEAT_INTERVAL_SECONDS:
        raise _local_strict_error(provider, "unsupported_request_shape")
    return interval


def default_heartbeat_interval() -> float:
    return _DEFAULT_HEARTBEAT_INTERVAL_SECONDS


def _reservation_body(prepared: PreparedProviderRequest) -> dict[str, Any]:
    ctx = current_context()
    return {
        "kind": "llm",
        "operation_id": str(uuid.uuid4()),
        "customer_id": ctx.customer_id if ctx else "anonymous",
        "trace_id": ctx.trace_id if ctx else str(uuid.uuid4()),
        "span_id": str(uuid.uuid4()),
        "parent_span_id": ctx.span_id if ctx else None,
        "step_name": ctx.step_name if ctx else None,
        "framework": (ctx.framework if ctx and ctx.framework in _SUPPORTED_FRAMEWORKS else "none"),
        "reservation_ttl_seconds": 300,
        "provider": prepared.provider,
        "model": prepared.model,
        "estimated_input_tokens": prepared.estimated_input_tokens,
        "max_output_tokens": prepared.max_output_tokens,
    }


def _attempt_from_body(
    decision: object,
    prepared: PreparedProviderRequest,
    body: Mapping[str, Any],
) -> ControlledAttemptContext:
    return ControlledAttemptContext(
        kind="llm",
        operation_id=cast(str, body["operation_id"]),
        reservation_id=(
            decision.reservation_id if isinstance(decision, ReservedBudgetDecision) else None
        ),
        trace_id=cast(str, body["trace_id"]),
        span_id=cast(str, body["span_id"]),
        parent_span_id=cast(str | None, body["parent_span_id"]),
        customer_id=cast(str, body["customer_id"]),
        provider=prepared.provider,
        model=prepared.model,
        owns_reservation=isinstance(decision, ReservedBudgetDecision),
        legacy_telemetry_required=_is_legacy_billable(decision),
        config_generation=get_config_generation(),
    )


def reserve_sync(
    prepared: PreparedProviderRequest,
) -> tuple[object, ControlledAttemptContext]:
    # Resolve config before entering the provider hot path so an uninitialized
    # SDK cannot accidentally dispatch.
    body = _reservation_body(prepared)
    try:
        require_config()
        decision = control_client.reserve_usage_sync(body)
        return decision, _attempt_from_body(decision, prepared, body)
    except BaseException:
        _controlled_no_dispatch(_attempt_from_body(None, prepared, body))
        raise


async def reserve_async(
    prepared: PreparedProviderRequest,
) -> tuple[object, ControlledAttemptContext]:
    body = _reservation_body(prepared)
    try:
        require_config()
        decision = await control_client.reserve_usage(body)
        return decision, _attempt_from_body(decision, prepared, body)
    except BaseException:
        _controlled_no_dispatch(_attempt_from_body(None, prepared, body))
        raise


def _is_controlled(decision: object) -> bool:
    return isinstance(decision, ReservedBudgetDecision)


def _is_legacy_billable(decision: object) -> bool:
    return isinstance(decision, (BypassedBudgetDecision, UnavailableBudgetDecision))


@contextmanager
def dispatch_context(
    decision: object,
    prepared: PreparedProviderRequest,
    attempt: ControlledAttemptContext,
) -> Iterator[None]:
    with ExitStack() as stack:
        if isinstance(decision, ReservedBudgetDecision):
            stack.enter_context(controlled_operation_ownership(decision))
        stack.enter_context(_controlled_attempt_scope(attempt))
        stack.enter_context(strict_provider_dispatch(prepared.provider, prepared.model))
        yield


def _latency_ms(started: float) -> int:
    return min(max(int((time.monotonic() - started) * 1_000), 0), _UINT32_MAX)


def _emit_legacy(
    prepared: PreparedProviderRequest,
    evidence: UsageEvidence,
    started: float,
    status: Literal["success", "failure", "aborted"],
) -> None:
    try:
        enqueue(
            build_llm_event(
                provider=prepared.provider,
                model=evidence.observed_model or prepared.model,
                tokens_in=evidence.input_tokens or 0,
                tokens_out=evidence.output_tokens or 0,
                latency_ms=_latency_ms(started),
                status=status,
                token_count_source=(
                    "exact"
                    if evidence.input_tokens is not None and evidence.output_tokens is not None
                    else None
                ),
            )
        )
    except Exception:
        # Legacy telemetry remains best-effort during rollout.
        pass


def settle_sync(
    decision: object,
    prepared: PreparedProviderRequest,
    evidence: UsageEvidence,
    started: float,
) -> None:
    if isinstance(decision, ReservedBudgetDecision):
        if not evidence.exact:
            return
        try:
            control_client.commit_usage_sync(
                decision.reservation_id,
                {
                    "kind": "llm",
                    "actual_input_tokens": evidence.input_tokens,
                    "actual_output_tokens": evidence.output_tokens,
                    "status": "success",
                    "latency_ms": _latency_ms(started),
                    "stream_aborted": False,
                },
            )
        except Exception:
            # A response is already in the caller's hands.  Lost commit ACKs
            # remain reservation-owned and must never turn into legacy billing.
            return
    elif _is_legacy_billable(decision):
        _emit_legacy(prepared, evidence, started, "success")


async def settle_async(
    decision: object,
    prepared: PreparedProviderRequest,
    evidence: UsageEvidence,
    started: float,
) -> None:
    if isinstance(decision, ReservedBudgetDecision):
        if not evidence.exact:
            return
        try:
            await control_client.commit_usage(
                decision.reservation_id,
                {
                    "kind": "llm",
                    "actual_input_tokens": evidence.input_tokens,
                    "actual_output_tokens": evidence.output_tokens,
                    "status": "success",
                    "latency_ms": _latency_ms(started),
                    "stream_aborted": False,
                },
            )
        except Exception:
            return
    elif _is_legacy_billable(decision):
        _emit_legacy(prepared, evidence, started, "success")


def provider_failed(
    decision: object,
    prepared: PreparedProviderRequest,
    evidence: UsageEvidence,
    started: float,
) -> None:
    if _is_legacy_billable(decision):
        _emit_legacy(prepared, evidence, started, "failure")


def release_proven_predispatch_sync(decision: object) -> None:
    if not isinstance(decision, ReservedBudgetDecision):
        return
    try:
        control_client.release_usage_sync(
            decision.reservation_id,
            {"reason": "provider_not_called"},
        )
    except Exception:
        # Failed release becomes unresolved through expiry; it cannot authorize
        # a provider call or fall back to duplicate legacy billing.
        pass


async def release_proven_predispatch_async(decision: object) -> None:
    if not isinstance(decision, ReservedBudgetDecision):
        return
    try:
        await control_client.release_usage(
            decision.reservation_id,
            {"reason": "provider_not_called"},
        )
    except Exception:
        pass


class _ControlledLifecycleStream(Protocol):
    def abandon_from_lifecycle(self) -> object | None: ...


class _ControlledAttemptLifecycleLease:
    """Weakly registered cancellation state for one post-reservation attempt."""

    __slots__ = ("__weakref__", "_cancelled", "_finished", "_lock", "_stream_state")

    def __init__(self) -> None:
        self._cancelled = False
        self._finished = False
        self._lock = threading.Lock()
        self._stream_state: weakref.ReferenceType[Any] | None = None

    def bind_stream_state(self, state: object) -> object | None:
        cancel_now = False
        with self._lock:
            if self._cancelled or self._finished:
                cancel_now = True
            else:
                self._stream_state = weakref.ref(state)
        if cancel_now:
            return cast(_ControlledLifecycleStream, state).abandon_from_lifecycle()
        return None

    def cancel(self) -> object | None:
        stream_state: object | None = None
        with self._lock:
            if self._cancelled or self._finished:
                return None
            self._cancelled = True
            if self._stream_state is not None:
                stream_state = self._stream_state()
        if stream_state is not None:
            return cast(
                _ControlledLifecycleStream,
                stream_state,
            ).abandon_from_lifecycle()
        return None

    def finish(self) -> bool:
        with self._lock:
            if self._finished:
                return False
            self._finished = True
            self._stream_state = None
            return not self._cancelled


class _AsyncLoopAffinity:
    """Bind one async provider facade to its first operational event loop."""

    __slots__ = ("_lock", "_loop", "_provider")

    def __init__(self, provider: Provider) -> None:
        self._provider = provider
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def bind(self) -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        with self._lock:
            owner = self._loop
            if owner is None:
                self._loop = loop
            elif owner is not loop:
                raise _strict_error(self._provider, "invalid_client")
        return loop


class _ControlledClientLifecycle:
    """One close barrier shared by a controlled facade and its live attempts."""

    __slots__ = ("_attempts", "_closed", "_heartbeats", "_lock")

    def __init__(self) -> None:
        self._closed = False
        self._attempts: weakref.WeakSet[_ControlledAttemptLifecycleLease] = weakref.WeakSet()
        self._heartbeats: weakref.WeakSet[Any] = weakref.WeakSet()
        self._lock = threading.Lock()

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def register_heartbeat(self, heartbeat: object) -> None:
        should_stop = False
        with self._lock:
            if self._closed:
                should_stop = True
            else:
                self._heartbeats.add(heartbeat)
        if should_stop:
            cast(Any, heartbeat).stop()

    def unregister_heartbeat(self, heartbeat: object) -> None:
        with self._lock:
            self._heartbeats.discard(heartbeat)

    def register_attempt(self, lease: _ControlledAttemptLifecycleLease) -> None:
        cancel_now = False
        with self._lock:
            if self._closed:
                cancel_now = True
            else:
                self._attempts.add(lease)
        if cancel_now:
            lease.cancel()

    def finish_attempt(self, lease: _ControlledAttemptLifecycleLease) -> bool:
        with self._lock:
            if not self._closed:
                self._attempts.discard(lease)
                # Finish while holding the lifecycle lock so facade close
                # cannot linearize in the gap between deregistration and
                # settlement eligibility.
                return lease.finish()
        # Cancellation can call back into this lifecycle through stream
        # abandonment, so never perform it while holding the lifecycle lock.
        lease.cancel()
        return False

    def abandon_attempt(self, lease: _ControlledAttemptLifecycleLease) -> None:
        with self._lock:
            self._attempts.discard(lease)
        lease.finish()

    def cancel_attempt(self, lease: _ControlledAttemptLifecycleLease) -> None:
        with self._lock:
            self._attempts.discard(lease)
        lease.cancel()

    def _begin_close(
        self,
    ) -> tuple[
        bool,
        tuple[_SyncHeartbeat | _AsyncHeartbeat, ...],
        tuple[_ControlledAttemptLifecycleLease, ...],
    ]:
        with self._lock:
            if self._closed:
                return False, (), ()
            self._closed = True
            heartbeats = tuple(self._heartbeats)
            attempts = tuple(self._attempts)
            self._heartbeats.clear()
            self._attempts.clear()
        return True, heartbeats, attempts

    def close(self) -> bool:
        changed, heartbeats, attempts = self._begin_close()
        if not changed:
            return False
        for heartbeat in heartbeats:
            heartbeat.stop()
        for attempt in attempts:
            attempt.cancel()
        return True

    async def close_async(self) -> bool:
        changed, heartbeats, attempts = self._begin_close()
        if not changed:
            return False
        for heartbeat in heartbeats:
            heartbeat.stop()
        attempt_cleanups = tuple(attempt.cancel() for attempt in attempts)
        for heartbeat in heartbeats:
            if isinstance(heartbeat, _AsyncHeartbeat):
                await heartbeat.wait_stopped()
        for cleanup in attempt_cleanups:
            if inspect.isawaitable(cleanup):
                try:
                    await asyncio.shield(cleanup)
                except BaseException:
                    # The private provider client is closed immediately after
                    # this barrier.  A raw stream cleanup failure must not
                    # reactivate or settle the cancelled reservation.
                    pass
        return True


class _SyncHeartbeat:
    def __init__(self, decision: object, interval: float | None) -> None:
        self._reservation = decision if isinstance(decision, ReservedBudgetDecision) else None
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._deadline = time.monotonic() + _MAX_CONTROLLED_LIFETIME_SECONDS

    def start(self) -> None:
        if self._reservation is None or self._interval is None or self._stop.is_set():
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        assert self._interval is not None
        assert self._reservation is not None
        while True:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0 or self._stop.wait(min(self._interval, remaining)):
                return
            try:
                control_client.extend_usage_sync(
                    self._reservation.reservation_id,
                    {
                        "extension_id": str(uuid.uuid4()),
                        "extend_by_seconds": _EXTEND_BY_SECONDS,
                    },
                )
            except Exception:
                # Once provider dispatch occurred, extension uncertainty is
                # resolved by expiry/unresolved accounting, never a release.
                continue

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join()


class _AsyncHeartbeat:
    def __init__(self, decision: object, interval: float | None) -> None:
        self._reservation = decision if isinstance(decision, ReservedBudgetDecision) else None
        self._interval = interval
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop = threading.Event()
        self._task: asyncio.Task[None] | None = None
        self._deadline = time.monotonic() + _MAX_CONTROLLED_LIFETIME_SECONDS

    def start(self) -> None:
        if self._reservation is None or self._interval is None or self._stop.is_set():
            return
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        assert self._interval is not None
        assert self._reservation is not None
        while True:
            try:
                if self._stop.is_set():
                    return
                remaining = self._deadline - time.monotonic()
                if remaining <= 0:
                    return
                await asyncio.sleep(min(self._interval, remaining))
                if self._stop.is_set() or time.monotonic() >= self._deadline:
                    return
                await control_client.extend_usage(
                    self._reservation.reservation_id,
                    {
                        "extension_id": str(uuid.uuid4()),
                        "extend_by_seconds": _EXTEND_BY_SECONDS,
                    },
                )
            except asyncio.CancelledError:
                return
            except Exception:
                continue

    def stop(self) -> None:
        self._stop.set()
        task = self._task
        if task is None or task.done():
            return
        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None
        if task is current_task:
            return
        loop = self._loop
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        try:
            if loop is None or loop is running_loop or loop.is_closed():
                task.cancel()
            else:
                loop.call_soon_threadsafe(task.cancel)
        except RuntimeError:
            # A concurrently closing loop cannot run another extension; the
            # stop flag still prevents a later iteration if the task resumes.
            pass

    async def wait_stopped(self) -> None:
        task = self._task
        if task is None or task is asyncio.current_task():
            return
        caller = asyncio.current_task()
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if caller is not None and caller.cancelling():
                raise
            if not task.cancelled():
                raise
        except Exception:
            # Heartbeat failures are already fail-safe and never release a
            # post-dispatch reservation.  Shutdown only needs quiescence.
            pass


def _start_registered_heartbeat(
    heartbeat: _SyncHeartbeat | _AsyncHeartbeat,
    lifecycle: _ControlledClientLifecycle,
) -> None:
    heartbeat.start()
    lifecycle.register_heartbeat(heartbeat)


def _stop_registered_heartbeat(
    heartbeat: _SyncHeartbeat | _AsyncHeartbeat,
    lifecycle: _ControlledClientLifecycle,
) -> None:
    heartbeat.stop()
    lifecycle.unregister_heartbeat(heartbeat)


async def _stop_registered_heartbeat_async(
    heartbeat: _AsyncHeartbeat,
    lifecycle: _ControlledClientLifecycle,
) -> None:
    heartbeat.stop()
    lifecycle.unregister_heartbeat(heartbeat)
    await heartbeat.wait_stopped()


@dataclass(eq=False)
class _SyncControlledStreamState:
    stream: object
    decision: object
    attempt: ControlledAttemptContext
    prepared: PreparedProviderRequest
    started: float
    heartbeat: _SyncHeartbeat
    lifecycle: _ControlledClientLifecycle
    lifecycle_lease: _ControlledAttemptLifecycleLease
    evidence: UsageEvidence
    finished: bool = False
    settled: bool = False
    finalizer: weakref.finalize[..., Any] | None = None
    raw_shutdown_condition: threading.Condition = field(
        default_factory=threading.Condition,
        repr=False,
    )
    raw_shutdown_started: bool = False
    raw_shutdown_finished: bool = False
    raw_shutdown_owner: int | None = None
    raw_shutdown_result: Any = None
    raw_shutdown_error: BaseException | None = None

    def abandon_from_lifecycle(self) -> object | None:
        _sync_stream_abandon_state(self, "aborted")
        result: object | None = _sync_stream_shutdown_raw(self, suppress=True)
        return result


def _finalize_sync_stream(state: _SyncControlledStreamState) -> None:
    state.finalizer = None
    _sync_stream_abandon_state(state, "aborted")
    _sync_stream_shutdown_raw(state, suppress=True)


class SyncControlledStream(Iterator[Any]):
    """Narrow sync stream facade with no provider client or response escape."""

    __slots__ = ("__weakref__",)

    def __init__(
        self,
        stream: object,
        decision: object,
        attempt: ControlledAttemptContext,
        prepared: PreparedProviderRequest,
        started: float,
        heartbeat: _SyncHeartbeat,
        lifecycle: _ControlledClientLifecycle,
        lifecycle_lease: _ControlledAttemptLifecycleLease,
    ) -> None:
        state = _SyncControlledStreamState(
            stream=stream,
            decision=decision,
            attempt=attempt,
            prepared=prepared,
            started=started,
            heartbeat=heartbeat,
            lifecycle=lifecycle,
            lifecycle_lease=lifecycle_lease,
            evidence=UsageEvidence(prepared.provider),
        )
        _SYNC_CONTROLLED_STREAM_STATES[self] = state
        try:
            state.finalizer = weakref.finalize(
                self,
                _finalize_sync_stream,
                state,
            )
        except BaseException:
            del _SYNC_CONTROLLED_STREAM_STATES[self]
            _stop_registered_heartbeat(heartbeat, lifecycle)
            raise
        lifecycle_lease.bind_stream_state(state)

    def __iter__(self) -> Iterator[Any]:
        def consume() -> Iterator[Any]:
            completed = False
            try:
                while True:
                    yield self.__next__()
            except StopIteration:
                completed = True
                return
            finally:
                if not completed:
                    state = _sync_stream_state(self)
                    _sync_stream_abandon_state(state, "aborted")
                    _sync_stream_shutdown_raw(state, suppress=True)

        return consume()

    def __next__(self) -> Any:
        state = _sync_stream_state(self)
        if state.finished:
            raise StopIteration
        try:
            with dispatch_context(state.decision, state.prepared, state.attempt):
                item = next(cast(Iterator[Any], state.stream))
        except StopIteration:
            _sync_stream_finish_success(state)
            raise
        except BaseException:
            _sync_stream_finish_failure(state)
            raise
        state.evidence.observe(item, state.prepared.model)
        return item

    def close(self) -> Any:
        state = _sync_stream_state(self)
        state.lifecycle.cancel_attempt(state.lifecycle_lease)
        _sync_stream_abandon_state(state, "aborted")
        return _sync_stream_shutdown_raw(state, suppress=False)

    def __enter__(self) -> SyncControlledStream:
        state = _sync_stream_state(self)
        enter = getattr(state.stream, "__enter__", None)
        if callable(enter):
            entered = enter()
            if entered is not None:
                state.stream = entered
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Any:
        state = _sync_stream_state(self)
        state.lifecycle.cancel_attempt(state.lifecycle_lease)
        _sync_stream_abandon_state(state, "aborted" if exc_type is None else "failure")
        exit_method = getattr(state.stream, "__exit__", None)
        if not callable(exit_method):
            _sync_stream_shutdown_raw(state, suppress=exc_type is not None)
            return False
        result = _sync_stream_shutdown_raw(
            state,
            suppress=exc_type is not None,
            shutdown=lambda: exit_method(exc_type, exc, tb),
        )
        return bool(result)

    @property
    def text_stream(self) -> Iterator[str]:
        for event in self:
            delta = _get(event, "delta")
            text = _get(delta, "text")
            if isinstance(text, str):
                yield text

    def until_done(self) -> None:
        for _event in self:
            pass

    def get_final_message(self) -> Any:
        self.until_done()
        state = _sync_stream_state(self)
        getter = getattr(state.stream, "get_final_message", None)
        if not callable(getter):
            raise AttributeError("get_final_message")
        result = getter()
        state.evidence.observe(result, state.prepared.model)
        _sync_stream_try_settle(state)
        return result

    def get_final_text(self) -> str:
        self.until_done()
        state = _sync_stream_state(self)
        getter = getattr(state.stream, "get_final_text", None)
        if not callable(getter):
            raise AttributeError("get_final_text")
        result = cast(str, getter())
        _sync_stream_observe_terminal_snapshot(state)
        _sync_stream_try_settle(state)
        return result

    def __getattribute__(self, name: str) -> Any:
        if name in {
            "__class__",
            "__dir__",
            "__enter__",
            "__exit__",
            "__iter__",
            "__next__",
            "__weakref__",
            "close",
        }:
            return object.__getattribute__(self, name)
        if name in {"get_final_message", "get_final_text", "text_stream", "until_done"}:
            state = _sync_stream_state(self)
            if state.prepared.provider == "anthropic":
                return object.__getattribute__(self, name)
        _sync_stream_reject(self)

    def __getattr__(self, _name: str) -> Any:
        _sync_stream_reject(self)

    def __setattr__(self, _name: str, _value: object) -> None:
        _sync_stream_reject(self)

    def __delattr__(self, _name: str) -> None:
        _sync_stream_reject(self)

    def __copy__(self) -> Any:
        _sync_stream_reject(self)

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        _sync_stream_reject(self)

    def __reduce__(self) -> Any:
        _sync_stream_reject(self)

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        _sync_stream_reject(self)

    def __dir__(self) -> list[str]:
        state = _sync_stream_state(self)
        if state.prepared.provider == "anthropic":
            return ["close", "get_final_message", "get_final_text", "text_stream", "until_done"]
        return ["close"]


_SYNC_CONTROLLED_STREAM_STATES: weakref.WeakKeyDictionary[
    SyncControlledStream, _SyncControlledStreamState
] = weakref.WeakKeyDictionary()


def _sync_stream_state(facade: SyncControlledStream) -> _SyncControlledStreamState:
    try:
        return _SYNC_CONTROLLED_STREAM_STATES[facade]
    except (KeyError, TypeError) as error:
        raise RuntimeError("[pylva] invalid controlled sync stream facade") from error


def _sync_stream_reject(facade: SyncControlledStream) -> Any:
    state = _sync_stream_state(facade)
    raise _strict_error(state.prepared.provider, "unsupported_pricing_feature")


def _sync_stream_shutdown_raw(
    state: _SyncControlledStreamState,
    *,
    suppress: bool,
    shutdown: Callable[[], Any] | None = None,
) -> Any:
    condition = state.raw_shutdown_condition
    owner = threading.get_ident()
    with condition:
        if state.raw_shutdown_started:
            if state.raw_shutdown_owner == owner and not state.raw_shutdown_finished:
                return None
            while not state.raw_shutdown_finished:
                condition.wait()
            if state.raw_shutdown_error is not None and not suppress:
                raise state.raw_shutdown_error
            return state.raw_shutdown_result
        state.raw_shutdown_started = True
        state.raw_shutdown_owner = owner

    error: BaseException | None = None
    result: Any = None
    try:
        close = shutdown
        if close is None:
            candidate = getattr(state.stream, "close", None)
            close = candidate if callable(candidate) else None
        if close is not None:
            result = close()
    except BaseException as caught:
        error = caught.with_traceback(None)
    finally:
        with condition:
            state.raw_shutdown_result = result
            state.raw_shutdown_error = error
            state.raw_shutdown_finished = True
            condition.notify_all()

    if error is not None and not suppress:
        raise error
    return result


def _sync_stream_cleanup(state: _SyncControlledStreamState) -> None:
    _stop_registered_heartbeat(state.heartbeat, state.lifecycle)
    if state.finalizer is not None:
        state.finalizer.detach()


def _sync_stream_observe_terminal_snapshot(state: _SyncControlledStreamState) -> None:
    try:
        snapshot = _get(state.stream, "current_message_snapshot")
    except BaseException:
        state.evidence.evidence_safe = False
        return
    if snapshot is not _MISSING:
        state.evidence.observe(snapshot, state.prepared.model)


def _sync_stream_try_settle(state: _SyncControlledStreamState) -> None:
    if state.settled:
        return
    if isinstance(state.decision, ReservedBudgetDecision) and not state.evidence.exact:
        return
    if not state.lifecycle.finish_attempt(state.lifecycle_lease):
        return
    state.settled = True
    settle_sync(
        state.decision,
        state.prepared,
        state.evidence,
        state.started,
    )


def _sync_stream_finish_success(state: _SyncControlledStreamState) -> None:
    if state.finished:
        return
    _sync_stream_observe_terminal_snapshot(state)
    state.finished = True
    _sync_stream_cleanup(state)
    _sync_stream_try_settle(state)


def _sync_stream_finish_failure(state: _SyncControlledStreamState) -> None:
    if state.finished:
        return
    state.finished = True
    _sync_stream_cleanup(state)
    state.lifecycle.abandon_attempt(state.lifecycle_lease)
    _sync_stream_shutdown_raw(state, suppress=True)
    provider_failed(
        state.decision,
        state.prepared,
        state.evidence,
        state.started,
    )


def _sync_stream_abandon(
    facade: SyncControlledStream,
    status: Literal["failure", "aborted"],
) -> None:
    _sync_stream_abandon_state(_sync_stream_state(facade), status)


def _sync_stream_abandon_state(
    state: _SyncControlledStreamState,
    status: Literal["failure", "aborted"],
) -> None:
    if state.finished:
        return
    state.finished = True
    _sync_stream_cleanup(state)
    state.lifecycle.abandon_attempt(state.lifecycle_lease)
    if _is_legacy_billable(state.decision):
        _emit_legacy(
            state.prepared,
            state.evidence,
            state.started,
            status,
        )


@dataclass(eq=False)
class _AsyncControlledStreamState:
    stream: object
    decision: object
    attempt: ControlledAttemptContext
    prepared: PreparedProviderRequest
    started: float
    heartbeat: _AsyncHeartbeat
    lifecycle: _ControlledClientLifecycle
    lifecycle_lease: _ControlledAttemptLifecycleLease
    loop: asyncio.AbstractEventLoop
    evidence: UsageEvidence
    finished: bool = False
    settled: bool = False
    finalizer: weakref.finalize[..., Any] | None = None
    raw_shutdown_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    raw_shutdown_task: asyncio.Task[Any] | None = None

    def abandon_from_lifecycle(self) -> object | None:
        _async_stream_abandon_state(self, "aborted")
        return _async_stream_start_shutdown(self)


def _finalize_async_stream(state: _AsyncControlledStreamState) -> None:
    state.finalizer = None
    _async_stream_abandon_state(state, "aborted")
    if state.loop.is_closed():
        return
    try:
        state.loop.call_soon_threadsafe(_async_stream_start_shutdown, state)
    except RuntimeError:
        # The loop can close between the check and scheduling.  The stopped
        # heartbeat cannot extend again, and interpreter shutdown cannot run
        # asynchronous provider cleanup safely.
        pass


class AsyncControlledStream(AsyncIterator[Any]):
    """Narrow async stream facade with no provider client or response escape."""

    __slots__ = ("__weakref__",)

    def __init__(
        self,
        stream: object,
        decision: object,
        attempt: ControlledAttemptContext,
        prepared: PreparedProviderRequest,
        started: float,
        heartbeat: _AsyncHeartbeat,
        lifecycle: _ControlledClientLifecycle,
        lifecycle_lease: _ControlledAttemptLifecycleLease,
    ) -> None:
        state = _AsyncControlledStreamState(
            stream=stream,
            decision=decision,
            attempt=attempt,
            prepared=prepared,
            started=started,
            heartbeat=heartbeat,
            lifecycle=lifecycle,
            lifecycle_lease=lifecycle_lease,
            loop=asyncio.get_running_loop(),
            evidence=UsageEvidence(prepared.provider),
        )
        _ASYNC_CONTROLLED_STREAM_STATES[self] = state
        try:
            state.finalizer = weakref.finalize(
                self,
                _finalize_async_stream,
                state,
            )
        except BaseException:
            del _ASYNC_CONTROLLED_STREAM_STATES[self]
            _stop_registered_heartbeat(heartbeat, lifecycle)
            raise
        lifecycle_lease.bind_stream_state(state)

    def __aiter__(self) -> AsyncIterator[Any]:
        async def consume() -> AsyncIterator[Any]:
            state = _async_stream_state(self)
            _ensure_async_stream_loop(state)
            completed = False
            try:
                while True:
                    yield await self.__anext__()
            except StopAsyncIteration:
                completed = True
                return
            finally:
                if not completed:
                    state = _async_stream_state(self)
                    state.lifecycle.cancel_attempt(state.lifecycle_lease)
                    _async_stream_abandon_state(state, "aborted")
                    await state.heartbeat.wait_stopped()
                    await _async_stream_shutdown_raw(state, suppress=True)

        return consume()

    async def __anext__(self) -> Any:
        state = _async_stream_state(self)
        _ensure_async_stream_loop(state)
        if state.finished:
            raise StopAsyncIteration
        try:
            with dispatch_context(state.decision, state.prepared, state.attempt):
                item = await cast(AsyncIterator[Any], state.stream).__anext__()
        except StopAsyncIteration:
            await _async_stream_finish_success(state)
            raise
        except BaseException:
            await _async_stream_finish_failure(state)
            raise
        state.evidence.observe(item, state.prepared.model)
        return item

    async def close(self) -> Any:
        state = _async_stream_state(self)
        _ensure_async_stream_loop(state)
        state.lifecycle.cancel_attempt(state.lifecycle_lease)
        _async_stream_abandon_state(state, "aborted")
        await state.heartbeat.wait_stopped()
        return await _async_stream_shutdown_raw(state, suppress=False)

    async def aclose(self) -> Any:
        return await self.close()

    async def __aenter__(self) -> AsyncControlledStream:
        state = _async_stream_state(self)
        _ensure_async_stream_loop(state)
        enter = getattr(state.stream, "__aenter__", None)
        if callable(enter):
            entered = await enter()
            if entered is not None:
                state.stream = entered
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> Any:
        state = _async_stream_state(self)
        _ensure_async_stream_loop(state)
        state.lifecycle.cancel_attempt(state.lifecycle_lease)
        _async_stream_abandon_state(state, "aborted" if exc_type is None else "failure")
        await state.heartbeat.wait_stopped()
        exit_method = getattr(state.stream, "__aexit__", None)
        if not callable(exit_method):
            await _async_stream_shutdown_raw(state, suppress=exc_type is not None)
            return False
        result = await _async_stream_shutdown_raw(
            state,
            suppress=exc_type is not None,
            shutdown=lambda: exit_method(exc_type, exc, tb),
        )
        return bool(result)

    @property
    def text_stream(self) -> AsyncIterator[str]:
        async def iterate() -> AsyncIterator[str]:
            async for event in self:
                delta = _get(event, "delta")
                text = _get(delta, "text")
                if isinstance(text, str):
                    yield text

        return iterate()

    async def until_done(self) -> None:
        async for _event in self:
            pass

    async def get_final_message(self) -> Any:
        await self.until_done()
        state = _async_stream_state(self)
        getter = getattr(state.stream, "get_final_message", None)
        if not callable(getter):
            raise AttributeError("get_final_message")
        result = getter()
        if inspect.isawaitable(result):
            result = await result
        state.evidence.observe(result, state.prepared.model)
        await _async_stream_try_settle(state)
        return result

    async def get_final_text(self) -> str:
        await self.until_done()
        state = _async_stream_state(self)
        getter = getattr(state.stream, "get_final_text", None)
        if not callable(getter):
            raise AttributeError("get_final_text")
        result = getter()
        if inspect.isawaitable(result):
            result = await result
        _async_stream_observe_terminal_snapshot(state)
        await _async_stream_try_settle(state)
        return cast(str, result)

    def __getattribute__(self, name: str) -> Any:
        if name in {
            "__aenter__",
            "__aexit__",
            "__aiter__",
            "__anext__",
            "__class__",
            "__dir__",
            "__weakref__",
            "aclose",
            "close",
        }:
            return object.__getattribute__(self, name)
        if name in {"get_final_message", "get_final_text", "text_stream", "until_done"}:
            state = _async_stream_state(self)
            if state.prepared.provider == "anthropic":
                return object.__getattribute__(self, name)
        _async_stream_reject(self)

    def __getattr__(self, _name: str) -> Any:
        _async_stream_reject(self)

    def __setattr__(self, _name: str, _value: object) -> None:
        _async_stream_reject(self)

    def __delattr__(self, _name: str) -> None:
        _async_stream_reject(self)

    def __copy__(self) -> Any:
        _async_stream_reject(self)

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        _async_stream_reject(self)

    def __reduce__(self) -> Any:
        _async_stream_reject(self)

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        _async_stream_reject(self)

    def __dir__(self) -> list[str]:
        state = _async_stream_state(self)
        if state.prepared.provider == "anthropic":
            return [
                "aclose",
                "close",
                "get_final_message",
                "get_final_text",
                "text_stream",
                "until_done",
            ]
        return ["aclose", "close"]


_ASYNC_CONTROLLED_STREAM_STATES: weakref.WeakKeyDictionary[
    AsyncControlledStream, _AsyncControlledStreamState
] = weakref.WeakKeyDictionary()


def _async_stream_state(facade: AsyncControlledStream) -> _AsyncControlledStreamState:
    try:
        return _ASYNC_CONTROLLED_STREAM_STATES[facade]
    except (KeyError, TypeError) as error:
        raise RuntimeError("[pylva] invalid controlled async stream facade") from error


def _ensure_async_stream_loop(state: _AsyncControlledStreamState) -> None:
    if asyncio.get_running_loop() is not state.loop:
        raise _strict_error(state.prepared.provider, "invalid_client")


def _async_stream_reject(facade: AsyncControlledStream) -> Any:
    state = _async_stream_state(facade)
    raise _strict_error(state.prepared.provider, "unsupported_pricing_feature")


async def _async_stream_run_shutdown(
    state: _AsyncControlledStreamState,
    shutdown: Callable[[], Any] | None,
) -> Any:
    close = shutdown
    if close is None:
        candidate = getattr(state.stream, "close", None)
        if not callable(candidate):
            candidate = getattr(state.stream, "aclose", None)
        close = candidate if callable(candidate) else None
    if close is None:
        return None
    result = close()
    return await result if inspect.isawaitable(result) else result


def _consume_shutdown_task(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except BaseException:
        pass


def _async_stream_start_shutdown(
    state: _AsyncControlledStreamState,
    shutdown: Callable[[], Any] | None = None,
) -> asyncio.Task[Any]:
    with state.raw_shutdown_lock:
        task = state.raw_shutdown_task
        if task is not None:
            return task
        task = asyncio.create_task(_async_stream_run_shutdown(state, shutdown))
        task.add_done_callback(_consume_shutdown_task)
        state.raw_shutdown_task = task
        return task


async def _async_stream_shutdown_raw(
    state: _AsyncControlledStreamState,
    *,
    suppress: bool,
    shutdown: Callable[[], Any] | None = None,
) -> Any:
    task = _async_stream_start_shutdown(state, shutdown)
    if task is asyncio.current_task():
        return None
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if current is not None and current.cancelling():
            raise
        if not suppress:
            raise
        return None
    except BaseException:
        if not suppress:
            raise
        return None


def _async_stream_cleanup_nowait(state: _AsyncControlledStreamState) -> None:
    _stop_registered_heartbeat(state.heartbeat, state.lifecycle)
    if state.finalizer is not None:
        state.finalizer.detach()


async def _async_stream_cleanup(state: _AsyncControlledStreamState) -> None:
    _async_stream_cleanup_nowait(state)
    await state.heartbeat.wait_stopped()


def _async_stream_observe_terminal_snapshot(state: _AsyncControlledStreamState) -> None:
    try:
        snapshot = _get(state.stream, "current_message_snapshot")
    except BaseException:
        state.evidence.evidence_safe = False
        return
    if snapshot is not _MISSING:
        state.evidence.observe(snapshot, state.prepared.model)


async def _async_stream_try_settle(state: _AsyncControlledStreamState) -> None:
    if state.settled:
        return
    if isinstance(state.decision, ReservedBudgetDecision) and not state.evidence.exact:
        return
    if not state.lifecycle.finish_attempt(state.lifecycle_lease):
        return
    state.settled = True
    await settle_async(
        state.decision,
        state.prepared,
        state.evidence,
        state.started,
    )


async def _async_stream_finish_success(state: _AsyncControlledStreamState) -> None:
    if state.finished:
        return
    _async_stream_observe_terminal_snapshot(state)
    state.finished = True
    await _async_stream_cleanup(state)
    await _async_stream_try_settle(state)


async def _async_stream_finish_failure(state: _AsyncControlledStreamState) -> None:
    if state.finished:
        return
    state.finished = True
    # Establish every durable failure action before the first cancellation
    # point.  In particular, detaching the GC finalizer before scheduling raw
    # shutdown would otherwise let caller cancellation strand the provider
    # stream open forever.
    _async_stream_cleanup_nowait(state)
    state.lifecycle.abandon_attempt(state.lifecycle_lease)
    _async_stream_start_shutdown(state)
    provider_failed(
        state.decision,
        state.prepared,
        state.evidence,
        state.started,
    )
    await state.heartbeat.wait_stopped()
    await _async_stream_shutdown_raw(state, suppress=True)


def _async_stream_abandon(
    facade: AsyncControlledStream,
    status: Literal["failure", "aborted"],
) -> None:
    _async_stream_abandon_state(_async_stream_state(facade), status)


def _async_stream_abandon_state(
    state: _AsyncControlledStreamState,
    status: Literal["failure", "aborted"],
) -> None:
    if state.finished:
        return
    state.finished = True
    _async_stream_cleanup_nowait(state)
    state.lifecycle.abandon_attempt(state.lifecycle_lease)
    if _is_legacy_billable(state.decision):
        _emit_legacy(
            state.prepared,
            state.evidence,
            state.started,
            status,
        )


@dataclass
class _SyncControlledStreamManagerState:
    stream_factory: Callable[..., Any]
    manager_kwargs: dict[str, Any]
    prepared: PreparedProviderRequest
    heartbeat_interval: float | None
    pre_reservation_check: Callable[[], None]
    predispatch_check: Callable[[], None]
    lifecycle: _ControlledClientLifecycle
    manager: object | None = None
    stream: SyncControlledStream | None = None
    entered: bool = False


class SyncControlledStreamManager:
    """Narrow lazy facade preserving Anthropic's sync manager contract."""

    __slots__ = ("__weakref__",)

    def __init__(
        self,
        stream_factory: Callable[..., Any],
        manager_kwargs: dict[str, Any],
        prepared: PreparedProviderRequest,
        heartbeat_interval: float | None,
        pre_reservation_check: Callable[[], None],
        predispatch_check: Callable[[], None],
        lifecycle: _ControlledClientLifecycle,
    ) -> None:
        _SYNC_CONTROLLED_STREAM_MANAGER_STATES[self] = _SyncControlledStreamManagerState(
            stream_factory=stream_factory,
            manager_kwargs=manager_kwargs,
            prepared=prepared,
            heartbeat_interval=heartbeat_interval,
            pre_reservation_check=pre_reservation_check,
            predispatch_check=predispatch_check,
            lifecycle=lifecycle,
        )

    def __enter__(self) -> SyncControlledStream:
        state = _sync_stream_manager_state(self)
        if state.entered:
            raise RuntimeError("[pylva] controlled stream manager cannot be re-entered")
        state.pre_reservation_check()
        state.entered = True
        decision, attempt = reserve_sync(state.prepared)
        lifecycle_lease = _ControlledAttemptLifecycleLease()
        state.lifecycle.register_attempt(lifecycle_lease)
        evidence = UsageEvidence(state.prepared.provider)
        started = time.monotonic()
        heartbeat = _SyncHeartbeat(decision, state.heartbeat_interval)
        _start_registered_heartbeat(heartbeat, state.lifecycle)
        dispatch_started = False
        try:
            with dispatch_context(decision, state.prepared, attempt):
                state.predispatch_check()
                dispatch_started = True
                manager = state.stream_factory(**state.manager_kwargs)
                if inspect.isawaitable(manager):
                    raise _strict_error(state.prepared.provider, "invalid_client")
                entered = cast(Any, manager).__enter__()
        except BaseException:
            _stop_registered_heartbeat(heartbeat, state.lifecycle)
            state.lifecycle.abandon_attempt(lifecycle_lease)
            if not dispatch_started:
                _controlled_no_dispatch(attempt)
                release_proven_predispatch_sync(decision)
            provider_failed(decision, state.prepared, evidence, started)
            raise
        state.manager = manager
        state.stream = SyncControlledStream(
            entered,
            decision,
            attempt,
            state.prepared,
            started,
            heartbeat,
            state.lifecycle,
            lifecycle_lease,
        )
        return state.stream

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Any:
        state = _sync_stream_manager_state(self)
        stream = state.stream
        manager = state.manager
        state.stream = None
        state.manager = None
        if stream is not None:
            stream_state = _sync_stream_state(stream)
            stream_state.lifecycle.cancel_attempt(stream_state.lifecycle_lease)
            _sync_stream_abandon_state(
                stream_state,
                "aborted" if exc_type is None else "failure",
            )
            if manager is not None:
                exit_method = getattr(manager, "__exit__", None)
                if callable(exit_method):
                    result = _sync_stream_shutdown_raw(
                        stream_state,
                        suppress=exc_type is not None,
                        shutdown=lambda: exit_method(exc_type, exc, tb),
                    )
                    return bool(result)
            _sync_stream_shutdown_raw(stream_state, suppress=True)
            return False
        if manager is None:
            return False
        return cast(Any, manager).__exit__(exc_type, exc, tb)

    def __getattribute__(self, name: str) -> Any:
        if name in {"__class__", "__dir__", "__enter__", "__exit__", "__weakref__"}:
            return object.__getattribute__(self, name)
        _sync_stream_manager_reject(self)

    def __getattr__(self, _name: str) -> Any:
        _sync_stream_manager_reject(self)

    def __setattr__(self, _name: str, _value: object) -> None:
        _sync_stream_manager_reject(self)

    def __delattr__(self, _name: str) -> None:
        _sync_stream_manager_reject(self)

    def __copy__(self) -> Any:
        _sync_stream_manager_reject(self)

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        _sync_stream_manager_reject(self)

    def __reduce__(self) -> Any:
        _sync_stream_manager_reject(self)

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        _sync_stream_manager_reject(self)

    def __dir__(self) -> list[str]:
        _sync_stream_manager_state(self)
        return []


_SYNC_CONTROLLED_STREAM_MANAGER_STATES: weakref.WeakKeyDictionary[
    SyncControlledStreamManager, _SyncControlledStreamManagerState
] = weakref.WeakKeyDictionary()


def _sync_stream_manager_state(
    facade: SyncControlledStreamManager,
) -> _SyncControlledStreamManagerState:
    try:
        return _SYNC_CONTROLLED_STREAM_MANAGER_STATES[facade]
    except (KeyError, TypeError) as error:
        raise RuntimeError("[pylva] invalid controlled sync stream manager") from error


def _sync_stream_manager_reject(facade: SyncControlledStreamManager) -> Any:
    state = _sync_stream_manager_state(facade)
    raise _strict_error(state.prepared.provider, "unsupported_pricing_feature")


@dataclass
class _AsyncControlledStreamManagerState:
    stream_factory: Callable[..., Any]
    manager_kwargs: dict[str, Any]
    prepared: PreparedProviderRequest
    heartbeat_interval: float | None
    pre_reservation_check: Callable[[], None]
    predispatch_check: Callable[[], None]
    lifecycle: _ControlledClientLifecycle
    manager: object | None = None
    stream: AsyncControlledStream | None = None
    entered: bool = False


class AsyncControlledStreamManager:
    """Narrow lazy facade preserving Anthropic's async manager contract."""

    __slots__ = ("__weakref__",)

    def __init__(
        self,
        stream_factory: Callable[..., Any],
        manager_kwargs: dict[str, Any],
        prepared: PreparedProviderRequest,
        heartbeat_interval: float | None,
        pre_reservation_check: Callable[[], None],
        predispatch_check: Callable[[], None],
        lifecycle: _ControlledClientLifecycle,
    ) -> None:
        _ASYNC_CONTROLLED_STREAM_MANAGER_STATES[self] = _AsyncControlledStreamManagerState(
            stream_factory=stream_factory,
            manager_kwargs=manager_kwargs,
            prepared=prepared,
            heartbeat_interval=heartbeat_interval,
            pre_reservation_check=pre_reservation_check,
            predispatch_check=predispatch_check,
            lifecycle=lifecycle,
        )

    async def __aenter__(self) -> AsyncControlledStream:
        state = _async_stream_manager_state(self)
        if state.entered:
            raise RuntimeError("[pylva] controlled stream manager cannot be re-entered")
        state.pre_reservation_check()
        state.entered = True
        decision, attempt = await reserve_async(state.prepared)
        lifecycle_lease = _ControlledAttemptLifecycleLease()
        state.lifecycle.register_attempt(lifecycle_lease)
        evidence = UsageEvidence(state.prepared.provider)
        started = time.monotonic()
        heartbeat = _AsyncHeartbeat(decision, state.heartbeat_interval)
        _start_registered_heartbeat(heartbeat, state.lifecycle)
        dispatch_started = False
        try:
            with dispatch_context(decision, state.prepared, attempt):
                state.predispatch_check()
                dispatch_started = True
                manager = state.stream_factory(**state.manager_kwargs)
                if inspect.isawaitable(manager):
                    raise _strict_error(state.prepared.provider, "invalid_client")
                entered = await cast(Any, manager).__aenter__()
        except BaseException:
            await _stop_registered_heartbeat_async(heartbeat, state.lifecycle)
            state.lifecycle.abandon_attempt(lifecycle_lease)
            if not dispatch_started:
                _controlled_no_dispatch(attempt)
                await release_proven_predispatch_async(decision)
            provider_failed(decision, state.prepared, evidence, started)
            raise
        state.manager = manager
        state.stream = AsyncControlledStream(
            entered,
            decision,
            attempt,
            state.prepared,
            started,
            heartbeat,
            state.lifecycle,
            lifecycle_lease,
        )
        return state.stream

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> Any:
        state = _async_stream_manager_state(self)
        stream = state.stream
        manager = state.manager
        state.stream = None
        state.manager = None
        if stream is not None:
            stream_state = _async_stream_state(stream)
            _ensure_async_stream_loop(stream_state)
            stream_state.lifecycle.cancel_attempt(stream_state.lifecycle_lease)
            _async_stream_abandon_state(
                stream_state,
                "aborted" if exc_type is None else "failure",
            )
            await stream_state.heartbeat.wait_stopped()
            if manager is not None:
                exit_method = getattr(manager, "__aexit__", None)
                if callable(exit_method):
                    result = await _async_stream_shutdown_raw(
                        stream_state,
                        suppress=exc_type is not None,
                        shutdown=lambda: exit_method(exc_type, exc, tb),
                    )
                    return bool(result)
            await _async_stream_shutdown_raw(stream_state, suppress=True)
            return False
        if manager is None:
            return False
        return await cast(Any, manager).__aexit__(exc_type, exc, tb)

    def __getattribute__(self, name: str) -> Any:
        if name in {"__aenter__", "__aexit__", "__class__", "__dir__", "__weakref__"}:
            return object.__getattribute__(self, name)
        _async_stream_manager_reject(self)

    def __getattr__(self, _name: str) -> Any:
        _async_stream_manager_reject(self)

    def __setattr__(self, _name: str, _value: object) -> None:
        _async_stream_manager_reject(self)

    def __delattr__(self, _name: str) -> None:
        _async_stream_manager_reject(self)

    def __copy__(self) -> Any:
        _async_stream_manager_reject(self)

    def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
        _async_stream_manager_reject(self)

    def __reduce__(self) -> Any:
        _async_stream_manager_reject(self)

    def __reduce_ex__(self, _protocol: SupportsIndex) -> Any:
        _async_stream_manager_reject(self)

    def __dir__(self) -> list[str]:
        _async_stream_manager_state(self)
        return []


_ASYNC_CONTROLLED_STREAM_MANAGER_STATES: weakref.WeakKeyDictionary[
    AsyncControlledStreamManager, _AsyncControlledStreamManagerState
] = weakref.WeakKeyDictionary()


def _async_stream_manager_state(
    facade: AsyncControlledStreamManager,
) -> _AsyncControlledStreamManagerState:
    try:
        return _ASYNC_CONTROLLED_STREAM_MANAGER_STATES[facade]
    except (KeyError, TypeError) as error:
        raise RuntimeError("[pylva] invalid controlled async stream manager") from error


def _async_stream_manager_reject(facade: AsyncControlledStreamManager) -> Any:
    state = _async_stream_manager_state(facade)
    raise _strict_error(state.prepared.provider, "unsupported_pricing_feature")


def run_sync_create(
    method: Callable[..., Any],
    prepared: PreparedProviderRequest,
    heartbeat_interval: float | None,
    predispatch_check: Callable[[], None],
    lifecycle: _ControlledClientLifecycle,
) -> Any:
    decision, attempt = reserve_sync(prepared)
    lifecycle_lease = _ControlledAttemptLifecycleLease()
    lifecycle.register_attempt(lifecycle_lease)
    evidence = UsageEvidence(prepared.provider)
    started = time.monotonic()
    heartbeat = _SyncHeartbeat(decision, heartbeat_interval)
    _start_registered_heartbeat(heartbeat, lifecycle)
    dispatch_started = False
    try:
        with dispatch_context(decision, prepared, attempt):
            predispatch_check()
            dispatch_started = True
            result = method(**prepared.kwargs)
    except BaseException:
        _stop_registered_heartbeat(heartbeat, lifecycle)
        lifecycle.abandon_attempt(lifecycle_lease)
        if not dispatch_started:
            _controlled_no_dispatch(attempt)
            release_proven_predispatch_sync(decision)
        provider_failed(decision, prepared, evidence, started)
        raise
    if inspect.isawaitable(result):
        _stop_registered_heartbeat(heartbeat, lifecycle)
        lifecycle.abandon_attempt(lifecycle_lease)
        # Dispatch already occurred and may have charged.  Leave a controlled
        # reservation unresolved; never try to reinterpret an async provider
        # as sync after the fact.
        raise _strict_error(prepared.provider, "invalid_client")
    if prepared.stream:
        return SyncControlledStream(
            result,
            decision,
            attempt,
            prepared,
            started,
            heartbeat,
            lifecycle,
            lifecycle_lease,
        )
    _stop_registered_heartbeat(heartbeat, lifecycle)
    evidence.observe(result, prepared.model)
    if lifecycle.finish_attempt(lifecycle_lease):
        settle_sync(decision, prepared, evidence, started)
    return result


async def run_async_create(
    method: Callable[..., Any],
    prepared: PreparedProviderRequest,
    heartbeat_interval: float | None,
    predispatch_check: Callable[[], None],
    lifecycle: _ControlledClientLifecycle,
) -> Any:
    decision, attempt = await reserve_async(prepared)
    lifecycle_lease = _ControlledAttemptLifecycleLease()
    lifecycle.register_attempt(lifecycle_lease)
    evidence = UsageEvidence(prepared.provider)
    started = time.monotonic()
    heartbeat = _AsyncHeartbeat(decision, heartbeat_interval)
    _start_registered_heartbeat(heartbeat, lifecycle)
    dispatch_started = False
    try:
        with dispatch_context(decision, prepared, attempt):
            predispatch_check()
            dispatch_started = True
            result = method(**prepared.kwargs)
            if not inspect.isawaitable(result):
                raise _strict_error(prepared.provider, "invalid_client")
            response = await result
    except BaseException:
        await _stop_registered_heartbeat_async(heartbeat, lifecycle)
        lifecycle.abandon_attempt(lifecycle_lease)
        if not dispatch_started:
            _controlled_no_dispatch(attempt)
            await release_proven_predispatch_async(decision)
        provider_failed(decision, prepared, evidence, started)
        raise
    if prepared.stream:
        return AsyncControlledStream(
            response,
            decision,
            attempt,
            prepared,
            started,
            heartbeat,
            lifecycle,
            lifecycle_lease,
        )
    await _stop_registered_heartbeat_async(heartbeat, lifecycle)
    evidence.observe(response, prepared.model)
    if lifecycle.finish_attempt(lifecycle_lease):
        await settle_async(decision, prepared, evidence, started)
    return response
