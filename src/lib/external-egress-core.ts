import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCallback, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export type EgressTarget = 'github' | 'google_oauth' | 'slack' | 'litellm' | 'custom_webhook';

export interface EgressRequest {
  target: EgressTarget;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface EgressResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface PreparedEgressRequest {
  request: EgressRequest;
  url: URL;
}

type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

interface LookupDependencies {
  lookupAll?: LookupAll;
  isBlocked?: (address: string) => boolean;
}

const KNOWN_HOSTS: Record<Exclude<EgressTarget, 'custom_webhook'>, ReadonlyArray<string>> = {
  github: ['api.github.com', 'github.com'],
  google_oauth: ['oauth2.googleapis.com', 'openidconnect.googleapis.com'],
  slack: ['hooks.slack.com'],
  litellm: ['raw.githubusercontent.com'],
};

function hostnameAllowed(target: EgressTarget, hostname: string): boolean {
  if (target === 'custom_webhook') return true;
  return KNOWN_HOSTS[target].some(
    (allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
  );
}

function isNonPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

function expandIpv6(address: string): number[] | null {
  const [head = '', tail = ''] = address.toLowerCase().split('::') as [string?, string?];
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];
  if (address.includes('::') && address.indexOf('::') !== address.lastIndexOf('::')) return null;
  if (!address.includes('::') && headParts.length !== 8) return null;
  const fill = address.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  if (fill < 0) return null;
  const parts = [...headParts, ...Array.from({ length: fill }, () => '0'), ...tailParts];
  if (parts.length !== 8) return null;
  const hextets = parts.map((part) => Number.parseInt(part || '0', 16));
  if (hextets.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return hextets;
}

function ipv4FromHextets(high: number, low: number): string {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

function embeddedIpv4FromIpv6(address: string): string | null {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const suffix = lower.slice('::ffff:'.length);
    if (isIP(suffix) === 4) return suffix;
  }

  const hextets = expandIpv6(lower);
  if (!hextets) return null;

  const isMappedIpv4 =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff;
  if (isMappedIpv4) return ipv4FromHextets(hextets[6]!, hextets[7]!);

  const isWellKnownNat64 =
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0;
  if (isWellKnownNat64) return ipv4FromHextets(hextets[6]!, hextets[7]!);

  return null;
}

function isPrivateIp(address: string): boolean {
  const normalized =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipVersion = isIP(normalized);
  if (!ipVersion) return false;
  if (ipVersion === 4) return isNonPublicIpv4(normalized);

  const embeddedIpv4 = embeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4) return isNonPublicIpv4(embeddedIpv4);

  const hextets = expandIpv6(normalized);
  if (!hextets) return true;
  const first = hextets[0]!;
  if (
    hextets.every((part) => part === 0) ||
    (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1)
  ) {
    return true;
  }
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && hextets[1] === 0x0db8) return true;
  return false;
}

function defaultLookupAll(
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
): void {
  dnsLookupCallback(hostname, options, callback);
}

/**
 * Creates the connect-time DNS guard used by every Undici socket. Node's
 * lookup callback has two result contracts; Undici requests `all: true` and
 * therefore must receive an address array rather than a scalar address.
 */
export function createSsrfSafeLookup({
  lookupAll = defaultLookupAll,
  isBlocked = isPrivateIp,
}: LookupDependencies = {}): LookupFunction {
  return (hostname, options, callback) => {
    const respondWithError = (error: NodeJS.ErrnoException): void => {
      if (options.all === true) callback(error, []);
      else callback(error, '', 0);
    };

    lookupAll(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        respondWithError(err);
        return;
      }

      const publicAddresses = addresses.filter((entry) => !isBlocked(entry.address));
      if (publicAddresses.length === 0) {
        respondWithError(
          Object.assign(
            new Error(`egress to ${hostname} blocked: resolves to a non-public address`),
            { code: 'EEGRESSBLOCKED' },
          ),
        );
        return;
      }

      if (options.all === true) {
        callback(null, publicAddresses);
        return;
      }

      const [first] = publicAddresses as [LookupAddress, ...LookupAddress[]];
      callback(null, first.address, first.family);
    });
  };
}

const ssrfSafeLookup = createSsrfSafeLookup();
const ssrfSafeAgent = new Agent({ connect: { lookup: ssrfSafeLookup } });

async function assertUrlAllowed(target: EgressTarget, rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('external egress only supports https URLs');
  }
  if (!hostnameAllowed(target, url.hostname)) {
    throw new Error(`host ${url.hostname} is not allowed for ${target}`);
  }
  if (target !== 'custom_webhook') return url;

  const host = url.hostname.toLowerCase();
  const lookupHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('custom webhook host is not public');
  }
  if (isPrivateIp(lookupHost)) {
    throw new Error('custom webhook IP is not public');
  }
  const addresses = await lookup(lookupHost, { all: true, verbatim: true });
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('custom webhook DNS resolves to a private address');
  }
  return url;
}

export async function prepareEgressRequest(request: EgressRequest): Promise<PreparedEgressRequest> {
  return { request, url: await assertUrlAllowed(request.target, request.url) };
}

export async function assertWebhookUrlAllowed(rawUrl: string): Promise<void> {
  await assertUrlAllowed('custom_webhook', rawUrl);
}

function toHeaders(headers: {
  forEach(callback: (value: string, key: string) => void): void;
}): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function executePreparedEgressRequest(
  prepared: PreparedEgressRequest,
): Promise<EgressResponse> {
  const { request, url } = prepared;
  const signal =
    request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? AbortSignal.timeout(request.timeoutMs)
      : undefined;
  const isWebhook = request.target === 'custom_webhook';
  const response = await undiciFetch(url, {
    method: request.method ?? 'GET',
    headers: request.headers,
    body: request.body,
    signal,
    dispatcher: ssrfSafeAgent,
    ...(isWebhook ? { redirect: 'manual' as const } : {}),
  });
  if (isWebhook && response.status >= 300 && response.status < 400) {
    throw new Error('external egress: redirects are not allowed for custom webhooks');
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: toHeaders(response.headers),
    body: await response.text(),
  };
}

export async function directExternalFetch(request: EgressRequest): Promise<EgressResponse> {
  return executePreparedEgressRequest(await prepareEgressRequest(request));
}

export const _internal = {
  createSsrfSafeLookup,
  hostnameAllowed,
  isPrivateIp,
  ssrfSafeLookup,
};
