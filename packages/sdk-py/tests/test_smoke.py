"""Phase 0 smoke test — confirms the package imports and exposes __version__."""

import pylva


def test_package_imports() -> None:
    assert pylva.__version__ == "1.1.0"
