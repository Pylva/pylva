"""Authoritative non-LLM lifecycle tests."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict
from decimal import Decimal
from typing import Any

import pytest

from pylva.core import controlled_usage as subject
from pylva.core.config import get_config_generation, require_config
from pylva.core.config import init as init_config
from pylva.core.control_ownership import (
    _register_controlled_reservation,
    current_controlled_attempt,
)
from pylva.core.control_schema import (
    BudgetCommitResponse,
    BypassedBudgetDecision,
    ReservedBudgetDecision,
    UnavailableBudgetDecision,
)
from pylva.errors.control import (
    PylvaControlUnavailableError,
    PylvaControlUnavailableReason,
    PylvaControlValidationError,
)

KEY_A = "pv_live_12345678_" + "a" * 32
KEY_B = "pv_live_12345678_" + "b" * 32
RESERVATION_A = "33333333-3333-4333-8333-333333333333"
RESERVATION_B = "44444444-4444-4444-8444-444444444444"
DECISION_ID = "55555555-5555-4555-8555-555555555555"


def _init(*, mode: str = "enforce", on_unavailable: str = "deny", key: str = KEY_A) -> None:
    init_config(
        key,
        endpoint="https://control.test",
        control={"mode": mode, "on_unavailable": on_unavailable},
    )


def _reserved(
    operation_id: str,
    reservation_id: str = RESERVATION_A,
    *,
    owned: bool = True,
) -> ReservedBudgetDecision:
    response = ReservedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "reserved",
            "allowed": True,
            "decision_id": DECISION_ID,
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
    if owned:
        assert _register_controlled_reservation(
            response,
            require_config(),
            get_config_generation(),
        )
    return response


def _bypassed(operation_id: str, reason: str = "shadow_would_deny") -> BypassedBudgetDecision:
    return BypassedBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "bypassed",
            "allowed": True,
            "decision_id": DECISION_ID if reason != "control_disabled" else None,
            "operation_id": operation_id,
            "reason": reason,
            "would_have_denied": True if reason == "shadow_would_deny" else None,
            "warnings": [],
        },
        strict=True,
    )


def _unavailable(operation_id: str) -> UnavailableBudgetDecision:
    return UnavailableBudgetDecision.model_validate(
        {
            "schema_version": "1.0",
            "decision": "unavailable",
            "allowed": False,
            "decision_id": None,
            "operation_id": operation_id,
            "reason": "pricing_unavailable",
            "retryable": False,
        },
        strict=True,
    )


def _committed(reservation: ReservedBudgetDecision) -> BudgetCommitResponse:
    return BudgetCommitResponse.model_validate(
        {
            "schema_version": "1.0",
            "state": "committed",
            "reservation_id": reservation.reservation_id,
            "operation_id": reservation.operation_id,
            "reserved_usd": "1",
            "actual_usd": "1",
            "released_usd": "0",
            "overage_usd": "0",
            "budget_exceeded_after_commit": False,
            "committed_at": "2026-07-14T00:01:00Z",
            "idempotent_replay": False,
            "late": False,
        },
        strict=True,
    )


def _base_sync(**overrides: Any) -> subject.ControlledUsageResult[Any]:
    values: dict[str, Any] = {
        "cost_source_slug": "document-parser",
        "tool_name": "Document Parser",
        "metric": "page",
        "maximum_value": "10",
        "invoke": lambda: {"pages": 6},
        "extract_actual": lambda result: result["pages"],
        "customer_id": "customer_acme",
    }
    values.update(overrides)
    return subject.controlled_usage_sync(**values)


def _patch_reserved_sync(
    monkeypatch: pytest.MonkeyPatch,
    *,
    reservation_id: str = RESERVATION_A,
    owned: bool = True,
) -> list[dict[str, object]]:
    requests: list[dict[str, object]] = []

    def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        requests.append(request)
        return _reserved(str(request["operation_id"]), reservation_id, owned=owned)

    monkeypatch.setattr(subject, "reserve_usage_sync", reserve)
    return requests


def test_bounded_success_commits_actual_and_surfaces_over_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    requests = _patch_reserved_sync(monkeypatch)
    commits: list[dict[str, object]] = []
    reports: list[object] = []

    def commit(reservation_id: str, request: dict[str, object]) -> BudgetCommitResponse:
        commits.append(request)
        return _committed(_reserved(str(requests[0]["operation_id"]), reservation_id))

    monkeypatch.setattr(subject, "commit_usage_sync", commit)
    monkeypatch.setattr(subject, "extend_usage_sync", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(subject, "_legacy_report", lambda **kwargs: reports.append(kwargs) or True)

    result = _base_sync(maximum_value="1", invoke=lambda: {"pages": 2})

    assert result.value == {"pages": 2}
    assert result.control.settlement == "committed"
    assert result.control.actual_value == "2"
    assert result.control.maximum_value == "1"
    assert result.control.bound_violated is True
    assert result.control.authoritative_ownership is True
    assert result.control.legacy_telemetry_emitted is False
    assert commits[0]["actual_value"] == "2"
    assert reports == []


def test_generic_bound_and_callable_are_snapshotted_before_reserve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    requests: list[dict[str, object]] = []
    original_calls = 0
    replacement_calls = 0

    def original_invoke() -> dict[str, int]:
        nonlocal original_calls
        original_calls += 1
        return {"pages": 1}

    def replacement_invoke() -> dict[str, int]:
        nonlocal replacement_calls
        replacement_calls += 1
        return {"pages": 99}

    caller: dict[str, object] = {
        "maximum": Decimal("1.000"),
        "invoke": original_invoke,
    }

    def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        requests.append(request)
        caller["maximum"] = Decimal("999")
        caller["invoke"] = replacement_invoke
        return _reserved(str(request["operation_id"]))

    monkeypatch.setattr(subject, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        subject,
        "commit_usage_sync",
        lambda _reservation_id, _request: _committed(_reserved(str(requests[0]["operation_id"]))),
    )
    maximum = caller["maximum"]
    invoke = caller["invoke"]
    assert isinstance(maximum, Decimal)
    assert callable(invoke)

    result = subject.controlled_usage_sync(
        cost_source_slug="document-parser",
        tool_name="Document Parser",
        metric="page",
        maximum_value=maximum,
        invoke=invoke,
        extract_actual=lambda value: value["pages"],
        customer_id="customer_acme",
    )

    assert requests[0]["maximum_value"] == "1"
    assert result.control.maximum_value == "1"
    assert result.control.actual_value == "1"
    assert original_calls == 1
    assert replacement_calls == 0


def test_exact_quantity_and_callable_are_snapshotted_before_reserve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    requests: list[dict[str, object]] = []
    original_calls = 0
    replacement_calls = 0

    def original_invoke() -> str:
        nonlocal original_calls
        original_calls += 1
        return "original"

    def replacement_invoke() -> str:
        nonlocal replacement_calls
        replacement_calls += 1
        return "replacement"

    caller: dict[str, object] = {
        "value": Decimal("1.000"),
        "invoke": original_invoke,
    }

    def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        requests.append(request)
        caller["value"] = Decimal("99")
        caller["invoke"] = replacement_invoke
        return _reserved(str(request["operation_id"]))

    monkeypatch.setattr(subject, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        subject,
        "commit_usage_sync",
        lambda _reservation_id, _request: _committed(_reserved(str(requests[0]["operation_id"]))),
    )
    value = caller["value"]
    invoke = caller["invoke"]
    assert isinstance(value, Decimal)
    assert callable(invoke)

    result = subject.controlled_exact_usage_sync(
        cost_source_slug="document-parser",
        tool_name="Document Parser",
        metric="page",
        value=value,
        invoke=invoke,
        customer_id="customer_acme",
    )

    assert requests[0]["maximum_value"] == "1"
    assert result.value == "original"
    assert result.control.maximum_value == "1"
    assert result.control.actual_value == "1"
    assert original_calls == 1
    assert replacement_calls == 0


@pytest.mark.parametrize(
    ("mode", "on_unavailable", "reservation_factory", "expected"),
    [
        ("shadow", "deny", "bypass", "bypassed"),
        ("shadow", "deny", "raise_unavailable", "unavailable"),
        ("enforce", "allow", "unavailable", "unavailable"),
    ],
)
def test_nonblocking_modes_call_once_and_emit_legacy_tracking(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    on_unavailable: str,
    reservation_factory: str,
    expected: str,
) -> None:
    _init(mode=mode, on_unavailable=on_unavailable)
    calls = 0
    reports: list[dict[str, object]] = []

    def reserve(request: dict[str, object]) -> object:
        operation_id = str(request["operation_id"])
        if reservation_factory == "bypass":
            return _bypassed(operation_id)
        if reservation_factory == "unavailable":
            return _unavailable(operation_id)
        raise PylvaControlUnavailableError(
            PylvaControlUnavailableReason.PRICING_UNAVAILABLE,
            False,
            "reserve_usage",
            operation_id=operation_id,
        )

    def invoke() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"pages": 1}

    monkeypatch.setattr(subject, "reserve_usage_sync", reserve)
    monkeypatch.setattr(subject, "_legacy_report", lambda **kwargs: reports.append(kwargs) or True)
    result = _base_sync(invoke=invoke)

    assert calls == 1
    assert result.control.decision == expected
    assert result.control.authoritative_ownership is False
    assert result.control.legacy_telemetry_emitted is True
    assert len(reports) == 1


def test_legacy_has_zero_control_io_and_keeps_report_usage_tracking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="legacy", on_unavailable="deny")
    reports: list[dict[str, object]] = []
    monkeypatch.setattr(subject, "_legacy_report", lambda **kwargs: reports.append(kwargs) or True)
    monkeypatch.setattr(subject, "_make_sync_client", None, raising=False)

    result = _base_sync()

    assert result.control.decision == "bypassed"
    assert result.control.decision_reason == "control_disabled"
    assert result.control.legacy_telemetry_emitted is True
    assert len(reports) == 1


def test_enforce_deny_unavailable_invokes_provider_zero_times(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="enforce", on_unavailable="deny")
    calls = 0

    def unavailable(_request: dict[str, object]) -> object:
        raise PylvaControlUnavailableError(
            PylvaControlUnavailableReason.PRICING_UNAVAILABLE,
            False,
            "reserve_usage",
        )

    def invoke() -> object:
        nonlocal calls
        calls += 1
        return object()

    monkeypatch.setattr(subject, "reserve_usage_sync", unavailable)
    with pytest.raises(PylvaControlUnavailableError):
        _base_sync(invoke=invoke, extract_actual=lambda _value: 1)
    assert calls == 0


def test_provider_and_extractor_failures_remain_unresolved_without_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _patch_reserved_sync(monkeypatch)
    commits: list[object] = []
    releases: list[object] = []
    monkeypatch.setattr(subject, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(subject, "release_usage_sync", lambda *args: releases.append(args))

    provider_error = RuntimeError("provider secret URL https://private.example")
    with pytest.raises(RuntimeError) as raised:
        _base_sync(invoke=lambda: (_ for _ in ()).throw(provider_error))
    assert raised.value is provider_error
    assert commits == []
    assert releases == []

    provider_value = {"private_url": "https://private.example"}
    result = _base_sync(
        invoke=lambda: provider_value,
        extract_actual=lambda _value: (_ for _ in ()).throw(RuntimeError("secret query")),
    )
    assert result.value is provider_value
    assert result.control.settlement == "unresolved"
    assert result.control.issue == "usage_extraction_failed"
    assert commits == []
    assert "private" not in json.dumps(asdict(result.control))


def test_predispatch_failure_releases_and_provider_is_not_called(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _patch_reserved_sync(monkeypatch)
    calls = 0
    releases: list[tuple[object, ...]] = []
    monkeypatch.setattr(subject, "release_usage_sync", lambda *args: releases.append(args))

    def invoke() -> object:
        nonlocal calls
        calls += 1
        return object()

    prepare_error = RuntimeError("local preparation failed")
    with pytest.raises(RuntimeError) as raised:
        _base_sync(
            invoke=invoke,
            extract_actual=lambda _value: 1,
            before_invoke=lambda: (_ for _ in ()).throw(prepare_error),
        )

    assert raised.value is prepare_error
    assert calls == 0
    assert len(releases) == 1
    assert releases[0][1] == {"reason": "provider_not_called"}


def test_commit_lost_ack_returns_provider_result_and_never_reports_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _patch_reserved_sync(monkeypatch)
    reports: list[object] = []
    monkeypatch.setattr(subject, "_legacy_report", lambda **kwargs: reports.append(kwargs) or True)
    monkeypatch.setattr(
        subject,
        "commit_usage_sync",
        lambda *_args: (_ for _ in ()).throw(ConnectionError("lost ACK with secret")),
    )

    result = _base_sync()

    assert result.value == {"pages": 6}
    assert result.control.settlement == "unresolved"
    assert result.control.issue == "commit_failed"
    assert result.control.authoritative_ownership is True
    assert reports == []
    assert "secret" not in json.dumps(asdict(result.control))


def test_forged_receipt_and_identity_reinit_are_fenced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    calls = 0
    _patch_reserved_sync(monkeypatch, owned=False)

    def invoke() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"pages": 1}

    with pytest.raises(PylvaControlValidationError):
        _base_sync(invoke=invoke)
    assert calls == 0

    _patch_reserved_sync(monkeypatch, reservation_id=RESERVATION_B)
    commits: list[object] = []
    reports: list[object] = []
    monkeypatch.setattr(subject, "commit_usage_sync", lambda *args: commits.append(args))
    monkeypatch.setattr(subject, "_legacy_report", lambda **kwargs: reports.append(kwargs) or True)

    def invoke_and_reinit() -> dict[str, int]:
        init_config(
            KEY_B,
            endpoint="https://other.test",
            control={"mode": "enforce", "on_unavailable": "deny"},
        )
        return {"pages": 1}

    result = _base_sync(invoke=invoke_and_reinit)
    assert result.control.settlement == "unresolved"
    assert result.control.issue == "configuration_changed"
    assert commits == []
    assert reports == []


def test_sync_long_call_extends_and_extension_failure_is_surfaced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    _patch_reserved_sync(monkeypatch)
    extensions: list[tuple[object, ...]] = []
    monkeypatch.setattr(subject, "extend_usage_sync", lambda *args: extensions.append(args))
    monkeypatch.setattr(
        subject,
        "commit_usage_sync",
        lambda reservation_id, _request: BudgetCommitResponse.model_validate(
            {
                "schema_version": "1.0",
                "state": "committed",
                "reservation_id": reservation_id,
                "operation_id": "11111111-1111-4111-8111-111111111111",
                "reserved_usd": "1",
                "actual_usd": "1",
                "released_usd": "0",
                "overage_usd": "0",
                "budget_exceeded_after_commit": False,
                "committed_at": "2026-07-14T00:01:00Z",
                "idempotent_replay": False,
                "late": False,
            },
            strict=True,
        ),
    )
    result = _base_sync(
        invoke=lambda: (time.sleep(0.04), {"pages": 1})[1],
        heartbeat_interval_seconds=0.01,
    )
    assert result.control.settlement == "committed"
    assert len(extensions) >= 1
    extension_ids = [str(call[1]["extension_id"]) for call in extensions]
    assert len(set(extension_ids)) == len(extension_ids)

    monkeypatch.setattr(
        subject,
        "extend_usage_sync",
        lambda *_args: (_ for _ in ()).throw(ConnectionError("extension failed")),
    )
    result = _base_sync(
        invoke=lambda: (time.sleep(0.04), {"pages": 1})[1],
        heartbeat_interval_seconds=0.01,
    )
    assert result.control.settlement == "committed"
    assert result.control.issue == "extension_failed"


@pytest.mark.parametrize(
    "invalid",
    [
        1.0,
        Decimal("NaN"),
        Decimal("Infinity"),
        Decimal("-1"),
        Decimal("1E+999999999"),
        Decimal("1E-999999999"),
        Decimal("1E-19"),
    ],
)
def test_decimal_validation_rejects_binary_floats_and_hostile_values_before_call(
    monkeypatch: pytest.MonkeyPatch,
    invalid: object,
) -> None:
    _init(mode="legacy")
    calls = 0

    def invoke() -> object:
        nonlocal calls
        calls += 1
        return object()

    with pytest.raises(PylvaControlValidationError):
        _base_sync(
            maximum_value=invalid,
            invoke=invoke,
            extract_actual=lambda _value: 1,
        )
    assert calls == 0


def test_decimal_acceptance_is_exact_and_negative_zero_is_canonical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="legacy")
    monkeypatch.setattr(subject, "_legacy_report", lambda **_kwargs: True)
    zero = subject.controlled_exact_usage_sync(
        cost_source_slug="document-parser",
        tool_name="Document Parser",
        metric="page",
        value=Decimal("-0"),
        invoke=lambda: "zero",
        customer_id="customer_acme",
    )
    fractional = subject.controlled_exact_usage_sync(
        cost_source_slug="document-parser",
        tool_name="Document Parser",
        metric="page",
        value=Decimal("1.2300"),
        invoke=lambda: "fractional",
        customer_id="customer_acme",
    )
    assert zero.control.maximum_value == zero.control.actual_value == "0"
    assert fractional.control.maximum_value == fractional.control.actual_value == "1.23"


@pytest.mark.asyncio
async def test_async_heartbeat_concurrency_and_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    reservation_counter = 0
    operations: set[str] = set()
    extensions: list[tuple[str, str]] = []
    commits: list[str] = []
    releases: list[str] = []
    seen_attempts: list[object] = []

    async def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        nonlocal reservation_counter
        reservation_counter += 1
        operation_id = str(request["operation_id"])
        operations.add(operation_id)
        reservation_id = RESERVATION_A if reservation_counter == 1 else RESERVATION_B
        return _reserved(operation_id, reservation_id)

    async def extend(reservation_id: str, request: dict[str, object]) -> None:
        extensions.append((reservation_id, str(request["extension_id"])))

    async def commit(reservation_id: str, _request: dict[str, object]) -> BudgetCommitResponse:
        commits.append(reservation_id)
        operation_id = next(iter(operations))
        return _committed(_reserved(operation_id, reservation_id))

    async def release(reservation_id: str, _request: dict[str, object]) -> None:
        releases.append(reservation_id)

    monkeypatch.setattr(subject, "reserve_usage", reserve)
    monkeypatch.setattr(subject, "extend_usage", extend)
    monkeypatch.setattr(subject, "commit_usage", commit)
    monkeypatch.setattr(subject, "release_usage", release)

    async def invoke(value: int) -> dict[str, int]:
        active = current_controlled_attempt()
        seen_attempts.append(active)
        await asyncio.sleep(0.04)
        assert current_controlled_attempt() is active
        return {"pages": value}

    results = await asyncio.gather(
        subject.controlled_usage(
            cost_source_slug="document-parser",
            tool_name="Document Parser",
            metric="page",
            maximum_value="2",
            invoke=lambda: invoke(1),
            extract_actual=lambda value: value["pages"],
            customer_id="customer_acme",
            heartbeat_interval_seconds=0.01,
        ),
        subject.controlled_usage(
            cost_source_slug="document-parser",
            tool_name="Document Parser",
            metric="page",
            maximum_value="2",
            invoke=lambda: invoke(2),
            extract_actual=lambda value: value["pages"],
            customer_id="customer_acme",
            heartbeat_interval_seconds=0.01,
        ),
    )
    assert len(operations) == 2
    assert len(commits) == 2
    assert len(extensions) >= 2
    assert len({extension_id for _, extension_id in extensions}) == len(extensions)
    assert all(result.control.settlement == "committed" for result in results)
    assert len(seen_attempts) == 2
    first, second = seen_attempts
    assert first is not None and second is not None
    assert first.operation_id != second.operation_id
    assert first.reservation_id != second.reservation_id
    assert first.kind == second.kind == "tool"
    assert first.cost_source_slug == second.cost_source_slug == "document-parser"
    assert first.tool_name == second.tool_name == "Document Parser"
    assert first.metric == second.metric == "page"
    assert first.provider is first.model is None
    assert second.provider is second.model is None
    assert current_controlled_attempt() is None

    started = asyncio.Event()

    async def never_finishes() -> object:
        started.set()
        await asyncio.Event().wait()
        return object()

    task = asyncio.create_task(
        subject.controlled_usage(
            cost_source_slug="document-parser",
            tool_name="Document Parser",
            metric="page",
            maximum_value="1",
            invoke=never_finishes,
            extract_actual=lambda _value: 1,
            customer_id="customer_acme",
            heartbeat_interval_seconds=0.01,
        )
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(commits) == 2
    assert releases == []


@pytest.mark.asyncio
async def test_async_extraction_keeps_lease_alive_and_fences_reinitialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init()
    extensions: list[str] = []
    commits: list[str] = []

    async def reserve(request: dict[str, object]) -> ReservedBudgetDecision:
        return _reserved(str(request["operation_id"]))

    async def extend(reservation_id: str, _request: dict[str, object]) -> None:
        extensions.append(reservation_id)

    async def commit(
        reservation_id: str,
        _request: dict[str, object],
    ) -> BudgetCommitResponse:
        commits.append(reservation_id)
        raise AssertionError("configuration change must fence commit")

    async def invoke() -> dict[str, int]:
        return {"pages": 1}

    async def extract(value: dict[str, int]) -> int:
        await asyncio.sleep(0.03)
        init_config(
            KEY_B,
            endpoint="https://other.test",
            control={"mode": "enforce", "on_unavailable": "deny"},
        )
        return value["pages"]

    monkeypatch.setattr(subject, "reserve_usage", reserve)
    monkeypatch.setattr(subject, "extend_usage", extend)
    monkeypatch.setattr(subject, "commit_usage", commit)

    result = await subject.controlled_usage(
        cost_source_slug="document-parser",
        tool_name="Document Parser",
        metric="page",
        maximum_value="1",
        invoke=invoke,
        extract_actual=extract,
        customer_id="customer_acme",
        heartbeat_interval_seconds=0.005,
    )

    assert extensions
    assert commits == []
    assert result.control.settlement == "unresolved"
    assert result.control.issue == "configuration_changed"
    assert result.control.actual_value is None
    assert result.control.legacy_telemetry_emitted is False


def test_bypass_tool_context_suppresses_callback_and_helper_reports_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _init(mode="shadow", on_unavailable="deny")
    callback_events: list[str] = []
    helper_events: list[str] = []

    def reserve(request: dict[str, object]) -> BypassedBudgetDecision:
        return _bypassed(str(request["operation_id"]))

    def invoke() -> dict[str, int]:
        active = current_controlled_attempt()
        if active is None or active.kind != "tool":
            callback_events.append("duplicate")
        assert active is not None
        assert active.owns_reservation is False
        assert active.legacy_telemetry_required is True
        return {"pages": 1}

    monkeypatch.setattr(subject, "reserve_usage_sync", reserve)
    monkeypatch.setattr(
        subject,
        "_legacy_report",
        lambda **_kwargs: helper_events.append("fallback") or True,
    )
    result = _base_sync(invoke=invoke)
    assert result.control.legacy_telemetry_emitted is True
    assert callback_events == []
    assert helper_events == ["fallback"]
