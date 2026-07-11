"""R6 abort savings — parity with TS."""

from __future__ import annotations

from dataclasses import dataclass

from .pricing_cache import get_pricing


@dataclass(frozen=True)
class AbortSavingsInput:
    provider: str | None
    model: str | None
    tokens_generated: int
    max_tokens_expected: int | None


def compute_abort_savings_usd(inp: AbortSavingsInput) -> float:
    if (
        inp.provider is None
        or inp.model is None
        or inp.max_tokens_expected is None
        or inp.max_tokens_expected <= inp.tokens_generated
    ):
        return 0.0
    pricing = get_pricing(inp.provider, inp.model)
    if pricing is None:
        return 0.0
    unused = inp.max_tokens_expected - inp.tokens_generated
    raw = (unused * pricing["output_per_1m"]) / 1_000_000
    return round(raw * 1_000_000) / 1_000_000
