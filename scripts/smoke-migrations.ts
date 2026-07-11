// One-off smoke test: apply every migration against a throwaway Postgres DB
// to confirm DDL validity. Used during Phase 0a to verify 010–019 apply clean.
// This script is run manually, not in CI.

import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const baseUrl =
    process.env['DATABASE_URL'] ??
    'postgresql://pylva:pylva_dev@localhost:5432/pylva';
  const sql = postgres(baseUrl);
  const dbName = `pylva_m_smoke_${Date.now().toString(36)}`;
  console.log('Creating test DB:', dbName);
  await sql.unsafe(`CREATE DATABASE ${dbName}`);

  const testUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const testSql = postgres(testUrl);

  try {
    const migrationDir = path.resolve('db/migrations');
    const files = fs
      .readdirSync(migrationDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(migrationDir, f), 'utf-8');
      process.stdout.write(`  ${f}... `);
      await testSql.unsafe(content);
      process.stdout.write('ok\n');
    }
    console.log('\nAll migrations applied cleanly.');
  } finally {
    await testSql.end();
    await sql.unsafe(`DROP DATABASE ${dbName}`);
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
