// B3 Phase 0c — ClickHouse tenant-isolation guard (D11, I-CH-1)
//
// Defense-in-depth: every ClickHouse call site should pass the builderId it
// queries AND the builderId claimed by the caller's JWT (or API key context).
// If they ever diverge, that's a bug worth crashing the request.
//
// Usage (route handler):
//   const jwtBuilderId = session.builderId;
//   const queryBuilderId = params.builderId; // from path / body
//   assertBuilderId(queryBuilderId, jwtBuilderId);
//   await getOverview(queryBuilderId, range);
//
// Why not wrap every dashboard-queries.ts function:
//   Existing signatures only take one `builderId`. Rolling the guard into
//   each of them would cascade into every caller's signature. Instead, the
//   guard is enforced at the API-route seam, which is the single place the
//   mismatch could ever be introduced.

export class BuilderIdMismatchError extends Error {
  readonly code = 'BUILDER_ID_MISMATCH';
  constructor(
    public readonly queryBuilderId: string,
    public readonly jwtBuilderId: string,
  ) {
    super('ClickHouse query builder_id does not match authenticated builder_id');
  }
}

/**
 * Throws {@link BuilderIdMismatchError} when the builder_id embedded in a
 * ClickHouse query differs from the builder_id claimed by the caller's JWT
 * / API key. Callers MUST invoke this before any query that takes builderId
 * from user-controllable input (path params, body, query string).
 */
export function assertBuilderId(queryBuilderId: string, jwtBuilderId: string): void {
  if (queryBuilderId !== jwtBuilderId) {
    throw new BuilderIdMismatchError(queryBuilderId, jwtBuilderId);
  }
}
