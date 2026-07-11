import '../helpers/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_EVENTS,
  ALLOWED_PROPERTY_KEYS,
  InvalidEventError,
  __resetCaptureImpl,
  __setCaptureImpl,
  sanitizeProperties,
  track,
} from '../../src/lib/analytics/events';

type CapturedCall = {
  event: string;
  properties: Record<string, unknown>;
  api_key: string;
};

describe('analytics events allowlist', () => {
  afterEach(() => __resetCaptureImpl());

  it('rejects events not in the allowlist', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    (process.env as Record<string, string>).NODE_ENV = 'development';

    await expect(
      // @ts-expect-error — testing runtime guard with bad name
      track('unknown_event', {}),
    ).rejects.toBeInstanceOf(InvalidEventError);
  });

  it('declares a stable, non-empty allowlist', () => {
    expect(ALLOWED_EVENTS.length).toBeGreaterThan(10);
    expect(ALLOWED_EVENTS).toContain('page_viewed');
    expect(ALLOWED_EVENTS).not.toContain('checkout_started');
    expect(ALLOWED_EVENTS).not.toContain('subscription_portal_opened');
    expect(ALLOWED_EVENTS).toContain('api_key_created');
    expect(ALLOWED_EVENTS).toContain('api_key_copied');
    expect(ALLOWED_EVENTS).toContain('agent_prompt_copied');
  });
});

describe('sanitizeProperties', () => {
  it('drops pylva-key-shaped values even on allowed keys', () => {
    const out = sanitizeProperties({
      plan: 'pv_live_deadbeef_feedfacefeedfacefeedfacefeedface',
      surface: 'onboarding',
    });
    expect(out).toEqual({ surface: 'onboarding' });
  });

  it('drops sensitive property keys and stripe-shaped values', () => {
    const out = sanitizeProperties({
      // forbidden keys
      api_key: 'sk_secret',
      apiKey: 'sk_secret',
      authorization: 'Bearer x',
      password: 'hunter2',
      email: 'a@b.com',
      customer_id: 'cus_123',
      builder_id: 'bld_x',
      stripe_invoice: 'in_123',
      portal_token: 'pt_x',
      // allowed but with stripe-shaped string value
      plan: 'price_abc123',
      // allowed
      surface: 'marketing',
      cta_id: 'hero_start_free',
      tier: 'free',
    });
    expect(out).toEqual({
      surface: 'marketing',
      cta_id: 'hero_start_free',
      tier: 'free',
    });
  });

  it('only retains keys on the property allowlist', () => {
    const out = sanitizeProperties({
      surface: 'app',
      arbitrary_field: 'anything',
      another: 123,
    });
    expect(out).toEqual({ surface: 'app' });
    expect(ALLOWED_PROPERTY_KEYS.has('arbitrary_field')).toBe(false);
  });
});

describe('track() runtime guard', () => {
  let calls: CapturedCall[];

  beforeEach(() => {
    calls = [];
    __setCaptureImpl(async (body) => {
      calls.push({
        event: body.event,
        properties: body.properties,
        api_key: body.api_key,
      });
    });
  });
  afterEach(() => __resetCaptureImpl());

  it('does nothing when env keys are missing', async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
    (process.env as Record<string, string>).NODE_ENV = 'development';

    await track('page_viewed', { surface: 'marketing' });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when NODE_ENV === 'test'", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    (process.env as Record<string, string>).NODE_ENV = 'test';

    await track('page_viewed', { surface: 'marketing' });
    expect(calls).toHaveLength(0);
  });

  it('never forwards forbidden properties even when configured', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    (process.env as Record<string, string>).NODE_ENV = 'development';

    await track('api_key_created', {
      // would-be plaintext: must NOT appear in capture body
      api_key: 'pv_live_AAAA',
      apiKey: 'pv_live_BBBB',
      surface: 'app',
      tier: 'free',
      is_owner: true,
    } as never);

    vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const call = calls.at(-1)!;
    const serialized = JSON.stringify(call.properties);
    expect(serialized).not.toContain('pv_live_AAAA');
    expect(serialized).not.toContain('pv_live_BBBB');
    expect(call.properties).not.toHaveProperty('api_key');
    expect(call.properties).not.toHaveProperty('apiKey');
    expect(call.properties).toMatchObject({
      surface: 'app',
      tier: 'free',
      is_owner: true,
    });
  });
});
