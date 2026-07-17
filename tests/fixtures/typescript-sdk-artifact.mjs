import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKSPACE_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`immutable TypeScript SDK artifact mode requires ${name}`);
  }
  return value;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function packageRootFromResolvedEntry(resolvedEntry, expectedName) {
  let candidate = path.dirname(resolvedEntry);
  for (;;) {
    const manifestPath = path.join(candidate, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest?.name === expectedName) return realpathSync(candidate);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`could not locate installed package root for ${expectedName}`);
}

function importTarget(manifest, subpath) {
  const branch = manifest?.exports?.[subpath]?.import;
  const target = typeof branch === 'string' ? branch : branch?.default;
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`installed @pylva/sdk export ${subpath} has no relative ESM target`);
  }
  return target;
}

async function loadSourceArtifact(requireLangGraph) {
  const packageRoot = path.join(WORKSPACE_ROOT, 'packages/sdk-ts');
  const rootEntry = realpathSync(path.join(packageRoot, 'dist/index.js'));
  const langgraphEntry = requireLangGraph
    ? realpathSync(path.join(packageRoot, 'dist/langgraph.js'))
    : null;
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const root = await import(pathToFileURL(rootEntry).href);
  const langgraph =
    langgraphEntry === null ? null : await import(pathToFileURL(langgraphEntry).href);
  const sourceResolver = createRequire(path.join(packageRoot, 'package.json'));
  const peers = requireLangGraph
    ? Object.freeze({
        graph: sourceResolver('@langchain/langgraph'),
        messages: sourceResolver('@langchain/core/messages'),
        testing: sourceResolver('@langchain/core/utils/testing'),
        tools: sourceResolver('@langchain/core/tools'),
      })
    : null;
  return {
    root,
    langgraph,
    peers,
    evidence: Object.freeze({
      artifactMode: 'source',
      sdkArtifact: rootEntry,
      sdkArtifactSha256: null,
      sdkInstallRoot: null,
      sdkLanggraphArtifact: langgraphEntry,
      sdkPackageRoot: realpathSync(packageRoot),
      sdkPeerArtifacts: null,
      sdkTarball: null,
      sdkVersion: manifest.version,
    }),
  };
}

/**
 * Load the SDK used by a process-level integration gate.
 *
 * Immutable mode is deliberately the default. Source mode exists only for an
 * explicit local developer run and is rejected whenever CI=true.
 */
export async function loadTypescriptSdkArtifact({
  environment = process.env,
  requireLangGraph = false,
} = {}) {
  const mode = environment.PYLVA_TYPESCRIPT_ARTIFACT_MODE ?? 'immutable';
  if (mode === 'source') {
    if (environment.CI === 'true') {
      throw new Error('TypeScript SDK source artifact mode is forbidden in CI');
    }
    return loadSourceArtifact(requireLangGraph);
  }
  if (mode !== 'immutable') {
    throw new Error(`unsupported TypeScript SDK artifact mode: ${mode}`);
  }

  const installRoot = realpathSync(required(environment, 'PYLVA_TYPESCRIPT_INSTALL_ROOT'));
  const tarball = realpathSync(required(environment, 'PYLVA_TYPESCRIPT_TARBALL'));
  const expectedSha256 = required(environment, 'PYLVA_TYPESCRIPT_TARBALL_SHA256');
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error('PYLVA_TYPESCRIPT_TARBALL_SHA256 must be 64 lowercase hexadecimal characters');
  }
  if (!statSync(installRoot).isDirectory()) {
    throw new Error('PYLVA_TYPESCRIPT_INSTALL_ROOT must identify a directory');
  }
  if (!statSync(tarball).isFile()) {
    throw new Error('PYLVA_TYPESCRIPT_TARBALL must identify a regular file');
  }
  if (isWithin(WORKSPACE_ROOT, installRoot)) {
    throw new Error('immutable TypeScript SDK install root must be outside the workspace');
  }

  const actualSha256 = sha256(tarball);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `TypeScript SDK tarball SHA-256 ${actualSha256} does not match ${expectedSha256}`,
    );
  }

  const resolver = createRequire(path.join(installRoot, 'package.json'));
  const resolvedRoot = realpathSync(resolver.resolve('@pylva/sdk'));
  const packageRoot = packageRootFromResolvedEntry(resolvedRoot, '@pylva/sdk');
  if (!isWithin(installRoot, packageRoot) || isWithin(WORKSPACE_ROOT, packageRoot)) {
    throw new Error('resolved @pylva/sdk package is not owned by the isolated install root');
  }

  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@pylva/sdk' || typeof manifest.version !== 'string') {
    throw new Error('isolated TypeScript SDK package metadata is invalid');
  }
  const rootEntry = realpathSync(path.resolve(packageRoot, importTarget(manifest, '.')));
  if (!isWithin(packageRoot, rootEntry)) {
    throw new Error('installed @pylva/sdk root export escapes its package root');
  }

  let langgraphEntry = null;
  let peerArtifacts = null;
  let peers = null;
  if (requireLangGraph) {
    langgraphEntry = realpathSync(path.resolve(packageRoot, importTarget(manifest, './langgraph')));
    if (!isWithin(packageRoot, langgraphEntry)) {
      throw new Error('installed @pylva/sdk LangGraph export escapes its package root');
    }
    const langgraphPeerEntry = realpathSync(resolver.resolve('@langchain/langgraph'));
    const messagesPeerEntry = realpathSync(resolver.resolve('@langchain/core/messages'));
    const testingPeerEntry = realpathSync(resolver.resolve('@langchain/core/utils/testing'));
    const toolsPeerEntry = realpathSync(resolver.resolve('@langchain/core/tools'));
    const langgraphPeerRoot = packageRootFromResolvedEntry(
      langgraphPeerEntry,
      '@langchain/langgraph',
    );
    const corePeerRoot = packageRootFromResolvedEntry(messagesPeerEntry, '@langchain/core');
    const testingPeerRoot = packageRootFromResolvedEntry(testingPeerEntry, '@langchain/core');
    const toolsPeerRoot = packageRootFromResolvedEntry(toolsPeerEntry, '@langchain/core');
    if (!isWithin(installRoot, langgraphPeerRoot) || !isWithin(installRoot, corePeerRoot)) {
      throw new Error('LangGraph peers were not resolved from the isolated install root');
    }
    if (testingPeerRoot !== corePeerRoot || toolsPeerRoot !== corePeerRoot) {
      throw new Error('LangChain core subpaths did not resolve from one installed package');
    }
    peerArtifacts = Object.freeze({
      messages: messagesPeerEntry,
      corePackageRoot: corePeerRoot,
      langgraph: langgraphPeerEntry,
      langgraphPackageRoot: langgraphPeerRoot,
      testing: testingPeerEntry,
      tools: toolsPeerEntry,
    });
    peers = Object.freeze({
      graph: resolver('@langchain/langgraph'),
      messages: resolver('@langchain/core/messages'),
      testing: resolver('@langchain/core/utils/testing'),
      tools: resolver('@langchain/core/tools'),
    });
  }

  const root = await import(pathToFileURL(rootEntry).href);
  const langgraph =
    langgraphEntry === null ? null : await import(pathToFileURL(langgraphEntry).href);
  if (root.SDK_VERSION !== manifest.version) {
    throw new Error(
      `installed SDK runtime version ${String(root.SDK_VERSION)} does not match ${manifest.version}`,
    );
  }

  return {
    root,
    langgraph,
    peers,
    evidence: Object.freeze({
      artifactMode: 'immutable',
      sdkArtifact: rootEntry,
      sdkArtifactSha256: actualSha256,
      sdkInstallRoot: installRoot,
      sdkLanggraphArtifact: langgraphEntry,
      sdkPackageRoot: packageRoot,
      sdkPeerArtifacts: peerArtifacts,
      sdkTarball: tarball,
      sdkVersion: manifest.version,
    }),
  };
}
