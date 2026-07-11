// Auto-patch coordinator (D8 + D21).
// Called on `import 'pylva'` and defensively re-called from init() for
// HMR / import-order edge cases. Every patch attempt is try/catch — if the
// provider SDK isn't installed, patch is a silent no-op (R1 isolation).

import { applyOpenAiPatch } from './openai.js';
import { applyAnthropicPatch } from './anthropic.js';
import { applyVercelAiPatch } from './vercel-ai.js';

let patchedOnce = false;

export function applyAllPatches(): void {
  tryPatch(applyOpenAiPatch, 'openai');
  tryPatch(applyAnthropicPatch, 'anthropic');
  tryPatch(applyVercelAiPatch, 'vercel-ai');
  patchedOnce = true;
}

export function wasAutoPatched(): boolean {
  return patchedOnce;
}

function tryPatch(fn: () => void, label: string): void {
  try {
    fn();
  } catch (err) {
    console.warn(
      `[pylva] ${label} auto-patch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
