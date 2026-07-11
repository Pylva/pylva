// B2a T1 — dashboard top bar. Minimal Phase 0 version: logout button +
// placeholder theme toggle. T1 commit 3 adds OrgSwitcher + DateRangePicker.

const LOGOUT_ACTION = '/api/v1/auth/logout';

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--background)]/95 px-4 py-3 backdrop-blur sm:px-6">
      <span className="text-xs font-medium uppercase tracking-wider app-muted">
        Product dashboard
      </span>
      <div className="flex items-center gap-2">
        {/* Middleware lets logout pass through even after the session expires. */}
        <form action={LOGOUT_ACTION} method="post">
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
