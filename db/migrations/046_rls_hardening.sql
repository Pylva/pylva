-- 046: RLS hardening (prep for future FORCE ROW LEVEL SECURITY enforcement).
--
-- Context: the app currently connects as the table owner, which bypasses
-- non-forced RLS, so today tenant isolation is enforced by explicit builder_id
-- filters in application code (see withRLS in src/lib/db/rls.ts). This migration
-- does NOT enable FORCE — that is a deliberate follow-up that also introduces a
-- dedicated non-owner runtime role. What it does now:
--
--   1. Fix the users_self policy, which keyed on current_setting('app.user_id'),
--      a GUC no code path ever sets (withRLS only sets app.builder_id). Left as
--      is, users would be invisible to any future non-owner role. Rewrite it to
--      scope users to the members of the current builder.
--   2. Add WITH CHECK clauses (mirroring each USING predicate) to every tenant
--      policy that only had USING. Without WITH CHECK, a forced-RLS INSERT/UPDATE
--      would fall back to the USING predicate; making the write-side explicit now
--      means enabling FORCE later is a no-behavior-change flip.
--
-- These changes are inert while the app runs as owner; they take effect for the
-- NOBYPASSRLS role the isolation test suite uses, and for the future runtime role.

-- 1. users: replace the dead app.user_id predicate with membership scoping.
ALTER POLICY users_self ON users
  USING (
    id IN (
      SELECT user_id FROM user_builder_memberships
      WHERE builder_id = current_setting('app.builder_id', true)::uuid
    )
  );

-- 2a. builders keys on id (the row's own id is the builder id).
ALTER POLICY builders_isolation ON builders
  WITH CHECK (id = current_setting('app.builder_id', true)::uuid);

-- 2b. rule_alert_channels scopes through its parent rule.
ALTER POLICY rule_alert_channels_isolation ON rule_alert_channels
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rules r
       WHERE r.id = rule_id
         AND r.builder_id = current_setting('app.builder_id', true)::uuid
    )
  );

-- 2c. All standard builder_id-keyed tenant policies.
ALTER POLICY customers_isolation ON customers
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY api_keys_isolation ON api_keys
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY rules_isolation ON rules
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY webhook_configs_isolation ON webhook_configs
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY webhook_dlq_isolation ON webhook_dlq
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY audit_log_isolation ON audit_log
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY customer_pricing_isolation ON customer_pricing
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY invoices_isolation ON invoices
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY stripe_connect_isolation ON stripe_connect
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY portal_configs_isolation ON portal_configs
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY portal_links_isolation ON portal_links
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY api_key_vault_isolation ON api_key_vault
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY custom_pricing_isolation ON custom_pricing
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY pricing_onboarding_tasks_isolation ON pricing_onboarding_tasks
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY memberships_isolation ON user_builder_memberships
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY invites_isolation ON invites
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY alert_history_isolation ON alert_history
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY builder_feature_flags_isolation ON builder_feature_flags
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY invoice_idempotency_isolation ON invoice_idempotency
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY builder_alert_config_isolation ON builder_alert_config
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY cost_sources_isolation ON cost_sources
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY rule_events_isolation ON rule_events
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY anomaly_events_isolation ON anomaly_events
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY portal_access_grants_isolation ON portal_access_grants
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY portal_domains_isolation ON portal_domains
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY feature_flag_overrides_isolation ON feature_flag_overrides
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
ALTER POLICY portal_sessions_isolation ON portal_sessions
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
