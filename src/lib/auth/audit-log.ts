// Audit log — spec Section 4.9
// Logs state-changing operations within the RLS-scoped transaction

import { auditLog as auditLogTable } from '../db/schema.js';
import type { DrizzleTransaction } from '../db/rls.js';
import type { AuditAction } from '../audit/actions.js';

export interface AuditLogEntry {
  builder_id: string;
  actor_type: 'user' | 'api_key' | 'system';
  actor_id: string;
  // Compile-time enforcement: callers must pass an AuditAction constant from
  // src/lib/audit/actions.ts. Prevents drift like `'rule.activated'` vs
  // `'rule.activate'` typos that audit-log queries silently miss.
  action: AuditAction;
  resource_type: string;
  resource_id?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
}

// Default `actor_user_id` from `actor_id` when the actor is a user. The
// dedicated UUID column (added in migration 019) carries the indexed FK to
// `users.id`. Without this, the audit-log viewer's email join is dead code.
function deriveActorUserId(entry: AuditLogEntry): string | null {
  if (entry.actor_type !== 'user') return null;
  // actor_id for actor_type=user is already the user UUID; copy it into
  // the dedicated column so the viewer's `(SELECT email FROM users WHERE
  // users.id = audit_log.actor_user_id)` join resolves.
  return entry.actor_id;
}

/**
 * Insert an audit log entry within an RLS-scoped transaction.
 * Should be called inside withRLS() to inherit the same transaction.
 */
export async function auditLog(tx: DrizzleTransaction, entry: AuditLogEntry): Promise<void> {
  await tx.insert(auditLogTable).values({
    builder_id: entry.builder_id,
    actor_type: entry.actor_type,
    actor_id: entry.actor_id,
    actor_user_id: deriveActorUserId(entry),
    action: entry.action,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id ?? null,
    details: entry.details ?? null,
    ip_address: entry.ip_address ?? null,
  });
}
