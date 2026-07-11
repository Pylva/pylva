"""SDK init-time validation (D52). After the rules cache is first
populated, scan reliability_failover rules and warn if a backup
provider is neither auto-patched nor registered via the Pylva constructor.
Cross-provider failover requires the backup to be reachable;
without it, the primary call proceeds and the wrapper emits a per-call
``failover_missing_backup`` warning. The init-time check surfaces the
same gap once at startup so builders see it before traffic.

Mirrors the TS ``packages/sdk-ts/src/wrappers/_init_validation.ts``.
"""

from __future__ import annotations

from typing import Any

from ..core.client_registry import has_registered_client
from ..core.rules_engine import RULE_TYPE_RELIABILITY_FAILOVER, narrow_rules

# Registry of provider ids whose wrappers successfully attached to a peer
# SDK in this process. Wrappers call `mark_provider_patched` once their
# `try_patch_*` finishes wiring the peer module.
_patched_providers: set[str] = set()


def mark_provider_patched(provider_id: str) -> None:
    _patched_providers.add(provider_id)


# A builder using `Pylva(..., providers={...})` has the backup client available
# in the registry even if the backup wrapper module wasn't imported in user
# code. The registry counts as "backup is reachable" for warning purposes; the
# runtime engine likewise consults the registry before emitting
# failover_missing_backup.
def _is_backup_reachable(provider: str) -> bool:
    return provider in _patched_providers or has_registered_client(provider)


_warned_pairs: set[str] = set()
_validated_once = False


async def refresh_and_validate_once() -> None:
    """Refresh the rules cache and run the D52 failover-wrapper validation.
    Validation runs at most once per process; subsequent calls only refresh
    the cache. Idempotent under R1 — any exception in the chain is swallowed
    so the wrapper hot path never sees a propagated error."""
    global _validated_once
    from ..core.rules_cache import ensure_rules_cache, get_cached_rules

    try:
        await ensure_rules_cache()
        if not _validated_once:
            validate_failover_wrappers(get_cached_rules())
            _validated_once = True
    except Exception:
        pass  # R1


def validate_failover_wrappers(raw_rules: list[Any]) -> None:
    try:
        rules = narrow_rules(raw_rules)
    except Exception as err:
        # R1 — diagnostic warnings should still surface, but a malformed
        # cache shouldn't crash init. Include the error type so operators
        # can pin down whether it's schema drift, encoding issues, etc.
        print(
            f"[pylva] failover validation skipped: malformed cache "
            f"({type(err).__name__})",
            flush=True,
        )
        return

    for rule in rules:
        if rule.type != RULE_TYPE_RELIABILITY_FAILOVER:
            continue
        cfg = rule.config
        if not cfg.get("enabled"):
            continue

        primary = cfg.get("primary_provider")
        backup = cfg.get("backup_provider")
        if not primary or not backup:
            continue

        pair_key = f"{primary}|{backup}"
        if pair_key in _warned_pairs:
            continue
        if _is_backup_reachable(backup):
            continue

        _warned_pairs.add(pair_key)
        print(
            f'[pylva] reliability_failover rule "{rule.id}" routes '
            f"{primary} → {backup}, but the {backup} SDK is neither "
            f"auto-patched nor passed to the Pylva constructor. "
            f"Either import the {backup} SDK or pass an instantiated "
            f"client via `Pylva(..., providers={{\"{backup}\": client}})` "
            f"so failover can route there; otherwise calls continue on the primary and "
            f"the wrapper logs failover_missing_backup per call.",
            flush=True,
        )


def _reset_init_validation_for_tests() -> None:
    global _validated_once
    _patched_providers.clear()
    _warned_pairs.clear()
    _validated_once = False
