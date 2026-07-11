// PostgreSQL client via porsager/postgres + Drizzle ORM
// Decision #16: postgres (porsager) as PG driver

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config.js';
import { getDbPassword } from './credentials.js';

// When the RDS-managed master secret ARN is available (ECS/Lambda), fetch the
// CURRENT password per connection so an AWS-side password rotation is picked up
// without a container restart. porsager/postgres calls a `password` function on
// each new connection and it overrides the password baked into DATABASE_URL
// (parseOptions: o.password || url.password). Local/dev/test leave the ARN unset
// and keep the static DATABASE_URL password. See db/credentials.ts and the
// internal operations notes.
const credentialRefresher = env.DB_MASTER_USER_SECRET_ARN
  ? { password: () => getDbPassword() }
  : {};

// Connection pool via porsager/postgres
const queryClient = postgres(env.DATABASE_URL, {
  max: 20, // Connection pool size
  idle_timeout: 20, // Close idle connections after 20s
  max_lifetime: 60 * 30, // Max connection lifetime: 30 min
  ...credentialRefresher,
});

// Drizzle ORM instance — use drizzle-orm/postgres-js adapter
export const db = drizzle(queryClient);

// Raw SQL client for migrations and direct queries
export const sql = queryClient;

// Graceful shutdown
export async function closeDb(): Promise<void> {
  await queryClient.end();
}
