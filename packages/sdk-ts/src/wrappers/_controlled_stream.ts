// Preserve provider async-iterator behavior while settling only after an
// exact terminal usage record is observed and the consumer reaches EOF.

import type { ControlledAttemptHandle } from '../core/control_attempt.js';

const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const ABORT_CONTROLLER_SIGNAL_GETTER = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  'signal',
)?.get;
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;

export interface ControlledStreamObserver<TChunk> {
  observe(chunk: TChunk): void;
  settle(attempt: ControlledAttemptHandle): Promise<void>;
}

export interface ControlledStreamLifecycle {
  readonly isClosed: () => boolean;
  readonly close: () => unknown;
  readonly subscribeCancellation: (cancel: () => void) => () => void;
}

export interface ControlledStreamCancellation {
  readonly signal?: AbortSignal;
  readonly subscribeCancellation?: (cancel: () => void) => () => void;
}

type AsyncIteratorLike<T> = AsyncIterator<T> & {
  return?(value?: unknown): Promise<IteratorResult<T>>;
  throw?(error?: unknown): Promise<IteratorResult<T>>;
};

/** One close result plus a leak-free registry of active stream heartbeats. */
export function createControlledStreamLifecycle(
  closeProvider: () => unknown,
): ControlledStreamLifecycle {
  let closeStarted = false;
  let closeResult: unknown;
  const cancellations = new Set<() => void>();
  return {
    isClosed: () => closeStarted,
    close: () => {
      if (!closeStarted) {
        closeStarted = true;
        for (const cancel of cancellations) {
          try {
            cancel();
          } catch {
            // Stream instrumentation cannot replace native close behavior.
          }
        }
        cancellations.clear();
        closeResult = closeProvider();
      }
      return closeResult;
    },
    subscribeCancellation: (cancel) => {
      if (closeStarted) {
        try {
          cancel();
        } catch {
          // The lifecycle stays closed even if an observer is hostile.
        }
        return () => {};
      }
      cancellations.add(cancel);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        cancellations.delete(cancel);
      };
    },
  };
}

function nativeAbortSignal(value: unknown): AbortSignal | null {
  if (ABORT_SIGNAL_ABORTED_GETTER === undefined) return null;
  try {
    return typeof Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, value, []) === 'boolean'
      ? (value as AbortSignal)
      : null;
  } catch {
    return null;
  }
}

interface NativeStreamController {
  readonly value: unknown;
  readonly signal: AbortSignal;
}

function streamController(stream: object): NativeStreamController | null {
  if (ABORT_CONTROLLER_SIGNAL_GETTER === undefined) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'controller');
    if (descriptor === undefined || !('value' in descriptor)) return null;
    const signal = nativeAbortSignal(
      Reflect.apply(ABORT_CONTROLLER_SIGNAL_GETTER, descriptor.value, []),
    );
    return signal === null ? null : { value: descriptor.value, signal };
  } catch {
    return null;
  }
}

function abortSignals(
  providerSignal: AbortSignal | undefined,
  callerSignal: AbortSignal | undefined,
): AbortSignal[] {
  const signals: AbortSignal[] = [];
  const caller = nativeAbortSignal(callerSignal);
  const provider = nativeAbortSignal(providerSignal);
  if (caller !== null) signals.push(caller);
  if (provider !== null && provider !== caller) signals.push(provider);
  return signals;
}

/**
 * Wrap a single-consumer provider stream. Early return, cancellation, errors,
 * and missing terminal usage deliberately leave the reservation unresolved.
 */
export function wrapControlledAsyncStream<T extends object, TChunk = unknown>(
  stream: T,
  attempt: ControlledAttemptHandle,
  observer: ControlledStreamObserver<TChunk>,
  cancellation: ControlledStreamCancellation = {},
): T {
  const iterable = stream as T & AsyncIterable<TChunk>;
  if (typeof iterable[Symbol.asyncIterator] !== 'function') return stream;
  const controller = streamController(stream);
  const signals = abortSignals(controller?.signal, cancellation.signal);
  const subscribeCancellation = cancellation.subscribeCancellation;
  let claimed = false;

  const iteratorFactory = (): AsyncIteratorLike<TChunk> => {
    if (claimed) {
      throw new TypeError('[pylva] strict provider streams support one consumer');
    }
    claimed = true;
    const inner = iterable[Symbol.asyncIterator]() as AsyncIteratorLike<TChunk>;
    let stopHeartbeat: (() => void) | null = null;
    let canSettle = true;
    let finished = false;
    let monitoringStarted = false;
    let unsubscribeCancellation: (() => void) | null = null;
    const monitoredSignals: AbortSignal[] = [];
    const stopMonitoring = (): void => {
      stopHeartbeat?.();
      stopHeartbeat = null;
      for (const signal of monitoredSignals.splice(0)) {
        try {
          Reflect.apply(EVENT_TARGET_REMOVE, signal, ['abort', unresolved]);
        } catch {
          // Native stream behavior is independent from observer cleanup.
        }
      }
      const unsubscribe = unsubscribeCancellation;
      unsubscribeCancellation = null;
      try {
        unsubscribe?.();
      } catch {
        // Native stream behavior is independent from observer cleanup.
      }
    };
    const unresolved = (): void => {
      if (finished) return;
      canSettle = false;
      stopMonitoring();
    };
    const startMonitoring = (): void => {
      if (monitoringStarted || !canSettle) return;
      monitoringStarted = true;
      for (const signal of signals) {
        try {
          Reflect.apply(EVENT_TARGET_ADD, signal, ['abort', unresolved]);
          monitoredSignals.push(signal);
        } catch {
          unresolved();
          return;
        }
      }
      if (subscribeCancellation !== undefined) {
        try {
          const unsubscribe = subscribeCancellation(unresolved);
          if (canSettle) unsubscribeCancellation = unsubscribe;
          else unsubscribe();
        } catch {
          unresolved();
          return;
        }
      }
      for (const signal of signals) {
        if (nativeAbortSignal(signal) === null) {
          unresolved();
          return;
        }
        try {
          if (Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER!, signal, []) === true) {
            unresolved();
            return;
          }
        } catch {
          unresolved();
          return;
        }
      }
    };
    const startHeartbeat = (): void => {
      // Merely asking for an iterator is not active consumption. Starting on
      // the first pull prevents an abandoned iterator from extending a hold.
      if (finished) return;
      startMonitoring();
      if (!canSettle || stopHeartbeat !== null) return;
      try {
        const stop = attempt.startHeartbeat();
        if (canSettle) stopHeartbeat = stop;
        else stop();
      } catch {
        // Instrumentation failure cannot replace native iteration behavior.
        unresolved();
      }
    };

    return {
      async next(...args: [] | [undefined]): Promise<IteratorResult<TChunk>> {
        startHeartbeat();
        try {
          const result = await inner.next(...args);
          if (result.done) {
            if (!finished) {
              finished = true;
              const shouldSettle = canSettle;
              stopMonitoring();
              if (shouldSettle) {
                try {
                  await observer.settle(attempt);
                } catch {
                  // Post-dispatch evidence/settlement never changes stream EOF.
                }
              }
            }
          } else {
            try {
              observer.observe(result.value);
            } catch {
              // Unsafe evidence leaves the reservation unresolved.
              unresolved();
            }
          }
          return result;
        } catch (error) {
          unresolved();
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<TChunk>> {
        unresolved();
        if (inner.return) return inner.return(value);
        return { value: value as TChunk, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<TChunk>> {
        unresolved();
        if (inner.throw) return inner.throw(error);
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncIteratorLike<TChunk> & AsyncIterableIterator<TChunk>;
  };

  // Proxy a clean facade rather than the native stream itself. Official peer
  // streams expose their raw iterator as a configurable own field at runtime;
  // retaining it as the Proxy target would leave reflection and direct-call
  // bypasses around the controlled iterator.
  const facade = Object.create(Object.getPrototypeOf(stream)) as T;
  if (controller !== null) {
    Object.defineProperty(facade, 'controller', {
      value: controller.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return new Proxy(facade, {
    get(_target, property) {
      if (property === Symbol.asyncIterator) return iteratorFactory;
      if (property === 'toReadableStream') {
        return () => {
          const iterator = iteratorFactory();
          return new ReadableStream<TChunk>({
            async pull(controller) {
              try {
                const result = await iterator.next();
                if (result.done) controller.close();
                else controller.enqueue(result.value);
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel(reason) {
              await iterator.return?.(reason);
            },
          });
        };
      }
      if (property === 'tee') {
        // One provider response cannot safely be settled from two consumers.
        // Reject before either branch starts instead of double-accounting.
        return () => {
          throw new TypeError('[pylva] strict provider streams do not support tee()');
        };
      }
      if (property === 'controller') return controller?.value;
      // Promise resolution probes `then`; every other non-public field is
      // deliberately absent, including the peer's raw `iterator` closure.
      return undefined;
    },
    has(_target, property) {
      return (
        property === Symbol.asyncIterator ||
        property === 'toReadableStream' ||
        property === 'tee' ||
        (property === 'controller' && controller !== null)
      );
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    setPrototypeOf() {
      return false;
    },
  });
}
