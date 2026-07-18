"""Wire schemas for Pylva's authoritative budget-control contract (v1.0).

The models in this module deliberately keep the JSON wire names and string
representations used by ``@pylva/shared``.  In particular, UUIDs, timestamps,
and fixed-precision decimal values remain strings after validation so callers
can hash and replay requests identically in Python and TypeScript.
"""

from __future__ import annotations

import re
from datetime import datetime
from math import isfinite
from typing import Annotated, Any, Literal, cast

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PrivateAttr,
    SerializerFunctionWrapHandler,
    StringConstraints,
    TypeAdapter,
    ValidationInfo,
    field_validator,
    model_serializer,
    model_validator,
)

from .identifiers import (
    STORE_LONE_SURROGATE_RE,
    is_store_blank_string,
    validate_provider_model_identifier,
)

BudgetControlMode = Literal["shadow", "enforce"]
BudgetReservationKind = Literal["llm", "tool"]
BudgetReservationState = Literal["reserved", "committed", "released", "unresolved", "refused"]
BudgetReservationDecision = Literal["reserved", "denied", "bypassed", "unavailable"]
BudgetReleaseReason = Literal["provider_not_called", "provider_confirmed_uncharged"]

_UUID_RE = re.compile(
    r"^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$",
    re.IGNORECASE | re.ASCII,
)
_ISO_TIMESTAMP_RE = re.compile(
    r"^\d{4}-(?:0[1-9]|1[0-2])-(?:[12]\d|0[1-9]|3[01])T"
    r"(?:0\d|1\d|2[0-3])(?::[0-5]\d){2}(?:\.\d{1,3})?"
    r"Z$",
    re.ASCII,
)
_BUDGET_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$")
_POST_PROVIDER_COST_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]{0,25})(?:\.[0-9]{1,18})?$")
_CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")


def _validate_uuid_string(value: str) -> str:
    if _UUID_RE.fullmatch(value) is None:
        raise ValueError("must be a UUID-shaped string")
    return value.lower()


def _validate_iso_timestamp(value: str) -> str:
    if _ISO_TIMESTAMP_RE.fullmatch(value) is None:
        raise ValueError("must be an ISO timestamp with an explicit timezone")
    try:
        _parse_iso_timestamp(value)
    except ValueError as error:
        raise ValueError("must contain a valid calendar date and timezone") from error
    return value


def _canonicalize_budget_decimal(value: str) -> str:
    if _BUDGET_DECIMAL_RE.fullmatch(value) is None:
        raise ValueError("must be a nonnegative NUMERIC(38,18) decimal string")
    if "." not in value:
        return value
    canonical = value.rstrip("0").rstrip(".")
    return canonical or "0"


def _canonicalize_post_provider_cost_decimal(value: str) -> str:
    if _POST_PROVIDER_COST_DECIMAL_RE.fullmatch(value) is None:
        raise ValueError("must be a nonnegative NUMERIC(44,18) decimal string")
    if "." not in value:
        return value
    canonical = value.rstrip("0").rstrip(".")
    return canonical or "0"


def _budget_decimal_units(value: str) -> int:
    """Convert an already-validated decimal into exact 18-place integer units."""
    integer_part, separator, fractional_part = value.partition(".")
    if not separator:
        fractional_part = ""
    return int(integer_part) * 10**18 + int(fractional_part.ljust(18, "0") or "0")


def _validate_metric(value: str) -> str:
    if is_store_blank_string(value):
        raise ValueError("metric must not be empty or whitespace-only")
    if STORE_LONE_SURROGATE_RE.search(value):
        raise ValueError("metric must contain valid Unicode scalar values")
    if _CONTROL_CHARACTER_RE.search(value):
        raise ValueError("metric must not contain control characters")
    return value


def _canonicalize_wire_integer(value: Any) -> Any:
    """Normalize integral JSON numbers to match JavaScript's number model."""
    if isinstance(value, bool):
        raise ValueError("must be an integer, not a boolean")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and isfinite(value) and value.is_integer():
        return int(value)
    raise ValueError("must be an integer")


def _parse_iso_timestamp(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    normalized = re.sub(r" (?=[+-]\d{2}(?::?\d{2})?$)", "", normalized)
    return datetime.fromisoformat(normalized)


BudgetDecimal = Annotated[str, AfterValidator(_canonicalize_budget_decimal)]
PostProviderCostDecimal = Annotated[
    str,
    AfterValidator(_canonicalize_post_provider_cost_decimal),
]
UuidString = Annotated[str, AfterValidator(_validate_uuid_string)]
IsoTimestamp = Annotated[str, AfterValidator(_validate_iso_timestamp)]

_CustomerId = Annotated[
    str,
    StringConstraints(min_length=1, max_length=255, pattern=r"^[A-Za-z0-9_-]+$"),
]
_StepName = Annotated[
    str,
    StringConstraints(max_length=200, pattern=r"^[A-Za-z0-9 _\-.:/]*$"),
]
_ToolName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9 _\-.:/]*$"),
]
_ProviderModel = Annotated[str, AfterValidator(validate_provider_model_identifier)]
_CostSourceSlug = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9-]*$"),
]
_Metric = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100),
    AfterValidator(_validate_metric),
]
_UInt32 = Annotated[
    int,
    BeforeValidator(_canonicalize_wire_integer),
    Field(ge=0, le=4_294_967_295),
]
_ReservationTtlSeconds = Annotated[
    int,
    BeforeValidator(_canonicalize_wire_integer),
    Field(ge=30, le=3_600),
]
_Framework = Literal[
    "langgraph",
    "crewai",
    "mastra",
    "openai-agents",
    "pydantic-ai",
    "none",
]
_EventStatus = Literal["success", "failure", "retry", "aborted"]


class _BudgetControlRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class _BudgetControlResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")


class BudgetControlWarning(_BudgetControlResponse):
    code: Literal["advisory_budget_exceeded"]
    rule_id: UuidString
    limit_usd: BudgetDecimal
    projected_usd: BudgetDecimal

    @model_validator(mode="after")
    def _validate_exceeded_budget(self) -> BudgetControlWarning:
        if _budget_decimal_units(self.projected_usd) <= _budget_decimal_units(self.limit_usd):
            raise ValueError("projected_usd must exceed limit_usd")
        return self


class BudgetCapabilitiesResponse(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    control_enabled: bool
    min_reservation_ttl_seconds: Literal[30]
    default_reservation_ttl_seconds: Literal[300]
    max_reservation_ttl_seconds: Literal[3600]
    server_time: IsoTimestamp


class _BudgetReservationRequest(_BudgetControlRequest):
    schema_version: Literal["1.0"]
    mode: BudgetControlMode
    operation_id: UuidString
    customer_id: _CustomerId
    trace_id: UuidString
    span_id: UuidString
    parent_span_id: UuidString | None
    step_name: _StepName | None
    framework: _Framework = "none"
    reservation_ttl_seconds: _ReservationTtlSeconds = 300


class LlmBudgetReservationRequest(_BudgetReservationRequest):
    kind: Literal["llm"]
    provider: _ProviderModel
    model: _ProviderModel
    estimated_input_tokens: _UInt32
    max_output_tokens: _UInt32


class ToolBudgetReservationRequest(_BudgetReservationRequest):
    kind: Literal["tool"]
    cost_source_slug: _CostSourceSlug
    tool_name: _ToolName
    metric: _Metric
    maximum_value: BudgetDecimal


class BudgetRuleSnapshot(_BudgetControlResponse):
    rule_id: UuidString
    scope: Literal["per_customer", "pooled"]
    customer_id: _CustomerId | None
    period: Literal["hour", "day", "week", "month"]
    period_start: IsoTimestamp
    period_end: IsoTimestamp

    @model_validator(mode="after")
    def _validate_scope_and_period(self) -> BudgetRuleSnapshot:
        if self.scope == "pooled" and self.customer_id is not None:
            raise ValueError("pooled rule snapshots must not identify a customer")
        if self.scope == "per_customer" and self.customer_id is None:
            raise ValueError("per-customer rule snapshots must identify a customer")
        try:
            starts_at = _parse_iso_timestamp(self.period_start)
            ends_at = _parse_iso_timestamp(self.period_end)
        except ValueError as error:
            raise ValueError("rule snapshot period timestamps must be valid dates") from error
        if ends_at <= starts_at:
            raise ValueError("period_end must be after period_start")
        return self


class ReservedBudgetDecision(_BudgetControlResponse):
    # Set only by the transport after a validated, correlated reservation.
    # Private attrs never enter the wire/model dump contract.
    _pylva_control_ownership: Any = PrivateAttr(default=None)

    schema_version: Literal["1.0"]
    decision: Literal["reserved"]
    allowed: Literal[True]
    decision_id: UuidString
    operation_id: UuidString
    reservation_id: UuidString
    state: Literal["reserved"]
    reserved_usd: BudgetDecimal
    remaining_usd: BudgetDecimal | None
    expires_at: IsoTimestamp
    warnings: list[BudgetControlWarning]


class DeniedBudgetDecision(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    decision: Literal["denied"]
    allowed: Literal[False]
    decision_id: UuidString
    operation_id: UuidString
    state: Literal["refused"]
    deciding_rule: BudgetRuleSnapshot
    committed_usd: BudgetDecimal
    reserved_usd: BudgetDecimal
    unresolved_usd: BudgetDecimal
    requested_usd: BudgetDecimal
    limit_usd: BudgetDecimal
    remaining_usd: BudgetDecimal
    warnings: list[BudgetControlWarning]

    @model_validator(mode="after")
    def _validate_budget_arithmetic(self) -> DeniedBudgetDecision:
        protected_before = (
            _budget_decimal_units(self.committed_usd)
            + _budget_decimal_units(self.reserved_usd)
            + _budget_decimal_units(self.unresolved_usd)
        )
        requested = _budget_decimal_units(self.requested_usd)
        limit = _budget_decimal_units(self.limit_usd)
        expected_remaining = max(limit - protected_before, 0)
        if protected_before + requested <= limit:
            raise ValueError("a denied request must exceed its deciding limit")
        if _budget_decimal_units(self.remaining_usd) != expected_remaining:
            raise ValueError("remaining_usd is inconsistent with protected capacity")
        return self


class BypassedBudgetDecision(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    decision: Literal["bypassed"]
    allowed: Literal[True]
    decision_id: UuidString | None
    operation_id: UuidString
    reason: Literal[
        "control_disabled",
        "no_applicable_budget",
        "shadow_would_allow",
        "shadow_would_deny",
        "shadow_control_unavailable",
    ]
    would_have_denied: bool | None
    warnings: list[BudgetControlWarning]

    @model_validator(mode="after")
    def _validate_decision_identity(self) -> BypassedBudgetDecision:
        if self.reason == "control_disabled":
            if self.decision_id is not None:
                raise ValueError("control_disabled requires a null decision_id")
        elif self.reason != "shadow_control_unavailable" and self.decision_id is None:
            raise ValueError("evaluated bypass decisions require a decision_id")
        if (
            self.reason
            in {
                "control_disabled",
                "no_applicable_budget",
                "shadow_control_unavailable",
            }
            and self.warnings
        ):
            raise ValueError("a bypass without evaluated allocations cannot include warnings")
        return self

    @field_validator("would_have_denied")
    @classmethod
    def _validate_would_have_denied(
        cls,
        value: bool | None,
        info: ValidationInfo,
    ) -> bool | None:
        reason = info.data.get("reason")
        expected: bool | None
        if reason == "shadow_would_allow":
            expected = False
        elif reason == "shadow_would_deny":
            expected = True
        else:
            expected = None
        if value is not expected:
            raise ValueError("would_have_denied is inconsistent with bypass reason")
        return value


class UnavailableBudgetDecision(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    decision: Literal["unavailable"]
    allowed: Literal[False]
    decision_id: UuidString | None
    operation_id: UuidString
    reason: Literal["pricing_unavailable", "usage_bound_required", "control_unavailable"]
    retryable: bool


BudgetReservationRequest = Annotated[
    LlmBudgetReservationRequest | ToolBudgetReservationRequest,
    Field(discriminator="kind"),
]
BudgetReservationResponse = Annotated[
    ReservedBudgetDecision
    | DeniedBudgetDecision
    | BypassedBudgetDecision
    | UnavailableBudgetDecision,
    Field(discriminator="decision"),
]


class LlmBudgetCommitRequest(_BudgetControlRequest):
    schema_version: Literal["1.0"]
    kind: Literal["llm"]
    actual_input_tokens: _UInt32
    actual_output_tokens: _UInt32
    status: _EventStatus
    latency_ms: _UInt32
    stream_aborted: bool


class ToolBudgetCommitRequest(_BudgetControlRequest):
    schema_version: Literal["1.0"]
    kind: Literal["tool"]
    actual_value: BudgetDecimal
    status: _EventStatus
    latency_ms: _UInt32
    stream_aborted: bool


BudgetCommitRequest = Annotated[
    LlmBudgetCommitRequest | ToolBudgetCommitRequest,
    Field(discriminator="kind"),
]


class BudgetCommitResponse(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    state: Literal["committed"]
    reservation_id: UuidString
    operation_id: UuidString
    reserved_usd: BudgetDecimal
    actual_usd: PostProviderCostDecimal
    released_usd: BudgetDecimal
    overage_usd: PostProviderCostDecimal
    budget_exceeded_after_commit: bool
    committed_at: IsoTimestamp
    idempotent_replay: bool
    late: bool

    @model_validator(mode="after")
    def _validate_settlement_arithmetic(self) -> BudgetCommitResponse:
        reserved = _budget_decimal_units(self.reserved_usd)
        actual = _budget_decimal_units(self.actual_usd)
        expected_released = max(reserved - actual, 0)
        expected_overage = max(actual - reserved, 0)
        if _budget_decimal_units(self.released_usd) != expected_released:
            raise ValueError("released_usd is inconsistent with reserved and actual cost")
        if _budget_decimal_units(self.overage_usd) != expected_overage:
            raise ValueError("overage_usd is inconsistent with reserved and actual cost")
        return self


class BudgetReleaseRequest(_BudgetControlRequest):
    schema_version: Literal["1.0"]
    reason: BudgetReleaseReason


class BudgetReleaseResponse(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    state: Literal["released"]
    reservation_id: UuidString
    operation_id: UuidString
    released_usd: BudgetDecimal
    released_at: IsoTimestamp
    idempotent_replay: bool


class BudgetExtendRequest(_BudgetControlRequest):
    schema_version: Literal["1.0"]
    extension_id: UuidString
    extend_by_seconds: _ReservationTtlSeconds


class BudgetExtendResponse(_BudgetControlResponse):
    schema_version: Literal["1.0"]
    state: Literal["reserved"]
    reservation_id: UuidString
    operation_id: UuidString
    extension_id: UuidString
    expires_at: IsoTimestamp
    idempotent_replay: bool


_BudgetControlErrorType = Literal[
    "invalid_request_error",
    "authentication_error",
    "rate_limit_error",
    "api_error",
]
_BudgetControlErrorCode = Literal[
    "INVALID_API_KEY",
    "WRONG_SCOPE",
    "VALIDATION_ERROR",
    "RESOURCE_NOT_FOUND",
    "RATE_LIMIT_EXCEEDED",
    "INTERNAL_ERROR",
    "IDEMPOTENCY_CONFLICT",
    "RESERVATION_STATE_CONFLICT",
]


class BudgetControlError(_BudgetControlResponse):
    type: _BudgetControlErrorType
    code: _BudgetControlErrorCode
    message: str
    param: str | None = None

    @field_validator("param", mode="before")
    @classmethod
    def _reject_explicit_null_param(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("param must be omitted rather than null")
        return value

    @model_serializer(mode="wrap")
    def _serialize_without_omitted_param(
        self,
        handler: SerializerFunctionWrapHandler,
    ) -> dict[str, Any]:
        serialized = cast(dict[str, Any], handler(self))
        if self.param is None:
            serialized.pop("param", None)
        return serialized


class BudgetControlErrorResponse(_BudgetControlResponse):
    error: BudgetControlError


BUDGET_RESERVATION_REQUEST_ADAPTER: TypeAdapter[BudgetReservationRequest] = TypeAdapter(
    BudgetReservationRequest
)
BUDGET_RESERVATION_RESPONSE_ADAPTER: TypeAdapter[BudgetReservationResponse] = TypeAdapter(
    BudgetReservationResponse
)
BUDGET_COMMIT_REQUEST_ADAPTER: TypeAdapter[BudgetCommitRequest] = TypeAdapter(BudgetCommitRequest)

BUDGET_CONTROL_SCHEMA_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "capabilities_response": TypeAdapter(BudgetCapabilitiesResponse),
    "reservation_request": BUDGET_RESERVATION_REQUEST_ADAPTER,
    "reservation_response": BUDGET_RESERVATION_RESPONSE_ADAPTER,
    "commit_request": BUDGET_COMMIT_REQUEST_ADAPTER,
    "commit_response": TypeAdapter(BudgetCommitResponse),
    "release_request": TypeAdapter(BudgetReleaseRequest),
    "release_response": TypeAdapter(BudgetReleaseResponse),
    "extend_request": TypeAdapter(BudgetExtendRequest),
    "extend_response": TypeAdapter(BudgetExtendResponse),
    "error_response": TypeAdapter(BudgetControlErrorResponse),
}
