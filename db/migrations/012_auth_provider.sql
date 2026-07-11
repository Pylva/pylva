-- B2a Phase 0a — Migration 012
-- Record which auth path a user used. `mixed` means the user has linked
-- both OAuth and magic-link; we allow that (D10/edge-case §5.4).
-- No magic_links table: tokens live in Redis with 15-min TTL.
--
-- Per internal design notes (migration 012) + §2c (D10/D12).

ALTER TABLE users
  ADD COLUMN auth_provider TEXT
    CHECK (auth_provider IN ('oauth_google', 'oauth_github', 'magic_link', 'mixed'));

-- Existing rows: no users table contents yet in this environment (B0/B1
-- introduced builders but not users). Leaving auth_provider nullable
-- intentionally — first login sets the value; NULL means "never logged in
-- via any flow" (e.g. a seed/test user). The API layer requires a value
-- on OAuth/magic-link path.
