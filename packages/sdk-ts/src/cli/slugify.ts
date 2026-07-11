// B3-T4a — CLI-side slug normalizer.
//
// Must produce the same output as the server-side slugify in
// src/lib/ingest/last-seen-buffer.ts:17 so CLI-declared slugs match the regex
// enforced on POST /api/v1/cost-sources (^[a-z0-9][a-z0-9-]*$) and the slugs
// that ingest auto-register creates for LLM providers.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
