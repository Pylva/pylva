"""Provider wrappers.

Legacy auto-patches remain best-effort telemetry.  The explicit controlled
wrappers are the bounded surface used for authoritative enforcement.
"""

from .anthropic_controlled import ControlledAnthropic, wrap_anthropic
from .openai_controlled import ControlledOpenAI, wrap_openai

__all__ = [
    "ControlledAnthropic",
    "ControlledOpenAI",
    "wrap_anthropic",
    "wrap_openai",
]
