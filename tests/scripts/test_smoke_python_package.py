from __future__ import annotations

import importlib.util
import io
import pathlib
import sys
import tempfile
import unittest
from hashlib import sha256
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
HARNESS_PATH = REPO_ROOT / "scripts" / "ci" / "smoke-python-package.py"
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "publish-python-sdk.yml"


def load_harness():
    spec = importlib.util.spec_from_file_location(
        "pylva_smoke_python_package", HARNESS_PATH
    )
    if spec is None or spec.loader is None:
        raise AssertionError("cannot load Python package smoke harness")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def digest(payload: bytes) -> str:
    return sha256(payload).hexdigest()


class ImmutableArtifactHarnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.harness = load_harness()

    def test_verified_leg_hashes_both_artifacts_before_and_after(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            wheel = root / "candidate.whl"
            sdist = root / "candidate.tar.gz"
            wheel.write_bytes(b"wheel")
            sdist.write_bytes(b"sdist")
            proofs = (
                self.harness.artifact_proof("wheel", wheel, digest(b"wheel")),
                self.harness.artifact_proof("sdist", sdist, digest(b"sdist")),
            )

            self.harness.run_verified_leg(proofs, "stable", lambda: None)

            def mutate_wheel() -> None:
                wheel.write_bytes(b"changed")

            with self.assertRaisesRegex(
                AssertionError, "wheel SHA-256 changed after mutating"
            ):
                self.harness.run_verified_leg(proofs, "mutating", mutate_wheel)

    def test_wrong_initial_hash_prevents_the_leg_from_running(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            wheel = root / "candidate.whl"
            sdist = root / "candidate.tar.gz"
            wheel.write_bytes(b"wheel")
            sdist.write_bytes(b"sdist")
            proofs = (
                self.harness.artifact_proof("wheel", wheel, "0" * 64),
                self.harness.artifact_proof("sdist", sdist, digest(b"sdist")),
            )
            called = False

            def action() -> None:
                nonlocal called
                called = True

            with self.assertRaisesRegex(
                AssertionError, "wheel SHA-256 changed before rejected"
            ):
                self.harness.run_verified_leg(proofs, "rejected", action)
            self.assertFalse(called)

    def test_verify_existing_branch_never_invokes_build(self) -> None:
        options = self.harness.Options(
            package_dir=REPO_ROOT / "packages" / "sdk-py",
            wheel=pathlib.Path("candidate.whl"),
            sdist=pathlib.Path("candidate.tar.gz"),
            wheel_sha256="1" * 64,
            sdist_sha256="2" * 64,
        )
        project = {"name": "pylva-sdk", "version": "1.2.0"}
        with (
            mock.patch.object(self.harness, "parse_options", return_value=options),
            mock.patch.object(self.harness, "load_project", return_value=project),
            mock.patch.object(self.harness, "verify_existing") as verify_existing,
            mock.patch.object(
                self.harness,
                "build_and_verify",
                side_effect=AssertionError("verification mode rebuilt artifacts"),
            ) as build_and_verify,
        ):
            self.harness.main([])
        verify_existing.assert_called_once_with(options, project)
        build_and_verify.assert_not_called()

    def test_cli_requires_all_artifact_paths_and_hashes(self) -> None:
        with mock.patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                self.harness.parse_options(["--verify-existing"])
        self.assertEqual(raised.exception.code, 2)

    def test_publish_workflow_audits_the_only_build_before_publish(self) -> None:
        workflow = WORKFLOW_PATH.read_text()
        self.assertEqual(workflow.count("python -m build "), 1)
        self.assertIn("actions: read", workflow)
        self.assertIn("head_sha=${RELEASE_SHA}", workflow)
        self.assertIn("run.head_branch === 'main'", workflow)
        self.assertIn("run.conclusion === 'success'", workflow)
        self.assertIn("--verify-existing", workflow)
        self.assertIn(
            "--wheel-sha256 '${{ steps.artifacts.outputs.wheel_sha256 }}'", workflow
        )
        self.assertIn(
            "--sdist-sha256 '${{ steps.artifacts.outputs.sdist_sha256 }}'", workflow
        )
        self.assertIn("packages-dir: packages/sdk-py/dist", workflow)
        self.assertNotIn("types.ModuleType", workflow)
        self.assertNotIn("ls packages/sdk-py/dist", workflow)


if __name__ == "__main__":
    unittest.main()
