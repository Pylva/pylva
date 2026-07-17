"""B2a — PylvaBudgetExceeded (Python parity with TS).

Raised by the wrappers' pre-call hook when projected spend crosses a hard-stop
budget_limit rule, OR on the next call after the backend ingest response
flagged the (rule, scope_token, customer_id) key.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal

PYLVA_BUDGET_EXCEEDED_CODE = "budget_exceeded"


class BudgetExceededSource(str, Enum):
    SDK_PRECALL = "sdk_precall"
    BACKEND_INGEST_FLAG = "backend_ingest_flag"
    AUTHORITATIVE_CONTROL = "authoritative_control"


Period = Literal["hour", "day", "week", "month"]


@dataclass(frozen=True)
class _BudgetFields:
    source: BudgetExceededSource
    rule_id: str
    customer_id: str | None
    period: Period
    period_start: str
    limit_usd: float
    accumulated_usd: float
    estimated_usd: float


class PylvaBudgetExceeded(Exception):
    """Raised when a hard-stop budget_limit rule would be crossed.

    Attributes mirror the TS class 1:1 for contract parity.
    """

    code = PYLVA_BUDGET_EXCEEDED_CODE

    def __init__(
        self,
        *,
        source: BudgetExceededSource,
        rule_id: str,
        customer_id: str | None,
        period: Period,
        period_start: str,
        limit_usd: float,
        accumulated_usd: float,
        estimated_usd: float,
        authoritative_denial: Any | None = None,
        limit_usd_exact: str | None = None,
        accumulated_usd_exact: str | None = None,
        estimated_usd_exact: str | None = None,
    ) -> None:
        self.source = source
        self.rule_id = rule_id
        self.customer_id = customer_id
        self.period = period
        self.period_start = period_start
        self.limit_usd = limit_usd
        self.accumulated_usd = accumulated_usd
        self.estimated_usd = estimated_usd
        # Additive exact evidence for authoritative denials. Existing callers
        # and catch paths retain every legacy float field above unchanged.
        self.authoritative_denial = authoritative_denial
        # Internal compatibility alias used during the additive client rollout.
        # ``authoritative_denial`` is the documented public evidence field.
        self.control_decision = authoritative_denial
        self.limit_usd_exact = limit_usd_exact
        self.accumulated_usd_exact = accumulated_usd_exact
        self.estimated_usd_exact = estimated_usd_exact
        super().__init__(self._format_message())

    def _format_message(self) -> str:
        who = self.customer_id if self.customer_id is not None else "pooled"
        spend = self.accumulated_usd + self.estimated_usd
        return (
            f"[pylva] budget exceeded for {who} ({self.period}): "
            f"${spend:.2f} ≥ ${self.limit_usd:.2f} "
            f"(source={self.source.value}, rule={self.rule_id})"
        )
