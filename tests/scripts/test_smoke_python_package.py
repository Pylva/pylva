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
ATTESTATION_PATH = REPO_ROOT / "scripts" / "ci" / "attest-release-sha.mjs"


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

    def test_packaged_readme_must_match_source_bytes_exactly(self) -> None:
        source = "# Pylva\n\nAuthoritative control.\n".encode()
        self.harness.assert_readme_bytes(source, source, "wheel METADATA")
        one_byte_mismatch = bytearray(source)
        one_byte_mismatch[-1] ^= 1
        with self.assertRaisesRegex(AssertionError, "README bytes do not match"):
            self.harness.assert_readme_bytes(
                bytes(one_byte_mismatch),
                source,
                "wheel METADATA",
            )

    def test_wheel_description_normalizes_metadata_line_endings(self) -> None:
        self.assertEqual(
            self.harness.normalized_metadata_description("# Pylva\r\n\r\nRelease.\r\n"),
            b"# Pylva\n\nRelease.\n",
        )

    def test_pep440_prerelease_classification_controls_pip_policy(self) -> None:
        for version in ("1.2.0a1", "1.2.0b2", "1.2.0rc3", "1.2.0.dev4"):
            self.assertTrue(self.harness.is_prerelease_version(version), version)
        for version in ("1.2.0", "1.2.0.post1", "1.2.0+build.7"):
            self.assertFalse(self.harness.is_prerelease_version(version), version)

    def test_verify_artifacts_clean_installs_both_formats_for_each_profile(
        self,
    ) -> None:
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
            profiles = (
                ("floor", ("openai==1.0.0", "anthropic==1.0.0")),
                ("current", ("openai>=1,<2", "anthropic>=1,<2")),
            )
            smoke_root = root / "smoke"

            with (
                mock.patch.object(self.harness, "inspect_wheel"),
                mock.patch.object(self.harness, "inspect_sdist"),
                mock.patch.object(self.harness, "assert_pip_prerelease_policy"),
                mock.patch.object(
                    self.harness, "provider_matrix", return_value=profiles
                ),
                mock.patch.object(self.harness, "smoke_artifact") as smoke_artifact,
            ):
                self.harness.verify_artifacts(
                    project={"name": "pylva-sdk", "version": "1.2.0"},
                    proofs=proofs,
                    smoke_root=smoke_root,
                    expected_readme=b"README",
                )

            self.assertEqual(
                smoke_artifact.call_args_list,
                [
                    mock.call(wheel, "1.2.0", smoke_root, *profiles[0]),
                    mock.call(sdist, "1.2.0", smoke_root, *profiles[0]),
                    mock.call(wheel, "1.2.0", smoke_root, *profiles[1]),
                    mock.call(sdist, "1.2.0", smoke_root, *profiles[1]),
                ],
            )

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
        attestation = ATTESTATION_PATH.read_text()
        self.assertEqual(workflow.count("python -m build "), 0)
        self.assertNotIn("pip install -e", workflow)
        self.assertNotIn("python -m pytest packages/sdk-py/tests", workflow)
        self.assertIn("actions: read", workflow)
        self.assertIn("node scripts/ci/attest-release-sha.mjs", workflow)
        self.assertIn("head_sha", attestation)
        self.assertIn("run?.head_branch === 'main'", attestation)
        self.assertIn("run?.conclusion === 'success'", attestation)
        self.assertIn("new Set(['push', 'workflow_dispatch'])", attestation)
        self.assertNotIn("'schedule'", attestation.split("RELEASE_WORKFLOW_GATES", 1)[0])
        self.assertIn("actions/download-artifact@v7", workflow)
        self.assertIn("name: pylva-python-sdk-immutable", workflow)
        self.assertIn(
            "run-id: ${{ steps.release_gates.outputs.authoritative_run_id }}", workflow
        )
        for required_workflow in (
            "authoritative-budget-control-ci.yml",
            "ci-fast.yml",
            "ci-integration.yml",
            "ci-e2e-smoke.yml",
        ):
            self.assertIn(required_workflow, attestation)
        self.assertIn("--verify-existing", workflow)
        self.assertIn('attestation["source_sha"] == os.environ["RELEASE_SHA"]', workflow)
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
