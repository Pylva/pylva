type Reason =
  | {
      kind: 'tier';
      required: 'pro' | 'scale' | 'enterprise';
      current: 'free' | 'pro' | 'scale' | 'enterprise';
    }
  | { kind: 'env_disabled'; flag: string };

// Discoverable, safe lock state.
// - Tier-locked: kept for defensive callers, but public self-host builds do not
//   link to Pylva Cloud subscription management.
// - Env-disabled: shows operator-facing reason.
export function FeatureLockedState({
  feature,
  reason,
}: {
  feature: string;
  reason: Reason;
  slug: string;
}) {
  return (
    <div
      role="region"
      aria-label={`${feature} locked`}
      className="rounded-md border p-8 text-center"
      style={{ borderColor: 'var(--border)' }}
    >
      <h2 className="text-xl font-semibold tracking-tight">{feature}</h2>
      {reason.kind === 'tier' ? (
        <>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
            This feature is included on the{' '}
            <strong>
              {reason.required[0]?.toUpperCase()}
              {reason.required.slice(1)}
            </strong>{' '}
            plan. Your workspace is on{' '}
            <strong>
              {reason.current[0]?.toUpperCase()}
              {reason.current.slice(1)}
            </strong>
            .
          </p>
          <p className="mt-4 text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Ask the workspace operator to enable this feature for the self-hosted instance.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
          This feature is currently disabled by the operator (env flag <code>{reason.flag}</code>).
        </p>
      )}
    </div>
  );
}
