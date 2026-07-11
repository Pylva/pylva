// B4-T1 model routing — wrapper-level helper that classifies provider
// errors and decides whether to retry with the original model. The
// classification rules come from the b4 plan §B4-2:
//
//   - Cross-provider routing (rule.route_to.provider !== request.provider)
//     and the response is 401/403/404: retry with original model.
//   - Same-provider routing (rule.route_to.provider === request.provider)
//     and the response is 401: DO NOT retry — the same key would fail
//     again (D25).
//   - 429/500 are provider failures, not routing failures: do not retry.
//
// The helper is intentionally generic over the wrapper-specific call
// shape — wrappers pass a `call(model)` callback and the helper either
// returns the result or invokes the fallback path.

import { RuleWarningCode, type ModelRoutingFallback } from '@pylva/shared';

export interface ProviderError {
  status?: number | undefined;
}

type FallbackKind = 'auth_401' | 'access_403' | 'not_found_404' | 'other';

function classifyStatus(status: number | undefined): FallbackKind {
  if (status === 401) return 'auth_401';
  if (status === 403) return 'access_403';
  if (status === 404) return 'not_found_404';
  return 'other';
}

const FALLBACK_REASON_BY_KIND: Record<Exclude<FallbackKind, 'other'>, RuleWarningCode> = {
  auth_401: RuleWarningCode.ROUTING_FALLBACK_AUTH_401,
  access_403: RuleWarningCode.ROUTING_FALLBACK_ACCESS_403,
  not_found_404: RuleWarningCode.ROUTING_FALLBACK_NOT_FOUND_404,
};

export function shouldFallback(
  err: ProviderError,
  fallback: ModelRoutingFallback,
  isSameProvider: boolean,
): boolean {
  const status = err.status;
  const kind = classifyStatus(status);

  if (kind === 'auth_401') {
    if (isSameProvider)
      return fallback.skip_same_provider_401 ? false : fallback.use_original_model;
    return fallback.on_cross_provider_auth_error && fallback.use_original_model;
  }
  if (kind === 'access_403') return fallback.on_access_denied && fallback.use_original_model;
  if (kind === 'not_found_404') return fallback.on_model_not_found && fallback.use_original_model;
  return false;
}

export interface ModelRoutingAttemptInput<T> {
  /** Issues a request with the given model name. */
  call: (model: string) => Promise<T>;
  /** Routed (target) model from the matched rule. */
  routedModel: string;
  /** Original model the host app asked for. */
  originalModel: string;
  /** True when the routed provider matches the host's provider. */
  isSameProvider: boolean;
  /** The fallback config from the matched rule. */
  fallback: ModelRoutingFallback;
}

export interface ModelRoutingAttemptResult<T> {
  result: T;
  /** The model that successfully served the request. */
  modelUsed: string;
  /** True iff the original model fell back to (i.e. routing was attempted but failed). */
  fellBack: boolean;
  /** Set when fallback fired — the wrapper logs this for observability. */
  fallbackReason?: RuleWarningCode;
}

/**
 * Attempts the routed model first; if the provider error is a fallback-
 * eligible auth/access/not-found and the rule's fallback flags allow it,
 * retries with the original model. Other errors (429/500/etc) propagate
 * unchanged.
 */
export async function attemptWithFallback<T>(
  input: ModelRoutingAttemptInput<T>,
): Promise<ModelRoutingAttemptResult<T>> {
  try {
    const result = await input.call(input.routedModel);
    return { result, modelUsed: input.routedModel, fellBack: false };
  } catch (err) {
    const provErr = err as ProviderError;
    if (!shouldFallback(provErr, input.fallback, input.isSameProvider)) throw err;

    const result = await input.call(input.originalModel);
    const kind = classifyStatus(provErr.status);
    return {
      result,
      modelUsed: input.originalModel,
      fellBack: true,
      ...(kind !== 'other' ? { fallbackReason: FALLBACK_REASON_BY_KIND[kind] } : {}),
    };
  }
}
