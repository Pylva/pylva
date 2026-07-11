"""Store-safe provider/model identifier helpers.

Provider and model names are runtime identifiers, not closed enums. Keep this
module in sync with ``@pylva/shared`` telemetry provider/model validation.
"""

from __future__ import annotations

import re
from typing import Any

PROVIDER_MODEL_MAX_LENGTH = 255
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")


def validate_provider_model_identifier(value: str, *, field_name: str = "identifier") -> str:
    """Return ``value`` if it is safe to store; raise ``ValueError`` otherwise."""
    if len(value) > PROVIDER_MODEL_MAX_LENGTH:
        raise ValueError(f"{field_name} must be at most {PROVIDER_MODEL_MAX_LENGTH} characters")
    if len(value.strip()) == 0:
        raise ValueError(f"{field_name} must not be empty or whitespace-only")
    if CONTROL_CHARACTER_RE.search(value):
        raise ValueError(f"{field_name} must not contain control characters")
    return value


def clean_provider_model_identifier(value: Any) -> str | None:
    """Best-effort extraction cleaner used by SDK runtime paths."""
    if not isinstance(value, str):
        return None
    try:
        return validate_provider_model_identifier(value)
    except ValueError:
        return None
