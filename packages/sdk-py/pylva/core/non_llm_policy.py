"""Policy-driven non-LLM tool tracking.

The runtime mirrors the TypeScript SDK contract: SDKs discover broadly, but
only emit cost events for dashboard-approved sources.
"""

from __future__ import annotations

import atexit
import json
import math
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import httpx

from .config import get_config, get_config_generation
from .telemetry import utc_now_iso

NonLlmMode = Literal["off", "policy", "legacy_all"]
NonLlmStatus = Literal["tracked", "ignored"]
UnknownBehavior = Literal["discover_only", "ignore"]

DEFAULT_REFRESH_SEC = 60.0
MIN_REFRESH_SEC = 10.0
DISCOVERY_BUFFER_CAP = 1000
DISCOVERY_DEDUP_TTL_SEC = 60.0

_MATCHER_RE = re.compile(r"[^a-z0-9_.:/-]+")


class NonLlmPolicyOverrideSource(TypedDict, total=False):
    slug: str
    status: NonLlmStatus
    matchers: list[str]
    metric: str | None
    unit: str | None
    default_metric_value: float | None


class NonLlmPolicyOverride(TypedDict, total=False):
    unknown_behavior: UnknownBehavior
    sources: list[NonLlmPolicyOverrideSource]


@dataclass(frozen=True)
class NonLlmToolContext:
    tool_name: str
    matcher: str
    customer_id: str
    step_name: str | None
    status: str
    framework: str
    input: Any | None
    output: Any | None
    metadata: dict[str, Any]


NonLlmUsageExtractor = Callable[[NonLlmToolContext], float | int | None]


class NonLlmConfig(TypedDict, total=False):
    mode: NonLlmMode
    policy: NonLlmPolicyOverride
    refresh_interval: float
    usage_extractors: dict[str, NonLlmUsageExtractor]


@dataclass(frozen=True)
class NormalizedPolicySource:
    slug: str
    status: NonLlmStatus
    matchers: tuple[str, ...]
    metric: str | None
    unit: str | None
    default_metric_value: float | None


@dataclass(frozen=True)
class NonLlmDecision:
    kind: Literal["tracked", "ignored", "unknown"]
    matcher: str
    source: NormalizedPolicySource | None = None


@dataclass(frozen=True)
class _DiscoveryItem:
    tool_name: str
    matcher: str
    step_name: str | None
    framework: str
    status: str
    timestamp: str
    count: int


_remote_policy: list[NormalizedPolicySource] = []
_local_policy: list[NormalizedPolicySource] = []
_unknown_behavior: UnknownBehavior = "discover_only"
_fetched_at = 0.0
_refresh_after_sec = DEFAULT_REFRESH_SEC
_state_lock = threading.Lock()
_cache_epoch = 0
_accepted_config_generation: int | None = None
_policy_lock = threading.Lock()
_policy_thread_lock = threading.Lock()
_policy_thread: threading.Thread | None = None
_policy_thread_token: object | None = None
_discovery_lock = threading.Lock()
_discovery_timer: threading.Timer | None = None
_discovery_buffer: list[_DiscoveryItem] = []
_discovery_dedup: dict[str, float] = {}
_warned_policy_fetch = False
_warned_extractors: set[str] = set()
_warned_legacy = False


def normalize_non_llm_matcher(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = _MATCHER_RE.sub("-", value.lower().strip()).strip("-")[:100]
    return normalized or None


def configure_non_llm_policy(config: NonLlmConfig | Mapping[str, Any] | None) -> None:
    global _local_policy, _unknown_behavior, _refresh_after_sec
    policy = _dict(config).get("policy")
    local_policy = _normalize_override(policy if isinstance(policy, Mapping) else None)
    unknown = policy.get("unknown_behavior") if isinstance(policy, Mapping) else None
    refresh = _dict(config).get("refresh_interval")
    refresh_after_sec = max(
        MIN_REFRESH_SEC,
        float(refresh)
        if isinstance(refresh, int | float) and math.isfinite(refresh)
        else DEFAULT_REFRESH_SEC,
    )
    with _state_lock:
        _local_policy = local_policy
        _unknown_behavior = "ignore" if unknown == "ignore" else "discover_only"
        _refresh_after_sec = refresh_after_sec


def non_llm_mode(
    config: NonLlmConfig | Mapping[str, Any] | None,
    track_tool_calls: bool = False,
) -> NonLlmMode:
    mode = _dict(config).get("mode")
    if mode == "off":
        return "off"
    if mode == "policy":
        return "policy"
    if mode == "legacy_all":
        return "legacy_all"
    return "legacy_all" if track_tool_calls else "off"


def warn_legacy_tool_tracking_once() -> None:
    global _warned_legacy
    if _warned_legacy:
        return
    _warned_legacy = True
    print(
        "[pylva] track_tool_calls=True records every tool as non-LLM usage. "
        'Prefer non_llm={"mode": "policy"} to track only approved sources.',
        flush=True,
    )


def ensure_non_llm_policy() -> None:
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
    with _state_lock:
        epoch = _cache_epoch
        if not _local_context_is_current_locked(epoch, config_generation) or (
            _fetched_at > 0 and now - _fetched_at < _refresh_after_sec
        ):
            return
    with _policy_lock:
        now = time.time()
        current_cfg = get_config()
        current_generation = get_config_generation()
        with _state_lock:
            if (
                current_cfg is None
                or current_cfg.api_key != cfg.api_key
                or current_cfg.endpoint != cfg.endpoint
                or current_generation != config_generation
                or not _local_context_is_current_locked(epoch, config_generation)
                or (_fetched_at > 0 and now - _fetched_at < _refresh_after_sec)
            ):
                return
        _refresh_policy(
            now,
            epoch=epoch,
            config_generation=config_generation,
            api_key=cfg.api_key,
            endpoint=cfg.endpoint,
        )


def schedule_non_llm_policy_refresh() -> None:
    global _policy_thread_token
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
    with _state_lock:
        epoch = _cache_epoch
        if not _local_context_is_current_locked(epoch, config_generation) or (
            _fetched_at > 0 and now - _fetched_at < _refresh_after_sec
        ):
            return
    with _policy_thread_lock:
        if _policy_thread is not None and _policy_thread.is_alive():
            return
        token = object()
        thread = threading.Thread(
            target=_refresh_policy_in_background,
            kwargs={
                "epoch": epoch,
                "config_generation": config_generation,
                "api_key": cfg.api_key,
                "endpoint": cfg.endpoint,
                "token": token,
            },
            daemon=True,
        )
        _policy_thread_token = token
        _set_policy_thread(thread)
        thread.start()


def decide_non_llm_tool(candidates: list[str | None]) -> NonLlmDecision:
    normalized = [
        matcher for value in candidates if (matcher := normalize_non_llm_matcher(value)) is not None
    ]
    matcher = normalized[0] if normalized else "tool"
    with _state_lock:
        local_policy = _local_policy
        remote_policy = _remote_policy
    if match := _find_match(local_policy, normalized, "ignored"):
        source, matched = match
        return NonLlmDecision(kind="ignored", matcher=matched, source=source)
    if match := _find_match(local_policy, normalized, "tracked"):
        source, matched = match
        return NonLlmDecision(kind="tracked", matcher=matched, source=source)
    if match := _find_match(remote_policy, normalized, "ignored"):
        source, matched = match
        return NonLlmDecision(kind="ignored", matcher=matched, source=source)
    if match := _find_match(remote_policy, normalized, "tracked"):
        source, matched = match
        return NonLlmDecision(kind="tracked", matcher=matched, source=source)
    return NonLlmDecision(kind="unknown", matcher=matcher)


def metric_value_for_source(
    source: NormalizedPolicySource,
    ctx: NonLlmToolContext,
    extractors: dict[str, NonLlmUsageExtractor] | None,
) -> float | int | None:
    extractor = (
        None if extractors is None else extractors.get(source.slug) or extractors.get(ctx.matcher)
    )
    if extractor is not None:
        try:
            value = extractor(ctx)
            if isinstance(value, int | float) and math.isfinite(value) and value >= 0:
                return value
        except Exception:
            pass
        _warn_extractor_once(source.slug)
        return None
    if source.default_metric_value is not None:
        return source.default_metric_value
    _warn_extractor_once(source.slug)
    return None


def record_non_llm_discovery(
    *,
    tool_name: str,
    matcher: str,
    step_name: str | None,
    framework: str,
    status: str,
) -> None:
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
    with _state_lock:
        epoch = _cache_epoch
        if _unknown_behavior == "ignore" or not _local_context_is_current_locked(
            epoch, config_generation
        ):
            return
        with _discovery_lock:
            last = _discovery_dedup.get(matcher)
            if last is not None and now - last < DISCOVERY_DEDUP_TTL_SEC:
                return
            _discovery_dedup[matcher] = now
            _discovery_buffer.append(
                _DiscoveryItem(
                    tool_name=tool_name[:200],
                    matcher=matcher,
                    step_name=step_name,
                    framework=framework,
                    status=status,
                    timestamp=utc_now_iso(),
                    count=1,
                )
            )
            if len(_discovery_buffer) > DISCOVERY_BUFFER_CAP:
                del _discovery_buffer[: len(_discovery_buffer) - DISCOVERY_BUFFER_CAP]
    _schedule_discovery_flush(epoch, config_generation)


def flush_non_llm_discoveries() -> None:
    config_generation = get_config_generation()
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    with _state_lock:
        epoch = _cache_epoch
        if not _local_context_is_current_locked(epoch, config_generation):
            return
    while True:
        current_cfg = get_config()
        current_generation = get_config_generation()
        with _state_lock:
            if not _context_is_current_locked(
                epoch,
                config_generation,
                cfg.api_key,
                cfg.endpoint,
                current_generation=current_generation,
                current_api_key=None if current_cfg is None else current_cfg.api_key,
                current_endpoint=None if current_cfg is None else current_cfg.endpoint,
            ):
                return
            with _discovery_lock:
                if not _discovery_buffer:
                    return
                batch = _discovery_buffer[:100]
                del _discovery_buffer[: len(batch)]
        body = {
            "batch_id": str(uuid.uuid4()),
            "discoveries": [
                {
                    "tool_name": item.tool_name,
                    "matcher": item.matcher,
                    "step_name": item.step_name,
                    "framework": item.framework,
                    "status": item.status,
                    "timestamp": item.timestamp,
                    "count": item.count,
                }
                for item in batch
            ],
        }
        try:
            with httpx.Client(timeout=5.0) as client:
                client.post(
                    f"{cfg.endpoint}/api/v1/sdk/non-llm-discoveries",
                    headers={
                        "content-type": "application/json",
                        "X-Pylva-Key": cfg.api_key,
                    },
                    content=json.dumps(body),
                )
        except Exception:
            return


def _refresh_policy(
    now: float,
    *,
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
) -> None:
    global _remote_policy, _unknown_behavior, _fetched_at, _refresh_after_sec, _warned_policy_fetch
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(
                f"{endpoint}/api/v1/sdk/non-llm-policy",
                headers={"X-Pylva-Key": api_key},
            )
        if response.status_code < 200 or response.status_code >= 300:
            _mark_policy_fetch_failed_if_current(
                epoch=epoch,
                config_generation=config_generation,
                api_key=api_key,
                endpoint=endpoint,
            )
            return
        normalized = _normalize_remote_policy(response.json())
        if normalized is None:
            _mark_policy_fetch_failed_if_current(
                epoch=epoch,
                config_generation=config_generation,
                api_key=api_key,
                endpoint=endpoint,
            )
            return
        current_cfg = get_config()
        current_generation = get_config_generation()
        with _state_lock:
            if not _context_is_current_locked(
                epoch,
                config_generation,
                api_key,
                endpoint,
                current_generation=current_generation,
                current_api_key=None if current_cfg is None else current_cfg.api_key,
                current_endpoint=None if current_cfg is None else current_cfg.endpoint,
            ):
                return
            _remote_policy = normalized["sources"]
            _unknown_behavior = normalized["unknown_behavior"]
            _refresh_after_sec = normalized["refresh_after_sec"]
            _fetched_at = now
            _warned_policy_fetch = False
    except Exception:
        _mark_policy_fetch_failed_if_current(
            epoch=epoch,
            config_generation=config_generation,
            api_key=api_key,
            endpoint=endpoint,
        )


def _refresh_policy_in_background(
    *,
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
    token: object,
) -> None:
    global _policy_thread_token
    try:
        with _policy_lock:
            with _state_lock:
                if not _local_context_is_current_locked(epoch, config_generation):
                    return
            _refresh_policy(
                time.time(),
                epoch=epoch,
                config_generation=config_generation,
                api_key=api_key,
                endpoint=endpoint,
            )
    finally:
        with _policy_thread_lock:
            if _policy_thread_token is token:
                _policy_thread_token = None
                _set_policy_thread(None)


def _normalize_remote_policy(body: Any) -> dict[str, Any] | None:
    if not isinstance(body, dict) or not isinstance(body.get("sources"), list):
        return None
    refresh_after_ms = body.get("refresh_after_ms")
    refresh_after_sec = (
        float(refresh_after_ms) / 1000
        if isinstance(refresh_after_ms, int | float) and math.isfinite(refresh_after_ms)
        else DEFAULT_REFRESH_SEC
    )
    return {
        "sources": _normalize_override({"sources": body["sources"]}),
        "unknown_behavior": "ignore"
        if body.get("unknown_behavior") == "ignore"
        else "discover_only",
        "refresh_after_sec": max(MIN_REFRESH_SEC, refresh_after_sec),
    }


def _normalize_override(policy: Mapping[str, Any] | None) -> list[NormalizedPolicySource]:
    sources: list[NormalizedPolicySource] = []
    raw_sources = [] if policy is None else policy.get("sources", [])
    if not isinstance(raw_sources, list):
        return sources
    for raw in raw_sources:
        if not isinstance(raw, dict):
            continue
        slug = raw.get("slug")
        status = raw.get("status")
        matchers = raw.get("matchers")
        if (
            not isinstance(slug, str)
            or status not in ("tracked", "ignored")
            or not isinstance(matchers, list)
        ):
            continue
        normalized_matchers = tuple(
            dict.fromkeys(
                matcher
                for value in matchers
                if (matcher := normalize_non_llm_matcher(value)) is not None
            )
        )
        if not normalized_matchers:
            continue
        default_metric_value = raw.get("default_metric_value")
        normalized_default = (
            float(default_metric_value)
            if isinstance(default_metric_value, int | float)
            and math.isfinite(default_metric_value)
            and default_metric_value >= 0
            else None
        )
        metric = raw.get("metric")
        unit = raw.get("unit")
        sources.append(
            NormalizedPolicySource(
                slug=slug,
                status=status,
                matchers=normalized_matchers,
                metric=metric if isinstance(metric, str) and metric else None,
                unit=unit if isinstance(unit, str) and unit else None,
                default_metric_value=normalized_default,
            )
        )
    return sources


def _find_match(
    sources: list[NormalizedPolicySource],
    candidates: list[str],
    status: NonLlmStatus,
) -> tuple[NormalizedPolicySource, str] | None:
    for candidate in candidates:
        for source in sources:
            if source.status == status and candidate in source.matchers:
                return source, candidate
    return None


def _schedule_discovery_flush(epoch: int, config_generation: int) -> None:
    global _discovery_timer
    with _state_lock:
        if not _local_context_is_current_locked(epoch, config_generation):
            return
        with _discovery_lock:
            if _discovery_timer is not None:
                return

            timer: threading.Timer

            def _flush_discovery_timer() -> None:
                global _discovery_timer
                with _state_lock:
                    if not _local_context_is_current_locked(epoch, config_generation):
                        return
                    with _discovery_lock:
                        if _discovery_timer is not timer:
                            return
                try:
                    flush_non_llm_discoveries()
                finally:
                    with _state_lock:
                        current = _local_context_is_current_locked(epoch, config_generation)
                        with _discovery_lock:
                            if _discovery_timer is timer:
                                _discovery_timer = None
                            has_more = current and bool(_discovery_buffer)
                    if has_more:
                        _schedule_discovery_flush(epoch, config_generation)

            timer = threading.Timer(0.25, _flush_discovery_timer)
            timer.daemon = True
            _discovery_timer = timer
            timer.start()


def _warn_policy_fetch_once() -> None:
    global _warned_policy_fetch
    if _warned_policy_fetch:
        return
    _warned_policy_fetch = True
    print("[pylva] non-LLM policy fetch failed; keeping stale policy", flush=True)


def _mark_policy_fetch_failed_if_current(
    *,
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
) -> None:
    current_cfg = get_config()
    current_generation = get_config_generation()
    with _state_lock:
        if not _context_is_current_locked(
            epoch,
            config_generation,
            api_key,
            endpoint,
            current_generation=current_generation,
            current_api_key=None if current_cfg is None else current_cfg.api_key,
            current_endpoint=None if current_cfg is None else current_cfg.endpoint,
        ):
            return
        _warn_policy_fetch_once()


def _context_is_current_locked(
    epoch: int,
    config_generation: int,
    api_key: str,
    endpoint: str,
    *,
    current_generation: int,
    current_api_key: str | None,
    current_endpoint: str | None,
) -> bool:
    return (
        _local_context_is_current_locked(epoch, config_generation)
        and config_generation == current_generation
        and api_key == current_api_key
        and endpoint == current_endpoint
    )


def _local_context_is_current_locked(epoch: int, config_generation: int) -> bool:
    return epoch == _cache_epoch and (
        _accepted_config_generation is None or config_generation == _accepted_config_generation
    )


def _warn_extractor_once(slug: str) -> None:
    if slug in _warned_extractors:
        return
    _warned_extractors.add(slug)
    print(f"[pylva] non-LLM source {slug} has no valid usage value; event skipped", flush=True)


def _dict(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _set_policy_thread(thread: threading.Thread | None) -> None:
    global _policy_thread
    _policy_thread = thread


def _flush_discoveries_at_exit() -> None:
    try:
        flush_non_llm_discoveries()
    except Exception:
        pass


atexit.register(_flush_discoveries_at_exit)


def _invalidate_non_llm_policy_for_config_change(
    next_config_generation: int | None = None,
) -> None:
    """Discard tenant policy/discoveries and invalidate late background fetches."""
    global _accepted_config_generation, _cache_epoch, _fetched_at, _local_policy
    global _policy_thread_token, _refresh_after_sec, _remote_policy, _unknown_behavior
    global _discovery_buffer, _discovery_dedup, _discovery_timer
    global _warned_legacy, _warned_policy_fetch
    with _state_lock:
        _cache_epoch += 1
        _accepted_config_generation = next_config_generation
        _remote_policy = []
        _local_policy = []
        _unknown_behavior = "discover_only"
        _fetched_at = 0.0
        _refresh_after_sec = DEFAULT_REFRESH_SEC
        _warned_policy_fetch = False
        _warned_extractors.clear()
        _warned_legacy = False
        with _policy_thread_lock:
            _policy_thread_token = None
            _set_policy_thread(None)
        with _discovery_lock:
            if _discovery_timer is not None:
                _discovery_timer.cancel()
            _discovery_timer = None
            _discovery_buffer = []
            _discovery_dedup = {}


def _reset_non_llm_policy_for_tests() -> None:
    global _accepted_config_generation, _cache_epoch, _fetched_at, _local_policy
    global _policy_thread_token, _refresh_after_sec, _remote_policy, _unknown_behavior
    global _discovery_buffer, _discovery_dedup, _discovery_timer
    global _warned_legacy, _warned_policy_fetch
    with _state_lock:
        _cache_epoch += 1
        _accepted_config_generation = None
        _remote_policy = []
        _local_policy = []
        _unknown_behavior = "discover_only"
        _fetched_at = 0.0
        _refresh_after_sec = DEFAULT_REFRESH_SEC
        _warned_policy_fetch = False
        _warned_extractors.clear()
        _warned_legacy = False
        with _policy_thread_lock:
            _policy_thread_token = None
            _set_policy_thread(None)
        with _discovery_lock:
            if _discovery_timer is not None:
                _discovery_timer.cancel()
            _discovery_timer = None
            _discovery_buffer = []
            _discovery_dedup = {}
