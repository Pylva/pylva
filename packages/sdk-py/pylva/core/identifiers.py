"""Store-safe provider/model identifier helpers.

Provider and model names are runtime identifiers, not closed enums. Keep this
module in sync with ``@pylva/shared`` telemetry provider/model validation.
"""

from __future__ import annotations

import re
from typing import Any

PROVIDER_MODEL_MAX_LENGTH = 255
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")
STORE_BLANK_STRING_RE = re.compile(
    r"^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a"
    r"\u2028\u2029\u202f\u205f\u3000\ufeff]*$"
)
STORE_LONE_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")


def is_store_blank_string(value: str) -> bool:
    """Return whether every character is in Pylva's cross-runtime blank set."""
    return STORE_BLANK_STRING_RE.fullmatch(value) is not None


def validate_provider_model_identifier(value: str, *, field_name: str = "identifier") -> str:
    """Return ``value`` if it is safe to store; raise ``ValueError`` otherwise."""
    if len(value) > PROVIDER_MODEL_MAX_LENGTH:
        raise ValueError(f"{field_name} must be at most {PROVIDER_MODEL_MAX_LENGTH} characters")
    if is_store_blank_string(value):
        raise ValueError(f"{field_name} must not be empty or whitespace-only")
    if STORE_LONE_SURROGATE_RE.search(value):
        raise ValueError(f"{field_name} must contain valid Unicode scalar values")
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
