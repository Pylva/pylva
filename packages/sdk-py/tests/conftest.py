"""Pytest config: autouse fixture that resets all SDK module-level state
between tests. Keeps individual test files from each duplicating the same
4-line reset block."""

from __future__ import annotations

import pytest

from pylva.core import rules_cache
from pylva.core.client_registry import _reset_client_registry
from pylva.core.config import _reset_config_for_tests
from pylva.core.failover import _reset_failover_for_tests
from pylva.core.non_llm_policy import _reset_non_llm_policy_for_tests
from pylva.core.rules_engine import _reset_engine_for_tests


@pytest.fixture(autouse=True)
def _reset_engine_state() -> None:
    """Run before every test. Tests that need additional resets (telemetry
    buffer, wrapper patch flags) still call those explicitly — they're
    test-suite-specific."""
    _reset_config_for_tests()
    _reset_client_registry()
    _reset_non_llm_policy_for_tests()
    rules_cache._reset_rules_cache_for_tests()
    _reset_engine_for_tests()
    _reset_failover_for_tests()
