import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PY_SDK_DISTRIBUTION_NAME,
  PY_SDK_IMPORT_PACKAGE_NAME,
  PY_SDK_INSTALL_COMMAND,
} from '../../src/lib/sdk-package-names';

const ROOT = path.resolve(__dirname, '../..');

const PUBLIC_PYTHON_NAME_FILES = [
  'AGENTS.md',
  'README.md',
  'packages/sdk-py/README.md',
];

const PUBLIC_INSTALL_GUIDANCE_FILES = [
  'AGENTS.md',
  'README.md',
  'packages/sdk-py/README.md',
];

const PUBLIC_CONTENT_FILES = [
  'packages/sdk-ts/README.md',
  'src/lib/sdk-snippets.ts',
];

const STALE_PYPI_DECLARATION_PATTERNS = [
  /PyPI project:\s*`pylva`/i,
  /PyPI distribution\s+`pylva`/i,
  /PyPI package:\s*`pylva`/i,
  /PyPI:\s*pylva(?!-)\b/i,
  /pylva\s*\(PyPI\)/i,
  /PyPI\s*\(\s*`pylva`\s*\)/i,
  /PyPI is\s*(?:\r?\n\s*)?`pylva`/i,
];

type ScannedLine = {
  file: string;
  line: number;
  text: string;
};

function projectPath(file: string): string {
  return path.join(ROOT, file);
}

function projectFileExists(file: string): boolean {
  return existsSync(projectPath(file));
}

async function readProjectFile(file: string): Promise<string> {
  return readFile(projectPath(file), 'utf8');
}

async function readProjectLines(files: string[]): Promise<ScannedLine[]> {
  const allLines = await Promise.all(
    files.map(async (file) =>
      (await readProjectFile(file)).split(/\r?\n/).map((text, index) => ({
        file,
        line: index + 1,
        text,
      })),
    ),
  );
  return allLines.flat();
}

function formatLine({ file, line, text }: ScannedLine): string {
  return `${file}:${line}: ${text.trim()}`;
}

function formatMatch(file: string, text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }

  const start = Math.max(0, match.index - 40);
  const end = Math.min(text.length, match.index + match[0].length + 40);
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${file}: ${snippet}`;
}

describe('SDK package name drift', () => {
  it('has all required public SDK package-name scan files', () => {
    const requiredFiles = [
      ...PUBLIC_PYTHON_NAME_FILES,
      ...PUBLIC_INSTALL_GUIDANCE_FILES,
      ...PUBLIC_CONTENT_FILES,
    ];

    expect([...new Set(requiredFiles)].filter((file) => !projectFileExists(file))).toEqual([]);
  });

  it('does not publish stale old Python install guidance in public guidance or content', async () => {
    const oldPythonDistributionName = ['pylva', 'ai'].join('-');
    const staleInstallPattern = new RegExp(
      `pip install ${oldPythonDistributionName}\\b|pip install pylva(?!-)\\b|${oldPythonDistributionName}`,
    );
    const lines = await readProjectLines([
      ...PUBLIC_PYTHON_NAME_FILES,
      ...PUBLIC_INSTALL_GUIDANCE_FILES,
      ...PUBLIC_CONTENT_FILES,
    ]);

    const staleLines = lines.filter((line) => staleInstallPattern.test(line.text));

    expect(staleLines.map(formatLine)).toEqual([]);
  });

  it('does not publish stale PyPI name-recovery caveats in public Python guidance', async () => {
    const lines = await readProjectLines(PUBLIC_PYTHON_NAME_FILES);
    const stalePypiClaimLines = lines.filter((line) =>
      /not controlled|different package|name recovery|recovered in parallel/i.test(line.text),
    );

    expect(stalePypiClaimLines.map(formatLine)).toEqual([]);
  });

  it('does not leave stale declarative PyPI package names in public Python guidance', async () => {
    const matches = (
      await Promise.all(
        PUBLIC_PYTHON_NAME_FILES.map(async (file) => {
          const text = await readProjectFile(file);
          return STALE_PYPI_DECLARATION_PATTERNS.map((pattern) =>
            formatMatch(file, text, pattern),
          ).filter((match): match is string => Boolean(match));
        }),
      )
    ).flat();

    expect(matches).toEqual([]);
  });

  it('keeps public Python guidance explicit about distribution and import package names', async () => {
    const importPackagePattern = new RegExp(
      `(?:import(?: package)?|runtime import package|Python import package)[\\s\\S]{0,120}` +
        PY_SDK_IMPORT_PACKAGE_NAME +
        `|` +
        '`' +
        PY_SDK_IMPORT_PACKAGE_NAME +
        '`[\\s\\S]{0,80}(?:import package|Python import package)',
      'i',
    );

    for (const file of PUBLIC_PYTHON_NAME_FILES) {
      const text = await readProjectFile(file);
      expect(text, `${file} should mention ${PY_SDK_DISTRIBUTION_NAME}`).toContain(
        PY_SDK_DISTRIBUTION_NAME,
      );
      expect(
        importPackagePattern.test(text),
        `${file} should distinguish the import package ${PY_SDK_IMPORT_PACKAGE_NAME}`,
      ).toBe(true);
    }
  });

  it('keeps public install guidance on the controlled PyPI distribution', async () => {
    for (const file of PUBLIC_INSTALL_GUIDANCE_FILES) {
      const text = await readProjectFile(file);
      expect(text, `${file} should mention ${PY_SDK_INSTALL_COMMAND}`).toContain(
        PY_SDK_INSTALL_COMMAND,
      );
    }
  });
});
