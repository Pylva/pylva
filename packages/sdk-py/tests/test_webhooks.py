"""Parity with TS webhooks.test.ts — Stripe-style HMAC verify (D7)."""

import pytest

from pylva.webhooks.verify import (
    InvalidSignatureFormat,
    sign_webhook,
    verify_webhook,
)

SECRET = "whsec_test_secret"
BODY = '{"event":"cost_threshold","amount":100}'


def test_accepts_valid_signature_in_tolerance() -> None:
    ts = "1700000000"
    sig = sign_webhook(BODY, SECRET, timestamp=ts).signature
    assert verify_webhook(BODY, sig, SECRET, ts, now=1_700_000_050) is True


def test_rejects_expired_timestamp() -> None:
    ts = "1700000000"
    sig = sign_webhook(BODY, SECRET, timestamp=ts).signature
    # 500s later — outside default 300s tolerance
    assert verify_webhook(BODY, sig, SECRET, ts, now=1_700_000_500) is False


def test_rejects_tampered_body() -> None:
    ts = "1700000000"
    sig = sign_webhook(BODY, SECRET, timestamp=ts).signature
    assert verify_webhook(BODY + "tampered", sig, SECRET, ts, now=1_700_000_050) is False


def test_throws_on_non_integer_timestamp() -> None:
    sig = sign_webhook(BODY, SECRET, timestamp="1700000000").signature
    with pytest.raises(InvalidSignatureFormat):
        verify_webhook(BODY, sig, SECRET, "not-a-number")


def test_throws_on_malformed_signature() -> None:
    with pytest.raises(InvalidSignatureFormat):
        verify_webhook(BODY, "xyz", SECRET, "1700000000")


def test_honors_custom_tolerance() -> None:
    ts = "1700000000"
    sig = sign_webhook(BODY, SECRET, timestamp=ts).signature
    assert verify_webhook(BODY, sig, SECRET, ts, tolerance_seconds=50, now=1_700_000_100) is False
    assert verify_webhook(BODY, sig, SECRET, ts, tolerance_seconds=200, now=1_700_000_100) is True


def test_round_trip_sign_verify() -> None:
    result = sign_webhook(BODY, SECRET)
    assert len(result.signature) == 64
    assert result.timestamp.isdigit()
    assert verify_webhook(BODY, result.signature, SECRET, result.timestamp) is True
