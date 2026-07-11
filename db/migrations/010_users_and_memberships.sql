-- B2a Phase 0a — Migration 010
-- Users, builder memberships, and invites. Supports the "builder = org" model
-- introduced in v1.0 (Decision D5). RLS on all three tables.
--
-- Per internal design notes (migration 010) + §2b (D5 org model)
-- Pre-req: 001_foundation.sql (builders exists).

CREATE EXTENSION IF NOT EXISTS "citext";

-------------------------------------------------------------------
-- users: Individual humans who log in. A user may belong to many
-- builders via user_builder_memberships.
-------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT NOT NULL UNIQUE,           -- case-insensitive: GitHub/Google normalize differently
  display_name   TEXT,
  avatar_url     TEXT,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- RLS: a user can read/modify only their own row (set via app.user_id GUC).
-- Back-end routes that need to touch arbitrary users (admin ops) run as superuser.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = current_setting('app.user_id', true)::uuid);

-------------------------------------------------------------------
-- user_builder_memberships: Role-scoped attachment of a user to a
-- builder. (user_id, builder_id) UNIQUE — one role per user per org.
-- Roles: owner (destructive + billing) | member (everything else).
-------------------------------------------------------------------
CREATE TABLE user_builder_memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, builder_id)
);

CREATE INDEX idx_memberships_user ON user_builder_memberships(user_id);
CREATE INDEX idx_memberships_builder ON user_builder_memberships(builder_id);

-- RLS: scoped by builder_id like every other tenant table.
ALTER TABLE user_builder_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation ON user_builder_memberships
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- invites: Pending invitations to join a builder. token is looked
-- up server-side; accepted_at nulls until redeem. expires_at bounds
-- the useful lifetime (default 7d in app layer, enforced at verify).
-------------------------------------------------------------------
CREATE TABLE invites (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id          UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  email               CITEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token               TEXT NOT NULL UNIQUE,           -- URL-safe opaque (crypto-random, 32 bytes hex)
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,                    -- null until first accept
  invited_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_builder ON invites(builder_id);
CREATE INDEX idx_invites_token ON invites(token);
CREATE INDEX idx_invites_email ON invites(email);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_isolation ON invites
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
