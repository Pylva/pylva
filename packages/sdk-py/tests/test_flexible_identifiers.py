"""Flexible provider/model identifier contract coverage."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from pylva import Pylva
from pylva.core.client_registry import (
    _reset_client_registry,
    get_registered_client,
    has_registered_client,
    register_provider_client,
    register_provider_clients,
)
from pylva.core.schema import TelemetryEvent
from pylva.wrappers._event import build_llm_event

VALID_KEY = "pv_live_12345678_" + "a" * 32


def _telemetry_payload(provider: str | None, model: str | None) -> dict[str, object]:
    return {
        "schema_version": "1.6",
        "run_id": "11111111-1111-4111-8111-111111111111",
        "parent_run_id": None,
        "trace_id": "22222222-2222-4222-8222-222222222222",
        "span_id": "33333333-3333-4333-8333-333333333333",
        "parent_span_id": None,
        "customer_id": "cust_1",
        "step_name": "answer",
        "model": model,
        "provider": provider,
        "tokens_in": 1,
        "tokens_out": 1,
        "latency_ms": 10,
        "tool_name": None,
        "status": "success",
        "framework": "none",
        "instrumentation_tier": "sdk_wrapper",
        "cost_source": "auto",
        "metric": None,
        "metric_value": None,
        "stream_aborted": False,
        "abort_savings_usd": 0,
        "sdk_version": "1.1.0",
        "timestamp": "2026-04-18T10:00:00.000Z",
    }


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("ollama", "ollama/llama3.1-8b"),
        ("openai.chat", "ft:gpt-4o-mini:org/name+v1@prod"),
        ("zhipu", "glm-4.5"),
        ("together_ai", "meta-llama/Llama 3.1 8B Instruct"),
        ("プロバイダー", "モデル/名前+v1@prod"),
    ],
)
def test_schema_accepts_store_safe_provider_model(provider: str, model: str) -> None:
    event = TelemetryEvent.model_validate(_telemetry_payload(provider, model))

    assert event.provider == provider
    assert event.model == model


@pytest.mark.parametrize("value", ["", "   ", "bad\nvalue", "x" * 256])
def test_schema_rejects_unsafe_provider_model_values(value: str) -> None:
    with pytest.raises(ValidationError):
        TelemetryEvent.model_validate(_telemetry_payload(value, "gpt-4o"))

    with pytest.raises(ValidationError):
        TelemetryEvent.model_validate(_telemetry_payload("openai", value))


def test_build_llm_event_preserves_store_safe_identifiers() -> None:
    event = build_llm_event(
        provider="openai.chat",
        model="ft:gpt-4o-mini:org/name+v1@prod",
        tokens_in=1,
        tokens_out=2,
        latency_ms=3,
        status="success",
    )

    assert event["provider"] == "openai.chat"
    assert event["model"] == "ft:gpt-4o-mini:org/name+v1@prod"


def test_build_llm_event_uses_other_only_when_provider_missing() -> None:
    event = build_llm_event(
        provider=None,
        model="ollama/llama3.1-8b",
        tokens_in=1,
        tokens_out=2,
        latency_ms=3,
        status="success",
    )

    assert event["provider"] == "other"
    assert event["model"] == "ollama/llama3.1-8b"


def test_client_registry_accepts_arbitrary_provider_ids() -> None:
    _reset_client_registry()
    openrouter_client = object()
    ollama_client = object()

    register_provider_client("openrouter", openrouter_client)
    register_provider_clients({"ollama/local": ollama_client})

    assert get_registered_client("openrouter") is openrouter_client
    assert get_registered_client("ollama/local") is ollama_client
    assert has_registered_client("ollama/local") is True


def test_client_registry_ignores_unsafe_provider_ids() -> None:
    _reset_client_registry()
    client = object()

    register_provider_client(" ", client)
    register_provider_client("bad\nprovider", client)

    assert get_registered_client(" ") is None
    assert get_registered_client("bad\nprovider") is None


def test_pylva_constructor_registers_generic_providers() -> None:
    _reset_client_registry()
    openai_client = object()
    openrouter_client = object()

    Pylva(
        VALID_KEY,
        local_mode=True,
        openai=openai_client,
        providers={"openrouter.chat": openrouter_client},
    )

    assert get_registered_client("openai") is openai_client
    assert get_registered_client("openrouter.chat") is openrouter_client
