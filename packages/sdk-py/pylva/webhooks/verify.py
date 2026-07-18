"""Stripe-style webhook verification (D7 parity with TS).

B2a D34: accept both raw hex and ``sha256=<hex>`` prefixed signatures so
consumers using a GitHub-style prefix don't get a false "malformed" error.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass

TIMESTAMP_RE = re.compile(r"^\d+$")
SIGNATURE_RE = re.compile(r"^[a-fA-F0-9]{64}$")
PREFIX = "sha256="


class InvalidSignatureFormat(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(f"[pylva] {message}")


def _sign(body: str, secret: str, timestamp: str) -> str:
    msg = f"{timestamp}.{body}".encode()
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _strip_prefix(signature: str) -> str:
    return signature[len(PREFIX) :] if signature.startswith(PREFIX) else signature


def verify_webhook(
    body: str,
    signature: str,
    secret: str,
    timestamp: str,
    *,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> bool:
    """Return True iff signature matches + timestamp within tolerance.

    Raises :class:`InvalidSignatureFormat` on malformed input.
    """
    if not isinstance(timestamp, str) or not TIMESTAMP_RE.match(timestamp):
        raise InvalidSignatureFormat(
            "timestamp must be an integer (epoch seconds) as a string",
        )

    digest = _strip_prefix(signature) if isinstance(signature, str) else signature
    if not isinstance(digest, str) or not SIGNATURE_RE.match(digest):
        raise InvalidSignatureFormat(
            "signature must be a 64-character hex HMAC-SHA256 digest "
            '(optionally prefixed with "sha256=")',
        )

    current = now if now is not None else time.time()
    ts_sec = int(timestamp)
    if abs(current - ts_sec) > tolerance_seconds:
        return False

    expected = _sign(body, secret, timestamp)
    return hmac.compare_digest(expected, digest.lower())


@dataclass(frozen=True)
class SignWebhookResult:
    signature: str
    timestamp: str


def sign_webhook(
    body: str,
    secret: str,
    timestamp: str | None = None,
    *,
    prefix: str = "",
) -> SignWebhookResult:
    """Sign a webhook body. Pass prefix='sha256=' for GitHub-style delivery."""
    ts = timestamp if timestamp is not None else str(int(time.time()))
    raw = _sign(body, secret, ts)
    return SignWebhookResult(signature=f"{prefix}{raw}", timestamp=ts)


# Back-compat alias for users who want the tuple form.
def sign_webhook_tuple(body: str, secret: str, timestamp: str | None = None) -> tuple[str, str]:
    result = sign_webhook(body, secret, timestamp)
    return result.signature, result.timestamp
