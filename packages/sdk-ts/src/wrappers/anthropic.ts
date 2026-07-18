// Anthropic wrapper — patches anthropic.messages.create().
// Same R1 isolation + model-from-response pattern as openai.ts. All
// pre-call enforcement / routing / failover lives in `_engine.ts`; this
// file is just the patch surface + telemetry emission.

import { EventStatus, Provider, TokenCountSource } from '@pylva/shared/telemetry-values';
import { enqueue } from '../core/telemetry.js';
import { getConfigGeneration, isInitialized } from '../core/config.js';
import { loadPeer, patchResourceProto } from './_load.js';
import { buildLlmEvent } from './_event.js';
import {
  attachPylvaMetadata,
  buildEngineCtx,
  isIntentionalRefusal,
  runWithEngine,
} from './_engine.js';
import { markProviderPatched } from './_init_validation.js';
import { originalProviderMethod, registerPatchedOriginal } from './_strict_unwrap.js';
import { LegacyProviderPromise } from './_legacy_provider_promise.js';

interface AnthropicResponse {
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicMessages {
  create(...args: unknown[]): Promise<AnthropicResponse>;
}

let applied = false;
let esmPatchLaunched = false;

/** Internal strict-wrapper escape hatch: never execute legacy routing twice. */
export function _originalAnthropicCreate(
  candidate: AnthropicMessages['create'],
): AnthropicMessages['create'] | null {
  return originalProviderMethod(candidate);
}

export function applyAnthropicPatch(): void {
  if (applied) return;
  const mod = loadPeer<{ default?: unknown; Anthropic?: unknown }>('@anthropic-ai/sdk');
  if (!mod) return;

  let patchedAny = false;

  const Ctor = (mod.default ?? mod.Anthropic) as unknown;
  if (typeof Ctor === 'function' && (Ctor as { prototype?: unknown }).prototype) {
    patchedAny = wrapMethod(Ctor as unknown as { prototype: Record<string, unknown> });
  }

  // Recent @anthropic-ai/sdk versions assign `messages` as a constructor
  // instance field — nothing on the prototype for wrapMethod to wrap, so the
  // path above silently missed every client. Patch the Messages class itself
  // (sdk-py parity: anthropic.resources.messages.Messages.create), which is
  // shape-stable across versions.
  if (
    patchResourceProto<AnthropicMessages>(
      loadPeer('@anthropic-ai/sdk/resources/messages'),
      'Messages',
      patchMessages,
    )
  ) {
    patchedAny = true;
  }

  // Recent @anthropic-ai/sdk versions ship true dual builds: the
  // require()-resolved class patched above is NOT the class ESM importers
  // construct. Patch the ESM build's Messages too (async — calls issued
  // before it resolves fall through unwrapped, R1-safe). The function-level
  // marker in patchMessages dedupes when both module systems share a class.
  if (!esmPatchLaunched) {
    esmPatchLaunched = true;
    void import('@anthropic-ai/sdk/resources/messages')
      .then((esmResources) => {
        patchResourceProto<AnthropicMessages>(esmResources, 'Messages', patchMessages);
      })
      .catch(() => {
        // Peer not installed / no ESM build — R1: silent no-op.
      });
  }

  if (!patchedAny) return;
  applied = true;
  markProviderPatched(Provider.ANTHROPIC);
}

function wrapMethod(Ctor: { prototype: Record<string, unknown> }): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'messages');
  const messagesKey = Symbol('pylva_messages');

  if (descriptor?.get) {
    const origGetter = descriptor.get;
    Object.defineProperty(Ctor.prototype, 'messages', {
      get() {
        const instance = this as Record<symbol, unknown>;
        if (!instance[messagesKey]) {
          const messages = origGetter.call(this) as AnthropicMessages | undefined;
          if (messages) patchMessages(messages);
          instance[messagesKey] = messages;
        }
        return instance[messagesKey];
      },
      configurable: true,
    });
    return true;
  }
  if (typeof Ctor.prototype['messages'] === 'object' && Ctor.prototype['messages'] !== null) {
    patchMessages(Ctor.prototype['messages'] as AnthropicMessages);
    return true;
  }
  return false;
}

function patchMessages(messages: AnthropicMessages): void {
  // Function-level marker: when the class prototype is already patched, the
  // getter path hands us instances whose inherited `create` is the patched
  // function — wrapping again would emit duplicate events.
  if ((messages.create as { __pylva_patched?: boolean }).__pylva_patched) return;
  const original = messages.create;
  const patched = function patched(this: unknown, ...args: unknown[]): Promise<AnthropicResponse> {
    // Preserve the caller's `this`: when patching Messages.prototype the
    // receiver is the per-client resource instance (carries auth/transport).
    const self = this ?? messages;
    if (!isInitialized()) return original.apply(self, args);
    if (typeof args[0] !== 'object' || args[0] === null) return original.apply(self, args);
    const start = Date.now();
    const ownerGeneration = getConfigGeneration();
    const reqArg = args[0] as { model?: string } & Record<string, unknown>;
    const engineCtx = buildEngineCtx(Provider.ANTHROPIC, reqArg.model ?? null);

    let nativePromise:
      | (Promise<AnthropicResponse> & {
          asResponse?: () => Promise<Response>;
        })
      | null = null;
    const finalized = runWithEngine<AnthropicResponse>({
      request: reqArg,
      providerId: Provider.ANTHROPIC,
      ctx: engineCtx,
      call: (req) => {
        nativePromise = original.apply(self, [req, ...args.slice(1)]) as typeof nativePromise;
        return nativePromise!;
      },
    })
      .then(({ result, metadata }) => {
        try {
          if (ownerGeneration === getConfigGeneration()) {
            enqueue(
              buildLlmEvent({
                provider: Provider.ANTHROPIC,
                model: result?.model ?? metadata.routed_model ?? metadata.original_model ?? null,
                tokensIn: result?.usage?.input_tokens ?? 0,
                tokensOut: result?.usage?.output_tokens ?? 0,
                latencyMs: Date.now() - start,
                status: EventStatus.SUCCESS,
                tokenCountSource: TokenCountSource.EXACT,
              }),
            );
          }
        } catch (err) {
          console.warn(
            `[pylva] anthropic telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return result && typeof result === 'object'
          ? attachPylvaMetadata(result, metadata)
          : result;
      })
      .catch((err: unknown) => {
        if (isIntentionalRefusal(err)) throw err;
        try {
          if (ownerGeneration === getConfigGeneration()) {
            enqueue(
              buildLlmEvent({
                provider: Provider.ANTHROPIC,
                model: reqArg.model ?? null,
                tokensIn: 0,
                tokensOut: 0,
                latencyMs: Date.now() - start,
                status: EventStatus.FAILURE,
              }),
            );
          }
        } catch {
          // swallow
        }
        throw err;
      });
    return new LegacyProviderPromise(finalized, () => nativePromise);
  };
  (patched as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  registerPatchedOriginal(patched, original);
  messages.create = patched;
}

export function _resetAnthropicPatchForTests(): void {
  applied = false;
  esmPatchLaunched = false;
}

export {
  wrapAnthropic,
  PylvaStrictProviderError,
  type ControlledAnthropicClient,
} from './anthropic_controlled.js';
export type { StrictAnthropicOptions } from './anthropic_controlled.js';
