// Explicit-events-only analytics wrapper.
//
// Design per internal design notes:
//   - PostHog Cloud via raw HTTP capture endpoint — no SDK dependency.
//   - Event-name allowlist enforced.
//   - Sensitive property keys are dropped (never sent).
//   - Plaintext API keys, prompts, completions, end-user IDs, and Stripe
//     payloads must never reach analytics.
//   - Disabled when env keys are missing or NODE_ENV === "test".
export const ALLOWED_EVENTS = [
  // Marketing / docs
  'page_viewed',
  'cta_clicked',
  'pricing_plan_clicked',
  'docs_tab_changed',
  'quickstart_copied',
  // Auth
  'signup_started',
  'login_started',
  // Onboarding
  'onboarding_viewed',
  'api_key_create_started',
  'api_key_created',
  'api_key_copied',
  'agent_prompt_copied',
  'sdk_install_copied',
  'first_event_seen',
  'onboarding_completed',
  // Product usage
  'nav_item_clicked',
  'rule_create_started',
  'rule_created',
  'webhook_created',
  'cost_source_configured',
  'portal_configured',
  'invoice_viewed',
  'feature_locked_viewed',
] as const;

export type AllowedEvent = (typeof ALLOWED_EVENTS)[number];

const ALLOWED_EVENT_SET = new Set<string>(ALLOWED_EVENTS);

export const ALLOWED_PROPERTY_KEYS = new Set<string>([
  'surface',
  'route_group',
  'cta_id',
  'plan',
  'tier',
  'feature',
  'step',
  'result',
  'is_owner',
  'is_trialing',
  'has_first_event',
  'path',
  'tab',
]);

export type EventProperties = Record<string, string | number | boolean | null>;

// Strict allowlist: any key not in ALLOWED_PROPERTY_KEYS is dropped. Values
// matching Stripe/Pylva secret prefixes are also dropped — defense in depth
// in case an allowlisted key (e.g. `plan`) is ever passed a secret-shaped
// value. Pylva API keys (pv_live_/pv_cli_) must never reach analytics.
const SECRET_VALUE_PREFIX = /^(sk|pk|whsec|price|sub|cus|pv)_/;

export function sanitizeProperties(props: EventProperties): EventProperties {
  const out: EventProperties = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPERTY_KEYS.has(k)) continue;
    if (typeof v === 'string' && SECRET_VALUE_PREFIX.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export class InvalidEventError extends Error {}

type RuntimeConfig = {
  key: string | null;
  host: string | null;
  enabled: boolean;
};

const POSTHOG_HOSTS = new Set(['app.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com']);

function getRuntimeConfig(): RuntimeConfig {
  const isTest = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
  const key =
    typeof process !== 'undefined' ? (process.env?.NEXT_PUBLIC_POSTHOG_KEY ?? null) : null;
  const host =
    typeof process !== 'undefined' ? (process.env?.NEXT_PUBLIC_POSTHOG_HOST ?? null) : null;
  return {
    key,
    host,
    enabled: !isTest && Boolean(key) && Boolean(host),
  };
}

export type CaptureFn = (body: {
  api_key: string;
  event: string;
  properties: Record<string, unknown>;
  distinct_id: string;
  timestamp: string;
}) => Promise<void>;

function posthogCaptureUrl(host: string): string | null {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:' || !POSTHOG_HOSTS.has(url.hostname)) {
      return null;
    }
    url.pathname = '/capture/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

const defaultCapture: CaptureFn = async (body) => {
  const cfg = getRuntimeConfig();
  const captureUrl = cfg.host ? posthogCaptureUrl(cfg.host) : null;
  if (!cfg.enabled || !captureUrl) return;
  await fetch(captureUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

let captureImpl: CaptureFn = defaultCapture;

// Test seam — vitest can swap the capture impl to inspect calls.
export function __setCaptureImpl(fn: CaptureFn) {
  captureImpl = fn;
}
export function __resetCaptureImpl() {
  captureImpl = defaultCapture;
}

function distinctId(): string {
  if (typeof window === 'undefined') return 'server';
  const KEY = 'pylva:ph_did';
  const existing = window.localStorage.getItem(KEY);
  if (existing) return existing;
  const fresh =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `anon_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.setItem(KEY, fresh);
  } catch {
    // ignore (private mode)
  }
  return fresh;
}

export async function track(name: AllowedEvent, props: EventProperties = {}): Promise<void> {
  if (!ALLOWED_EVENT_SET.has(name)) {
    throw new InvalidEventError(`event not allowed: ${name}`);
  }
  const cfg = getRuntimeConfig();
  if (!cfg.enabled || !cfg.key) return;

  const safeProps = sanitizeProperties(props);
  await captureImpl({
    api_key: cfg.key,
    event: name,
    properties: safeProps,
    distinct_id: distinctId(),
    timestamp: new Date().toISOString(),
  });
}
