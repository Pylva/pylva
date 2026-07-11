// B3-T4a — ci-check coverage. Pure-function tests plus one filesystem test
// to verify loadApprovedSources returns [] when the file is missing or malformed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCiCheck, loadApprovedSources, type Detection } from '../../src/cli/ci-check.js';

function det(slug: string, kind: Detection['kind'] = 'llm_provider'): Detection {
  return { package: slug, manifest: '/tmp/x', kind, display_name: slug, slug };
}

describe('runCiCheck', () => {
  it('exit 0 when every detection is approved', () => {
    const result = runCiCheck(
      [det('openai'), det('anthropic')],
      [{ slug: 'openai' }, { slug: 'anthropic' }],
    );
    expect(result.exitCode).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it('exit 1 when a detection is missing from approved-sources', () => {
    const result = runCiCheck(
      [det('openai'), det('elevenlabs', 'non_llm_suggested')],
      [{ slug: 'openai' }],
    );
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((d) => d.slug)).toEqual(['elevenlabs']);
  });

  it('exit 0 when approved has extra entries the scan did not detect', () => {
    // Extras in approved-sources.json are benign (e.g. a source instrumented
    // manually without being a dep). --ci only flags NEW uninstrumented deps.
    const result = runCiCheck([det('openai')], [{ slug: 'openai' }, { slug: 'custom-internal' }]);
    expect(result.exitCode).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it('exit 0 with empty detections even when approved is empty', () => {
    const result = runCiCheck([], []);
    expect(result.exitCode).toBe(0);
  });
});

describe('loadApprovedSources', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-ci-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns [] when .pylva/approved-sources.json is missing', async () => {
    expect(await loadApprovedSources(root)).toEqual([]);
  });

  it('returns [] when file is malformed JSON', async () => {
    await fs.mkdir(path.join(root, '.pylva'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.pylva', 'approved-sources.json'),
      '{not json}',
      'utf8',
    );
    expect(await loadApprovedSources(root)).toEqual([]);
  });

  it('returns [] when file is JSON but not an array', async () => {
    await fs.writeFile(
      path.join(root, '.pylva', 'approved-sources.json'),
      JSON.stringify({ not: 'an array' }),
      'utf8',
    );
    expect(await loadApprovedSources(root)).toEqual([]);
  });

  it('returns parsed entries when the file is a valid array', async () => {
    const entries = [{ slug: 'openai' }, { slug: 'elevenlabs', metric: 'characters' }];
    await fs.writeFile(
      path.join(root, '.pylva', 'approved-sources.json'),
      JSON.stringify(entries),
      'utf8',
    );
    expect(await loadApprovedSources(root)).toEqual(entries);
  });
});
