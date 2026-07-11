"""Policy-driven non-LLM tracking runtime coverage."""

from __future__ import annotations

import threading
import time
from typing import Any

from pylva.core import non_llm_policy as policy
from pylva.core.config import init as init_config

VALID_KEY = "pv_live_12345678_" + "a" * 32


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict[str, Any]:
        if self._payload is None:
            raise ValueError("invalid json")
        return self._payload


class _FakeClient:
    def __init__(
        self,
        *,
        responses: list[_FakeResponse] | None = None,
        posts: list[dict[str, Any]] | None = None,
        delay: float = 0,
    ) -> None:
        self.responses = responses or []
        self.posts = posts
        self.delay = delay
        self.get_calls = 0

    def __enter__(self) -> _FakeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def get(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:
        self.get_calls += 1
        if self.delay:
            time.sleep(self.delay)
        return self.responses.pop(0)

    def post(self, *_args: Any, **kwargs: Any) -> _FakeResponse:
        assert self.posts is not None
        self.posts.append({"content": kwargs.get("content"), "headers": kwargs.get("headers")})
        return _FakeResponse(200, {"accepted": 1, "rejected": 0})


def _policy_response(sources: list[dict[str, Any]], refresh_after_ms: int = 60_000) -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "version": "test",
            "refresh_after_ms": refresh_after_ms,
            "unknown_behavior": "discover_only",
            "sources": sources,
        },
    )


def _ctx(**overrides: Any) -> policy.NonLlmToolContext:
    values: dict[str, Any] = {
        "tool_name": "tavily_search",
        "matcher": "tavily_search",
        "customer_id": "cust_1",
        "step_name": "tools",
        "status": "success",
        "framework": "langgraph",
        "input": None,
        "output": None,
        "metadata": {},
    }
    values.update(overrides)
    metadata = values["metadata"] if isinstance(values["metadata"], dict) else {}
    return policy.NonLlmToolContext(
        tool_name=str(values["tool_name"]),
        matcher=str(values["matcher"]),
        customer_id=str(values["customer_id"]),
        step_name=values["step_name"] if isinstance(values["step_name"], str) else None,
        status=str(values["status"]),
        framework=str(values["framework"]),
        input=values["input"],
        output=values["output"],
        metadata=metadata,
    )


def test_policy_fetch_caches_dedupes_and_skips_malformed_sources(
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    init_config(VALID_KEY, endpoint="http://mock")
    fake = _FakeClient(
        responses=[
            _policy_response(
                [
                    {"slug": "bad-no-matchers", "status": "tracked", "metric": "calls"},
                    {"slug": "bad-status", "status": "pending", "matchers": ["pending_tool"]},
                    {
                        "slug": "tavily",
                        "status": "tracked",
                        "matchers": ["Tavily Search"],
                        "metric": "tavily_requests",
                        "unit": "request",
                        "default_metric_value": 1,
                    },
                ]
            )
        ],
        delay=0.02,
    )
    monkeypatch.setattr(policy.httpx, "Client", lambda *_a, **_kw: fake)
    policy.configure_non_llm_policy({"mode": "policy", "refresh_interval": 60})

    threads = [threading.Thread(target=policy.ensure_non_llm_policy) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    policy.ensure_non_llm_policy()

    assert fake.get_calls == 1
    assert policy.decide_non_llm_tool(["tavily search"]).kind == "tracked"
    assert policy.decide_non_llm_tool(["pending_tool"]).kind == "unknown"


def test_policy_keeps_stale_data_on_backend_failure(
    monkeypatch, capsys  # type: ignore[no-untyped-def]
) -> None:
    init_config(VALID_KEY, endpoint="http://mock")
    fake = _FakeClient(
        responses=[
            _policy_response(
                [
                    {
                        "slug": "tavily",
                        "status": "tracked",
                        "matchers": ["tavily_search"],
                        "metric": "tavily_requests",
                        "default_metric_value": 1,
                    }
                ],
                refresh_after_ms=10_000,
            ),
            _FakeResponse(500, {}),
        ]
    )
    monkeypatch.setattr(policy.httpx, "Client", lambda *_a, **_kw: fake)

    policy.ensure_non_llm_policy()
    assert policy.decide_non_llm_tool(["tavily_search"]).kind == "tracked"

    policy._fetched_at -= 11  # type: ignore[attr-defined]
    policy.ensure_non_llm_policy()

    assert fake.get_calls == 2
    assert policy.decide_non_llm_tool(["tavily_search"]).kind == "tracked"
    assert "non-LLM policy fetch failed" in capsys.readouterr().out


def test_local_overrides_win_and_ignored_beats_tracked() -> None:
    policy.configure_non_llm_policy(
        {
            "mode": "policy",
            "policy": {
                "sources": [
                    {
                        "slug": "local-track",
                        "status": "tracked",
                        "matchers": ["tavily_search"],
                        "metric": "local_calls",
                        "default_metric_value": 2,
                    }
                ]
            },
        }
    )

    decision = policy.decide_non_llm_tool(["tavily_search"])
    assert decision.kind == "tracked"
    assert decision.source is not None
    assert decision.source.slug == "local-track"

    policy.configure_non_llm_policy(
        {
            "mode": "policy",
            "policy": {
                "sources": [
                    {
                        "slug": "local-track",
                        "status": "tracked",
                        "matchers": ["grep"],
                        "metric": "grep_calls",
                        "default_metric_value": 1,
                    },
                    {"slug": "local-ignore", "status": "ignored", "matchers": ["grep"]},
                ]
            },
        }
    )

    decision = policy.decide_non_llm_tool(["grep"])
    assert decision.kind == "ignored"
    assert decision.source is not None
    assert decision.source.slug == "local-ignore"


def test_usage_extractor_defaults_invalid_values_and_warning_once(
    capsys,  # type: ignore[no-untyped-def]
) -> None:
    source = policy.NormalizedPolicySource(
        slug="tavily",
        status="tracked",
        matchers=("tavily_search",),
        metric="tavily_requests",
        unit="request",
        default_metric_value=1,
    )

    assert policy.metric_value_for_source(source, _ctx(), None) == 1
    assert policy.metric_value_for_source(source, _ctx(), {"tavily": lambda _ctx: 7}) == 7
    assert policy.metric_value_for_source(source, _ctx(), {"tavily": lambda _ctx: float("nan")}) is None
    assert policy.metric_value_for_source(source, _ctx(), {"tavily": lambda _ctx: float("inf")}) is None
    assert policy.metric_value_for_source(source, _ctx(), {"tavily": lambda _ctx: -1}) is None

    def raises(_ctx: policy.NonLlmToolContext) -> float:
        raise RuntimeError("extractor failed")

    assert policy.metric_value_for_source(source, _ctx(), {"tavily": raises}) is None
    assert capsys.readouterr().out.count("non-LLM source tavily") == 1


def test_normalizes_unsafe_high_cardinality_matchers() -> None:
    long = f"{'A' * 120} secret@example.com"

    assert policy.normalize_non_llm_matcher("  Local Lookup !!  ") == "local-lookup"
    assert len(policy.normalize_non_llm_matcher(long) or "") == 100
    assert policy.normalize_non_llm_matcher("@@@") is None


def test_posts_discovery_candidates_without_raw_payloads(
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    init_config(VALID_KEY, endpoint="http://mock")
    posts: list[dict[str, Any]] = []
    fake = _FakeClient(posts=posts)
    monkeypatch.setattr(policy.httpx, "Client", lambda *_a, **_kw: fake)

    policy.record_non_llm_discovery(
        tool_name="Local Lookup",
        matcher="local_lookup",
        step_name="tool_node",
        framework="langgraph",
        status="success",
    )
    policy.record_non_llm_discovery(
        tool_name="Local Lookup",
        matcher="local_lookup",
        step_name="tool_node",
        framework="langgraph",
        status="success",
    )
    policy.flush_non_llm_discoveries()

    assert len(posts) == 1
    content = posts[0]["content"]
    assert isinstance(content, str)
    assert '"tool_name": "Local Lookup"' in content
    assert '"matcher": "local_lookup"' in content
    assert "SECRET" not in content


def test_unknown_behavior_ignore_suppresses_discovery(
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    init_config(VALID_KEY, endpoint="http://mock")
    posts: list[dict[str, Any]] = []
    fake = _FakeClient(posts=posts)
    monkeypatch.setattr(policy.httpx, "Client", lambda *_a, **_kw: fake)
    policy.configure_non_llm_policy({"policy": {"unknown_behavior": "ignore"}})

    policy.record_non_llm_discovery(
        tool_name="Local Lookup",
        matcher="local_lookup",
        step_name="tool_node",
        framework="langgraph",
        status="success",
    )
    policy.flush_non_llm_discoveries()

    assert posts == []
