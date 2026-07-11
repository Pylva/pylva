"""Replay the cross-language ingest contract fixtures (tests/contracts/
ingest-contract.json). Python's IngestRequest (pydantic) must accept the same
canonical request pairs that the TS tests validate against Valibot."""

from __future__ import annotations

import json
import os
from typing import Any

import pytest
from pydantic import ValidationError

from pylva.core.schema import IngestRequest, IngestResponse

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CONTRACT_PATH = os.path.join(REPO_ROOT, "tests", "contracts", "ingest-contract.json")


def load_contract_fixtures() -> dict[str, Any]:
    with open(CONTRACT_PATH, encoding="utf-8") as fp:
        return json.load(fp)


def _generate_happy_batch(count: int, provider: str, model: str) -> dict[str, Any]:
    events = []
    for i in range(count):
        span_suffix = f"3{str(i).zfill(7)}-3333-4333-8333-333333333333"
        events.append(
            {
                "schema_version": "1.6",
                "run_id": "11111111-1111-4111-8111-111111111111",
                "parent_run_id": None,
                "trace_id": "22222222-2222-4222-8222-222222222222",
                "span_id": span_suffix[:36],
                "parent_span_id": None,
                "customer_id": f"cust_{i}",
                "step_name": "answer",
                "model": model,
                "provider": provider,
                "tokens_in": 10,
                "tokens_out": 5,
                "latency_ms": 100,
                "tool_name": None,
                "status": "success",
                "framework": "none",
                "instrumentation_tier": "sdk_wrapper",
                "cost_source": "auto",
                "metric": None,
                "metric_value": None,
                "stream_aborted": False,
                "abort_savings_usd": 0,
                "sdk_version": "1.0.0",
                "timestamp": "2026-04-18T10:00:00.000Z",
            }
        )
    return {
        "batch_id": "5a5ed760-8c72-4c7d-9a1d-0d2a9bde0002",
        "sdk_version": "1.0.0",
        "events": events,
    }


def test_contract_version_matches() -> None:
    data = load_contract_fixtures()
    assert data["$schema_version"] == "1.6"


def test_loads_ten_fixtures() -> None:
    data = load_contract_fixtures()
    assert len(data["fixtures"]) == 10


@pytest.mark.parametrize("fixture", load_contract_fixtures()["fixtures"], ids=lambda f: f["name"])
def test_fixture_request_parses_or_fails_as_expected(fixture: dict[str, Any]) -> None:
    # Fixtures either provide an explicit `request` or specify a generator.
    request_payload = fixture.get("request")
    if request_payload is None:
        gen = fixture.get("request_generator")
        args = fixture.get("generator_args", {})
        if gen == "generate_happy_batch":
            request_payload = _generate_happy_batch(**args)

    if fixture["name"] == "oversized_batch_rejected":
        with pytest.raises(ValidationError):
            IngestRequest.model_validate(request_payload)
        return

    if request_payload is not None:
        parsed = IngestRequest.model_validate(request_payload)
        assert len(parsed.events) > 0

    if "response" in fixture:
        IngestResponse.model_validate(fixture["response"])
