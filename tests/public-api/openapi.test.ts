import { describe, expect, it } from 'vitest';
import { Provider } from '@pylva/shared';
import { buildOpenApiDocument } from '../../src/lib/public-api/openapi';
import { PYLVA_SLACK_SUPPORT_URL } from '../../src/lib/public-links';

const doc = buildOpenApiDocument();

describe('public api openapi document', () => {
  it('declares OpenAPI 3.1.0', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('documents exactly the five public SDK endpoints', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
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
    expect(Object.keys(doc.paths['/api/v1/whoami'])).toEqual(['get']);
  });

  it('marks whoami responses as non-cacheable and null-usage-aware', () => {
    const schema = doc.components.schemas.WhoamiResponse;
    expect(schema.properties.usage.type).toEqual(['object', 'null']);
    expect(schema.properties.limits.properties.monthly_events.type).toEqual([
      'integer',
      'null',
    ]);
    expect(
      doc.paths['/api/v1/whoami'].get.responses['200'].headers['Cache-Control'],
    ).toBeDefined();
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
