"""Fail-closed identity check for immutable Python SDK service artifacts."""

from __future__ import annotations

import hashlib
import hmac
import importlib.metadata
import os
import re
from pathlib import Path

_SHA256 = re.compile(r"[0-9a-f]{64}")
_SOURCE_SHA = re.compile(r"[0-9a-f]{40}")


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"immutable Python SDK artifact requires {name}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_python_sdk_artifact() -> dict[str, str]:
    """Verify the exact wheel bytes and bind them to installed metadata."""

    wheel = Path(_required_environment("PYLVA_PYTHON_WHEEL")).resolve(strict=True)
    expected_sha256 = _required_environment("PYLVA_PYTHON_WHEEL_SHA256")
    expected_version = _required_environment("PYLVA_PYTHON_ARTIFACT_VERSION")
    source_sha = _required_environment("PYLVA_PYTHON_ARTIFACT_SOURCE_SHA")
    if wheel.suffix != ".whl" or not wheel.is_file():
        raise RuntimeError("immutable Python SDK artifact is not one wheel file")
    if _SHA256.fullmatch(expected_sha256) is None:
        raise RuntimeError("immutable Python SDK artifact SHA-256 is malformed")
    if _SOURCE_SHA.fullmatch(source_sha) is None:
        raise RuntimeError("immutable Python SDK artifact source SHA is malformed")

    actual_sha256 = _sha256(wheel)
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise RuntimeError("immutable Python SDK artifact SHA-256 mismatch")
    distribution_version = importlib.metadata.version("pylva-sdk")
    if distribution_version != expected_version:
        raise RuntimeError("immutable Python SDK artifact version mismatch")

    return {
        "python_artifact_source_sha": source_sha,
        "python_artifact_version": expected_version,
        "python_artifact_wheel": wheel.as_posix(),
        "python_artifact_wheel_sha256": actual_sha256,
    }
