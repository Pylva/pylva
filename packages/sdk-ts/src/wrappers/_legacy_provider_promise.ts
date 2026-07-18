interface NativeProviderPromise<T> extends PromiseLike<T> {
  asResponse?(): Promise<Response>;
  withResponse?(): Promise<{ data: T; response: Response; request_id?: string | null }>;
}

/** Preserve APIPromise helpers while legacy telemetry/routing stays asynchronous. */
export class LegacyProviderPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = 'Promise';

  constructor(
    private readonly finalized: Promise<T>,
    private readonly nativePromise: () => NativeProviderPromise<unknown> | null,
  ) {}

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.finalized.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.finalized.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.finalized.finally(onfinally ?? undefined);
  }

  async asResponse(): Promise<Response> {
    // The provider call is issued synchronously by runWithEngine before this
    // facade is returned. Calling asResponse in the normal immediate pattern
    // therefore reaches the native APIPromise without changing its contract.
    let native = this.nativePromise();
    if (native === null) {
      await this.finalized;
      native = this.nativePromise();
    }
    if (native === null || typeof native.asResponse !== 'function') {
      throw new TypeError('[pylva] provider promise does not support asResponse()');
    }
    return native.asResponse();
  }

  async withResponse(): Promise<{
    data: T;
    response: Response;
    request_id?: string | null;
  }> {
    const [data, response] = await Promise.all([this.finalized, this.asResponse()]);
    return {
      data,
      response,
      request_id:
        response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
    };
  }
}
