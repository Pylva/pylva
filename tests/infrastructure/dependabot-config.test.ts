import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync('.github/dependabot.yml', 'utf8');

const expectedEntries = [
  { ecosystem: 'npm', directory: '/', time: '09:00', group: 'npm-minor-patch' },
  {
    ecosystem: 'pip',
    directory: '/packages/sdk-py',
    time: '09:15',
    group: 'python-minor-patch',
  },
  {
    ecosystem: 'github-actions',
    directory: '/',
    time: '09:30',
    group: 'actions-minor-patch',
  },
  { ecosystem: 'docker', directory: '/', time: '09:45', group: 'docker-minor-patch' },
  {
    ecosystem: 'docker-compose',
    directory: '/docker',
    time: '10:00',
    group: 'compose-minor-patch',
  },
] as const;

function updateBlocks(source: string): Map<string, string> {
  const matches = [...source.matchAll(/^  - package-ecosystem: ([^\n]+)$/gm)];
  const blocks = new Map<string, string>();

  for (const [index, match] of matches.entries()) {
    const ecosystem = match[1]?.trim();
    if (!ecosystem) throw new Error('Dependabot ecosystem entry is missing a name');

    const start = match.index;
    const end = matches[index + 1]?.index ?? source.length;
    blocks.set(ecosystem, source.slice(start, end));
  }

  return blocks;
}

describe('Dependabot public-repository configuration', () => {
  const blocks = updateBlocks(config);

  it('uses version 2 and covers every dependency manifest ecosystem exactly once', () => {
    expect(config).toMatch(/^version: 2$/m);
    expect([...blocks.keys()]).toEqual(expectedEntries.map(({ ecosystem }) => ecosystem));
  });

  it.each(expectedEntries)(
    'schedules $ecosystem updates in the correct directory without opening major-update bundles',
    ({ ecosystem, directory, time, group }) => {
      const block = blocks.get(ecosystem);
      expect(block).toBeDefined();
      expect(block).toContain(`directory: ${directory}`);
      expect(block).toContain('interval: weekly');
      expect(block).toContain('day: monday');
      expect(block).toMatch(new RegExp(`time: ['"]${time}['"]`));
      expect(block).toContain('timezone: Asia/Riyadh');
      expect(block).toContain('open-pull-requests-limit: 5');
      expect(block).toContain(`${group}:`);
      expect(block).toMatch(/patterns:\n\s+- ['"]\*['"]/);
      expect(block).toMatch(/update-types:\n\s+- minor\n\s+- patch/);
      expect(block).not.toMatch(/^\s+- major$/m);
      expect(block).toMatch(/prefix: ['"]chore\(deps\)['"]/);
    },
  );

  it('stages ecosystem checks to avoid a single update burst', () => {
    const times = expectedEntries.map(({ time }) => time);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort());
  });

  it('does not propose image-only PostgreSQL major upgrades for the self-host volume', () => {
    const block = blocks.get('docker-compose');
    expect(block).toBeDefined();
    expect(block).toMatch(
      /ignore:\n\s+- dependency-name: postgres\n\s+update-types:\n\s+- version-update:semver-major/,
    );
  });
});
