import type {
  ControlledAttemptDispatch,
  ControlledAttemptHandle,
} from '../core/control_attempt.js';

export interface ProviderPromiseLike<T> extends PromiseLike<T> {
  catch?<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult>;
  finally?(onFinally?: (() => void) | null): Promise<T>;
  asResponse?(): Promise<Response>;
  withResponse?(): Promise<{ data: T; response: Response; request_id?: string | null }>;
}

export interface ControlledPromiseHooks<T> {
  transform(value: T, attempt: ControlledAttemptHandle): Promise<T>;
  providerRejected?(error: unknown, attempt: ControlledAttemptHandle): void;
  rawJson?(value: unknown, attempt: ControlledAttemptHandle): Promise<void>;
}

/**
 * A deferred APIPromise-compatible facade. Reservation finishes before the
 * underlying provider method is invoked, while `asResponse()` and
 * `withResponse()` remain available to OpenAI/Anthropic callers.
 */
export class DeferredControlledPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = 'Promise';
  private parsedPromise: Promise<T> | null = null;
  private transformedPromise: Promise<T> | null = null;
  private rejectionReported = false;

  constructor(
    private readonly launched: Promise<ControlledAttemptDispatch<ProviderPromiseLike<T>>>,
    private readonly hooks: ControlledPromiseHooks<T>,
  ) {}

  private reportRejected(error: unknown, attempt: ControlledAttemptHandle): void {
    if (this.rejectionReported) return;
    this.rejectionReported = true;
    this.hooks.providerRejected?.(error, attempt);
  }

  private parse(): Promise<T> {
    if (this.parsedPromise !== null) return this.parsedPromise;
    this.parsedPromise = this.launched.then(async ({ value, attempt }) => {
      try {
        const parsed = await value;
        return await this.transformOnce(parsed, attempt);
      } catch (error) {
        this.reportRejected(error, attempt);
        throw error;
      }
    });
    return this.parsedPromise;
  }

  private transformOnce(value: T, attempt: ControlledAttemptHandle): Promise<T> {
    // Native APIPromise permits then(), withResponse(), and repeated helper
    // access on the same response. Reuse one transformed stream/settlement so
    // those views cannot create multiple consumers or legacy billing events.
    this.transformedPromise ??= this.hooks.transform(value, attempt);
    return this.transformedPromise;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.parse().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.parse().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.parse().finally(onfinally ?? undefined);
  }

  async asResponse(): Promise<Response> {
    const { value, attempt } = await this.launched;
    if (typeof value.asResponse !== 'function') {
      throw new TypeError('[pylva] provider promise does not support asResponse()');
    }
    try {
      const response = await value.asResponse();
      // Parse a clone only for non-streaming JSON. The caller's raw body stays
      // untouched. Streaming raw responses remain unresolved because exact
      // usage cannot be tied to the caller reaching terminal EOF.
      const contentType = response.headers.get('content-type') ?? '';
      if (this.hooks.rawJson && contentType.toLowerCase().includes('application/json')) {
        void response
          .clone()
          .json()
          .then((body) => this.hooks.rawJson?.(body, attempt))
          .catch(() => {
            // Invalid/missing evidence remains unresolved.
          });
      }
      return response;
    } catch (error) {
      this.reportRejected(error, attempt);
      throw error;
    }
  }

  async withResponse(): Promise<{
    data: T;
    response: Response;
    request_id?: string | null;
  }> {
    const { value, attempt } = await this.launched;
    if (typeof value.withResponse !== 'function') {
      throw new TypeError('[pylva] provider promise does not support withResponse()');
    }
    try {
      const result = await value.withResponse();
      return { ...result, data: await this.transformOnce(result.data, attempt) };
    } catch (error) {
      this.reportRejected(error, attempt);
      throw error;
    }
  }
}
