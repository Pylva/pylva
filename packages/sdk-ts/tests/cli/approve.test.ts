// B3-T4a — approve flow coverage. Fakes stdin + fetch so the interactive
// readline path and the HTTP POST are exercised without a real terminal or
// a real backend.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runApprove } from '../../src/cli/approve.js';
import type { Detection } from '../../src/cli/ci-check.js';

const CLI_KEY = 'pv_cli_aabbccdd_' + 'a'.repeat(32);

function nonLlmDetection(slug: string, suggestedMetric = 'requests'): Detection {
  return {
    package: slug,
    manifest: '/tmp/fake/package.json',
    kind: 'non_llm_suggested',
    display_name: slug === 'elevenlabs' ? 'ElevenLabs' : slug,
    slug,
    suggested_metric: suggestedMetric,
  };
}

function llmDetection(slug: string): Detection {
  return {
    package: slug,
    manifest: '/tmp/fake/package.json',
    kind: 'llm_provider',
    display_name: slug,
    slug,
  };
}

/** Scripted prompt — pops the next answer for each question asked. */
function scriptedPrompt(answers: string[]): (q: string) => Promise<string> {
  const queue = [...answers];
  return async () => {
    if (queue.length === 0) return '';
    return queue.shift()!;
  };
}

describe('runApprove', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-approve-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('rejects when no API key is provided, naming PYLVA_API_KEY', async () => {
    await expect(
      runApprove([nonLlmDetection('elevenlabs')], {
        cwd,
        cliKey: '',
        prompt: scriptedPrompt([]),
      }),
    ).rejects.toThrow(/PYLVA_API_KEY/);
  });

  it('rejects a malformed key', async () => {
    await expect(
      runApprove([nonLlmDetection('elevenlabs')], {
        cwd,
        cliKey: 'pv_live_' + 'a'.repeat(40), // no keyId/random split
        prompt: scriptedPrompt([]),
      }),
    ).rejects.toThrow(/PYLVA_API_KEY/);
  });

  // One universal key: a pv_live_* key (the only kind minted now) works for
  // approve; legacy pv_cli_* keys keep working (CLI_KEY fixture below).
  it('accepts a pv_live_* universal key', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ cost_source: { slug: 'elevenlabs' } }), { status: 201 });

    const result = await runApprove([nonLlmDetection('elevenlabs', 'requests')], {
      cwd,
      cliKey: 'pv_live_aabbccdd_' + 'b'.repeat(32),
      prompt: scriptedPrompt(['y', '', '', 'character', '1', '0.0003']),
      fetchImpl: fakeFetch,
    });

    expect(result.declared).toHaveLength(1);
  });

  it('prefers PYLVA_API_KEY over the legacy PYLVA_CLI_KEY env var', async () => {
    const preferred = 'pv_live_11223344_' + 'c'.repeat(32);
    const legacy = 'pv_cli_99887766_' + 'd'.repeat(32);
    const seenAuth: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      seenAuth.push(((init?.headers ?? {}) as Record<string, string>)['authorization'] ?? '');
      return new Response(JSON.stringify({ cost_source: { slug: 'elevenlabs' } }), {
        status: 201,
      });
    };

    const previousApiKey = process.env['PYLVA_API_KEY'];
    const previousCliKey = process.env['PYLVA_CLI_KEY'];
    process.env['PYLVA_API_KEY'] = preferred;
    process.env['PYLVA_CLI_KEY'] = legacy;
    try {
      await runApprove([nonLlmDetection('elevenlabs', 'requests')], {
        cwd,
        prompt: scriptedPrompt(['y', '', '', 'character', '1', '0.0003']),
        fetchImpl: fakeFetch,
      });
    } finally {
      if (previousApiKey === undefined) delete process.env['PYLVA_API_KEY'];
      else process.env['PYLVA_API_KEY'] = previousApiKey;
      if (previousCliKey === undefined) delete process.env['PYLVA_CLI_KEY'];
      else process.env['PYLVA_CLI_KEY'] = previousCliKey;
    }

    expect(seenAuth).toEqual([`Bearer ${preferred}`]);
  });

  it('POSTs a declaration with the expected shape and saves approved-sources.json', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ cost_source: { slug: 'elevenlabs' } }), { status: 201 });
    };

    // Scripted answers for one elevenlabs declaration with flat pricing:
    //   1) accept? -> "y"
    //   2) display_name default -> blank (keep suggestion)
    //   3) metric default -> blank (keep "characters" default? our fixture used "requests")
    //   4) unit -> "character"
    //   5) template choice -> "1" (flat)
    //   6) price_per_unit -> "0.0003"
    const answers = ['y', '', '', 'character', '1', '0.0003'];

    const result = await runApprove([nonLlmDetection('elevenlabs', 'requests')], {
      cwd,
      cliKey: CLI_KEY,
      prompt: scriptedPrompt(answers),
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).toMatch(/\/api\/v1\/cost-sources$/);
    expect(capturedHeaders['authorization']).toBe(`Bearer ${CLI_KEY}`);
    expect(capturedBody).toMatchObject({
      display_name: 'ElevenLabs',
      slug: 'elevenlabs',
      source_type: 'non_llm_manual',
      metric: 'requests',
      unit: 'character',
      price_per_unit: 0.0003,
    });
    expect(result.declared.map((d) => d.slug)).toEqual(['elevenlabs']);

    const saved = JSON.parse(
      await fs.readFile(path.join(cwd, '.pylva', 'approved-sources.json'), 'utf8'),
    );
    expect(saved).toEqual([
      expect.objectContaining({
        slug: 'elevenlabs',
        source_type: 'non_llm_manual',
        metric: 'requests',
      }),
    ]);
  });

  it('dedupes on re-run — already-declared slugs are skipped without a new POST', async () => {
    await fs.mkdir(path.join(cwd, '.pylva'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.pylva', 'approved-sources.json'),
      JSON.stringify([
        { slug: 'elevenlabs', display_name: 'ElevenLabs', source_type: 'non_llm_manual' },
      ]),
      'utf8',
    );

    let posts = 0;
    const fakeFetch: typeof fetch = async () => {
      posts++;
      return new Response('{}', { status: 201 });
    };

    const result = await runApprove([nonLlmDetection('elevenlabs')], {
      cwd,
      cliKey: CLI_KEY,
      prompt: scriptedPrompt([]),
      fetchImpl: fakeFetch,
    });

    expect(posts).toBe(0);
    expect(result.declared).toHaveLength(0);
    expect(result.skipped.map((d) => d.slug)).toEqual(['elevenlabs']);
  });

  it('auto-records LLM providers into approved-sources.json without prompting', async () => {
    let posts = 0;
    const fakeFetch: typeof fetch = async () => {
      posts++;
      return new Response('{}', { status: 201 });
    };

    await runApprove([llmDetection('openai'), llmDetection('anthropic')], {
      cwd,
      cliKey: CLI_KEY,
      prompt: scriptedPrompt([]),
      fetchImpl: fakeFetch,
    });

    expect(posts).toBe(0); // no POSTs for LLM auto-register path
    const saved = JSON.parse(
      await fs.readFile(path.join(cwd, '.pylva', 'approved-sources.json'), 'utf8'),
    );
    expect(saved.map((s: { slug: string }) => s.slug).sort()).toEqual(['anthropic', 'openai']);
  });

  it('surfaces a useful error when the server rejects the declaration', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'invalid payload' } }), { status: 400 });

    await expect(
      runApprove([nonLlmDetection('elevenlabs')], {
        cwd,
        cliKey: CLI_KEY,
        prompt: scriptedPrompt(['y', '', '', 'character', '1', '0.0003']),
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/400/);
  });
});
