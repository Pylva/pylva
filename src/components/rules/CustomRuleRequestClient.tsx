'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation.js';
import { apiFetch } from '@/lib/dashboard/api-client';
import { Button } from '@/components/ui/button';

const MIN_IDEA_LENGTH = 10;
const MAX_IDEA_LENGTH = 4000;

export function CustomRuleRequestClient({ slug }: { slug: string }) {
  const router = useRouter();
  const [idea, setIdea] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [receiptEmailSent, setReceiptEmailSent] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = idea.trim();
    setError(null);

    if (trimmed.length < MIN_IDEA_LENGTH) {
      setError('Please share a little more detail before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/v1/rules/custom-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        receipt_email_sent?: boolean;
      } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? 'Could not send your request');
        return;
      }
      setReceiptEmailSent(body?.receipt_email_sent !== false);
      setSubmitted(true);
    } catch {
      setError('Network error - please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-xl space-y-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
            Request received
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Thanks for the idea.</h1>
          <p className="mt-2 text-sm leading-6 text-[color:var(--muted-foreground)]">
            {receiptEmailSent
              ? 'We received your custom rule request and sent a confirmation email. We appreciate it and are reviewing it.'
              : 'We received your custom rule request. We appreciate it and are reviewing it.'}
          </p>
        </div>

        <Button type="button" onClick={() => router.push(`/o/${slug}/dashboard/rules`)}>
          Back to rules
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-xl space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Custom rule request
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Request a custom rule</h1>
        <p className="mt-2 text-sm leading-6 text-[color:var(--muted-foreground)]">
          Write what you want this rule to catch, block, alert on, or automate. Your workspace and
          account details are attached automatically.
        </p>
      </div>

      <div>
        <label
          htmlFor="custom-rule-idea"
          className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]"
        >
          What should this rule do?
        </label>
        <textarea
          id="custom-rule-idea"
          required
          rows={9}
          maxLength={MAX_IDEA_LENGTH}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Example: Alert us when a single end-user suddenly spends much more than usual, but only during a 15 minute window."
          className="mt-2 min-h-48 w-full resize-y rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-2 text-sm leading-6 outline-none focus:border-[color:var(--primary)]"
        />
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[color:var(--muted-foreground)]">
          <span>We&apos;ll review it and follow up by email.</span>
          <span>
            {idea.length}/{MAX_IDEA_LENGTH}
          </span>
        </div>
      </div>

      {error ? <p className="text-sm text-[color:var(--destructive)]">{error}</p> : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Sending...' : 'Submit request'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/o/${slug}/dashboard/rules/new`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
