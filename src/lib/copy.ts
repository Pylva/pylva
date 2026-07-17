// B2a — builder-facing copy deck (D20 vocab).
//
// Rule: UI-facing strings reference COPY.*, NOT hard-coded "Customer",
// "customer", etc. The SDK + code + API keep `customer_id` for back-compat;
// the dashboard renders them as "End-user(s)".
//
// Grep gate (§5.3 `copy-deck-consistency.test.ts`): any hard-coded "Customer"
// under src/app/o/** or src/components/dashboard/** (outside code-comment
// contexts) fails CI.
//
// Stripe-specific "Customer" stays as "Stripe Customer" on billing pages
// (B2b adds those); not modeled here to avoid premature coupling.

export const COPY = {
  // --- End-user ---
  end_user: 'End-user',
  end_user_plural: 'End-users',
  end_user_lower: 'end-user',
  end_user_lower_plural: 'end-users',

  // --- Dashboard nav ---
  nav_overview: 'Overview',
  nav_end_users: 'End-users',
  nav_models: 'Models',
  nav_traces: 'Traces',
  nav_budget_activity: 'Budget activity',
  nav_rules: 'Rules',
  nav_settings: 'Settings',
  nav_billing: 'Billing', // populated in B2b; sidebar link placeholder in T1
  nav_simulator: 'Simulator',
  nav_cost_sources: 'Cost Sources',

  // --- Simulator ---
  simulator_page_title: 'Cost Simulator',
  simulator_page_subtitle: 'Explore what-if scenarios to find savings.',
  simulator_save_recommendation: 'Save as recommendation',
  simulator_promote_tooltip: 'Available when model routing ships',

  // --- Cost Sources ---
  cost_sources_page_title: 'Cost Sources',
  cost_sources_page_subtitle: 'Approve, price, or ignore discovered non-LLM tools.',

  // --- Rules ---
  rules_page_title: 'Reactive rules',
  rules_page_subtitle: 'Catch cost spikes + enforce budgets before they happen.',
  rule_template_budget: "Cap an end-user's daily spend",
  rule_template_threshold: 'Alert on a cost spike',
  rule_template_margin: 'Protect my margin',
  rule_custom: 'Request a custom rule',
  rule_silent_warning: 'This rule will log fires but not notify anyone — are you sure?',

  // --- Alert channels ---
  channel_webhook: 'Webhook',
  channel_email: 'Email',
  channel_slack: 'Slack',
  channel_empty_warning:
    'No alert channels configured — this rule will fire silently. Add a channel to receive notifications.',
  channel_no_webhooks:
    'No webhooks configured yet. Add one in Settings → Webhooks before attaching it to a rule.',
  channel_disabled_rule_banner:
    'This rule is disabled — channels will not deliver until you toggle it back on.',
  channel_member_view_only: 'Read-only — only owners can add or remove alert channels.',
  rule_detail_back: '← All rules',

  // --- Demo data banner (D11) ---
  demo_banner_title: 'This is demo data',
  demo_banner_body: 'Install the SDK to replace it with your own events.',
  demo_banner_dismiss: 'Got it',

  // --- API keys (Track 1 PR 1.2; universal key since migration 048) ---
  api_keys_page_title: 'API keys',
  api_keys_page_subtitle:
    'One key connects everything — SDK telemetry, rules, data import, and the Admin API.',
  api_key_empty: 'No keys yet. Create an API key to connect your agent.',
  api_key_member_view_only: 'Read-only — only owners can mint or revoke API keys.',
  api_key_created_title: 'Save your API key',
  api_key_capability:
    'This one key connects everything. Your agent uses it to stream usage and costs through the SDK, read your rules and budgets, import data, and manage pricing — any AI agent holding it can operate your entire Pylva workspace for you. Treat it like a password: store it as PYLVA_API_KEY, and revoke it here if it ever leaks.',
  api_key_shown_once: "For security, you won't be able to see this key again after closing.",
  api_key_copy: 'Copy key',
  api_key_copied: 'Copied',
  api_key_copy_manual: 'Automatic copy is unavailable — select the key and press Ctrl/Cmd+C.',
  api_key_done: 'Done',
  api_key_copy_button: 'Copy key',
  api_key_copy_done: 'Copied',
  copy_failed: 'Copy failed — select the text and copy manually',
  agent_prompt_copy_button: 'Copy prompt for your AI agent',
  agent_prompt_copy_done: 'Prompt copied',
  agent_prompt_hint:
    'Using Claude Code, Cursor, or another coding agent? Copy a ready-made setup prompt that includes this key.',

  // --- Webhooks (Track 1 PR 1.3) ---
  webhooks_page_title: 'Webhooks',
  webhooks_page_subtitle: 'Configure delivery endpoints for rule fires and alerts.',
  webhook_empty: 'No webhooks yet. Add one to start receiving alerts.',
  webhook_member_view_only: 'Read-only — only owners can add, rotate, or delete webhooks.',
  webhook_rotate_confirm:
    'Rotate the signing secret? Old secret keeps working for 24 hours so receivers have time to switch.',
  webhook_grace_window:
    'The previous secret stays valid for 24 hours so your receivers can finish switching over.',

  // --- Cost sources (Track 2 PR 2.3) ---
  cost_source_future_events_only:
    'Pricing changes apply to new events only — historical costs stay as recorded (D9).',
  cost_source_member_view_only:
    'Read-only — only owners can change tracking, matchers, or pricing.',
  broken_sources_title:
    'One or more cost sources are broken — pricing or telemetry has stopped flowing.',

  // --- Portal admin (Track 4 PR 4.1) ---
  portal_page_title: 'Customer portal',
  portal_page_subtitle:
    'Configure branding, allowed iframe origins, and mint per-customer access links.',
  portal_palette_hint:
    '12-color preset palette. Locked enum so the portal renderer never accepts arbitrary CSS.',
  portal_iframe_hint:
    'Exact origin (scheme://host) only — no wildcards, no paths. Max 10. Used for CSP frame-ancestors.',
  portal_member_view_only: 'Read-only — only owners can edit portal config or mint / revoke links.',

  // --- Audit log (v2 follow-up to O13) ---
  audit_log_page_title: 'Audit log',
  audit_log_page_subtitle:
    'Every owner / billing / security mutation. Filter by action, resource, or date range.',
  audit_log_empty: 'No audit entries match these filters.',
  audit_log_member_blocked: 'Audit logs are owner-only. Ask a workspace owner if you need access.',

  // --- DLQ (Track 1 PR 1.4) ---
  dlq_page_title: 'Dead-letter queue',
  dlq_page_subtitle:
    'Alerts that failed delivery after all retries. Replay against the frozen channel snapshot or dismiss.',
  dlq_empty: 'No DLQ entries — every alert delivered successfully.',

  // --- Empty states ---
  empty_dashboard_title: 'No events yet',
  empty_dashboard_body: 'Install the SDK to see your cost data.',
} as const;

export type CopyKey = keyof typeof COPY;
