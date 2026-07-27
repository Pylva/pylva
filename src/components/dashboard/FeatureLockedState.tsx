type Reason = { kind: 'env_disabled'; flag: string };

// Discoverable, safe lock state.
// Public self-hosted workspaces do not have commercial plans. Product access
// is enforced before dashboard rendering, so this component only explains an
// operator-disabled feature.
export function FeatureLockedState({ feature, reason }: { feature: string; reason: Reason }) {
  return (
    <div
      role="region"
      aria-label={`${feature} locked`}
      className="rounded-md border p-8 text-center"
      style={{ borderColor: 'var(--border)' }}
    >
      <h2 className="text-xl font-semibold tracking-tight">{feature}</h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
        This feature is currently disabled by the operator (env flag <code>{reason.flag}</code>).
      </p>
    </div>
  );
}
