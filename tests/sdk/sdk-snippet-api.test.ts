import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as snippets from '../../src/lib/sdk-snippets';

// Guard against SDK-snippet drift. Public onboarding and agent-facing code
// examples must match the REAL SDK surface (packages/sdk-{ts,py}), not stale
// README shapes. These are strings, so tsc cannot catch API drift.

const EXPORTED_SNIPPETS: Record<string, string> = {
  TS_MARKETING_SNIPPET: snippets.TS_MARKETING_SNIPPET,
  PY_MARKETING_SNIPPET: snippets.PY_MARKETING_SNIPPET,
  TS_QUICKSTART: snippets.TS_QUICKSTART,
  PY_QUICKSTART: snippets.PY_QUICKSTART,
  TS_REPORT_USAGE: snippets.TS_REPORT_USAGE,
  PY_REPORT_USAGE: snippets.PY_REPORT_USAGE,
};

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  {
    re: /import pylva from/,
    why: 'no default export - use named { init, track, reportUsage }',
  },
  { re: /\bmeter\.track\(/, why: 'track is a standalone function, not a Pylva method' },
  { re: /\bmeter\.(report_usage|reportUsage)\(/, why: 'reportUsage is standalone, not a method' },
  { re: /\btrack\(\s*\{/, why: 'track(customerId, ...) takes a string first arg, not an object' },
  { re: /metric_value/, why: 'reportUsage field is `value`, not `metric_value`' },
  { re: /\b(inputTokens|outputTokens)\b/, why: 'tokens are auto-captured; never passed manually' },
  {
    re: /\b(input_tokens|output_tokens)\s*=/,
    why: 'tokens are auto-captured; never passed manually',
  },
  {
    re: /\bstepName\b|step_name\s*[:=]/,
    why: 'the SDK input field/kwarg is `step`, not step_name',
  },
  { re: /\b(unit|amount)\s*:/, why: 'reportUsage uses { tool, metric, value }, not unit/amount' },
];

describe('SDK snippets match the real SDK API', () => {
  const allSnippets = Object.entries(EXPORTED_SNIPPETS).map(([label, code]) => ({ label, code }));

  it('collected the snippet corpus', () => {
    expect(Object.keys(EXPORTED_SNIPPETS).length).toBe(6);
  });

  for (const { label, code } of allSnippets) {
    it(`${label} uses no stale SDK API`, () => {
      for (const { re, why } of FORBIDDEN) {
        expect(re.test(code), `${label}: ${why}`).toBe(false);
      }
    });
  }

  it('reportUsage examples use the canonical fields', () => {
    for (const code of [snippets.TS_REPORT_USAGE, snippets.PY_REPORT_USAGE]) {
      expect(code).toMatch(/\btool\b/);
      expect(code).toMatch(/\bmetric\b/);
      expect(code).toMatch(/\bvalue\b/);
    }
  });

  it('track examples pass a customer id first (not an object) or use track_context', () => {
    for (const code of [snippets.TS_QUICKSTART, snippets.TS_MARKETING_SNIPPET]) {
      expect(/\btrack\(\s*[^{\s]/.test(code)).toBe(true);
    }
    for (const code of [snippets.PY_QUICKSTART, snippets.PY_MARKETING_SNIPPET]) {
      expect(/track_context\(/.test(code)).toBe(true);
    }
  });
});

const SDK_README_PATHS = [
  fileURLToPath(new URL('../../packages/sdk-ts/README.md', import.meta.url)),
  fileURLToPath(new URL('../../packages/sdk-py/README.md', import.meta.url)),
];
const AGENT_GUIDE_PATH = fileURLToPath(new URL('../../AGENTS.md', import.meta.url));
const AGENT_FACING_DOC_PATHS = [...SDK_README_PATHS, AGENT_GUIDE_PATH];

function codeFences(markdown: string): string[] {
  const out: string[] = [];
  const re = /```(?:ts|typescript|js|javascript|python|py)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) out.push(match[1]!);
  return out;
}

describe('SDK README and agent guide code samples match the real SDK API', () => {
  for (const path of AGENT_FACING_DOC_PATHS) {
    const name = path.endsWith('/AGENTS.md') ? 'AGENTS.md' : path.split('/').slice(-2).join('/');
    const blocks = codeFences(readFileSync(path, 'utf8'));

    it(`${name} has code samples`, () => {
      expect(blocks.length).toBeGreaterThan(0);
    });

    blocks.forEach((code, index) => {
      it(`${name} block #${index + 1} uses no stale SDK API`, () => {
        for (const { re, why } of FORBIDDEN) {
          expect(re.test(code), `${name} block #${index + 1}: ${why}`).toBe(false);
        }
      });
    });
  }
});

describe('agent guide LangGraph callback entrypoints', () => {
  const agentGuide = readFileSync(AGENT_GUIDE_PATH, 'utf8');

  it('documents the Python and TypeScript callback imports', () => {
    expect(agentGuide).toContain('pip install "pylva-sdk[langchain]"');
    expect(agentGuide).toContain('from pylva.langchain import PylvaCallbackHandler');
    expect(agentGuide).toContain('npm i @pylva/sdk @langchain/core @langchain/langgraph');
    expect(agentGuide).toContain("import { PylvaCallbackHandler } from '@pylva/sdk/langgraph';");
    expect(agentGuide).toContain('track_context');
  });
});
