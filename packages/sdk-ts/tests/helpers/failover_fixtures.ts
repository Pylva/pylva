// Shared test fixtures for reliability_failover rules. Used by
// init_validation, wrappers_engine, and any future failover-related
// test that needs a default-shaped rule. Centralizing here keeps the
// 9 cfg fields from drifting across files.

import { Provider, RuleStatus, RuleType, type ReliabilityFailoverConfig } from '@pylva/shared';

export const FAILOVER_CFG_BASE: ReliabilityFailoverConfig = {
  enabled: true,
  customer_id: 'cust_1',
  primary_provider: Provider.OPENAI,
  backup_provider: Provider.ANTHROPIC,
  trigger_error_rate_pct: 10,
  recover_error_rate_pct: 2,
  window_seconds: 60,
  recover_after_seconds: 60,
  recovery_probe_after_seconds: 1800,
  consent_to_cost_shift: true,
};

export interface FailoverRuleEnvelope {
  id?: string;
  enabled?: boolean;
  status?: typeof RuleStatus.ACTIVE | typeof RuleStatus.DRAFT;
  customer_id?: string | null;
  updated_at?: string;
}

export function failoverRule(
  cfgOverrides: Partial<ReliabilityFailoverConfig> = {},
  envelope: FailoverRuleEnvelope = {},
): unknown {
  return {
    id: envelope.id ?? 'r1',
    type: RuleType.RELIABILITY_FAILOVER,
    enabled: envelope.enabled ?? true,
    status: envelope.status ?? RuleStatus.ACTIVE,
    customer_id: envelope.customer_id ?? 'cust_1',
    updated_at: envelope.updated_at ?? '2026-04-26T00:00:00Z',
    config: { ...FAILOVER_CFG_BASE, ...cfgOverrides },
  };
}
