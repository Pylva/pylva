import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetControlCapabilitiesResponseSchema,
  CommitUsageRequestSchema,
  CommitUsageResponseSchema,
  DEFAULT_RESERVATION_TTL_SECONDS,
  ErrorCode,
  ExtendUsageRequestSchema,
  ExtendUsageResponseSchema,
  ReleaseUsageRequestSchema,
  ReleaseUsageResponseSchema,
  ReserveUsageRequestSchema,
  ReserveUsageResponseSchema,
  type CommitUsageResponse,
  type ExtendUsageResponse,
  type ParsedCommitUsageRequest,
  type ParsedReserveUsageRequest,
  type ReleaseUsageResponse,
  type ReserveUsageResponse,
} from '@pylva/shared';
import * as v from 'valibot';
import type { BudgetControlSdkIdentity } from './sdk-identity.js';
import {
  idempotencyConflictErrorResponse,
  internalErrorResponse,
  jsonResponse,
  reservationStateConflictErrorResponse,
  resourceNotFoundErrorResponse,
  serviceUnavailableErrorResponse,
  validationErrorResponse,
  withNoStore,
  type PublicHttpResponse,
} from '../public-http/response.js';

const MIN_RESERVATION_TTL_SECONDS = 30 as const;
const MAX_RESERVATION_TTL_SECONDS = 3_600 as const;
export const MAX_BUDGET_CONTROL_REQUEST_BYTES = 16 * 1024;

const reservationIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);

type ParsedReleaseUsageRequest = v.InferOutput<typeof ReleaseUsageRequestSchema>;
type ParsedExtendUsageRequest = v.InferOutput<typeof ExtendUsageRequestSchema>;

export interface BudgetControlServiceContext {
  builderId: string;
  keyId: string;
  sdkIdentity: BudgetControlSdkIdentity;
}

export type ReserveBudgetUsageService = (
  context: BudgetControlServiceContext,
  request: ParsedReserveUsageRequest,
) => Promise<unknown>;

export type CommitBudgetUsageService = (
  context: BudgetControlServiceContext,
  reservationId: string,
  request: ParsedCommitUsageRequest,
) => Promise<unknown>;

export type ReleaseBudgetUsageService = (
  context: BudgetControlServiceContext,
  reservationId: string,
  request: ParsedReleaseUsageRequest,
) => Promise<unknown>;

export type ExtendBudgetUsageService = (
  context: BudgetControlServiceContext,
  reservationId: string,
  request: ParsedExtendUsageRequest,
) => Promise<unknown>;

export interface BudgetControlServiceAdapter {
  reserveBudgetUsage: ReserveBudgetUsageService;
  commitBudgetUsage: CommitBudgetUsageService;
  releaseBudgetUsage: ReleaseBudgetUsageService;
  extendBudgetUsage: ExtendBudgetUsageService;
}

export type BudgetControlPublicServiceErrorCode =
  | typeof ErrorCode.RESOURCE_NOT_FOUND
  | typeof ErrorCode.IDEMPOTENCY_CONFLICT
  | typeof ErrorCode.RESERVATION_STATE_CONFLICT;

/**
 * Optional common error for service adapters. Mapping is structural, so a
 * business-service error with the same public `code` does not need to import
 * this HTTP-layer class.
 */
export class BudgetControlServiceError extends Error {
  constructor(readonly code: BudgetControlPublicServiceErrorCode) {
    super(code);
    this.name = 'BudgetControlServiceError';
  }
}

/** Production adapter from authenticated HTTP context to backend service signatures. */
export const defaultBudgetControlServiceAdapter: BudgetControlServiceAdapter = {
  async reserveBudgetUsage(context, request) {
    const { reserveBudgetUsage } = await import('./reservation-service.js');
    return reserveBudgetUsage(context.builderId, request, context.sdkIdentity);
  },
  async commitBudgetUsage(context, reservationId, request) {
    const { commitBudgetUsage } = await import('./lifecycle-service.js');
    return commitBudgetUsage(context.builderId, reservationId, request, context.sdkIdentity);
  },
  async releaseBudgetUsage(context, reservationId, request) {
    const { releaseBudgetUsage } = await import('./lifecycle-service.js');
    return releaseBudgetUsage(context.builderId, reservationId, request, context.sdkIdentity);
  },
  async extendBudgetUsage(context, reservationId, request) {
    const { extendBudgetUsage } = await import('./lifecycle-service.js');
    return extendBudgetUsage(context.builderId, reservationId, request, context.sdkIdentity);
  },
};

export interface BudgetControlHttpDependencies {
  services?: BudgetControlServiceAdapter;
  controlEnabled?: (context: BudgetControlServiceContext) => boolean | Promise<boolean>;
  now?: () => Date;
}

export interface BudgetControlHttpRequest {
  context: BudgetControlServiceContext;
  rawBody: string;
}

export interface BudgetControlLifecycleHttpRequest extends BudgetControlHttpRequest {
  reservationId: string;
}

export type BoundedBudgetControlBody =
  | { success: true; rawBody: string }
  | { success: false; response: PublicHttpResponse };

function oversizedBodyResponse(): PublicHttpResponse {
  return withNoStore(
    validationErrorResponse(
      `Request body must not exceed ${MAX_BUDGET_CONTROL_REQUEST_BYTES} bytes`,
      'body',
    ),
  );
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A failed cancellation must not replace the bounded public response.
  }
}

async function cancelRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return;
  try {
    await body.cancel();
  } catch {
    // A failed cancellation must not replace the bounded public response.
  }
}

/**
 * Read request bytes with a hard cap even for chunked bodies or dishonest
 * Content-Length headers. JSON decoding is strict UTF-8 and never logged.
 */
export async function readBoundedBudgetControlBody(
  request: Request,
): Promise<BoundedBudgetControlBody> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) {
    try {
      if (BigInt(contentLength) > BigInt(MAX_BUDGET_CONTROL_REQUEST_BYTES)) {
        await cancelRequestBody(request.body);
        return { success: false, response: oversizedBodyResponse() };
      }
    } catch {
      // Ignore an unparseable advisory header and enforce the streaming cap.
    }
  }

  if (!request.body) return { success: true, rawBody: '' };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { success: false, response: withNoStore(internalErrorResponse()) };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let rawBody = '';

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      await cancelBodyReader(reader);
      return { success: false, response: withNoStore(internalErrorResponse()) };
    }

    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_BUDGET_CONTROL_REQUEST_BYTES) {
      await cancelBodyReader(reader);
      return { success: false, response: oversizedBodyResponse() };
    }

    try {
      rawBody += decoder.decode(chunk.value, { stream: true });
    } catch {
      await cancelBodyReader(reader);
      return {
        success: false,
        response: withNoStore(validationErrorResponse('Request body must be valid UTF-8', 'body')),
      };
    }
  }

  try {
    rawBody += decoder.decode();
  } catch {
    return {
      success: false,
      response: withNoStore(validationErrorResponse('Request body must be valid UTF-8', 'body')),
    };
  }
  return { success: true, rawBody };
}

export interface BudgetControlHttpHandler {
  capabilities(context: BudgetControlServiceContext): Promise<PublicHttpResponse>;
  reserve(request: BudgetControlHttpRequest): Promise<PublicHttpResponse>;
  commit(request: BudgetControlLifecycleHttpRequest): Promise<PublicHttpResponse>;
  release(request: BudgetControlLifecycleHttpRequest): Promise<PublicHttpResponse>;
  extend(request: BudgetControlLifecycleHttpRequest): Promise<PublicHttpResponse>;
}

type ParsedBody<T> =
  | { success: true; output: T }
  | { success: false; response: PublicHttpResponse };

function firstIssue(
  issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<{ key: unknown }> }>,
): { message: string; param: string } {
  const issue = issues[0];
  if (!issue) return { message: 'Invalid request body', param: 'body' };

  const path = (issue.path ?? [])
    .map(({ key }) => (typeof key === 'string' || typeof key === 'number' ? String(key) : ''))
    .filter(Boolean)
    .join('.');
  return { message: issue.message, param: path || 'body' };
}

function parseJsonBody<T>(schema: v.GenericSchema<unknown, T>, rawBody: string): ParsedBody<T> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    return {
      success: false,
      response: withNoStore(validationErrorResponse('Invalid JSON body', 'body')),
    };
  }

  const parsed = v.safeParse(schema, value);
  if (!parsed.success) {
    const issue = firstIssue(parsed.issues);
    return {
      success: false,
      response: withNoStore(validationErrorResponse(issue.message, issue.param)),
    };
  }
  return { success: true, output: parsed.output };
}

function parseReservationId(value: string): ParsedBody<string> {
  const parsed = v.safeParse(reservationIdSchema, value);
  if (parsed.success) return { success: true, output: parsed.output };
  return {
    success: false,
    response: withNoStore(
      validationErrorResponse('reservation_id must be a valid UUID', 'reservation_id'),
    ),
  };
}

function publicErrorCode(error: unknown): BudgetControlPublicServiceErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (
    code === ErrorCode.RESOURCE_NOT_FOUND ||
    code === ErrorCode.IDEMPOTENCY_CONFLICT ||
    code === ErrorCode.RESERVATION_STATE_CONFLICT
  ) {
    return code;
  }
  return null;
}

function isServiceReadinessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.status === 503 && candidate.code === ErrorCode.INTERNAL_ERROR;
}

function serviceErrorResponse(
  error: unknown,
  allowedCodes: ReadonlySet<BudgetControlPublicServiceErrorCode>,
): PublicHttpResponse {
  if (isServiceReadinessError(error)) {
    // In particular, never reflect BudgetLifecycleSchemaBlockerError.actualUsd
    // or its message. It is operational evidence, not public response data.
    return withNoStore(serviceUnavailableErrorResponse());
  }
  const code = publicErrorCode(error);
  if (code === null || !allowedCodes.has(code)) {
    // Do not let an impossible service error silently expand an endpoint's
    // public status taxonomy. It is an internal contract violation.
    return withNoStore(internalErrorResponse());
  }
  switch (code) {
    case ErrorCode.RESOURCE_NOT_FOUND:
      return withNoStore(resourceNotFoundErrorResponse());
    case ErrorCode.IDEMPOTENCY_CONFLICT:
      return withNoStore(idempotencyConflictErrorResponse());
    case ErrorCode.RESERVATION_STATE_CONFLICT:
      return withNoStore(reservationStateConflictErrorResponse());
  }
}

function validatedSuccess(schema: v.GenericSchema, value: unknown): PublicHttpResponse {
  const parsed = v.safeParse(schema, value);
  return parsed.success
    ? withNoStore(jsonResponse(parsed.output))
    : withNoStore(internalErrorResponse());
}

async function invokeService(
  call: () => Promise<unknown>,
  responseSchema: v.GenericSchema,
  allowedCodes: ReadonlySet<BudgetControlPublicServiceErrorCode>,
): Promise<PublicHttpResponse> {
  try {
    return validatedSuccess(responseSchema, await call());
  } catch (error) {
    return serviceErrorResponse(error, allowedCodes);
  }
}

const reservePublicErrorCodes = new Set<BudgetControlPublicServiceErrorCode>([
  ErrorCode.IDEMPOTENCY_CONFLICT,
]);
const lifecyclePublicErrorCodes = new Set<BudgetControlPublicServiceErrorCode>([
  ErrorCode.RESOURCE_NOT_FOUND,
  ErrorCode.IDEMPOTENCY_CONFLICT,
  ErrorCode.RESERVATION_STATE_CONFLICT,
]);

export function createBudgetControlHttpHandler(
  dependencies: BudgetControlHttpDependencies = {},
): BudgetControlHttpHandler {
  const services = dependencies.services ?? defaultBudgetControlServiceAdapter;
  const controlEnabled = dependencies.controlEnabled ?? (() => false);
  const now = dependencies.now ?? (() => new Date());

  return {
    async capabilities(context) {
      try {
        const response = {
          schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
          control_enabled: await controlEnabled(context),
          min_reservation_ttl_seconds: MIN_RESERVATION_TTL_SECONDS,
          default_reservation_ttl_seconds: DEFAULT_RESERVATION_TTL_SECONDS,
          max_reservation_ttl_seconds: MAX_RESERVATION_TTL_SECONDS,
          server_time: now().toISOString(),
        };
        return validatedSuccess(BudgetControlCapabilitiesResponseSchema, response);
      } catch {
        return withNoStore(internalErrorResponse());
      }
    },

    async reserve(input) {
      const parsed = parseJsonBody<ParsedReserveUsageRequest>(
        ReserveUsageRequestSchema,
        input.rawBody,
      );
      if (!parsed.success) return parsed.response;
      return invokeService(
        () => services.reserveBudgetUsage(input.context, parsed.output),
        ReserveUsageResponseSchema,
        reservePublicErrorCodes,
      );
    },

    async commit(input) {
      const reservationId = parseReservationId(input.reservationId);
      if (!reservationId.success) return reservationId.response;
      const parsed = parseJsonBody<ParsedCommitUsageRequest>(
        CommitUsageRequestSchema,
        input.rawBody,
      );
      if (!parsed.success) return parsed.response;
      return invokeService(
        () => services.commitBudgetUsage(input.context, reservationId.output, parsed.output),
        CommitUsageResponseSchema,
        lifecyclePublicErrorCodes,
      );
    },

    async release(input) {
      const reservationId = parseReservationId(input.reservationId);
      if (!reservationId.success) return reservationId.response;
      const parsed = parseJsonBody<ParsedReleaseUsageRequest>(
        ReleaseUsageRequestSchema,
        input.rawBody,
      );
      if (!parsed.success) return parsed.response;
      return invokeService(
        () => services.releaseBudgetUsage(input.context, reservationId.output, parsed.output),
        ReleaseUsageResponseSchema,
        lifecyclePublicErrorCodes,
      );
    },

    async extend(input) {
      const reservationId = parseReservationId(input.reservationId);
      if (!reservationId.success) return reservationId.response;
      const parsed = parseJsonBody<ParsedExtendUsageRequest>(
        ExtendUsageRequestSchema,
        input.rawBody,
      );
      if (!parsed.success) return parsed.response;
      return invokeService(
        () => services.extendBudgetUsage(input.context, reservationId.output, parsed.output),
        ExtendUsageResponseSchema,
        lifecyclePublicErrorCodes,
      );
    },
  };
}

// Re-export response types next to the adapter contract for concrete service
// modules without making the HTTP layer their implementation dependency.
export type {
  CommitUsageResponse,
  ExtendUsageResponse,
  ReleaseUsageResponse,
  ReserveUsageResponse,
};
