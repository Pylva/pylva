import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ControlledAttemptHandle } from '../src/core/control_attempt.js';
import {
  createControlledStreamLifecycle,
  wrapControlledAsyncStream,
} from '../src/wrappers/_controlled_stream.js';

function attempt(startHeartbeat: () => () => void): ControlledAttemptHandle {
  return {
    startHeartbeat,
  } as unknown as ControlledAttemptHandle;
}

function finiteStream(values: unknown[]) {
  const controller = new AbortController();
  const next = vi.fn(async () =>
    values.length > 0
      ? { value: values.shift(), done: false as const }
      : { value: undefined, done: true as const },
  );
  const returnIterator = vi.fn(async () => ({ value: undefined, done: true as const }));
  return {
    controller,
    next,
    returnIterator,
    stream: {
      controller,
      iterator: () => ({ next, return: returnIterator }),
      [Symbol.asyncIterator]() {
        return this.iterator();
      },
      tee() {
        return [];
      },
      toReadableStream() {
        return new ReadableStream();
      },
    },
  };
}

describe('controlled stream lifecycle', () => {
  it('settles once and never restarts a heartbeat after repeated EOF pulls', async () => {
    const source = finiteStream([{ chunk: 1 }]);
    const stopHeartbeat = vi.fn();
    const startHeartbeat = vi.fn(() => stopHeartbeat);
    const settle = vi.fn(async () => undefined);
    const wrapped = wrapControlledAsyncStream(source.stream, attempt(startHeartbeat), {
      observe: vi.fn(),
      settle,
    });
    const iterator = wrapped[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    expect(source.next).toHaveBeenCalledTimes(3);
    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('marks an observer exception unresolved while preserving the native chunk', async () => {
    const chunk = { chunk: 1 };
    const source = finiteStream([chunk]);
    const stopHeartbeat = vi.fn();
    const settle = vi.fn(async () => undefined);
    const wrapped = wrapControlledAsyncStream(
      source.stream,
      attempt(() => stopHeartbeat),
      {
        observe() {
          throw new Error('observer failed');
        },
        settle,
      },
    );
    const iterator = wrapped[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: chunk, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('removes abort and close observers when an idle stream is cancelled', async () => {
    const source = finiteStream([{ chunk: 1 }]);
    const stopHeartbeat = vi.fn();
    const settle = vi.fn(async () => undefined);
    const closeProvider = vi.fn(() => ({ closed: true }));
    const lifecycle = createControlledStreamLifecycle(closeProvider);
    const listenersBefore = getEventListeners(source.controller.signal, 'abort').length;
    const wrapped = wrapControlledAsyncStream(
      source.stream,
      attempt(() => stopHeartbeat),
      { observe: vi.fn(), settle },
      { subscribeCancellation: lifecycle.subscribeCancellation },
    );
    const iterator = wrapped[Symbol.asyncIterator]();
    await iterator.next();
    expect(getEventListeners(source.controller.signal, 'abort').length).toBe(listenersBefore + 1);

    const firstClose = lifecycle.close();
    const secondClose = lifecycle.close();
    expect(firstClose).toBe(secondClose);
    expect(closeProvider).toHaveBeenCalledTimes(1);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(getEventListeners(source.controller.signal, 'abort')).toHaveLength(listenersBefore);
    await iterator.return?.();
  });

  it('hides the raw iterator from access and every reflection surface', () => {
    const source = finiteStream([]);
    const wrapped = wrapControlledAsyncStream(
      source.stream,
      attempt(() => vi.fn()),
      {
        observe: vi.fn(),
        settle: vi.fn(async () => undefined),
      },
    );
    const prototype = Object.getPrototypeOf(wrapped) as Record<PropertyKey, unknown>;

    expect(Reflect.ownKeys(wrapped)).toEqual(['controller']);
    expect('iterator' in wrapped).toBe(false);
    expect(Object.getOwnPropertyDescriptor(wrapped, 'iterator')).toBeUndefined();
    expect((wrapped as unknown as Record<string, unknown>)['iterator']).toBeUndefined();
    expect(() =>
      (prototype[Symbol.asyncIterator] as (this: unknown) => unknown).call(wrapped),
    ).toThrow();
    expect(wrapped.controller).toBe(source.controller);
    expect(() => wrapped.tee()).toThrow('do not support tee');
  });
});
