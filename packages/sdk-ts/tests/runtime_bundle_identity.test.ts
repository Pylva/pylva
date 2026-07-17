import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;
const KEY_C = `pv_live_ccddeeff_${'c'.repeat(32)}`;
const KEY_D = `pv_live_ddeeffaa_${'d'.repeat(32)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_bundle_identity' },
  });
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

async function requestBody(input: string | URL | Request, request?: RequestInit): Promise<string> {
  if (input instanceof Request) return input.clone().text();
  return request?.body == null ? '' : String(request.body);
}

async function waitForRootAutoPatch(client: {
  chat: { completions: { create: Function } };
  messages?: { create: Function };
}): Promise<void> {
  await vi.waitFor(() => {
    expect(
      (client.chat.completions.create as unknown as { __pylva_patched?: boolean }).__pylva_patched,
    ).toBe(true);
  });
}

describe('runtime identity primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves patched-original ownership across identity reset', async () => {
    vi.resetModules();
    const registry = await import('../src/wrappers/_strict_unwrap.js');
    const identity = await import('../src/core/identity.js');
    const config = await import('../src/core/config.js');
    config._resetConfigForTests();

    const original = function original(value: string): string {
      return value;
    };
    const patched = function patched(value: string): string {
      return original(value);
    };
    Object.defineProperty(patched, '__pylva_patched', { value: true });
    registry.registerPatchedOriginal(patched, original);
    identity.installSdkConfig({ apiKey: KEY_A, endpoint: 'https://identity-a.test' });
    identity.installSdkConfig({ apiKey: KEY_B, endpoint: 'https://identity-b.test' });

    expect(registry.originalProviderMethod(patched)).toBe(original);
    expect(registry.originalProviderMethod(original)).toBe(original);

    const opaque = Object.defineProperty(function opaque() {}, '__pylva_patched', {
      value: true,
    });
    expect(registry.originalProviderMethod(opaque)).toBeNull();
    config._resetConfigForTests();
  });

  it('canonicalizes every public control constructor without losing class ergonomics', async () => {
    vi.resetModules();
    const budgetModule = await import('../src/errors/budget_exceeded.js');
    const controlModule = await import('../src/errors/control.js');
    const strictModule = await import('../src/errors/strict_provider.js');
    const publicErrors = await import('../src/internal/public-errors.js');

    expect(publicErrors.PylvaBudgetExceeded).toBe(budgetModule.PylvaBudgetExceeded);
    expect(publicErrors.PylvaControlUnavailableError).toBe(
      controlModule.PylvaControlUnavailableError,
    );
    expect(publicErrors.PylvaControlApiError).toBe(controlModule.PylvaControlApiError);
    expect(publicErrors.PylvaControlValidationError).toBe(
      controlModule.PylvaControlValidationError,
    );
    expect(publicErrors.PylvaStrictProviderError).toBe(strictModule.PylvaStrictProviderError);

    const budget = new publicErrors.PylvaBudgetExceeded({
      source: publicErrors.BudgetExceededSource.AUTHORITATIVE_CONTROL,
      rule_id: 'rule-bundle',
      customer_id: 'customer-bundle',
      period: 'day',
      period_start: '2026-07-14T00:00:00.000Z',
      limit_usd: 1,
      accumulated_usd: 1,
      estimated_usd: 0.25,
    });
    const unavailable = new publicErrors.PylvaControlUnavailableError({
      reason: publicErrors.PylvaControlUnavailableReason.NETWORK_ERROR,
      retryable: true,
      operation: 'reserveUsage',
      operationId: '11111111-1111-4111-8111-111111111111',
    });
    const api = new publicErrors.PylvaControlApiError(409, 'operation_conflict', 'operation_id');
    const validation = new publicErrors.PylvaControlValidationError('reserveUsage');
    const strict = new publicErrors.PylvaStrictProviderError(
      'anthropic',
      'unknown_legacy_patch_cannot_be_bypassed',
    );

    for (const [value, constructor, name] of [
      [budget, budgetModule.PylvaBudgetExceeded, 'PylvaBudgetExceeded'],
      [unavailable, controlModule.PylvaControlUnavailableError, 'PylvaControlUnavailableError'],
      [api, controlModule.PylvaControlApiError, 'PylvaControlApiError'],
      [validation, controlModule.PylvaControlValidationError, 'PylvaControlValidationError'],
      [strict, strictModule.PylvaStrictProviderError, 'PylvaStrictProviderError'],
    ] as const) {
      expect(value).toBeInstanceOf(constructor);
      expect(Object.getPrototypeOf(value)).toBe(constructor.prototype);
      expect(constructor.name).toBe(name);
      expect(value.name).toBe(name);
    }
    expect(budget).toMatchObject({ code: 'budget_exceeded', rule_id: 'rule-bundle' });
    expect(unavailable).toMatchObject({
      code: 'control_unavailable',
      reason: 'network_error',
      retryable: true,
    });
    expect(api).toMatchObject({ status: 409, code: 'operation_conflict', param: 'operation_id' });
    expect(validation).toMatchObject({ operation: 'reserveUsage' });
    expect(strict).toMatchObject({
      code: 'strict_provider_unsupported',
      provider: 'anthropic',
    });
    expect(validation).toBeInstanceOf(TypeError);
    expect(strict).toBeInstanceOf(TypeError);
  });

  it('lets strict provider subpaths execute root-patched official SDKs after reinit and exposes root catch identities', async () => {
    vi.resetModules();
    const [{ default: OpenAI }, { default: Anthropic }] = await Promise.all([
      import('openai'),
      import('@anthropic-ai/sdk'),
    ]);
    const root = await import('../src/index.js');
    const openaiPatchProbe = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    const anthropicPatchProbe = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });

    await waitForRootAutoPatch(openaiPatchProbe);
    await vi.waitFor(() => {
      expect(
        (anthropicPatchProbe.messages.create as unknown as { __pylva_patched?: boolean })
          .__pylva_patched,
      ).toBe(true);
    });
    root.init({ apiKey: KEY_A, endpoint: 'https://identity-a.test', localMode: true });

    // Installed root/deep/mixed ESM+CJS identity is covered by the packed
    // artifact smoke. Source tests keep one graph and validate behavior.
    const [openaiSubpath, anthropicSubpath] = await Promise.all([
      import('../src/wrappers/openai.js'),
      import('../src/wrappers/anthropic.js'),
    ]);

    let mode: 'success' | 'denied' | 'unavailable' = 'success';
    let providerCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
      const url = href(input);
      if (url.endsWith('/api/v1/pricing')) return json({ models: [] });
      if (url.endsWith('/api/v1/rules')) return json({ rules: [] });
      if (url.endsWith('/api/v1/budget/capabilities')) {
        if (mode === 'unavailable') throw new Error('control is offline');
        return json({
          schema_version: '1.0',
          control_enabled: true,
          min_reservation_ttl_seconds: 30,
          default_reservation_ttl_seconds: 300,
          max_reservation_ttl_seconds: 3600,
          server_time: '2026-07-14T09:00:00.000Z',
        });
      }
      if (url.endsWith('/api/v1/budget/reservations')) {
        if (mode !== 'denied') throw new Error(`unexpected reserve in ${mode} mode`);
        const reservationInput = JSON.parse(await requestBody(input, request)) as {
          operation_id: string;
        };
        return json({
          schema_version: '1.0',
          decision: 'denied',
          allowed: false,
          decision_id: '55555555-5555-4555-8555-555555555555',
          operation_id: reservationInput.operation_id,
          state: 'refused',
          deciding_rule: {
            rule_id: '66666666-6666-4666-8666-666666666666',
            scope: 'pooled',
            customer_id: null,
            period: 'day',
            period_start: '2026-07-14T00:00:00.000Z',
            period_end: '2026-07-15T00:00:00.000Z',
          },
          committed_usd: '1',
          reserved_usd: '0',
          unresolved_usd: '0',
          requested_usd: '0.1',
          limit_usd: '1',
          remaining_usd: '0',
          warnings: [],
        });
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        providerCalls += 1;
        return json({
          id: 'chatcmpl_bundle',
          object: 'chat.completion',
          created: 1_784_009_600,
          model: 'gpt-4o-mini',
          service_tier: 'default',
          choices: [],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        });
      }
      if (url === 'https://api.anthropic.com/v1/messages') {
        providerCalls += 1;
        return json({
          id: 'msg_bundle',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'bundle identity' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: null,
            service_tier: 'standard',
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // This identity switch invokes every bundle's resetters. It must not
    // discard the process-wide root-patch ownership registry.
    root.init({ apiKey: KEY_B, endpoint: 'https://identity-b.test', localMode: true });
    // Construct after installing the fetch spy because the official clients
    // capture their transport at construction time.
    const openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    const anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
    const strictOpenAI = await openaiSubpath.wrapOpenAI(openai);
    const strictAnthropic = await anthropicSubpath.wrapAnthropic(anthropic);

    await expect(
      strictOpenAI.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'private bundle prompt' }],
        max_completion_tokens: 2,
      }),
    ).resolves.toMatchObject({ model: 'gpt-4o-mini' });
    await expect(
      strictAnthropic.messages.create({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'private bundle prompt' }],
        max_tokens: 2,
      }),
    ).resolves.toMatchObject({ model: 'claude-sonnet-4-5' });
    expect(providerCalls).toBe(2);

    let strictError: unknown;
    try {
      await openaiSubpath.wrapOpenAI({});
    } catch (error) {
      strictError = error;
    }
    expect(strictError).toBeInstanceOf(root.PylvaStrictProviderError);
    expect(strictError).toMatchObject({
      name: 'PylvaStrictProviderError',
      code: 'strict_provider_unsupported',
      provider: 'openai',
    });

    mode = 'denied';
    root.init({
      apiKey: KEY_C,
      endpoint: 'https://identity-c.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    let denial: unknown;
    try {
      await strictOpenAI.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'private denied prompt' }],
        max_completion_tokens: 2,
      });
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(root.PylvaBudgetExceeded);
    expect(denial).toMatchObject({
      name: 'PylvaBudgetExceeded',
      code: 'budget_exceeded',
      source: 'authoritative_control',
      rule_id: '66666666-6666-4666-8666-666666666666',
    });
    expect(providerCalls).toBe(2);

    mode = 'unavailable';
    root.init({
      apiKey: KEY_D,
      endpoint: 'https://identity-d.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    let unavailable: unknown;
    try {
      await strictAnthropic.messages.create({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'private unavailable prompt' }],
        max_tokens: 2,
      });
    } catch (error) {
      unavailable = error;
    }
    expect(unavailable).toBeInstanceOf(root.PylvaControlUnavailableError);
    expect(unavailable).toMatchObject({
      name: 'PylvaControlUnavailableError',
      code: 'control_unavailable',
      reason: 'network_error',
      operation: 'reserveUsage',
    });
    expect(providerCalls).toBe(2);
  });
});
