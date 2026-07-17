"""Controlled-reservation ownership is exact-match and context-local."""

from __future__ import annotations

import asyncio

import pytest

from pylva.core.config import (
    get_config_generation,
    require_config,
)
from pylva.core.config import (
    init as init_config,
)
from pylva.core.control_ownership import (
    _register_controlled_reservation,
    controlled_operation_ownership,
    current_controlled_operation,
    should_suppress_legacy_telemetry,
)
from pylva.core.control_schema import ReservedBudgetDecision

OPERATION_A = "11111111-1111-4111-8111-111111111111"
OPERATION_B = "22222222-2222-4222-8222-222222222222"
RESERVATION_A = "33333333-3333-4333-8333-333333333333"
RESERVATION_B = "44444444-4444-4444-8444-444444444444"
KEY_A = "pv_live_12345678_" + "a" * 32
KEY_B = "pv_live_12345678_" + "b" * 32


@pytest.fixture(autouse=True)
def _configured_identity() -> None:
    init_config(KEY_A, endpoint="https://a.test")


def _reservation(
    operation_id: str,
    reservation_id: str,
    *,
    register: bool = True,
) -> ReservedBudgetDecision:
    response = ReservedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "reserved",
            "allowed": True,
            "decision_id": "55555555-5555-4555-8555-555555555555",
            "operation_id": operation_id,
            "reservation_id": reservation_id,
            "state": "reserved",
            "reserved_usd": "1",
            "remaining_usd": "9",
            "expires_at": "2026-07-14T00:05:00Z",
            "warnings": [],
        },
        strict=True,
    )
    if register:
        assert _register_controlled_reservation(
            response,
            require_config(),
            get_config_generation(),
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
        )
    return response


def test_suppression_requires_sdk_owned_reservation_and_both_exact_identities() -> None:
    receipt = _reservation(OPERATION_A, RESERVATION_A)
    assert should_suppress_legacy_telemetry(operation_id=OPERATION_A) is False
    assert should_suppress_legacy_telemetry(reservation_id=RESERVATION_A) is False
    assert (
        should_suppress_legacy_telemetry(
            receipt,
            operation_id=OPERATION_A,
            reservation_id=RESERVATION_A,
        )
        is True
    )
    assert not should_suppress_legacy_telemetry(
        receipt,
        operation_id=OPERATION_B,
        reservation_id=RESERVATION_A,
    )
    assert not should_suppress_legacy_telemetry(
        receipt,
        operation_id=OPERATION_A,
        reservation_id=RESERVATION_B,
    )

    with controlled_operation_ownership(receipt) as owned:
        assert current_controlled_operation() is owned
        assert owned.trace_id == "44444444-4444-4444-8444-444444444444"
        assert owned.span_id == "55555555-5555-4555-8555-555555555555"
        assert should_suppress_legacy_telemetry(
            operation_id=OPERATION_A,
            reservation_id=RESERVATION_A,
        )
    assert current_controlled_operation() is None


def test_fabricated_or_copied_reservations_do_not_own_telemetry() -> None:
    fabricated = _reservation(OPERATION_A, RESERVATION_A, register=False)
    with pytest.raises(TypeError):
        with controlled_operation_ownership(fabricated):
            raise AssertionError("unreachable")

    receipt = _reservation(OPERATION_A, RESERVATION_A)
    copied = receipt.model_copy(deep=True)
    assert not should_suppress_legacy_telemetry(
        copied,
        operation_id=OPERATION_A,
        reservation_id=RESERVATION_A,
    )


def test_nested_ownership_restores_outer_operation() -> None:
    outer = _reservation(OPERATION_A, RESERVATION_A)
    inner = _reservation(OPERATION_B, RESERVATION_B)
    with controlled_operation_ownership(outer):
        with controlled_operation_ownership(inner):
            assert should_suppress_legacy_telemetry(
                operation_id=OPERATION_B,
                reservation_id=RESERVATION_B,
            )
            assert not should_suppress_legacy_telemetry(
                operation_id=OPERATION_A,
                reservation_id=RESERVATION_A,
            )
        assert should_suppress_legacy_telemetry(
            operation_id=OPERATION_A,
            reservation_id=RESERVATION_A,
        )


@pytest.mark.asyncio
async def test_concurrent_tasks_do_not_share_unrelated_ownership() -> None:
    receipt = _reservation(OPERATION_A, RESERVATION_A)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def owned_task() -> None:
        with controlled_operation_ownership(receipt):
            entered.set()
            await release.wait()
            assert should_suppress_legacy_telemetry(
                operation_id=OPERATION_A,
                reservation_id=RESERVATION_A,
            )

    task = asyncio.create_task(owned_task())
    await entered.wait()
    assert not should_suppress_legacy_telemetry(
        operation_id=OPERATION_A,
        reservation_id=RESERVATION_A,
    )
    release.set()
    await task


def test_builder_identity_change_makes_receipt_and_context_inert() -> None:
    receipt = _reservation(OPERATION_A, RESERVATION_A)
    with controlled_operation_ownership(receipt):
        assert should_suppress_legacy_telemetry(
            operation_id=OPERATION_A,
            reservation_id=RESERVATION_A,
        )
        init_config(KEY_B, endpoint="https://b.test")
        assert current_controlled_operation() is None
        assert not should_suppress_legacy_telemetry(
            receipt,
            operation_id=OPERATION_A,
            reservation_id=RESERVATION_A,
        )
