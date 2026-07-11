"""Auto-patch coordinator — runs on ``import pylva``. Every try_patch_* is
wrapped in try/except so a missing peer dep is a silent no-op (R1)."""

from __future__ import annotations

_patched_once = False


def apply_all_patches() -> None:
    """Call once on import and defensively from init() for Jupyter / importlib.reload."""
    global _patched_once
    from .anthropic_wrapper import try_patch_anthropic
    from .openai_wrapper import try_patch_openai

    try:
        try_patch_openai()
    except Exception as err:
        print(f"[pylva] openai auto-patch failed: {err}", flush=True)

    try:
        try_patch_anthropic()
    except Exception as err:
        print(f"[pylva] anthropic auto-patch failed: {err}", flush=True)

    _patched_once = True


def was_auto_patched() -> bool:
    return _patched_once
