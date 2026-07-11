// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — tiny hash helper split out so pure tests don't pull the DB /
// env validation chain in via idempotency.ts → rls.ts → client.ts → config.ts.

import { createHash } from 'node:crypto';

export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
