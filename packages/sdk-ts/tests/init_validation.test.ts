// Init-time failover validation (D52). Verifies that the SDK warns once
// at init when a reliability_failover rule names a backup provider whose
// wrapper isn't loaded in this process.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Provider, RuleStatus, RuleType } from '@pylva/shared';

import {
  _resetInitValidationForTests,
  markProviderPatched,
  validateFailoverWrappers,
} from '../src/wrappers/_init_validation.js';
import { failoverRule } from './helpers/failover_fixtures.js';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetInitValidationForTests();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('validateFailoverWrappers', () => {
  it('warns when the backup provider is neither auto-patched nor registered', () => {
    validateFailoverWrappers([failoverRule()]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('reliability_failover rule "r1"');
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'anthropic SDK is neither auto-patched nor passed',
    );
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'new Pylva({ providers: { "anthropic": client } })',
    );
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain('constructor alias');
  });

  it('does not warn when both wrappers are loaded', () => {
    markProviderPatched(Provider.OPENAI);
    markProviderPatched(Provider.ANTHROPIC);
    validateFailoverWrappers([failoverRule()]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once per (primary, backup) pair across multiple validation runs', () => {
    validateFailoverWrappers([failoverRule()]);
    validateFailoverWrappers([failoverRule()]);
    validateFailoverWrappers([failoverRule()]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns separately for distinct (primary, backup) pairs', () => {
    validateFailoverWrappers([
      failoverRule({ primary_provider: Provider.OPENAI, backup_provider: Provider.ANTHROPIC }),
      failoverRule({ primary_provider: Provider.ANTHROPIC, backup_provider: Provider.GOOGLE }),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('skips rules with enabled=false on the rule envelope', () => {
    validateFailoverWrappers([failoverRule({}, { enabled: false })]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips rules with cfg.enabled=false', () => {
    validateFailoverWrappers([failoverRule({ enabled: false })]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores non-failover rules', () => {
    validateFailoverWrappers([
      {
        id: 'r2',
        type: RuleType.MODEL_ROUTING,
        enabled: true,
        status: RuleStatus.ACTIVE,
        customer_id: null,
        updated_at: '2026-04-26T00:00:00Z',
        config: {
          scope: 'per_customer',
          match: {},
          route_to: { provider: Provider.OPENAI, model: 'gpt-4o-mini' },
          fallback: {
            on_cross_provider_auth_error: true,
            on_access_denied: true,
            on_model_not_found: true,
            use_original_model: true,
            skip_same_provider_401: true,
          },
        },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('handles empty rules array without warning', () => {
    validateFailoverWrappers([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
