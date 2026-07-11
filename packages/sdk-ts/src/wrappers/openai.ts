// OpenAI wrapper — patches openai.chat.completions.create() + .stream().
// R1 isolation: every wrapped call is try/catch; on throw, fall through
// to the untouched original. Model is read from the response body (D2.2)
// to defuse alias drift (gpt-4o → gpt-4o-2024-08-06). Pre-call budget
// enforcement, model routing, and failover state tracking all live in
// `_engine.ts` so anthropic + vercel-ai stay consistent.

import { EventStatus, Provider, TokenCountSource } from '@pylva/shared';
import { enqueue } from '../core/telemetry.js';
import { isInitialized } from '../core/config.js';
import { loadPeer, patchResourceProto } from './_load.js';
import { buildLlmEvent } from './_event.js';
import {
  attachPylvaMetadata,
  buildEngineCtx,
  isIntentionalRefusal,
  runWithEngine,
} from './_engine.js';
import { markProviderPatched } from './_init_validation.js';

interface OpenAIChatResponse {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIChatCompletions {
  create(...args: unknown[]): Promise<OpenAIChatResponse>;
}

let applied = false;
let esmPatchLaunched = false;

export function applyOpenAiPatch(): void {
  if (applied) return;
  const mod = loadPeer<{ default?: unknown; OpenAI?: unknown }>('openai');
  if (!mod) return;

  let patchedAny = false;

  const Ctor =
    (mod as { default?: unknown; OpenAI?: unknown }).default ??
    (mod as { OpenAI?: unknown }).OpenAI;
  if (typeof Ctor === 'function' && (Ctor as { prototype?: unknown }).prototype) {
    patchedAny = wrapMethod(Ctor as unknown as { prototype: Record<string, unknown> });
  }

  // openai v5+ assigns `chat` as a constructor instance field — nothing on
  // the prototype for wrapMethod to wrap, so the path above silently missed
  // every v5 client. Patch the Completions class itself (sdk-py parity:
  // openai.resources.chat.completions.Completions.create), which is
  // shape-stable across v4/v5.
  if (
    patchResourceProto<OpenAIChatCompletions>(
      loadPeer('openai/resources/chat/completions'),
      'Completions',
      patchCompletions,
    )
  ) {
    patchedAny = true;
  }

  // openai ≥5 ships true dual builds: the require()-resolved class patched
  // above is NOT the class ESM importers construct. Patch the ESM build's
  // Completions too. import() is async, so this lands a tick after init —
  // calls issued before it resolves fall through unwrapped (R1-safe). The
  // function-level marker in patchCompletions dedupes when both module
  // systems share one class (openai v4).
  if (!esmPatchLaunched) {
    esmPatchLaunched = true;
    void import('openai/resources/chat/completions')
      .then((esmResources) => {
        patchResourceProto<OpenAIChatCompletions>(esmResources, 'Completions', patchCompletions);
      })
      .catch(() => {
        // Peer not installed / no ESM build — R1: silent no-op.
      });
  }

  if (!patchedAny) return;
  applied = true;
  markProviderPatched(Provider.OPENAI);
}

function wrapMethod(Ctor: { prototype: Record<string, unknown> }): boolean {
  const originalChatDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'chat');
  const chatKey = Symbol('pylva_chat');

  if (originalChatDescriptor?.get) {
    const origGetter = originalChatDescriptor.get;
    Object.defineProperty(Ctor.prototype, 'chat', {
      get() {
        const instance = this as Record<symbol, unknown>;
        if (!instance[chatKey]) {
          const chat = origGetter.call(this) as { completions?: OpenAIChatCompletions };
          if (chat?.completions) patchCompletions(chat.completions);
          instance[chatKey] = chat;
        }
        return instance[chatKey];
      },
      configurable: true,
    });
    return true;
  }
  if (typeof Ctor.prototype['chat'] === 'object' && Ctor.prototype['chat'] !== null) {
    const chat = Ctor.prototype['chat'] as { completions?: OpenAIChatCompletions };
    if (chat.completions) {
      patchCompletions(chat.completions);
      return true;
    }
  }
  return false;
}

function patchCompletions(completions: OpenAIChatCompletions): void {
  // Function-level marker: when the class prototype is already patched, the
  // v4 getter path hands us instances whose inherited `create` is the
  // patched function — wrapping again would emit duplicate events.
  if ((completions.create as { __pylva_patched?: boolean }).__pylva_patched) return;
  const original = completions.create;
  const patched = async function patched(
    this: unknown,
    ...args: unknown[]
  ): Promise<OpenAIChatResponse> {
    // Preserve the caller's `this`: when patching Completions.prototype the
    // receiver is the per-client resource instance (carries auth/transport).
    const self = this ?? completions;
    if (!isInitialized()) return original.apply(self, args);
    // Malformed input falls through untouched — R1 isolation says wrapper
    // bugs never propagate, and the host SDK validates better than we can.
    if (typeof args[0] !== 'object' || args[0] === null) return original.apply(self, args);
    const start = Date.now();
    const reqArg = args[0] as { model?: string } & Record<string, unknown>;
    const engineCtx = buildEngineCtx(Provider.OPENAI, reqArg.model ?? null);

    try {
      const { result, metadata } = await runWithEngine<OpenAIChatResponse>({
        request: reqArg,
        providerId: Provider.OPENAI,
        ctx: engineCtx,
        call: (req) => original.apply(self, [req, ...args.slice(1)]) as Promise<OpenAIChatResponse>,
      });

      try {
        enqueue(
          buildLlmEvent({
            provider: Provider.OPENAI,
            model: result?.model ?? metadata.routed_model ?? metadata.original_model ?? null,
            tokensIn: result?.usage?.prompt_tokens ?? 0,
            tokensOut: result?.usage?.completion_tokens ?? 0,
            latencyMs: Date.now() - start,
            status: EventStatus.SUCCESS,
            tokenCountSource: TokenCountSource.EXACT,
          }),
        );
      } catch (err) {
        console.warn(
          `[pylva] openai telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return result && typeof result === 'object'
        ? attachPylvaMetadata(result, metadata)
        : result;
    } catch (err) {
      if (isIntentionalRefusal(err)) throw err;
      try {
        enqueue(
          buildLlmEvent({
            provider: Provider.OPENAI,
            model: reqArg.model ?? null,
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: Date.now() - start,
            status: EventStatus.FAILURE,
          }),
        );
      } catch {
        // swallow
      }
      throw err;
    }
  };
  (patched as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  completions.create = patched;
}

export function _resetOpenAiPatchForTests(): void {
  applied = false;
  esmPatchLaunched = false;
}
