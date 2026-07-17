"""Errors raised before a controlled provider request can be dispatched."""

from __future__ import annotations

from typing import Literal

PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE = "strict_provider_unsupported"

StrictProviderReason = Literal[
    "invalid_client",
    "provider_retries_enabled",
    "unsupported_request_shape",
    "usage_bound_required",
    "unsupported_pricing_feature",
]


class PylvaStrictProviderError(TypeError):
    """A request cannot be bounded and priced by the strict provider surface.

    The exception deliberately contains only a provider and a stable reason. It
    never reflects prompt content, tool arguments, or a provider response body.
    """

    code = PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE

    def __init__(self, provider: Literal["openai", "anthropic"], reason: StrictProviderReason):
        self.provider = provider
        self.reason = reason
        super().__init__(
            f"[pylva] {provider} request is not supported by the controlled provider "
            f"surface (reason={reason})"
        )
