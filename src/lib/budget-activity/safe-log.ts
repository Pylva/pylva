import { randomUUID } from 'node:crypto';

interface BudgetActivityWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

const messages = {
  api: 'authoritative budget activity unavailable',
  dashboard: 'dashboard budget activity unavailable',
} as const;

/**
 * Log an opaque incident reference without inspecting the caught value. A
 * database driver error can contain credentials, hosts, SQL, and row data.
 */
export function logBudgetActivityUnavailable(
  log: BudgetActivityWarningLogger,
  input: {
    builderId: string;
    actorId?: string | null;
    surface: keyof typeof messages;
  },
  cause: unknown,
): void {
  void cause;
  log.warn(
    {
      builder_id: input.builderId,
      error_code: 'budget_activity_unavailable',
      error_ref: randomUUID(),
      ...(input.actorId ? { actor_id: input.actorId } : {}),
    },
    messages[input.surface],
  );
}
