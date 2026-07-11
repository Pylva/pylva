-- B2a Phase 0a — Migration 011
-- Slugged URLs: every builder gets a stable URL-safe slug used in
-- dashboard paths (/o/{slug}/dashboard/...). Decision D7.
--
-- Slug invariants:
--  - lowercase ascii-alnum + hyphen
--  - starts with alnum, ends with alnum
--  - 3..48 chars (reserve a few for disambiguator suffix)
--  - UNIQUE across all builders
--  - IMMUTABLE once set (UI change path ships in B3 per §11 open item)
--
-- Existing builders: backfill from lower(name) or 'builder-<first-8-of-id>'.
-- Per internal design notes (migration 011) + §2b (D7).

-- Helper fn: normalize an input string to a slug candidate.
-- - lower, strip non-alnum to hyphens, collapse repeats, trim, clamp to 48
-- Not UNIQUE-safe on its own — callers append a random suffix on collision.
CREATE OR REPLACE FUNCTION generate_slug(input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate TEXT;
BEGIN
  candidate := lower(coalesce(input, ''));
  candidate := regexp_replace(candidate, '[^a-z0-9]+', '-', 'g');
  candidate := regexp_replace(candidate, '(^-+|-+$)', '', 'g');
  candidate := regexp_replace(candidate, '-{2,}', '-', 'g');
  IF length(candidate) < 3 THEN
    candidate := 'builder-' || substr(md5(random()::text), 1, 6);
  END IF;
  RETURN substring(candidate FROM 1 FOR 48);
END;
$$;

ALTER TABLE builders ADD COLUMN slug TEXT;

-- Backfill existing rows with derived slugs.
-- generate_slug may collide; disambiguate with -<4-hex>.
-- In dev we only expect a handful of seed rows; this is cheap.
UPDATE builders
SET slug = generate_slug(name) || '-' || substr(id::text, 1, 4)
WHERE slug IS NULL;

ALTER TABLE builders
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT builders_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,46}[a-z0-9])?$'),
  ADD CONSTRAINT builders_slug_unique UNIQUE (slug);

CREATE INDEX idx_builders_slug ON builders(slug);
