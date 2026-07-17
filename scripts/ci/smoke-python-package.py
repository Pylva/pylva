#!/usr/bin/env python3
"""Build or verify immutable public Python SDK distribution artifacts."""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile
from dataclasses import dataclass
from email.parser import Parser
from hashlib import sha256
from typing import Any, Callable

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 matrix leg
    import tomli as tomllib  # type: ignore[no-redef]


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_PACKAGE_DIR = REPO_ROOT / "packages" / "sdk-py"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class ArtifactProof:
    label: str
    path: pathlib.Path
    sha256: str


@dataclass(frozen=True)
class Options:
    package_dir: pathlib.Path
    wheel: pathlib.Path | None
    sdist: pathlib.Path | None
    wheel_sha256: str | None
    sdist_sha256: str | None

    @property
    def verify_existing(self) -> bool:
        return self.wheel is not None


def parse_options(argv: list[str]) -> Options:
    parser = argparse.ArgumentParser(
        description=(
            "Build and smoke wheel/sdist artifacts, or verify already-built immutable "
            "artifacts without rebuilding them."
        )
    )
    parser.add_argument(
        "package_dir",
        nargs="?",
        default=str(DEFAULT_PACKAGE_DIR),
        help="Python SDK package directory (default: packages/sdk-py)",
    )
    parser.add_argument(
        "--verify-existing",
        action="store_true",
        help="Verify the supplied wheel and sdist without invoking the build frontend",
    )
    parser.add_argument("--wheel", help="Exact already-built wheel path")
    parser.add_argument("--sdist", help="Exact already-built source-distribution path")
    parser.add_argument("--wheel-sha256", help="Expected SHA-256 for --wheel")
    parser.add_argument("--sdist-sha256", help="Expected SHA-256 for --sdist")
    namespace = parser.parse_args(argv)

    verification_values = (
        namespace.wheel,
        namespace.sdist,
        namespace.wheel_sha256,
        namespace.sdist_sha256,
    )
    if namespace.verify_existing:
        if not all(verification_values):
            parser.error(
                "--verify-existing requires --wheel, --sdist, --wheel-sha256, and "
                "--sdist-sha256"
            )
    elif any(verification_values):
        parser.error("artifact paths and hashes require --verify-existing")

    return Options(
        package_dir=pathlib.Path(namespace.package_dir).resolve(),
        wheel=(pathlib.Path(namespace.wheel).resolve() if namespace.wheel else None),
        sdist=(pathlib.Path(namespace.sdist).resolve() if namespace.sdist else None),
        wheel_sha256=namespace.wheel_sha256,
        sdist_sha256=namespace.sdist_sha256,
    )


def run(
    args: list[str],
    *,
    cwd: pathlib.Path | None = None,
    env: dict[str, str] | None = None,
) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True)


def load_project(package_dir: pathlib.Path) -> dict[str, Any]:
    with (package_dir / "pyproject.toml").open("rb") as pyproject:
        data = tomllib.load(pyproject)
    project = data.get("project")
    if not isinstance(project, dict):
        raise AssertionError("pyproject.toml has no [project] table")
    return project


def normalized_dist_name(name: str) -> str:
    return re.sub(r"[-_.]+", "_", name).lower()


def assert_distribution_metadata(
    metadata: Any, name: str, version: str, artifact_label: str
) -> None:
    if metadata["Name"] != name or metadata["Version"] != version:
        raise AssertionError(
            f"{artifact_label} metadata is {metadata['Name']}@{metadata['Version']}, "
            f"expected {name}@{version}"
        )
    if metadata["Requires-Python"] != ">=3.10":
        raise AssertionError(
            f"{artifact_label} has unexpected Requires-Python: {metadata['Requires-Python']}"
        )
    extras = set(metadata.get_all("Provides-Extra", []))
    if "langchain" not in extras:
        raise AssertionError(f"{artifact_label} lost the langchain extra")
    requirements = set(metadata.get_all("Requires-Dist", []))
    required = {
        "langchain-core<2.0,>=1.0; extra == 'langchain'",
        "langchain<2.0,>=1.0; extra == 'langchain'",
        "langgraph<2.0,>=1.0; extra == 'langchain'",
    }
    missing = sorted(required - requirements)
    if missing:
        raise AssertionError(
            f"{artifact_label} lost required langchain metadata: {missing}"
        )
    if metadata["License-File"] != "LICENSE":
        raise AssertionError(
            f"{artifact_label} has unexpected License-File: {metadata['License-File']}"
        )


def inspect_wheel(wheel: pathlib.Path, name: str, version: str) -> None:
    with zipfile.ZipFile(wheel) as archive:
        files = set(archive.namelist())
        required = {
            "pylva/__init__.py",
            "pylva/_version.py",
            "pylva/core/control_client.py",
            "pylva/core/control_ownership.py",
            "pylva/core/control_schema.py",
            "pylva/core/controlled_usage.py",
            "pylva/adapters/__init__.py",
            "pylva/adapters/tavily.py",
            "pylva/errors/__init__.py",
            "pylva/errors/strict_provider.py",
            "pylva/langchain/__init__.py",
            "pylva/langchain/callback.py",
            "pylva/wrappers/__init__.py",
            "pylva/wrappers/_controlled_provider.py",
            "pylva/wrappers/_strict_context.py",
            "pylva/wrappers/anthropic_controlled.py",
            "pylva/wrappers/openai_controlled.py",
            "pylva/py.typed",
        }
        missing = sorted(required - files)
        if missing:
            raise AssertionError(f"wheel is missing public runtime files: {missing}")
        metadata_files = [
            entry for entry in files if entry.endswith(".dist-info/METADATA")
        ]
        if len(metadata_files) != 1:
            raise AssertionError(
                f"wheel has invalid metadata entries: {metadata_files}"
            )
        metadata = Parser().parsestr(archive.read(metadata_files[0]).decode())
        assert_distribution_metadata(metadata, name, version, "wheel")
        license_files = [
            entry for entry in files if entry.endswith(".dist-info/licenses/LICENSE")
        ]
        if len(license_files) != 1:
            raise AssertionError(
                f"wheel has invalid packaged license entries: {license_files}"
            )


def inspect_sdist(sdist: pathlib.Path, name: str, version: str) -> None:
    with tarfile.open(sdist, mode="r:gz") as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        files = {member.name for member in members}
        metadata_members = [
            member
            for member in members
            if member.name.count("/") == 1 and member.name.endswith("/PKG-INFO")
        ]
        if len(metadata_members) != 1:
            raise AssertionError(
                f"sdist has invalid top-level PKG-INFO entries: "
                f"{[member.name for member in metadata_members]}"
            )
        metadata_file = archive.extractfile(metadata_members[0])
        if metadata_file is None:
            raise AssertionError("sdist PKG-INFO cannot be read")
        metadata = Parser().parsestr(metadata_file.read().decode())
        if metadata["Name"] != name or metadata["Version"] != version:
            raise AssertionError(
                f"sdist metadata is {metadata['Name']}@{metadata['Version']}, "
                f"expected {name}@{version}"
            )
    required_suffixes = {
        "/pyproject.toml",
        "/pylva/__init__.py",
        "/pylva/_version.py",
        "/pylva/core/control_client.py",
        "/pylva/core/control_ownership.py",
        "/pylva/core/control_schema.py",
        "/pylva/core/controlled_usage.py",
        "/pylva/adapters/__init__.py",
        "/pylva/adapters/tavily.py",
        "/pylva/errors/__init__.py",
        "/pylva/errors/strict_provider.py",
        "/pylva/langchain/__init__.py",
        "/pylva/langchain/callback.py",
        "/pylva/wrappers/__init__.py",
        "/pylva/wrappers/_controlled_provider.py",
        "/pylva/wrappers/_strict_context.py",
        "/pylva/wrappers/anthropic_controlled.py",
        "/pylva/wrappers/openai_controlled.py",
        "/pylva/py.typed",
        "/LICENSE",
    }
    missing = sorted(
        suffix
        for suffix in required_suffixes
        if not any(path.endswith(suffix) for path in files)
    )
    if missing:
        raise AssertionError(f"sdist is missing public runtime files: {missing}")
    assert_distribution_metadata(metadata, name, version, "sdist")


SMOKE_CODE = r"""
import asyncio
import importlib.metadata
import json
import os

import anthropic
import httpx
import openai
import pylva
from pylva.core import control_client, telemetry
from pylva.wrappers import _controlled_provider, anthropic_wrapper, openai_wrapper

expected = os.environ["PYLVA_EXPECTED_VERSION"]
assert importlib.metadata.version("pylva-sdk") == expected
assert pylva.__version__ == expected


def normalized_release(value):
    parts = [int(part) for part in value.split(".")]
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


if os.environ["PYLVA_PROVIDER_MATRIX"] == "floor":
    assert normalized_release(importlib.metadata.version("openai")) == normalized_release(
        os.environ["PYLVA_EXPECTED_OPENAI_FLOOR"]
    )
    assert normalized_release(importlib.metadata.version("anthropic")) == normalized_release(
        os.environ["PYLVA_EXPECTED_ANTHROPIC_FLOOR"]
    )
for name in (
    "ready",
    "ready_sync",
    "reserve_usage",
    "reserve_usage_sync",
    "commit_usage",
    "commit_usage_sync",
    "release_usage",
    "release_usage_sync",
    "extend_usage",
    "extend_usage_sync",
    "ControlledOperationOwnership",
    "controlled_operation_ownership",
    "current_controlled_operation",
    "should_suppress_legacy_telemetry",
    "controlled_usage",
    "controlled_usage_sync",
    "controlled_exact_usage",
    "controlled_exact_usage_sync",
    "controlled_tavily_search",
    "controlled_tavily_search_sync",
    "wrap_openai",
    "wrap_anthropic",
    "current_controlled_attempt",
):
    assert callable(getattr(pylva, name, None)), name
assert isinstance(pylva.PYLVA_CONTROL_UNAVAILABLE_CODE, str)
assert pylva.PYLVA_STRICT_PROVIDER_UNSUPPORTED_CODE == "strict_provider_unsupported"
assert issubclass(pylva.PylvaStrictProviderError, TypeError)

pylva.init(
    "pv_live_12345678_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    endpoint="http://127.0.0.1:1",
    local_mode=True,
    control={"mode": "legacy", "on_unavailable": "allow", "timeout_ms": 100},
)
is_ready = pylva.ready_sync()
assert type(is_ready) is bool
assert is_ready is False
assert pylva.current_controlled_operation() is None
assert pylva.should_suppress_legacy_telemetry(
    operation_id="11111111-1111-4111-8111-111111111111"
) is False
result = pylva.reserve_usage_sync(
    {
        "kind": "llm",
        "operation_id": "11111111-1111-4111-8111-111111111111",
        "customer_id": "package-smoke",
        "trace_id": "22222222-2222-4222-8222-222222222222",
        "span_id": "33333333-3333-4333-8333-333333333333",
        "parent_span_id": None,
        "step_name": "package.smoke",
        "provider": "openai",
        "model": "gpt-4.1",
        "estimated_input_tokens": 1,
        "max_output_tokens": 1,
    }
)
assert result.decision == "bypassed"
assert result.allowed is True
assert result.reason == "control_disabled"

controlled = pylva.controlled_exact_usage_sync(
    cost_source_slug="document-parser",
    tool_name="Document Parser",
    metric="page",
    value="1",
    invoke=lambda: "controlled-provider-value",
    customer_id="package-smoke",
)
assert controlled.value == "controlled-provider-value"
assert controlled.control.decision == "bypassed"
assert controlled.control.maximum_value == "1"
assert controlled.control.actual_value == "1"


class FakeTavily:
    def search(self, query, **options):
        assert query == "private package smoke query"
        assert options["search_depth"] == "basic"
        assert options["auto_parameters"] is False
        assert options["include_usage"] is True
        return {"usage": {"credits": 1}, "results": []}


tavily = pylva.controlled_tavily_search_sync(
    FakeTavily(),
    "private package smoke query",
    customer_id="package-smoke",
)
assert tavily.control.decision == "bypassed"
assert tavily.control.actual_value == "1"
assert openai_wrapper._patched is True
assert anthropic_wrapper._patched is True


class StructuralFake:
    provider_calls = 0

    def create(self, **_kwargs):
        self.provider_calls += 1
        raise AssertionError("a structural fake must never dispatch")


for wrapper in (pylva.wrap_openai, pylva.wrap_anthropic):
    fake = StructuralFake()
    try:
        wrapper(fake)
    except pylva.PylvaStrictProviderError as error:
        assert error.code == "strict_provider_unsupported"
        assert error.reason == "invalid_client"
    else:
        raise AssertionError("the public strict wrapper accepted a structural fake")
    assert fake.provider_calls == 0


OPENAI_MODEL = "gpt-package-smoke"
ANTHROPIC_MODEL = "claude-package-smoke"
provider_requests = []
provider_event_baseline = telemetry.buffer_size()
sync_control_calls = 0
async_control_calls = 0
strict_emitter_calls = 0
openai_legacy_emitter_calls = 0
anthropic_legacy_emitter_calls = 0
original_reserve_sync = control_client.reserve_usage_sync
original_reserve_async = control_client.reserve_usage
original_strict_enqueue = _controlled_provider.enqueue


def counted_reserve_sync(body):
    global sync_control_calls
    sync_control_calls += 1
    return original_reserve_sync(body)


async def counted_reserve_async(body):
    global async_control_calls
    async_control_calls += 1
    return await original_reserve_async(body)


def counted_strict_enqueue(event):
    global strict_emitter_calls
    strict_emitter_calls += 1
    return original_strict_enqueue(event)


def unexpected_openai_legacy_enqueue(_event):
    global openai_legacy_emitter_calls
    openai_legacy_emitter_calls += 1


def unexpected_anthropic_legacy_enqueue(_event):
    global anthropic_legacy_emitter_calls
    anthropic_legacy_emitter_calls += 1


control_client.reserve_usage_sync = counted_reserve_sync
control_client.reserve_usage = counted_reserve_async
_controlled_provider.enqueue = counted_strict_enqueue
openai_wrapper.enqueue = unexpected_openai_legacy_enqueue
anthropic_wrapper.enqueue = unexpected_anthropic_legacy_enqueue


def openai_response(request):
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-package-smoke",
            "object": "chat.completion",
            "created": 1,
            "model": OPENAI_MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 2,
                "completion_tokens": 3,
                "total_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
            "service_tier": "default",
        },
        request=request,
    )


def anthropic_response(request):
    return httpx.Response(
        200,
        json={
            "id": "msg_package_smoke",
            "type": "message",
            "role": "assistant",
            "model": ANTHROPIC_MODEL,
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": 2,
                "output_tokens": 3,
                "service_tier": "standard",
            },
        },
        headers={"request-id": "req_package_smoke"},
        request=request,
    )


def anthropic_stream_response(request):
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_package_smoke",
                    "type": "message",
                    "role": "assistant",
                    "model": ANTHROPIC_MODEL,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": 2,
                        "output_tokens": 0,
                        "service_tier": "standard",
                    },
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": "", "citations": None},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 3},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    body = "".join(
        f"event: {event_name}\ndata: {json.dumps(data)}\n\n"
        for event_name, data in events
    )
    return httpx.Response(
        200,
        text=body,
        headers={
            "content-type": "text/event-stream",
            "request-id": "req_package_smoke",
        },
        request=request,
    )


def provider_response(request):
    body = json.loads(request.content)
    assert request.url.scheme == "https"
    if request.url.path == "/v1/chat/completions":
        assert request.url.host == "api.openai.com"
        assert request.headers["authorization"] == "Bearer test"
    elif request.url.path == "/v1/messages":
        assert request.url.host == "api.anthropic.com"
        assert request.headers["x-api-key"] == "test"
    provider_requests.append((request.url.path, body))
    if request.url.path == "/v1/chat/completions":
        return openai_response(request)
    if request.url.path == "/v1/messages":
        return anthropic_stream_response(request) if body.get("stream") else anthropic_response(request)
    raise AssertionError(f"unexpected provider route: {request.url}")


def sync_handle_request(_transport, request):
    return provider_response(request)


async def async_handle_request(_transport, request):
    return provider_response(request)


# Keep the exact default transport classes while replacing only their terminal
# I/O in this hermetic installed-artifact smoke.
httpx.HTTPTransport.handle_request = sync_handle_request
httpx.AsyncHTTPTransport.handle_async_request = async_handle_request


openai_native = openai.OpenAI(api_key="test")
anthropic_native = anthropic.Anthropic(api_key="test")
controlled_openai = pylva.wrap_openai(openai_native)
controlled_anthropic = pylva.wrap_anthropic(anthropic_native)
for facade in (controlled_openai, controlled_anthropic):
    try:
        vars(facade)
    except TypeError:
        pass
    else:
        raise AssertionError("controlled facade exposes a writable __dict__")

openai_result = controlled_openai.chat.completions.create(
    model=OPENAI_MODEL,
    messages=[{"role": "user", "content": "local package smoke"}],
    max_completion_tokens=4,
)
assert openai_result.choices[0].message.content == "hello"

before_unbounded = len(provider_requests)
try:
    controlled_openai.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": "must not dispatch"}],
    )
except pylva.PylvaStrictProviderError as error:
    assert error.provider == "openai"
    assert error.reason == "usage_bound_required"
else:
    raise AssertionError("strict OpenAI wrapper accepted an unbounded request")
assert len(provider_requests) == before_unbounded

anthropic_result = controlled_anthropic.messages.create(
    model=ANTHROPIC_MODEL,
    messages=[{"role": "user", "content": "local package smoke"}],
    max_tokens=4,
)
assert anthropic_result.content[0].text == "hello"
with controlled_anthropic.messages.stream(
    model=ANTHROPIC_MODEL,
    messages=[{"role": "user", "content": "local package smoke"}],
    max_tokens=4,
) as stream:
    assert list(stream.text_stream) == ["hello"]
    assert stream.get_final_message().content[0].text == "hello"
controlled_openai.close()
controlled_anthropic.close()
openai_native.close()
anthropic_native.close()


async def async_provider_smoke():
    openai_async_native = openai.AsyncOpenAI(api_key="test")
    anthropic_async_native = anthropic.AsyncAnthropic(api_key="test")
    openai_async = pylva.wrap_openai(openai_async_native)
    anthropic_async = pylva.wrap_anthropic(anthropic_async_native)
    try:
        openai_async_result = await openai_async.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "user", "content": "local async package smoke"}],
            max_completion_tokens=4,
        )
        assert openai_async_result.choices[0].message.content == "hello"
        anthropic_async_result = await anthropic_async.messages.create(
            model=ANTHROPIC_MODEL,
            messages=[{"role": "user", "content": "local async package smoke"}],
            max_tokens=4,
        )
        assert anthropic_async_result.content[0].text == "hello"
        async with anthropic_async.messages.stream(
            model=ANTHROPIC_MODEL,
            messages=[{"role": "user", "content": "local async package smoke"}],
            max_tokens=4,
        ) as stream:
            assert [text async for text in stream.text_stream] == ["hello"]
            final_message = await stream.get_final_message()
            assert final_message.content[0].text == "hello"
    finally:
        await openai_async.close()
        await anthropic_async.close()
        await openai_async_native.close()
        await anthropic_async_native.close()


asyncio.run(async_provider_smoke())
assert len(provider_requests) == 6
assert sync_control_calls == 3
assert async_control_calls == 3
assert strict_emitter_calls == 6
assert openai_legacy_emitter_calls == 0
assert anthropic_legacy_emitter_calls == 0
assert telemetry.buffer_size() - provider_event_baseline == 6
assert {path for path, _body in provider_requests} == {
    "/v1/chat/completions",
    "/v1/messages",
}
print(
    "installed provider smoke passed: "
    f"{os.environ['PYLVA_PROVIDER_MATRIX']} "
    f"openai@{importlib.metadata.version('openai')} "
    f"anthropic@{importlib.metadata.version('anthropic')}"
)
"""


def python_in(venv_dir: pathlib.Path) -> pathlib.Path:
    folder = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    return venv_dir / folder / executable


def file_sha256(path: pathlib.Path) -> str:
    digest = sha256()
    with path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_sha256(value: str, label: str) -> str:
    normalized = value.strip().lower()
    if SHA256_PATTERN.fullmatch(normalized) is None:
        raise AssertionError(
            f"{label} SHA-256 must be exactly 64 hexadecimal characters"
        )
    return normalized


def artifact_proof(
    label: str, path: pathlib.Path, expected_sha256: str
) -> ArtifactProof:
    if not path.is_file():
        raise AssertionError(f"{label} artifact is not a regular file: {path}")
    if label == "wheel" and path.suffix != ".whl":
        raise AssertionError(f"wheel artifact does not end in .whl: {path.name}")
    if label == "sdist" and not path.name.endswith(".tar.gz"):
        raise AssertionError(f"sdist artifact does not end in .tar.gz: {path.name}")
    return ArtifactProof(
        label=label,
        path=path,
        sha256=normalized_sha256(expected_sha256, label),
    )


def assert_artifact_sha256(proof: ArtifactProof, phase: str) -> None:
    if not proof.path.is_file():
        raise AssertionError(
            f"{proof.label} artifact disappeared {phase}: {proof.path}"
        )
    actual = file_sha256(proof.path)
    if actual != proof.sha256:
        raise AssertionError(
            f"{proof.label} SHA-256 changed {phase}: expected {proof.sha256}, got {actual}"
        )
    print(f"verified {proof.label} sha256 {phase}: {actual}")


def assert_artifact_pair(
    proofs: tuple[ArtifactProof, ArtifactProof], phase: str
) -> None:
    failures: list[str] = []
    for proof in proofs:
        try:
            assert_artifact_sha256(proof, phase)
        except AssertionError as error:
            failures.append(str(error))
    if failures:
        raise AssertionError("; ".join(failures))


def run_verified_leg(
    proofs: tuple[ArtifactProof, ArtifactProof],
    label: str,
    action: Callable[[], None],
) -> None:
    assert_artifact_pair(proofs, f"before {label}")
    try:
        action()
    finally:
        # Verify even when installation or runtime smoke fails. A mutation is
        # a stronger release-boundary failure than the consumer error that
        # happened while the artifact was in use.
        assert_artifact_pair(proofs, f"after {label}")


def provider_matrix(project: dict[str, Any]) -> tuple[tuple[str, tuple[str, str]], ...]:
    optional = project.get("optional-dependencies")
    if not isinstance(optional, dict) or not isinstance(optional.get("dev"), list):
        raise AssertionError("pyproject.toml has no dev provider requirements")
    dev = optional["dev"]

    def requirement(name: str) -> str:
        matches = [
            item
            for item in dev
            if isinstance(item, str) and item.startswith(f"{name}>=")
        ]
        if len(matches) != 1:
            raise AssertionError(
                f"expected one {name} dev requirement, found {matches}"
            )
        return matches[0]

    def floor(specifier: str) -> str:
        match = re.fullmatch(
            r"([A-Za-z0-9_-]+)>=(\d+(?:\.\d+)*),<\d+(?:\.\d+)*",
            specifier,
        )
        if match is None:
            raise AssertionError(f"cannot derive provider floor from {specifier}")
        return f"{match.group(1)}=={match.group(2)}"

    current = (requirement("openai"), requirement("anthropic"))
    floors = (floor(current[0]), floor(current[1]))
    return (("floor", floors), ("current", current))


def smoke_artifact(
    artifact: pathlib.Path,
    version: str,
    root: pathlib.Path,
    matrix_name: str,
    provider_requirements: tuple[str, str],
) -> None:
    environment_dir = root / f"venv-{matrix_name}-{artifact.name.replace('.', '-')}"
    venv.EnvBuilder(with_pip=True, clear=True).create(environment_dir)
    python = python_in(environment_dir)
    try:
        run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                str(artifact),
                *provider_requirements,
            ],
            cwd=environment_dir,
        )
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        environment["PYLVA_EXPECTED_VERSION"] = version
        environment["PYLVA_PROVIDER_MATRIX"] = matrix_name
        environment["PYLVA_EXPECTED_OPENAI_FLOOR"] = provider_requirements[0].split(
            "=="
        )[-1]
        environment["PYLVA_EXPECTED_ANTHROPIC_FLOOR"] = provider_requirements[1].split(
            "=="
        )[-1]
        environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
        run([str(python), "-c", SMOKE_CODE], cwd=environment_dir, env=environment)
    finally:
        # Keep peak disk usage bounded while all four artifact/matrix legs run.
        shutil.rmtree(environment_dir, ignore_errors=True)


def discover_built_artifacts(
    dist: pathlib.Path, name: str, version: str
) -> tuple[pathlib.Path, pathlib.Path]:
    stem = normalized_dist_name(name)
    wheels = sorted(dist.glob(f"{stem}-{version}-*.whl"))
    sdists = sorted(dist.glob(f"{stem}-{version}.tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        raise AssertionError(
            f"expected one wheel and one sdist, found {sorted(dist.iterdir())}"
        )
    return wheels[0], sdists[0]


def verify_artifacts(
    *,
    project: dict[str, Any],
    proofs: tuple[ArtifactProof, ArtifactProof],
    smoke_root: pathlib.Path,
) -> None:
    name = project.get("name")
    version = project.get("version")
    if name != "pylva-sdk" or not isinstance(version, str):
        raise AssertionError(f"unexpected package metadata: {name}@{version}")
    wheel, sdist = proofs
    if wheel.path == sdist.path:
        raise AssertionError("wheel and sdist must be different artifacts")

    assert_artifact_pair(proofs, "before archive inspection")
    try:
        inspect_wheel(wheel.path, name, version)
        inspect_sdist(sdist.path, name, version)
    finally:
        assert_artifact_pair(proofs, "after archive inspection")

    for matrix_name, requirements in provider_matrix(project):
        for proof in proofs:
            leg = f"{proof.label}/{matrix_name} installed-artifact smoke"
            run_verified_leg(
                proofs,
                leg,
                lambda proof=proof, matrix_name=matrix_name, requirements=requirements: (
                    smoke_artifact(
                        proof.path,
                        version,
                        smoke_root,
                        matrix_name,
                        requirements,
                    )
                ),
            )
    assert_artifact_pair(proofs, "after all installed-artifact smoke legs")


def build_and_verify(package_dir: pathlib.Path, project: dict[str, Any]) -> None:
    name = project.get("name")
    version = project.get("version")
    if name != "pylva-sdk" or not isinstance(version, str):
        raise AssertionError(f"unexpected package metadata: {name}@{version}")

    with tempfile.TemporaryDirectory(prefix="pylva-python-package-smoke-") as temp:
        root = pathlib.Path(temp)
        dist = root / "dist"
        run(
            [sys.executable, "-m", "build", "--outdir", str(dist), str(package_dir)],
            cwd=REPO_ROOT,
        )
        wheel, sdist = discover_built_artifacts(dist, name, version)
        proofs = (
            artifact_proof("wheel", wheel, file_sha256(wheel)),
            artifact_proof("sdist", sdist, file_sha256(sdist)),
        )
        print(f"built wheel sha256: {proofs[0].sha256}")
        print(f"built sdist sha256: {proofs[1].sha256}")
        verify_artifacts(project=project, proofs=proofs, smoke_root=root)


def verify_existing(options: Options, project: dict[str, Any]) -> None:
    if (
        options.wheel is None
        or options.sdist is None
        or options.wheel_sha256 is None
        or options.sdist_sha256 is None
    ):
        raise AssertionError("verification options are incomplete")
    proofs = (
        artifact_proof("wheel", options.wheel, options.wheel_sha256),
        artifact_proof("sdist", options.sdist, options.sdist_sha256),
    )
    with tempfile.TemporaryDirectory(prefix="pylva-python-package-verify-") as temp:
        verify_artifacts(
            project=project,
            proofs=proofs,
            smoke_root=pathlib.Path(temp),
        )


def main(argv: list[str] | None = None) -> None:
    options = parse_options(sys.argv[1:] if argv is None else argv)
    project = load_project(options.package_dir)
    if options.verify_existing:
        verify_existing(options, project)
        mode = "verified existing immutable artifacts"
    else:
        build_and_verify(options.package_dir, project)
        mode = "built and verified artifacts"

    name = project.get("name")
    version = project.get("version")
    print(
        f"packed Python SDK smoke passed: {name}@{version} "
        f"({mode}; wheel + sdist; provider floor + current; sync + async)"
    )


if __name__ == "__main__":
    main()
