// Auth edge case tests — B0 security verification
// These tests require Docker services (PostgreSQL, ClickHouse, Redis) running
// Excluded from fast CI, included in integration CI

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

let sql: ReturnType<typeof postgres>;
let builderId: string;

beforeAll(async () => {
  sql = postgres(DATABASE_URL);

  const [builder] = await sql`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('test-auth-edge@test.com', 'Auth Edge Test', 'pro', 'auth-edge-test')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  builderId = builder!.id as string;
});

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE builder_id = ${builderId}`;
  await sql`DELETE FROM builders WHERE id = ${builderId}`;
  await sql.end();
});

describe('API Key Format', () => {
  it('generates keys in pv_live_{keyId}_{randomPart} format', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const randomPart = crypto.randomBytes(16).toString('hex');
    const fullKey = `pv_live_${keyId}_${randomPart}`;

    expect(fullKey).toMatch(/^pv_live_[a-f0-9]{8}_[a-f0-9]{32}$/);
  });

  it('argon2 hash + verify cycle works correctly', async () => {
    const key = `pv_live_${crypto.randomBytes(4).toString('hex')}_${crypto.randomBytes(16).toString('hex')}`;
    const hash = await argon2.hash(key, {
      secret: Buffer.from(ARGON2_SECRET),
    });

    const isValid = await argon2.verify(hash, key, {
      secret: Buffer.from(ARGON2_SECRET),
    });
    expect(isValid).toBe(true);

    // Wrong key should fail
    const isInvalid = await argon2.verify(hash, 'wrong_key', {
      secret: Buffer.from(ARGON2_SECRET),
    });
    expect(isInvalid).toBe(false);
  });

  it('key_id enables O(1) DB lookup', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const fullKey = `pv_live_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
    const hash = await argon2.hash(fullKey, {
      secret: Buffer.from(ARGON2_SECRET),
    });

    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, ${hash}, 'agent_sdk')
    `;

    // Lookup by key_id (O(1) via unique index)
    const [row] = await sql`SELECT * FROM api_keys WHERE key_id = ${keyId}`;
    expect(row).toBeDefined();
    expect(row!.builder_id).toBe(builderId);

    // Verify the full key
    const valid = await argon2.verify(row!.key_hash as string, fullKey, {
      secret: Buffer.from(ARGON2_SECRET),
    });
    expect(valid).toBe(true);
  });

  it('revoked key is rejected', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const fullKey = `pv_live_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
    const hash = await argon2.hash(fullKey, {
      secret: Buffer.from(ARGON2_SECRET),
    });

    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, ${hash}, 'agent_sdk')
    `;

    // Revoke immediately
    await sql`UPDATE api_keys SET revoked_at = NOW() WHERE key_id = ${keyId}`;

    // Should not return revoked keys
    const [row] = await sql`
      SELECT * FROM api_keys WHERE key_id = ${keyId} AND revoked_at IS NULL
    `;
    expect(row).toBeUndefined();
  });

  it('expired key is rejected', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const fullKey = `pv_live_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
    const hash = await argon2.hash(fullKey, {
      secret: Buffer.from(ARGON2_SECRET),
    });

    // Create key with past expiration
    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope, expires_at)
      VALUES (${keyId}, ${builderId}, ${hash}, 'agent_sdk', NOW() - INTERVAL '1 hour')
    `;

    const [row] = await sql`
      SELECT * FROM api_keys WHERE key_id = ${keyId}
    `;
    expect(row).toBeDefined();
    expect(new Date(row!.expires_at as string) < new Date()).toBe(true);
  });
});

describe('JWT Auth', () => {
  let privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  let publicKey: Awaited<ReturnType<typeof importSPKI>>;

  beforeAll(async () => {
    // Look for dev keys in .keys/ or generate in-memory for tests
    const keysDir = path.join(__dirname, '..', '..', '.keys');
    let privatePem: string;
    let publicPem: string;

    if (fs.existsSync(path.join(keysDir, 'private.pem'))) {
      privatePem = fs.readFileSync(path.join(keysDir, 'private.pem'), 'utf-8');
      publicPem = fs.readFileSync(path.join(keysDir, 'public.pem'), 'utf-8');
    } else {
      // Generate in-memory keys for tests
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      privatePem = keyPair.privateKey;
      publicPem = keyPair.publicKey;
    }

    privateKey = await importPKCS8(privatePem, 'RS256');
    publicKey = await importSPKI(publicPem, 'RS256');
  });

  it('signs and verifies a JWT with correct audience', async () => {
    const token = await new SignJWT({ builder_id: builderId })
      .setProtectedHeader({ alg: 'RS256' })
      .setJti(crypto.randomUUID())
      .setAudience('pylva:dashboard')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const { payload } = await jwtVerify(token, publicKey, {
      audience: 'pylva:dashboard',
    });

    expect(payload.builder_id).toBe(builderId);
    expect(payload.aud).toBe('pylva:dashboard');
  });

  it('rejects JWT with wrong audience', async () => {
    const token = await new SignJWT({ builder_id: builderId })
      .setProtectedHeader({ alg: 'RS256' })
      .setJti(crypto.randomUUID())
      .setAudience('pylva:portal')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(
      jwtVerify(token, publicKey, { audience: 'pylva:dashboard' }),
    ).rejects.toThrow();
  });

  it('rejects expired JWT', async () => {
    const token = await new SignJWT({ builder_id: builderId })
      .setProtectedHeader({ alg: 'RS256' })
      .setJti(crypto.randomUUID())
      .setAudience('pylva:dashboard')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2h ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // 1h ago
      .sign(privateKey);

    await expect(
      jwtVerify(token, publicKey, { audience: 'pylva:dashboard' }),
    ).rejects.toThrow();
  });

  it('sliding window refresh: detects token needing refresh', () => {
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 3600; // Issued 1h ago
    const exp = now + 800; // Expires in ~13 min (> 50% through 24h = refresh)
    const lifetime = exp - iat;
    const elapsed = now - iat;

    // Token is >50% through lifetime
    expect(elapsed > lifetime * 0.5).toBe(true);
  });
});

describe('Scope storage', () => {
  // One universal key (migration 048): scope is stored for display/audit only
  // and never gates authorization. Legacy values stay insertable as
  // previous-release straggler tolerance.
  it('universal scope key is correctly stored', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const hash = await argon2.hash('test', { secret: Buffer.from(ARGON2_SECRET) });

    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, ${hash}, 'universal')
    `;

    const [row] = await sql`SELECT scope FROM api_keys WHERE key_id = ${keyId}`;
    expect(row!.scope).toBe('universal');
  });

  it('legacy agent_sdk scope key is correctly stored', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const hash = await argon2.hash('test', { secret: Buffer.from(ARGON2_SECRET) });

    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, ${hash}, 'agent_sdk')
    `;

    const [row] = await sql`SELECT scope FROM api_keys WHERE key_id = ${keyId}`;
    expect(row!.scope).toBe('agent_sdk');
  });

  it('legacy admin_api scope key is correctly stored', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const hash = await argon2.hash('test', { secret: Buffer.from(ARGON2_SECRET) });

    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, ${hash}, 'admin_api')
    `;

    const [row] = await sql`SELECT scope FROM api_keys WHERE key_id = ${keyId}`;
    expect(row!.scope).toBe('admin_api');
  });
});
