-- Remove-Free rollout, contract phase.
-- migration-preflight: ok T8 This post-roll contraction runs only after 056/057 backfills, explicitly aborts unless zero Free rows remain, and requires all legacy Free writers to be drained before it is invoked.
--
-- Apply only after migration 056, the hosted companion migration 057 (when
-- present), new application code, and all old workers have been drained.
-- This migration is deliberately post-roll and refuses to infer or convert
-- stragglers.

-- Migration 054 moved general application tables behind a fixed NOLOGIN owner.
-- The migration principal has an explicit SET-only edge to that owner.
SET ROLE pylva_general_app_runtime;

DO $$
DECLARE
  free_count BIGINT;
  incomplete_count BIGINT;
BEGIN
  SELECT count(*) INTO free_count
  FROM builders
  WHERE tier = 'free';

  IF free_count > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Free-plan contract migration blocked: %s Free workspace(s) were written after expand',
        free_count
      ),
      HINT =
        'Drain legacy writers, resolve the reported rows outside this migration, and retry.';
  END IF;

  SELECT count(*) INTO incomplete_count
  FROM builders
  WHERE access_state IS NULL;

  IF incomplete_count > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'Free-plan contract migration blocked: %s workspace(s) have no access_state',
        incomplete_count
      ),
      HINT =
        'Complete the entitlement backfill and drain legacy writers before retrying.';
  END IF;
END
$$;

ALTER TABLE builders
  DROP CONSTRAINT IF EXISTS builders_tier_check,
  DROP CONSTRAINT IF EXISTS builders_no_new_free_during_expand_check;

ALTER TABLE builders
  ALTER COLUMN tier DROP DEFAULT,
  ALTER COLUMN access_state SET NOT NULL,
  ADD CONSTRAINT builders_plan_check
    CHECK (tier IS NULL OR tier IN ('pro', 'scale', 'enterprise')) NOT VALID,
  ADD CONSTRAINT builders_entitlement_combination_check
    CHECK ((
      (
        access_state = 'checkout_required'
        AND tier IS NULL
        AND entitlement_source IS NULL
      )
      OR
      (
        access_state = 'suspended'
        AND tier IS NULL
        AND (
          entitlement_source IS NULL
          OR entitlement_source IN ('stripe', 'admin')
        )
      )
      OR
      (
        access_state = 'active'
        AND tier IN ('pro', 'scale')
        AND entitlement_source IN ('stripe', 'admin')
      )
      OR
      (
        access_state = 'active'
        AND tier = 'enterprise'
        AND entitlement_source IN ('enterprise_contract', 'admin')
      )
      OR
      (
        access_state = 'active'
        AND tier IS NULL
        AND entitlement_source = 'self_hosted'
      )
    ) IS TRUE) NOT VALID;

ALTER TABLE builders
  VALIDATE CONSTRAINT builders_plan_check,
  VALIDATE CONSTRAINT builders_entitlement_combination_check;

RESET ROLE;
