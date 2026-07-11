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

from .config import get_config
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
_policy_lock = threading.Lock()
_policy_thread_lock = threading.Lock()
_policy_thread: threading.Thread | None = None
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
    _local_policy = _normalize_override(policy if isinstance(policy, Mapping) else None)
    unknown = policy.get("unknown_behavior") if isinstance(policy, Mapping) else None
    _unknown_behavior = "ignore" if unknown == "ignore" else "discover_only"
    refresh = _dict(config).get("refresh_interval")
    _refresh_after_sec = max(
        MIN_REFRESH_SEC,
        float(refresh) if isinstance(refresh, int | float) and math.isfinite(refresh) else DEFAULT_REFRESH_SEC,
    )


def non_llm_mode(
    config: NonLlmConfig | Mapping[str, Any] | None,
    track_tool_calls: bool = False,
) -> NonLlmMode:
    mode = _dict(config).get("mode")
    if mode in ("off", "policy", "legacy_all"):
        return mode
    return "legacy_all" if track_tool_calls else "off"


def warn_legacy_tool_tracking_once() -> None:
    global _warned_legacy
    if _warned_legacy:
        return
    _warned_legacy = True
    print(
        '[pylva] track_tool_calls=True records every tool as non-LLM usage. '
        'Prefer non_llm={"mode": "policy"} to track only approved sources.',
        flush=True,
    )


def ensure_non_llm_policy() -> None:
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
    if _fetched_at > 0 and now - _fetched_at < _refresh_after_sec:
        return
    with _policy_lock:
        now = time.time()
        if _fetched_at > 0 and now - _fetched_at < _refresh_after_sec:
            return
        _refresh_policy(now)


def schedule_non_llm_policy_refresh() -> None:
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
    if _fetched_at > 0 and now - _fetched_at < _refresh_after_sec:
        return
    with _policy_thread_lock:
        if _fetched_at > 0 and now - _fetched_at < _refresh_after_sec:
            return
        if _policy_thread is not None and _policy_thread.is_alive():
            return
        thread = threading.Thread(target=_refresh_policy_in_background, daemon=True)
        _set_policy_thread(thread)
        thread.start()


def decide_non_llm_tool(candidates: list[str | None]) -> NonLlmDecision:
    normalized = [
        matcher for value in candidates if (matcher := normalize_non_llm_matcher(value)) is not None
    ]
    matcher = normalized[0] if normalized else "tool"
    if match := _find_match(_local_policy, normalized, "ignored"):
        source, matched = match
        return NonLlmDecision(kind="ignored", matcher=matched, source=source)
    if match := _find_match(_local_policy, normalized, "tracked"):
        source, matched = match
        return NonLlmDecision(kind="tracked", matcher=matched, source=source)
    if match := _find_match(_remote_policy, normalized, "ignored"):
        source, matched = match
        return NonLlmDecision(kind="ignored", matcher=matched, source=source)
    if match := _find_match(_remote_policy, normalized, "tracked"):
        source, matched = match
        return NonLlmDecision(kind="tracked", matcher=matched, source=source)
    return NonLlmDecision(kind="unknown", matcher=matcher)


def metric_value_for_source(
    source: NormalizedPolicySource,
    ctx: NonLlmToolContext,
    extractors: dict[str, NonLlmUsageExtractor] | None,
) -> float | int | None:
    extractor = None if extractors is None else extractors.get(source.slug) or extractors.get(ctx.matcher)
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
    if _unknown_behavior == "ignore":
        return
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    now = time.time()
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
    _schedule_discovery_flush()


def flush_non_llm_discoveries() -> None:
    cfg = get_config()
    if cfg is None or cfg.local_mode:
        return
    while True:
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


def _refresh_policy(now: float) -> None:
    global _remote_policy, _unknown_behavior, _fetched_at, _refresh_after_sec, _warned_policy_fetch
    cfg = get_config()
    if cfg is None:
        return
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(
                f"{cfg.endpoint}/api/v1/sdk/non-llm-policy",
                headers={"X-Pylva-Key": cfg.api_key},
            )
        if response.status_code < 200 or response.status_code >= 300:
            _warn_policy_fetch_once()
            return
        normalized = _normalize_remote_policy(response.json())
        if normalized is None:
            _warn_policy_fetch_once()
            return
        _remote_policy = normalized["sources"]
        _unknown_behavior = normalized["unknown_behavior"]
        _refresh_after_sec = normalized["refresh_after_sec"]
        _fetched_at = now
        _warned_policy_fetch = False
    except Exception:
        _warn_policy_fetch_once()


def _refresh_policy_in_background() -> None:
    try:
        ensure_non_llm_policy()
    finally:
        with _policy_thread_lock:
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
        if not isinstance(slug, str) or status not in ("tracked", "ignored") or not isinstance(matchers, list):
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


def _schedule_discovery_flush() -> None:
    global _discovery_timer
    with _discovery_lock:
        if _discovery_timer is not None:
            return
        timer = threading.Timer(0.25, _flush_discovery_timer)
        timer.daemon = True
        _discovery_timer = timer
        timer.start()


def _flush_discovery_timer() -> None:
    global _discovery_timer
    try:
        flush_non_llm_discoveries()
    finally:
        with _discovery_lock:
            _discovery_timer = None
            has_more = bool(_discovery_buffer)
        if has_more:
            _schedule_discovery_flush()


def _warn_policy_fetch_once() -> None:
    global _warned_policy_fetch
    if _warned_policy_fetch:
        return
    _warned_policy_fetch = True
    print("[pylva] non-LLM policy fetch failed; keeping stale policy", flush=True)


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


def _reset_non_llm_policy_for_tests() -> None:
    global _remote_policy, _local_policy, _unknown_behavior, _fetched_at, _refresh_after_sec
    global _discovery_timer, _discovery_buffer, _discovery_dedup, _warned_policy_fetch
    global _policy_thread, _warned_legacy
    _remote_policy = []
    _local_policy = []
    _unknown_behavior = "discover_only"
    _fetched_at = 0.0
    _refresh_after_sec = DEFAULT_REFRESH_SEC
    _policy_thread = None
    with _discovery_lock:
        if _discovery_timer is not None:
            _discovery_timer.cancel()
        _discovery_timer = None
        _discovery_buffer = []
        _discovery_dedup = {}
    _warned_policy_fetch = False
    _warned_extractors.clear()
    _warned_legacy = False
