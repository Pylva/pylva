import { describe, expect, it } from 'vitest';
import { Provider } from '@pylva/shared';
import { buildOpenApiDocument } from '../../src/lib/public-api/openapi';
import { PYLVA_SLACK_SUPPORT_URL } from '../../src/lib/public-links';

const doc = buildOpenApiDocument();

describe('public api openapi document', () => {
  it('declares OpenAPI 3.1.0', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('documents exactly the ten public SDK endpoints', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/v1/budget/capabilities',
      '/api/v1/budget/reservations',
      '/api/v1/budget/reservations/{id}/commit',
      '/api/v1/budget/reservations/{id}/extend',
      '/api/v1/budget/reservations/{id}/release',
      '/api/v1/budget/sync',
      '/api/v1/events',
      '/api/v1/pricing',
      '/api/v1/rules',
      '/api/v1/whoami',
    ]);
    expect(Object.keys(doc.paths['/api/v1/events'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/rules'])).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/v1/pricing'])).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/v1/budget/sync'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/budget/capabilities'])).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/v1/budget/reservations'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/budget/reservations/{id}/commit'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/budget/reservations/{id}/release'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/budget/reservations/{id}/extend'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/api/v1/whoami'])).toEqual(['get']);
  });

  it('documents the authoritative control status taxonomy and no-store success state', () => {
    const capabilities = doc.paths['/api/v1/budget/capabilities'].get;
    const reserve = doc.paths['/api/v1/budget/reservations'].post;
    const commit = doc.paths['/api/v1/budget/reservations/{id}/commit'].post;
    const release = doc.paths['/api/v1/budget/reservations/{id}/release'].post;
    const extend = doc.paths['/api/v1/budget/reservations/{id}/extend'].post;

    expect(Object.keys(capabilities.responses).sort()).toEqual([
      '200',
      '401',
      '403',
      '429',
      '500',
      '503',
    ]);
    expect(Object.keys(reserve.responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '409',
      '429',
      '500',
      '503',
    ]);
    for (const operation of [commit, release, extend]) {
      expect(Object.keys(operation.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '409',
        '429',
        '500',
        '503',
      ]);
      expect(operation.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    }
    expect(capabilities.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(reserve.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(
      doc.components.responses.BudgetControlUnavailable.headers['Cache-Control'],
    ).toBeDefined();
    expect(doc.components.responses.BudgetControlUnavailable.description).toContain(
      'never reflected',
    );

    const controlOperations = [capabilities, reserve, commit, release, extend];
    const componentResponses = doc.components.responses as unknown as Record<
      string,
      { headers?: Record<string, unknown> }
    >;
    for (const operation of controlOperations) {
      for (const response of Object.values(operation.responses) as Array<{
        $ref?: string;
        headers?: Record<string, unknown>;
      }>) {
        const documented = response.$ref
          ? componentResponses[response.$ref.split('/').at(-1)!]
          : response;
        if (!documented) throw new Error(`Missing OpenAPI response component: ${response.$ref}`);
        expect(documented.headers?.['Cache-Control']).toBeDefined();
      }
    }

    for (const operation of [commit, release, extend]) {
      expect(operation.responses['409'].$ref).toBe(
        '#/components/responses/BudgetLifecycleConflict',
      );
    }
    expect(doc.components.responses.BudgetLifecycleConflict.description).toContain(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(doc.components.responses.BudgetLifecycleConflict.description).toContain(
      'RESERVATION_STATE_CONFLICT',
    );
  });

  it('documents the isolated control rate limit and bounded strict JSON bodies', () => {
    const rateLimit = doc.components.responses.BudgetControlRateLimited;
    expect(rateLimit.description).toContain('600 requests per minute');
    expect(rateLimit.headers['Retry-After'].schema.const).toBe(60);
    expect(rateLimit.headers['Cache-Control'].schema.const).toBe('no-store');

    for (const path of [
      '/api/v1/budget/reservations',
      '/api/v1/budget/reservations/{id}/commit',
      '/api/v1/budget/reservations/{id}/release',
      '/api/v1/budget/reservations/{id}/extend',
    ] as const) {
      expect(doc.paths[path].post.requestBody.description).toContain('16 KiB');
      expect(doc.paths[path].post.requestBody.description).toContain('Unknown properties');
    }
    expect(doc.components.schemas.LlmReserveUsageRequest.additionalProperties).toBe(false);
    expect(doc.components.schemas.ToolReserveUsageRequest.additionalProperties).toBe(false);
    expect(doc.components.schemas.LlmCommitUsageRequest.additionalProperties).toBe(false);
    expect(doc.components.schemas.ToolCommitUsageRequest.additionalProperties).toBe(false);
  });

  it('matches honest shadow-unavailability and post-provider decimal contracts', () => {
    type BypassVariant = {
      properties: {
        reason: { const: string };
        decision_id: { oneOf?: unknown };
        warnings: { maxItems?: number };
      };
    };
    const variants = doc.components.schemas.BypassedUsageResponse
      .oneOf as unknown as BypassVariant[];
    const byReason = (reason: string) =>
      variants.find((variant) => variant.properties.reason.const === reason);

    expect(byReason('control_disabled')?.properties.warnings.maxItems).toBe(0);
    expect(byReason('no_applicable_budget')?.properties.warnings.maxItems).toBe(0);
    const shadowUnavailable = byReason('shadow_control_unavailable');
    expect(shadowUnavailable?.properties.decision_id.oneOf).toEqual([
      expect.objectContaining({ format: 'uuid' }),
      { type: 'null' },
    ]);
    expect(shadowUnavailable?.properties.warnings.maxItems).toBe(0);
    expect(doc.components.schemas.CommitUsageResponse.properties.actual_usd.pattern).toBe(
      '^(?:0|[1-9][0-9]{0,25})(?:\\.[0-9]{1,18})?$',
    );
    expect(doc.components.schemas.CommitUsageResponse.properties.overage_usd.pattern).toBe(
      doc.components.schemas.CommitUsageResponse.properties.actual_usd.pattern,
    );
  });

  it("documents the budget contract's open provider/model identifiers", () => {
    const llmRequest = doc.components.schemas.LlmReserveUsageRequest;
    expect(llmRequest.properties.provider).toEqual({
      $ref: '#/components/schemas/BudgetProviderModelIdentifier',
    });
    expect(llmRequest.properties.model).toEqual({
      $ref: '#/components/schemas/BudgetProviderModelIdentifier',
    });

    const identifier = doc.components.schemas.BudgetProviderModelIdentifier;
    expect(identifier.maxLength).toBe(255);
    const pattern = new RegExp(identifier.pattern, 'u');
    expect(pattern.test('new-provider/model βeta')).toBe(true);
    expect(pattern.test('   ')).toBe(false);
    expect(pattern.test('provider\u0000secret')).toBe(false);
    expect(doc.components.schemas.ToolReserveUsageRequest.properties.metric.pattern).toBe(
      identifier.pattern,
    );
  });

  it('marks whoami responses as non-cacheable and null-usage-aware', () => {
    const schema = doc.components.schemas.WhoamiResponse;
    expect(schema.properties.usage.type).toEqual(['object', 'null']);
    expect(schema.properties.limits.properties.monthly_events.type).toEqual(['integer', 'null']);
    expect(doc.paths['/api/v1/whoami'].get.responses['200'].headers['Cache-Control']).toBeDefined();
  });

  it('authenticates via the X-Pylva-Key header scheme', () => {
    const scheme = doc.components.securitySchemes.ApiKeyAuth;
    expect(scheme.type).toBe('apiKey');
    expect(scheme.in).toBe('header');
    expect(scheme.name).toBe('X-Pylva-Key');
  });

  it('keeps servers fixed to the cloud origin and docs on the external site', () => {
    expect(doc.servers[0]?.url).toBe('https://api.pylva.com');
    expect(doc.externalDocs.url).toBe('https://docs.pylva.com');
  });

  it('points public API support contact to Slack', () => {
    expect(doc.info.contact.url).toBe(PYLVA_SLACK_SUPPORT_URL);
  });

  it('transcribes the batch and entry limits from the wire schemas', () => {
    const events = doc.components.schemas.IngestRequest.properties.events;
    expect(events.minItems).toBe(1);
    expect(events.maxItems).toBe(100);
    expect(doc.components.schemas.BudgetSyncRequest.properties.entries.maxItems).toBe(500);
    expect(doc.components.schemas.RulesResponse.properties.ttl_seconds.const).toBe(60);
  });

  it('matches the provider enum exported by @pylva/shared', () => {
    expect(doc.components.schemas.Provider.enum).toEqual(Object.values(Provider));
  });

  it('does not expose removed customer_throttle rules', () => {
    expect(doc.components.schemas.Rule.properties.type.enum).not.toContain('customer_throttle');
  });

  it('transcribes the field length constraints', () => {
    const event = doc.components.schemas.TelemetryEvent.properties;
    expect(event.customer_id.maxLength).toBe(255);
    expect(event.step_name.maxLength).toBe(200);
    expect(event.model.maxLength).toBe(100);
  });

  it('pins the charset patterns alongside the length caps', () => {
    const event = doc.components.schemas.TelemetryEvent.properties;
    expect(event.customer_id.pattern).toBe('^[a-zA-Z0-9_\\-]+$');
    expect(event.step_name.pattern).toBe('^[a-zA-Z0-9 _\\-.:/]*$');
    expect(event.model.pattern).toBe('^[a-zA-Z0-9\\-./]*$');
  });

  it('documents the scope-mismatch response on every path', () => {
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        expect(op.responses['403']).toBeDefined();
      }
    }
    expect(doc.components.responses.Forbidden).toBeDefined();
  });

  it('never references private or non-existent auth surfaces', () => {
    const serialized = JSON.stringify(doc).toLowerCase();
    for (const banned of ['oauth', '/o/', 'portal']) {
      expect(serialized).not.toContain(banned);
    }
  });
});
