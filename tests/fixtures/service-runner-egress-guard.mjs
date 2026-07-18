const BACKEND_ROUTES = new Map([
  ['GET /api/v1/budget/capabilities', true],
  ['GET /api/v1/pricing', true],
  ['GET /api/v1/rules', true],
  ['GET /api/v1/sdk/non-llm-policy', true],
  ['POST /api/v1/budget/reservations', true],
  ['POST /api/v1/budget/sync', true],
  ['POST /api/v1/events', true],
  ['POST /api/v1/sdk/non-llm-discoveries', true],
]);
const RESERVATION_MUTATION =
  /^\/api\/v1\/budget\/reservations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:commit|extend|release)$/iu;

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function parseBackend(endpoint) {
  const parsed = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('service runner backend endpoint must be an exact loopback HTTP origin');
  }
  return {
    basePath: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, ''),
    origin: parsed.origin,
  };
}

function effectiveMethod(input, init) {
  const value = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return String(value).toUpperCase();
}

function backendPath(url, backend) {
  if (backend.basePath === '') return url.pathname;
  if (!url.pathname.startsWith(`${backend.basePath}/`)) return null;
  return url.pathname.slice(backend.basePath.length);
}

function isAllowedBackendRequest(url, method, backend) {
  if (url.origin !== backend.origin || url.username || url.password || url.search || url.hash) {
    return false;
  }
  const path = backendPath(url, backend);
  if (path === null) return false;
  return (
    BACKEND_ROUTES.has(`${method} ${path}`) ||
    (method === 'POST' && RESERVATION_MUTATION.test(path))
  );
}

function manualRedirectInit(init) {
  return { ...init, redirect: 'manual' };
}

export function createServiceRunnerFetch(options) {
  const backend = parseBackend(options.endpoint);
  const networkFetch = options.networkFetch;
  if (typeof networkFetch !== 'function') throw new TypeError('networkFetch must be callable');

  return async function guardedServiceRunnerFetch(input, init) {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    const method = effectiveMethod(input, init);

    if (
      options.providerHandler &&
      method === 'POST' &&
      url.origin === 'https://api.openai.com' &&
      url.pathname === '/v1/chat/completions' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return options.providerHandler(input, init);
    }
    if (!isAllowedBackendRequest(url, method, backend)) {
      throw new Error(`unexpected external request: ${method} ${url.origin}${url.pathname}`);
    }

    const response = await networkFetch(input, manualRedirectInit(init));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`unexpected redirect from allowed service route: ${method} ${url.pathname}`);
    }
    return response;
  };
}

export async function assertEgressSentinelBlocked(guardedFetch, sentinelUrl) {
  if (!sentinelUrl) return;
  try {
    await guardedFetch(sentinelUrl, { method: 'GET' });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unexpected external request:')) return;
    throw error;
  }
  throw new Error('service runner egress sentinel unexpectedly reached native transport');
}
