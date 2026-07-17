import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const temporaryRoots = new Set<string>();

type JsonObject = Record<string, unknown>;
type ArtifactEnvironment = Readonly<Record<string, string | undefined>>;
type ArtifactLoader = (options?: {
  environment?: ArtifactEnvironment;
  requireLangGraph?: boolean;
}) => Promise<{
  evidence: JsonObject;
  langgraph: JsonObject | null;
  peers: Record<string, JsonObject> | null;
  root: JsonObject;
}>;

function authoritativeWorkflow(): string {
  return readFileSync(
    path.join(repoRoot, '.github/workflows/authoritative-budget-control-ci.yml'),
    'utf8',
  );
}

function jobBlock(source: string, name: string): string {
  const start = source.search(new RegExp(`^  ${name}:\\s*$`, 'mu'));
  expect(start, `workflow job ${name}`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start + 1);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/mu);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function namedStep(source: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  expect(start, `workflow step ${name}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\n      - ', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function writeJson(file: string, value: JsonObject): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeModule(file: string, source: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function fakeImmutableInstall(): {
  environment: ArtifactEnvironment;
  installRoot: string;
  sha256: string;
  tarball: string;
} {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pylva-ts-artifact-loader-'));
  temporaryRoots.add(fixtureRoot);
  const installRoot = path.join(fixtureRoot, 'install');
  const sdkRoot = path.join(installRoot, 'node_modules/@pylva/sdk');
  const coreRoot = path.join(installRoot, 'node_modules/@langchain/core');
  const graphRoot = path.join(installRoot, 'node_modules/@langchain/langgraph');
  mkdirSync(sdkRoot, { recursive: true });

  writeJson(path.join(installRoot, 'package.json'), {
    name: 'isolated-artifact-fixture',
    private: true,
  });
  writeJson(path.join(sdkRoot, 'package.json'), {
    exports: {
      '.': {
        import: { default: './dist/index.js' },
        require: { default: './dist/index.cjs' },
      },
      './langgraph': {
        import: { default: './dist/langgraph.js' },
        require: { default: './dist/langgraph.cjs' },
      },
    },
    name: '@pylva/sdk',
    type: 'module',
    version: '9.8.7',
  });
  writeModule(
    path.join(sdkRoot, 'dist/index.js'),
    `
export const SDK_VERSION = '9.8.7';
export class PylvaBudgetExceeded extends Error {}
export class PylvaControlUnavailableError extends Error {}
export function init() {}
export async function reserveUsage() { return { decision: 'bypassed', local: true }; }
export async function ready() { return true; }
export async function controlStatus() { return { supported: true }; }
`,
  );
  writeModule(path.join(sdkRoot, 'dist/index.cjs'), 'module.exports = {};\n');
  writeModule(
    path.join(sdkRoot, 'dist/langgraph.js'),
    `
export const marker = 'deep';
export class PylvaCallbackHandler {}
export function withLangGraphControlScope(callback) { return callback(); }
`,
  );
  writeModule(path.join(sdkRoot, 'dist/langgraph.cjs'), 'module.exports = {};\n');

  writeJson(path.join(graphRoot, 'package.json'), {
    exports: { '.': './index.cjs' },
    name: '@langchain/langgraph',
    version: '1.0.0',
  });
  writeModule(
    path.join(graphRoot, 'index.cjs'),
    `
module.exports = {
  Annotation: {},
  END: 'end',
  START: 'start',
  StateGraph: class StateGraph {},
  marker: 'graph-peer',
};
`,
  );
  writeJson(path.join(coreRoot, 'package.json'), {
    exports: {
      './messages': './messages.cjs',
      './tools': './tools.cjs',
      './utils/testing': './testing.cjs',
    },
    name: '@langchain/core',
    version: '1.0.0',
  });
  writeModule(
    path.join(coreRoot, 'messages.cjs'),
    "module.exports = { HumanMessage: class HumanMessage {}, marker: 'messages' };\n",
  );
  writeModule(
    path.join(coreRoot, 'tools.cjs'),
    "module.exports = { DynamicTool: class DynamicTool {}, marker: 'tools' };\n",
  );
  writeModule(
    path.join(coreRoot, 'testing.cjs'),
    "module.exports = { FakeListChatModel: class FakeListChatModel {}, marker: 'testing' };\n",
  );

  const tarball = path.join(fixtureRoot, 'pylva-sdk.tgz');
  writeFileSync(tarball, 'immutable-artifact-fixture');
  const sha256 = crypto.createHash('sha256').update(readFileSync(tarball)).digest('hex');
  return {
    environment: {
      PYLVA_TYPESCRIPT_ARTIFACT_MODE: 'immutable',
      PYLVA_TYPESCRIPT_INSTALL_ROOT: installRoot,
      PYLVA_TYPESCRIPT_TARBALL: tarball,
      PYLVA_TYPESCRIPT_TARBALL_SHA256: sha256,
    },
    installRoot,
    sha256,
    tarball,
  };
}

async function artifactLoader(): Promise<ArtifactLoader> {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/fixtures/typescript-sdk-artifact.mjs'),
  ).href;
  const loaded = (await import(moduleUrl)) as { loadTypescriptSdkArtifact: ArtifactLoader };
  return loaded.loadTypescriptSdkArtifact;
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe('immutable TypeScript artifact service gate', () => {
  it('makes service suites consume the uploaded tarball without rebuilding or repacking it', () => {
    const integration = jobBlock(authoritativeWorkflow(), 'authoritative-integration');
    expect(integration).toContain('    needs: typescript-package-artifact');
    expect(
      namedStep(integration, 'Download the immutable TypeScript artifact for final service gates'),
    ).toContain('uses: actions/download-artifact@v4');

    const verify = namedStep(
      integration,
      'Verify and isolate the exact TypeScript artifact for final service gates',
    );
    for (const invariant of [
      'test "${#TARBALLS[@]}" -eq 1',
      '--tarball "$TARBALL"',
      '--expected-sha256 "$SHA256"',
      '--artifact-only',
      '--install-root "$INSTALL_ROOT"',
      '--peer-set scripts/ci/typescript-package-peers-current.json',
      'PYLVA_TYPESCRIPT_ARTIFACT_MODE=immutable',
      'PYLVA_TYPESCRIPT_INSTALL_ROOT=$INSTALL_ROOT',
      'PYLVA_TYPESCRIPT_TARBALL=$TARBALL',
      'PYLVA_TYPESCRIPT_TARBALL_SHA256=$SHA256',
    ]) {
      expect(verify, invariant).toContain(invariant);
    }
    expect(integration).not.toContain('npm pack');
    expect(integration).not.toContain('--pack-output');
    expect(integration).not.toContain('pnpm --filter @pylva/sdk build');
    expect(integration).not.toContain('PYLVA_TYPESCRIPT_ARTIFACT_MODE=source');
    expect(verify).not.toContain('npm pack');
    expect(verify).not.toContain('pnpm --filter @pylva/sdk build');
    expect(namedStep(integration, 'Build clean Python chaos artifact')).not.toContain('@pylva/sdk');
    const pythonLangGraph = namedStep(integration, 'Build clean Python LangGraph artifact');
    expect(pythonLangGraph).not.toContain('@pylva/sdk');
    expect(pythonLangGraph).toContain("'openai==2.45.0'");
    expect(pythonLangGraph).toContain("'respx==0.23.1'");
  });

  it('keeps both runners fail-closed unless immutable artifact identity is supplied', () => {
    const environment = { ...process.env };
    for (const name of [
      'PYLVA_TYPESCRIPT_ARTIFACT_MODE',
      'PYLVA_TYPESCRIPT_INSTALL_ROOT',
      'PYLVA_TYPESCRIPT_TARBALL',
      'PYLVA_TYPESCRIPT_TARBALL_SHA256',
    ]) {
      delete environment[name];
    }
    Object.assign(environment, {
      PYLVA_RUNNER_API_KEY: 'key',
      PYLVA_RUNNER_COUNT: '0',
      PYLVA_RUNNER_ENDPOINT: 'https://pylva.invalid',
      PYLVA_RUNNER_MODE: 'legacy',
    });
    for (const fixture of [
      'tests/fixtures/authoritative-budget-sdk-ts-runner.mjs',
      'tests/fixtures/authoritative-budget-langgraph-sdk-ts-runner.mjs',
    ]) {
      const outcome = spawnSync(process.execPath, [path.join(repoRoot, fixture)], {
        encoding: 'utf8',
        env: environment,
      });
      expect(outcome.status, fixture).toBe(1);
      expect(outcome.stdout, fixture).toContain(
        'immutable TypeScript SDK artifact mode requires PYLVA_TYPESCRIPT_INSTALL_ROOT',
      );
    }
  });

  it('uses the official OpenAI peer from the isolated install in the LangGraph runner', () => {
    const runner = readFileSync(
      path.join(repoRoot, 'tests/fixtures/authoritative-budget-langgraph-sdk-ts-runner.mjs'),
      'utf8',
    );
    expect(runner).toContain("realpathSync(artifactResolver.resolve('openai'))");
    expect(runner).toContain("artifactResolver('openai')");
    expect(runner).toContain("new OpenAI({ apiKey: 'provider-private-langgraph-key'");
    expect(runner).toContain('const openai = await this.openai');
    expect(runner).toContain("url.origin === 'https://api.openai.com'");
    expect(runner).toContain("url.pathname === '/api/v1/budget/reservations'");
    expect(runner).toContain("decision.decision === 'reserved'");
    expect(runner).not.toContain('const rawClient');
    expect(runner).not.toContain('attemptIds(');
  });

  it('loads root, deep entrypoint, and LangGraph peers only from one verified install', async () => {
    const fixture = fakeImmutableInstall();
    const load = await artifactLoader();
    const loaded = await load({ environment: fixture.environment, requireLangGraph: true });

    expect(loaded.root['SDK_VERSION']).toBe('9.8.7');
    expect(loaded.langgraph?.['marker']).toBe('deep');
    expect(loaded.peers?.['graph']?.['marker']).toBe('graph-peer');
    expect(loaded.evidence).toMatchObject({
      artifactMode: 'immutable',
      sdkArtifactSha256: fixture.sha256,
      sdkInstallRoot: realpathSync(fixture.installRoot),
      sdkTarball: realpathSync(fixture.tarball),
      sdkVersion: '9.8.7',
    });
    for (const value of [
      loaded.evidence['sdkArtifact'],
      loaded.evidence['sdkLanggraphArtifact'],
      loaded.evidence['sdkPackageRoot'],
      ...Object.values(loaded.evidence['sdkPeerArtifacts'] as JsonObject),
    ]) {
      expect(path.relative(realpathSync(fixture.installRoot), String(value))).not.toMatch(/^\.\./u);
      expect(path.relative(repoRoot, String(value))).toMatch(/^\.\./u);
    }

    const runner = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'tests/fixtures/authoritative-budget-sdk-ts-runner.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.environment,
          PYLVA_RUNNER_API_KEY: 'fixture-key',
          PYLVA_RUNNER_COUNT: '0',
          PYLVA_RUNNER_ENDPOINT: 'https://pylva.invalid',
          PYLVA_RUNNER_MODE: 'legacy',
        },
      },
    );
    expect(runner.status).toBe(0);
    const result = JSON.parse(runner.stdout) as JsonObject;
    expect(result).toMatchObject({
      artifactMode: 'immutable',
      decision: 'bypassed',
      sdkArtifactSha256: fixture.sha256,
      sdkInstallRoot: realpathSync(fixture.installRoot),
      sdkVersion: '9.8.7',
    });
    expect(path.relative(repoRoot, String(result['sdkArtifact']))).toMatch(/^\.\./u);

    const langgraphRunner = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'tests/fixtures/authoritative-budget-langgraph-sdk-ts-runner.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, ...fixture.environment },
      },
    );
    expect(langgraphRunner.status).toBe(1);
    expect(langgraphRunner.stdout).toContain('invalid TypeScript LangGraph runner configuration');
    expect(langgraphRunner.stdout).not.toContain('artifact loading failure');
  });

  it('rejects a mismatched hash and forbids the explicit source escape hatch in CI', async () => {
    const fixture = fakeImmutableInstall();
    const load = await artifactLoader();
    for (const name of [
      'PYLVA_TYPESCRIPT_INSTALL_ROOT',
      'PYLVA_TYPESCRIPT_TARBALL',
      'PYLVA_TYPESCRIPT_TARBALL_SHA256',
    ]) {
      const environment = { ...fixture.environment };
      delete environment[name];
      await expect(load({ environment })).rejects.toThrow(`requires ${name}`);
    }
    await expect(
      load({
        environment: { ...fixture.environment, PYLVA_TYPESCRIPT_TARBALL_SHA256: '0'.repeat(64) },
      }),
    ).rejects.toThrow('does not match');
    await expect(
      load({ environment: { CI: 'true', PYLVA_TYPESCRIPT_ARTIFACT_MODE: 'source' } }),
    ).rejects.toThrow('source artifact mode is forbidden in CI');
    await expect(
      load({ environment: { PYLVA_TYPESCRIPT_ARTIFACT_MODE: 'unexpected' } }),
    ).rejects.toThrow('unsupported TypeScript SDK artifact mode');
  });

  it('keeps the installer passive and rejects invalid artifact hashes before npm runs', () => {
    const installer = readFileSync(
      path.join(repoRoot, 'scripts/ci/install-typescript-integration-artifact.mjs'),
      'utf8',
    );
    expect(installer).toContain("'--ignore-scripts'");
    expect(installer).toContain("'--save-exact'");
    expect(installer).not.toContain('npm pack');
    expect(installer).not.toContain('@pylva/sdk build');
    expect(installer).toContain('path.relative(requestedInstallRoot, requestedAttestationOutput)');
    expect(installer).toContain('path.join(installRoot, attestationRelative)');
    expect(installer).not.toContain(
      'const attestationOutput = path.resolve(repoRoot, options.attestationOutput)',
    );

    const fixture = fakeImmutableInstall();
    const emptyInstall = path.join(path.dirname(fixture.installRoot), 'installer-output');
    const outcome = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/ci/install-typescript-integration-artifact.mjs'),
        '--tarball',
        fixture.tarball,
        '--expected-sha256',
        '0'.repeat(64),
        '--install-root',
        emptyInstall,
        '--peer-set',
        path.join(repoRoot, 'scripts/ci/typescript-package-peers-current.json'),
        '--attestation-output',
        path.join(emptyInstall, 'attestation.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('does not match --expected-sha256');
    expect(() => realpathSync(emptyInstall)).toThrow();
  });
});
