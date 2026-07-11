-- 049_backfill_builder_owner_memberships.sql
-- Link legacy/provisioned builders to already-created users with the same
-- verified email. This repairs OAuth/magic-link attempts that created a user
-- row, then failed when org creation hit builders.email UNIQUE.

INSERT INTO user_builder_memberships (user_id, builder_id, role)
SELECT u.id, b.id, 'owner'
FROM builders b
JOIN users u ON lower(u.email::text) = lower(b.email)
WHERE NOT EXISTS (
  SELECT 1
  FROM user_builder_memberships m
  WHERE m.user_id = u.id
    AND m.builder_id = b.id
)
ON CONFLICT (user_id, builder_id) DO NOTHING;
