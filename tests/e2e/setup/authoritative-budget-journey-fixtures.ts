/**
 * Stable public identities for the real authoritative-control browser journey.
 *
 * Keep these values content-free: the seed and Playwright assertions share
 * only correlation identifiers and expected public labels, never prompts,
 * tool arguments/results, credentials, or provider payloads.
 */
export const AUTHORITATIVE_E2E = {
  customerId: 'control_demo_user',
  blockedOnlyCustomerId: 'blocked_only_user',
  ruleId: 'e2eb0000-0000-4000-8000-000000000001',
  ruleName: 'Authoritative agent daily budget',
  budgetLimitUsd: '0.0009',
  primaryTraceId: 'e2eb1000-0000-4000-8000-000000000001',
  blockedOnlyTraceId: 'e2eb1000-0000-4000-8000-000000000002',
  operations: {
    llm: 'e2eb2000-0000-4000-8000-000000000001',
    tool: 'e2eb2000-0000-4000-8000-000000000002',
    refused: 'e2eb2000-0000-4000-8000-000000000003',
    blockedOnly: 'e2eb2000-0000-4000-8000-000000000004',
  },
  spans: {
    llm: 'e2eb3000-0000-4000-8000-000000000001',
    tool: 'e2eb3000-0000-4000-8000-000000000002',
    refused: 'e2eb3000-0000-4000-8000-000000000003',
    blockedOnly: 'e2eb3000-0000-4000-8000-000000000004',
  },
  steps: {
    llm: 'draft_answer',
    tool: 'search_knowledge',
    refused: 'verify_answer',
    blockedOnly: 'blocked_before_dispatch',
  },
  expected: {
    llmActualUsd: '0.00021',
    toolActualUsd: '0.000004',
    committedUsd: '0.000214',
    primaryActions: 3,
    primaryCharged: 2,
    primaryRefused: 1,
  },
} as const;
