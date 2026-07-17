"""Public errors for authoritative budget-control transport and validation."""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from ..core.control_schema import UnavailableBudgetDecision

PYLVA_CONTROL_UNAVAILABLE_CODE = "control_unavailable"


class PylvaControlUnavailableReason(str, Enum):
    PRICING_UNAVAILABLE = "pricing_unavailable"
    USAGE_BOUND_REQUIRED = "usage_bound_required"
    CONTROL_UNAVAILABLE = "control_unavailable"
    CONTROL_DISABLED = "control_disabled"
    UNSUPPORTED_BACKEND = "unsupported_backend"
    TIMEOUT = "timeout"
    NETWORK_ERROR = "network_error"
    INVALID_RESPONSE = "invalid_response"
    CONFIGURATION_CHANGED = "configuration_changed"
    RATE_LIMITED = "rate_limited"
    SERVICE_UNAVAILABLE = "service_unavailable"


class PylvaControlUnavailableError(Exception):
    """A typed failure to obtain authoritative pre-dispatch control."""

    code = PYLVA_CONTROL_UNAVAILABLE_CODE

    def __init__(
        self,
        reason: PylvaControlUnavailableReason,
        retryable: bool,
        operation: Literal[
            "ready",
            "reserve_usage",
            "commit_usage",
            "release_usage",
            "extend_usage",
        ],
        operation_id: str | None = None,
        reservation_id: str | None = None,
        unavailable_response: UnavailableBudgetDecision | None = None,
        status: int | None = None,
    ) -> None:
        self.reason = reason
        self.retryable = retryable
        self.operation = operation
        self.operation_id = operation_id
        self.reservation_id = reservation_id
        self.unavailable_response = unavailable_response
        self.status = status
        super().__init__(
            f"[pylva] authoritative budget control unavailable (reason={reason.value})"
        )


class PylvaControlApiError(Exception):
    """A validated public API rejection, without reflecting backend body text."""

    def __init__(self, status: int, code: str, param: str | None = None) -> None:
        self.status = status
        self.code = code
        self.param = param
        super().__init__(
            "[pylva] authoritative budget control rejected the request "
            f"(HTTP {status}, code={code})"
        )


class PylvaControlValidationError(TypeError):
    """A local request value failed the strict cross-SDK wire contract."""

    def __init__(self, operation: str) -> None:
        self.operation = operation
        super().__init__(f"[pylva] {operation} received an invalid authoritative-control value")
