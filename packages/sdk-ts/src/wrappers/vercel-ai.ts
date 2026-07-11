// Vercel AI SDK wrapper — patches generateText, streamText, generateObject.
// generateText/generateObject resolve `usage` to a value before returning, so
// telemetry is emitted inline. streamText returns synchronously; touching
// result.usage can consume the stream, so we emit telemetry from onFinish
// while preserving the host's synchronous stream result.
// R1 isolation preserved.
//
// D23 — this wrapper is intentionally thinner than openai/anthropic. It
// runs pre-call budget enforcement only; model routing and failover happen
// in the underlying provider's wrapper (vercel-ai composes over
// openai/anthropic SDKs, which are patched separately).
// Wiring runWithEngine here would double-apply routing decisions.

import { EventStatus, TokenCountSource } from '@pylva/shared';
import { enqueue } from '../core/telemetry.js';
import { isInitialized } from '../core/config.js';
import { currentContext } from '../core/context.js';
import { loadPeer } from './_load.js';
import { buildLlmEvent } from './_event.js';
import { maybeEnforcePreCall } from './_budget.js';
import { isIntentionalRefusal } from './_engine.js';

interface AiUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface AiResponse {
  usage?: AiUsage;
  modelId?: string;
}

type AiCallback = (event: unknown) => unknown;

interface AiRequest {
  model?: { modelId?: string; provider?: string };
  onFinish?: AiCallback;
  onError?: AiCallback;
  onAbort?: AiCallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

let applied = false;

export function applyVercelAiPatch(): void {
  if (applied) return;
  const mod = loadPeer<Record<string, unknown>>('ai');
  if (!mod) return;

  wrapAsyncFn(mod, 'generateText');
  wrapStreamText(mod, aiSupportsStreamTerminalCallbacks());
  wrapAsyncFn(mod, 'generateObject');

  applied = true;
}

function wrapAsyncFn(mod: Record<string, unknown>, fnName: string): void {
  const original = mod[fnName];
  if (typeof original !== 'function') return;
  if ((original as { __pylva_patched?: boolean }).__pylva_patched) return;

  const wrapped = async function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
    if (!isInitialized())
      return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    const start = Date.now();
    const reqArg = getRequest(args);
    const providerRaw = reqArg?.model?.provider ?? null;
    const modelRaw = reqArg?.model?.modelId ?? null;

    try {
      maybeEnforcePreCall({
        // 'anonymous' matches telemetry attribution for untracked calls
        // (parity with buildEngineCtx).
        customer_id: currentContext()?.customer_id ?? 'anonymous',
        estimated_usd: 0,
      });
      const result = (await (original as (...a: unknown[]) => Promise<unknown>).apply(
        this,
        args,
      )) as AiResponse;
      emitSuccess(result?.modelId ?? modelRaw, result?.usage, providerRaw, start, fnName);
      return result;
    } catch (err) {
      if (isIntentionalRefusal(err)) throw err;
      emitTerminal(EventStatus.FAILURE, modelRaw, providerRaw, start, fnName);
      throw err;
    }
  };

  (wrapped as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  replaceExport(mod, fnName, wrapped);
}

function wrapStreamText(mod: Record<string, unknown>, supportsTerminalCallbacks: boolean): void {
  const original = mod['streamText'];
  if (typeof original !== 'function') return;
  if ((original as { __pylva_patched?: boolean }).__pylva_patched) return;

  const wrapped = function patched(this: unknown, ...args: unknown[]): unknown {
    if (!isInitialized()) return (original as (...a: unknown[]) => unknown).apply(this, args);
    const start = Date.now();
    const reqArg = getRequest(args);
    const providerRaw = reqArg?.model?.provider ?? null;
    const modelRaw = reqArg?.model?.modelId ?? null;
    let terminalEmitted = false;

    try {
      maybeEnforcePreCall({
        // 'anonymous' matches telemetry attribution for untracked calls
        // (parity with buildEngineCtx).
        customer_id: currentContext()?.customer_id ?? 'anonymous',
        estimated_usd: 0,
      });

      const streamArgs = reqArg
        ? [
            wrapStreamRequest(reqArg, {
              providerRaw,
              modelRaw,
              start,
              supportsTerminalCallbacks,
              getTerminalEmitted: () => terminalEmitted,
              setTerminalEmitted: () => {
                terminalEmitted = true;
              },
            }),
            ...args.slice(1),
          ]
        : args;
      return (original as (...a: unknown[]) => unknown).apply(this, streamArgs);
    } catch (err) {
      if (isIntentionalRefusal(err)) throw err;
      if (!terminalEmitted) {
        terminalEmitted = true;
        emitTerminal(EventStatus.FAILURE, modelRaw, providerRaw, start, 'streamText');
      }
      throw err;
    }
  };

  (wrapped as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  replaceExport(mod, 'streamText', wrapped);
}

function replaceExport(
  mod: Record<string, unknown>,
  fnName: string,
  wrapped: (...args: unknown[]) => unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(mod, fnName);
  if (descriptor) {
    if ('value' in descriptor && descriptor.writable === false) return false;
    if (!('value' in descriptor) && typeof descriptor.set !== 'function') return false;
  }

  try {
    mod[fnName] = wrapped;
    return mod[fnName] === wrapped;
  } catch {
    return false;
  }
}

function wrapStreamRequest(
  reqArg: AiRequest,
  options: {
    providerRaw: string | null;
    modelRaw: string | null;
    start: number;
    supportsTerminalCallbacks: boolean;
    getTerminalEmitted: () => boolean;
    setTerminalEmitted: () => void;
  },
): AiRequest {
  const originalOnFinish = reqArg.onFinish;
  const originalOnError = reqArg.onError;
  const originalOnAbort = reqArg.onAbort;
  const wrapped: AiRequest = { ...reqArg };

  wrapped.onFinish = (event: unknown) => {
    if (!options.getTerminalEmitted()) {
      options.setTerminalEmitted();
      emitSuccess(
        modelFromFinishEvent(event, options.modelRaw),
        usageFromFinishEvent(event),
        options.providerRaw,
        options.start,
        'streamText',
      );
    }
    return originalOnFinish?.(event);
  };

  if (options.supportsTerminalCallbacks) {
    wrapped.onError = (event: unknown) => {
      if (!options.getTerminalEmitted()) {
        options.setTerminalEmitted();
        emitTerminal(
          EventStatus.FAILURE,
          options.modelRaw,
          options.providerRaw,
          options.start,
          'streamText',
        );
      }
      if (originalOnError) return originalOnError(event);
      // Provider/AI SDK error payloads can contain prompt or request details.
      // The wrapper records failure telemetry, but never logs raw host data.
      return undefined;
    };

    wrapped.onAbort = (event: unknown) => {
      if (!options.getTerminalEmitted()) {
        options.setTerminalEmitted();
        emitTerminal(
          EventStatus.ABORTED,
          options.modelRaw,
          options.providerRaw,
          options.start,
          'streamText',
        );
      }
      return originalOnAbort?.(event);
    };
  }

  return wrapped;
}

/** Emit a SUCCESS telemetry event from a (resolved) usage object. R1: never
 *  let a telemetry failure surface to the host. */
function emitSuccess(
  model: string | null,
  usage: AiUsage | undefined,
  providerRaw: string | null,
  start: number,
  fnName: string,
): void {
  try {
    const extracted = extractUsage(usage);
    enqueue(
      buildLlmEvent({
        provider: providerRaw,
        model,
        tokensIn: extracted.tokensIn,
        tokensOut: extracted.tokensOut,
        latencyMs: Date.now() - start,
        status: EventStatus.SUCCESS,
        tokenCountSource: extracted.exact ? TokenCountSource.EXACT : TokenCountSource.ESTIMATED,
        stepNameFallback: fnName,
      }),
    );
  } catch (err) {
    console.warn(
      `[pylva] ai.${fnName} telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function emitTerminal(
  status: EventStatus,
  model: string | null,
  providerRaw: string | null,
  start: number,
  fnName: string,
): void {
  try {
    enqueue(
      buildLlmEvent({
        provider: providerRaw,
        model,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - start,
        status,
        stepNameFallback: fnName,
      }),
    );
  } catch {
    // swallow
  }
}

function extractUsage(usage: AiUsage | undefined): {
  tokensIn: number;
  tokensOut: number;
  exact: boolean;
} {
  const tokensIn = readToken(usage?.promptTokens) ?? readToken(usage?.inputTokens);
  const tokensOut = readToken(usage?.completionTokens) ?? readToken(usage?.outputTokens);
  return {
    tokensIn: tokensIn ?? 0,
    tokensOut: tokensOut ?? 0,
    exact: tokensIn !== undefined && tokensOut !== undefined,
  };
}

function readToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRequest(args: unknown[]): AiRequest | undefined {
  return isObject(args[0]) ? (args[0] as AiRequest) : undefined;
}

function usageFromFinishEvent(event: unknown): AiUsage | undefined {
  if (!isObject(event)) return undefined;
  return ((event['totalUsage'] ?? event['usage']) as AiUsage | undefined) ?? undefined;
}

function modelFromFinishEvent(event: unknown, fallback: string | null): string | null {
  if (!isObject(event)) return fallback;
  const response = event['response'];
  if (isObject(response) && typeof response['modelId'] === 'string') return response['modelId'];
  return fallback;
}

function aiSupportsStreamTerminalCallbacks(): boolean {
  const pkg = loadPeer<{ version?: unknown }>('ai/package.json');
  if (typeof pkg?.version !== 'string') return true;
  const major = Number.parseInt(pkg.version.split('.')[0] ?? '', 10);
  return Number.isNaN(major) || major >= 5;
}

export function _resetVercelAiPatchForTests(): void {
  applied = false;
}
