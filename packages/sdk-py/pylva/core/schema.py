"""Pydantic models matching ``@pylva/shared`` TelemetryEventSchema (v1.6).

Field names match the wire format exactly so the cross-language contract
fixtures replay into Python without transformation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from .identifiers import validate_provider_model_identifier

Provider = str
EventStatus = Literal["success", "failure", "retry", "aborted"]
Framework = Literal[
    "langgraph", "crewai", "mastra", "openai-agents", "pydantic-ai", "none"
]
InstrumentationTier = Literal["sdk_wrapper", "reported"]
CostSource = Literal["auto", "configured"]
TokenCountSource = Literal["exact", "estimated"]


class EventMetadata(BaseModel):
    model_config = ConfigDict(extra="allow")
    token_count_source: TokenCountSource | None = None


class TelemetryEvent(BaseModel):
    schema_version: Literal["1.6"] = "1.6"
    run_id: str
    parent_run_id: str | None = None
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    customer_id: str
    step_name: str | None = None
    model: str | None = None
    provider: Provider | None = None
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    latency_ms: int = Field(ge=0)
    tool_name: str | None = None
    status: EventStatus
    framework: Framework
    instrumentation_tier: InstrumentationTier
    cost_source: CostSource
    metric: str | None = None
    metric_value: float | None = None
    stream_aborted: bool = False
    abort_savings_usd: float = Field(default=0, ge=0)
    sdk_version: str = Field(min_length=1, max_length=50)
    timestamp: str  # ISO 8601 string; ingest parses via parseDateTimeBestEffort
    metadata: EventMetadata | None = None

    @field_validator("model", "provider")
    @classmethod
    def _validate_provider_model(
        cls,
        value: str | None,
        info: ValidationInfo,
    ) -> str | None:
        if value is None:
            return None
        return validate_provider_model_identifier(
            value,
            field_name=info.field_name or "identifier",
        )


class IngestRequest(BaseModel):
    batch_id: str
    sdk_version: str = Field(min_length=1, max_length=50)
    events: list[TelemetryEvent] = Field(min_length=1, max_length=100)


class IngestError(BaseModel):
    index: int = Field(ge=0)
    message: str


class IngestWarning(BaseModel):
    event_index: int = Field(ge=0)
    code: Literal["needs_pricing_input", "pending_pricing", "customer_limit_reached"]
    provider: str | None = None
    model: str | None = None
    metric: str | None = None
    message: str | None = None


class IngestResponse(BaseModel):
    accepted: int = Field(ge=0)
    rejected: int = Field(ge=0)
    errors: list[IngestError] | None = None
    warnings: list[IngestWarning] | None = None
