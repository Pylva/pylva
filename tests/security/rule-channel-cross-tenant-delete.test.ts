// Cross-tenant rule-alert-channel deletion regression.
//
// `rule_alert_channels` has no builder_id column; its tenant boundary is the
// parent rule's builder_id. Because the app role owns the tables and no table
// sets FORCE ROW LEVEL SECURITY, withRLS() is only a backstop. The DELETE and
// POST paths must explicitly scope through the parent rule and related channel
// targets in repository predicates.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { NextRequest } from 'next/server.js';
import { Role } from '@pylva/shared';

import { DELETE as deleteChannel } from '../../src/app/api/v1/rules/[id]/channels/[channel_id]/route.js';
import { POST as postChannel } from '../../src/app/api/v1/rules/[id]/channels/route.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

let sql: ReturnType<typeof postgres>;
let attackerBuilderId = '';
let victimBuilderId = '';
let freeBuilderId = '';
let attackerUserId = '';
let freeUserId = '';
let attackerWebhookConfigId = '';
let victimWebhookConfigId = '';

const suffix = crypto.randomBytes(4).toString('hex');
const builderIdsToCleanup: string[] = [];
const userIdsToCleanup: string[] = [];

function dashboardDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/x/channels/y', {
    method: 'DELETE',
    headers: {
      'x-builder-id': attackerBuilderId,
      'x-user-id': attackerUserId,
      'x-user-role': Role.OWNER,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function dashboardPostRequest(
  body: Record<string, unknown>,
  context: { builderId?: string; userId?: string } = {},
): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/x/channels', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-builder-id': context.builderId ?? attackerBuilderId,
      'x-user-id': context.userId ?? attackerUserId,
      'x-user-role': Role.OWNER,
    },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

async function insertRuleWithSlackChannel(
  builderId: string,
): Promise<{ ruleId: string; channelId: string }> {
  const label = crypto.randomBytes(4).toString('hex');
  const [rule] = await sql<{ id: string }[]>`
    INSERT INTO rules (builder_id, type, enforcement, name, config)
    VALUES (${builderId}, 'cost_threshold', 'post_call', ${`rule-${suffix}-${label}`}, '{}')
    RETURNING id
  `;
  const [channel] = await sql<{ id: string }[]>`
    INSERT INTO rule_alert_channels (rule_id, channel, slack_webhook_url)
    VALUES (${rule!.id}, 'slack', 'https://hooks.slack.com/services/xtenant-test')
    RETURNING id
  `;
  return { ruleId: rule!.id, channelId: channel!.id };
}

async function insertWebhookConfig(builderId: string, label: string): Promise<string> {
  const [webhook] = await sql<{ id: string }[]>`
    INSERT INTO webhook_configs (builder_id, url, events, secret)
    VALUES (
      ${builderId},
      ${`https://example.com/${label}-${suffix}`},
      ARRAY['rule.fired']::text[],
      ${`whsec_${label}_${suffix}`}
    )
    RETURNING id
  `;
  return webhook!.id;
}

async function channelExists(channelId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM rule_alert_channels WHERE id = ${channelId}
  `;
  return row !== undefined;
}

async function channelRemoveAuditRows(channelId: string) {
  return sql<{ id: number; details: { rule_id?: string } | null }[]>`
    SELECT id, details
      FROM audit_log
     WHERE builder_id = ${attackerBuilderId}
       AND action = 'rule.channel_remove'
       AND resource_type = 'rule_alert_channel'
       AND resource_id = ${channelId}
     ORDER BY timestamp DESC
  `;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);

  const [attacker] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`rac-attacker-${suffix}@test.com`}, 'Attacker A', 'pro', ${`rac-attacker-${suffix}`})
    RETURNING id
  `;
  attackerBuilderId = attacker!.id;
  builderIdsToCleanup.push(attackerBuilderId);

  const [victim] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`rac-victim-${suffix}@test.com`}, 'Victim B', 'pro', ${`rac-victim-${suffix}`})
    RETURNING id
  `;
  victimBuilderId = victim!.id;
  builderIdsToCleanup.push(victimBuilderId);

  const [freeBuilder] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`rac-free-${suffix}@test.com`}, 'Free C', 'free', ${`rac-free-${suffix}`})
    RETURNING id
  `;
  freeBuilderId = freeBuilder!.id;
  builderIdsToCleanup.push(freeBuilderId);

  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${`rac-user-${suffix}@test.com`}, 'magic_link')
    RETURNING id
  `;
  attackerUserId = user!.id;
  userIdsToCleanup.push(attackerUserId);

  const [freeUser] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${`rac-free-user-${suffix}@test.com`}, 'magic_link')
    RETURNING id
  `;
  freeUserId = freeUser!.id;
  userIdsToCleanup.push(freeUserId);

  await sql`
    INSERT INTO user_builder_memberships (user_id, builder_id, role)
    VALUES (${attackerUserId}, ${attackerBuilderId}, 'owner')
  `;
  await sql`
    INSERT INTO user_builder_memberships (user_id, builder_id, role)
    VALUES (${freeUserId}, ${freeBuilderId}, 'owner')
  `;

  attackerWebhookConfigId = await insertWebhookConfig(attackerBuilderId, 'attacker');
  victimWebhookConfigId = await insertWebhookConfig(victimBuilderId, 'victim');
});

afterAll(async () => {
  if (!sql) return;
  try {
    if (builderIdsToCleanup.length > 0) {
      await sql`DELETE FROM rule_alert_channels WHERE rule_id IN (
        SELECT id FROM rules WHERE builder_id IN ${sql(builderIdsToCleanup)}
      )`;
      await sql`DELETE FROM rules WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
      await sql`DELETE FROM webhook_configs WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
      await sql`DELETE FROM audit_log WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
      await sql`DELETE FROM user_builder_memberships WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
    }
    if (userIdsToCleanup.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIdsToCleanup)}`;
    }
    if (builderIdsToCleanup.length > 0) {
      await sql`DELETE FROM builders WHERE id IN ${sql(builderIdsToCleanup)}`;
    }
  } finally {
    await sql.end();
  }
});

describe('DELETE /api/v1/rules/[id]/channels/[channel_id] tenant isolation', () => {
  it("returns 404 and preserves the row when builder A supplies builder B's rule id and channel id", async () => {
    const victim = await insertRuleWithSlackChannel(victimBuilderId);

    const response = await deleteChannel(dashboardDeleteRequest(), {
      params: Promise.resolve({
        id: victim.ruleId,
        channel_id: victim.channelId,
      }),
    });

    expect(response.status).toBe(404);
    await expect(channelExists(victim.channelId)).resolves.toBe(true);
    await expect(channelRemoveAuditRows(victim.channelId)).resolves.toEqual([]);
  });

  it("returns 404 and preserves the row when builder A supplies A's rule id with builder B's channel id", async () => {
    const attacker = await insertRuleWithSlackChannel(attackerBuilderId);
    const victim = await insertRuleWithSlackChannel(victimBuilderId);

    const response = await deleteChannel(dashboardDeleteRequest(), {
      params: Promise.resolve({
        id: attacker.ruleId,
        channel_id: victim.channelId,
      }),
    });

    expect(response.status).toBe(404);
    await expect(channelExists(attacker.channelId)).resolves.toBe(true);
    await expect(channelExists(victim.channelId)).resolves.toBe(true);
    await expect(channelRemoveAuditRows(victim.channelId)).resolves.toEqual([]);
  });

  it('deletes and audit-logs an owned channel', async () => {
    const attacker = await insertRuleWithSlackChannel(attackerBuilderId);

    const response = await deleteChannel(dashboardDeleteRequest(), {
      params: Promise.resolve({
        id: attacker.ruleId,
        channel_id: attacker.channelId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(channelExists(attacker.channelId)).resolves.toBe(false);
    await expect(channelRemoveAuditRows(attacker.channelId)).resolves.toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ rule_id: attacker.ruleId }),
      }),
    ]);
  });

  it('returns 404 for a nonexistent channel under an owned rule without removing siblings', async () => {
    const attacker = await insertRuleWithSlackChannel(attackerBuilderId);
    const missingChannelId = crypto.randomUUID();

    const response = await deleteChannel(dashboardDeleteRequest(), {
      params: Promise.resolve({
        id: attacker.ruleId,
        channel_id: missingChannelId,
      }),
    });

    expect(response.status).toBe(404);
    await expect(channelExists(attacker.channelId)).resolves.toBe(true);
    await expect(channelRemoveAuditRows(missingChannelId)).resolves.toEqual([]);
  });
});

describe('POST /api/v1/rules/[id]/channels tenant isolation', () => {
  it('returns 404 for a free-tier builder using another builder webhook target', async () => {
    const freeRule = await insertRuleWithSlackChannel(freeBuilderId);

    const response = await postChannel(
      dashboardPostRequest(
        {
          channel: 'webhook',
          webhook_config_id: victimWebhookConfigId,
        },
        { builderId: freeBuilderId, userId: freeUserId },
      ),
      {
        params: Promise.resolve({ id: freeRule.ruleId }),
      },
    );
    expect(response.status).toBe(404);

    const rows = await sql<{ id: string }[]>`
      SELECT id
        FROM rule_alert_channels
       WHERE rule_id = ${freeRule.ruleId}
         AND webhook_config_id = ${victimWebhookConfigId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("returns 404 and inserts nothing when builder A uses builder B's webhook config", async () => {
    const attacker = await insertRuleWithSlackChannel(attackerBuilderId);

    const response = await postChannel(
      dashboardPostRequest({
        channel: 'webhook',
        webhook_config_id: victimWebhookConfigId,
      }),
      {
        params: Promise.resolve({ id: attacker.ruleId }),
      },
    );

    expect(response.status).toBe(404);

    const rows = await sql<{ id: string }[]>`
      SELECT id
        FROM rule_alert_channels
       WHERE rule_id = ${attacker.ruleId}
         AND webhook_config_id = ${victimWebhookConfigId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('creates a webhook channel when builder A uses its own webhook config', async () => {
    const attacker = await insertRuleWithSlackChannel(attackerBuilderId);

    const response = await postChannel(
      dashboardPostRequest({
        channel: 'webhook',
        webhook_config_id: attackerWebhookConfigId,
      }),
      {
        params: Promise.resolve({ id: attacker.ruleId }),
      },
    );

    expect(response.status).toBe(201);

    const rows = await sql<{ id: string }[]>`
      SELECT id
        FROM rule_alert_channels
       WHERE rule_id = ${attacker.ruleId}
         AND webhook_config_id = ${attackerWebhookConfigId}
    `;
    expect(rows).toHaveLength(1);
  });
});
