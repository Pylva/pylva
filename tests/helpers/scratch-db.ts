import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';

const DEFAULT_DATABASE_URL = 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

export interface ScratchDb {
  name: string;
  url: string;
  sql: Sql;
  drop(): Promise<void>;
}

function databaseUrlForName(baseUrl: string, name: string): string {
  const nextUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  if (nextUrl === baseUrl) {
    throw new Error('Unable to replace database name in DATABASE_URL');
  }
  return nextUrl;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function createScratchDb(opts?: { prefix?: string }): Promise<ScratchDb> {
  const baseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const prefix = opts?.prefix ?? 'pylva_scratch';
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
  const name = `${safePrefix}_${randomBytes(6).toString('hex')}`;
  const url = databaseUrlForName(baseUrl, name);
  const managementSql = postgres(baseUrl, { max: 1, onnotice: () => undefined });

  try {
    await managementSql.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await managementSql.end();
  }

  const sql = postgres(url, { max: 1, onnotice: () => undefined });

  return {
    name,
    url,
    sql,
    drop: async (): Promise<void> => {
      try {
        await sql.end();
      } catch {
        // drop() is intentionally idempotent for try/finally cleanup paths.
      }

      const dropSql = postgres(baseUrl, { max: 1, onnotice: () => undefined });
      try {
        await dropSql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      } finally {
        await dropSql.end();
      }
    },
  };
}

export async function applyMigrationsThrough(
  scratch: ScratchDb,
  lastPrefix: string,
): Promise<string[]> {
  const migrationsDir = path.resolve('db/migrations');
  const maxPrefix = Number.parseInt(lastPrefix.slice(0, 3), 10);
  const filenames = (await fs.readdir(migrationsDir))
    .filter((filename) => filename.endsWith('.sql'))
    .filter((filename) => {
      const prefix = Number.parseInt(filename.slice(0, 3), 10);
      return Number.isFinite(prefix) && prefix <= maxPrefix;
    })
    .sort();

  for (const filename of filenames) {
    const content = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    await scratch.sql.begin((sql) => sql.unsafe(content));
  }

  return filenames;
}
