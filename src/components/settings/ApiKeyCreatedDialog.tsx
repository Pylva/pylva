// Shown-once API key dialog (OpenAI/Anthropic-style "Save your key" modal).
// Shared by the settings page and the onboarding checklist.
//
// The plaintext exists only in client state; every close path goes through
// onDone so the caller clears it and refreshes the key list. Backdrop clicks
// are disabled (closeOnBackdrop={false}) — an accidental click must not
// destroy a secret that is never shown again. Escape is treated as Done.

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { track } from '@/lib/analytics/events';
import { COPY } from '@/lib/copy';
import { buildAgentSetupPrompt } from '@/lib/sdk-snippets';

interface Props {
  plaintext: string | null;
  onDone: () => void;
  copySurface?: 'onboarding' | 'settings';
}

export function ApiKeyCreatedDialog({ plaintext, onDone, copySurface }: Props) {
  const [manualHint, setManualHint] = useState(false);
  const prompt = plaintext ? buildAgentSetupPrompt({ apiKey: plaintext }) : '';

  function trackCopied(kind: 'api_key_copied' | 'agent_prompt_copied') {
    if (!copySurface) return;
    void track(kind, { surface: copySurface });
  }

  return (
    <Dialog
      open={plaintext !== null}
      onClose={onDone}
      labelledBy="api-key-created-title"
      describedBy="api-key-created-capability"
      closeOnBackdrop={false}
    >
      <h2 id="api-key-created-title" className="text-lg font-semibold tracking-tight">
        {COPY.api_key_created_title}
      </h2>
      <p
        id="api-key-created-capability"
        className="mt-2 text-sm text-[color:var(--muted-foreground)]"
      >
        {COPY.api_key_capability}
      </p>

      <div className="mt-4 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-[color:var(--border)] bg-[color:var(--muted)] p-3 font-mono text-xs">
          <code>{plaintext}</code>
        </pre>
        <CopyButton
          value={plaintext ?? ''}
          onCopied={() => trackCopied('api_key_copied')}
          onFallback={() => setManualHint(true)}
          data-autofocus
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyButton
          value={prompt}
          label={COPY.agent_prompt_copy_button}
          copiedLabel={COPY.agent_prompt_copy_done}
          onCopied={() => trackCopied('agent_prompt_copied')}
          onFallback={() => setManualHint(true)}
        />
        <p className="text-xs text-[color:var(--muted-foreground)]">{COPY.agent_prompt_hint}</p>
      </div>
      {manualHint ? (
        <p role="alert" className="mt-2 text-xs text-[color:var(--destructive)]">
          {COPY.api_key_copy_manual}
        </p>
      ) : null}

      <p className="mt-3 text-xs text-[color:var(--muted-foreground)]">{COPY.api_key_shown_once}</p>

      <div className="mt-5 flex justify-end">
        <Button type="button" onClick={onDone}>
          {COPY.api_key_done}
        </Button>
      </div>
    </Dialog>
  );
}
