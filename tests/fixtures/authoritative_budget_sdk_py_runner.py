"""Real Python SDK child process for authoritative-control integration gates."""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from uuid import uuid4

import pylva


SDK_PATH = Path(pylva.__file__ or "").resolve().as_posix()


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def _reserve_input(prefix: str, index: int) -> dict[str, Any]:
    return {
        "operation_id": str(uuid4()),
        "customer_id": f"{prefix}_{index:03d}",
        "trace_id": str(uuid4()),
        "span_id": str(uuid4()),
        "parent_span_id": None,
        "step_name": "chaos.sdk.python",
        "framework": "none",
        "reservation_ttl_seconds": 30,
        "kind": "tool",
        "cost_source_slug": "chaos-tool",
        "tool_name": "chaos_tool",
        "metric": "calls",
        "maximum_value": "1",
    }


def _reserve_one(prefix: str, index: int) -> dict[str, Any]:
    try:
        result = pylva.reserve_usage_sync(_reserve_input(prefix, index))
    except pylva.PylvaBudgetExceeded:
        return {"decision": "denied"}
    except pylva.PylvaControlUnavailableError:
        return {"decision": "unavailable"}
    return {
        "decision": result.decision,
        "reservation_id": getattr(result, "reservation_id", None),
        "reserved_usd": getattr(result, "reserved_usd", None),
    }


def main() -> None:
    mode = os.environ.get("PYLVA_RUNNER_MODE", "contend")
    endpoint = os.environ.get("PYLVA_RUNNER_ENDPOINT")
    api_key = os.environ.get("PYLVA_RUNNER_API_KEY")
    count = int(os.environ.get("PYLVA_RUNNER_COUNT", "0"))
    prefix = os.environ.get("PYLVA_RUNNER_PREFIX", "python")
    if endpoint is None or api_key is None or count < 0 or count > 1000:
        raise RuntimeError("invalid Python SDK runner configuration")

    legacy = mode == "legacy"
    pylva.init(
        api_key,
        endpoint=endpoint,
        control={
            "mode": "legacy" if legacy else "enforce",
            "on_unavailable": "allow" if mode == "old_backend" else "deny",
            "timeout_ms": 30_000,
        },
    )

    if legacy:
        result = pylva.reserve_usage_sync(_reserve_input(prefix, 0))
        _write(
            {
                "event": "result",
                "runtime": "python",
                "sdk_path": SDK_PATH,
                "sdk_version": pylva.__version__,
                "decision": result.decision,
                "ready": None,
            }
        )
        return

    if mode == "old_backend":
        is_ready = pylva.ready_sync()
        result = pylva.reserve_usage_sync(_reserve_input(prefix, 0))
        _write(
            {
                "event": "result",
                "runtime": "python",
                "sdk_path": SDK_PATH,
                "sdk_version": pylva.__version__,
                "decision": result.decision,
                "ready": is_ready,
            }
        )
        return

    if mode != "contend":
        raise RuntimeError("unsupported Python SDK runner mode")
    if not pylva.ready_sync():
        raise RuntimeError("Python SDK control did not become ready")
    _write(
        {
            "event": "ready",
            "runtime": "python",
            "sdk_path": SDK_PATH,
            "sdk_version": pylva.__version__,
        }
    )
    sys.stdin.readline()

    with ThreadPoolExecutor(max_workers=min(16, max(1, count))) as executor:
        results = list(
            executor.map(lambda index: _reserve_one(prefix, index), range(count))
        )
    decisions = {
        decision: sum(result["decision"] == decision for result in results)
        for decision in ("reserved", "denied", "unavailable")
    }
    _write(
        {
            "event": "result",
            "runtime": "python",
            "sdk_path": SDK_PATH,
            "sdk_version": pylva.__version__,
            "decisions": decisions,
            "reservation_ids": [
                result["reservation_id"]
                for result in results
                if isinstance(result.get("reservation_id"), str)
            ],
            "reserved_usd": sorted(
                {
                    result["reserved_usd"]
                    for result in results
                    if isinstance(result.get("reserved_usd"), str)
                }
            ),
        }
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - test runner must report every failure
        _write(
            {
                "event": "error",
                "runtime": "python",
                "name": type(error).__name__,
                "message": str(error),
            }
        )
        raise
