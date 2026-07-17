import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NextRequest } from 'next/server.js';
import { middleware } from '../../src/middleware.js';
import { GET as capabilities } from '../../src/app/api/v1/budget/capabilities/route.js';
import { POST as reserve } from '../../src/app/api/v1/budget/reservations/route.js';
import { POST as commit } from '../../src/app/api/v1/budget/reservations/[id]/commit/route.js';
import { POST as release } from '../../src/app/api/v1/budget/reservations/[id]/release/route.js';
import { POST as extend } from '../../src/app/api/v1/budget/reservations/[id]/extend/route.js';

const HOST = '127.0.0.1';
const MAX_HARNESS_BODY_BYTES = 32 * 1024;
const OLD_BACKEND = process.env['PYLVA_CHAOS_OLD_BACKEND'] === 'true';

const requestCounts = new Map<string, number>();

function countRequest(method: string, pathname: string): void {
  if (pathname.startsWith('/__chaos/')) return;
  const key = `${method.toUpperCase()} ${pathname}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_HARNESS_BODY_BYTES) throw new Error('harness request body exceeded limit');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function forwardedHeaders(original: Headers, middlewareResponse: Response): Headers {
  const headers = new Headers(original);
  const overridden = middlewareResponse.headers.get('x-middleware-override-headers');
  if (!overridden) return headers;
  for (const name of overridden
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const forwarded = middlewareResponse.headers.get(`x-middleware-request-${name}`);
    if (forwarded === null) headers.delete(name);
    else headers.set(name, forwarded);
  }
  return headers;
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  for (const [name, value] of result.headers.entries()) response.setHeader(name, value);
  response.end(Buffer.from(await result.arrayBuffer()));
}

async function routeRequest(request: NextRequest): Promise<Response> {
  const pathname = request.nextUrl.pathname;
  if (request.method === 'GET' && pathname === '/api/v1/budget/capabilities') {
    return capabilities(request);
  }
  if (request.method === 'POST' && pathname === '/api/v1/budget/reservations') {
    return reserve(request);
  }
  const lifecycle = pathname.match(
    /^\/api\/v1\/budget\/reservations\/([^/]+)\/(commit|release|extend)$/,
  );
  if (request.method === 'POST' && lifecycle) {
    const id = lifecycle[1]!;
    const context = { params: Promise.resolve({ id }) };
    if (lifecycle[2] === 'commit') return commit(request, context);
    if (lifecycle[2] === 'release') return release(request, context);
    return extend(request, context);
  }
  return Response.json(
    { error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' } },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', `http://${HOST}`);
    const method = incoming.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/__chaos/stats') {
      await writeResponse(
        outgoing,
        Response.json({ requests: Object.fromEntries([...requestCounts].sort()) }),
      );
      return;
    }

    countRequest(method, url.pathname);
    if (OLD_BACKEND && url.pathname.startsWith('/api/v1/budget/')) {
      await writeResponse(
        outgoing,
        Response.json(
          { error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' } },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        ),
      );
      return;
    }

    const body = await readBody(incoming);
    const bodyText = body?.toString('utf8');
    const originalHeaders = incomingHeaders(incoming);
    const requestInit: ConstructorParameters<typeof NextRequest>[1] = {
      method,
      headers: originalHeaders,
    };
    if (bodyText !== undefined && bodyText.length > 0) requestInit.body = bodyText;
    const edgeRequest = new NextRequest(`http://${HOST}${url.pathname}${url.search}`, requestInit);
    const edgeResponse = await middleware(edgeRequest);
    if (edgeResponse.status !== 200 || edgeResponse.headers.get('x-middleware-next') !== '1') {
      await writeResponse(outgoing, edgeResponse);
      return;
    }

    const trustedRequest = new NextRequest(edgeRequest.url, {
      method,
      headers: forwardedHeaders(originalHeaders, edgeResponse),
      ...(bodyText !== undefined && bodyText.length > 0 ? { body: bodyText } : {}),
    });
    const result = await routeRequest(trustedRequest);

    // A deterministic test-only transport fault: the route and PostgreSQL
    // transaction have completed, but the caller receives no acknowledgement.
    if (originalHeaders.get('x-pylva-chaos-drop-response') === 'true') {
      incoming.socket.destroy();
      return;
    }
    await writeResponse(outgoing, result);
  } catch {
    if (!outgoing.headersSent) {
      await writeResponse(
        outgoing,
        Response.json(
          { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
          { status: 500, headers: { 'Cache-Control': 'no-store' } },
        ),
      );
    } else {
      outgoing.destroy();
    }
  }
});

server.listen(0, HOST, () => {
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('chaos server has no port');
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
});

function terminate(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
