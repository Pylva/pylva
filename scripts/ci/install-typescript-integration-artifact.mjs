#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const requiredPeers = Object.freeze([
  '@ai-sdk/openai',
  '@anthropic-ai/sdk',
  '@langchain/core',
  '@langchain/langgraph',
  'ai',
  'openai',
]);
const usage = `Usage:
  node scripts/ci/install-typescript-integration-artifact.mjs \\
    --tarball <file.tgz> \\
    --expected-sha256 <sha256> \\
    --install-root <outside-workspace-dir> \\
    --peer-set <file.json> \\
    --attestation-output <file.json>
`;

function parseArgs(argv) {
  const options = {
    attestationOutput: null,
    expectedSha256: null,
    installRoot: null,
    peerSet: null,
    tarball: null,
  };
  const names = new Map([
    ['--attestation-output', 'attestationOutput'],
    ['--expected-sha256', 'expectedSha256'],
    ['--install-root', 'installRoot'],
    ['--peer-set', 'peerSet'],
    ['--tarball', 'tarball'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') {
      process.stdout.write(usage);
      process.exit(0);
    }
    const property = names.get(name);
    const value = argv[index + 1];
    if (property === undefined || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument ${String(name)}\n${usage}`);
    }
    options[property] = value;
    index += 1;
  }
  for (const [property, value] of Object.entries(options)) {
    if (value === null)
      throw new Error(
        `missing --${property.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}\n${usage}`,
      );
  }
  if (!/^[a-f0-9]{64}$/u.test(options.expectedSha256)) {
    throw new Error('--expected-sha256 must be 64 lowercase hexadecimal characters');
  }
  return options;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function loadPeerSet(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--peer-set must contain one JSON object');
  }
  const names = Object.keys(parsed).sort();
  if (JSON.stringify(names) !== JSON.stringify([...requiredPeers].sort())) {
    throw new Error(`--peer-set must contain exactly: ${requiredPeers.join(', ')}`);
  }
  for (const name of requiredPeers) {
    const version = parsed[name];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`--peer-set ${name} must use one exact version`);
    }
  }
  return parsed;
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, NODE_PATH: '' },
    stdio: 'inherit',
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tarball = realpathSync(path.resolve(repoRoot, options.tarball));
  const peerSetPath = realpathSync(path.resolve(repoRoot, options.peerSet));
  const requestedInstallRoot = path.resolve(repoRoot, options.installRoot);
  const requestedAttestationOutput = path.resolve(repoRoot, options.attestationOutput);
  const attestationRelative = path.relative(requestedInstallRoot, requestedAttestationOutput);
  if (
    attestationRelative === '' ||
    attestationRelative.startsWith(`..${path.sep}`) ||
    attestationRelative === '..' ||
    path.isAbsolute(attestationRelative)
  ) {
    throw new Error('--attestation-output must be a file inside --install-root');
  }
  const installParent = realpathSync(path.dirname(requestedInstallRoot));
  const plannedInstallRoot = path.join(installParent, path.basename(requestedInstallRoot));

  if (!statSync(tarball).isFile()) throw new Error('--tarball must identify a regular file');
  if (sha256(tarball) !== options.expectedSha256) {
    throw new Error('immutable TypeScript SDK tarball does not match --expected-sha256');
  }
  if (isWithin(repoRoot, plannedInstallRoot)) {
    throw new Error('--install-root must be outside the workspace');
  }
  if (existsSync(plannedInstallRoot)) {
    if (
      lstatSync(plannedInstallRoot).isSymbolicLink() ||
      !statSync(plannedInstallRoot).isDirectory() ||
      readdirSync(plannedInstallRoot).length > 0
    ) {
      throw new Error('--install-root must not exist or must be an empty directory');
    }
    rmSync(plannedInstallRoot, { recursive: true });
  }
  mkdirSync(plannedInstallRoot, { recursive: false });
  const installRoot = realpathSync(plannedInstallRoot);
  const attestationOutput = path.join(installRoot, attestationRelative);
  if (isWithin(repoRoot, installRoot)) {
    throw new Error('--install-root must be outside the workspace');
  }
  if (!isWithin(installRoot, attestationOutput)) throw new Error('invalid attestation output');

  const peerVersions = loadPeerSet(peerSetPath);
  writeFileSync(
    path.join(installRoot, 'package.json'),
    `${JSON.stringify({ name: 'pylva-typescript-integration-artifact', private: true }, null, 2)}\n`,
  );
  run(
    'npm',
    [
      'install',
      tarball,
      ...requiredPeers.map((name) => `${name}@${peerVersions[name]}`),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
    ],
    installRoot,
  );
  if (sha256(tarball) !== options.expectedSha256) {
    throw new Error('immutable TypeScript SDK tarball changed while it was being installed');
  }

  const sdkRoot = realpathSync(path.join(installRoot, 'node_modules/@pylva/sdk'));
  if (!isWithin(installRoot, sdkRoot)) {
    throw new Error('installed @pylva/sdk resolved outside --install-root');
  }
  const sdkManifest = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  if (sdkManifest.name !== '@pylva/sdk' || typeof sdkManifest.version !== 'string') {
    throw new Error('installed TypeScript SDK metadata is invalid');
  }
  for (const name of requiredPeers) {
    const peerRoot = realpathSync(path.join(installRoot, 'node_modules', ...name.split('/')));
    if (!isWithin(installRoot, peerRoot)) {
      throw new Error(`installed peer ${name} resolved outside --install-root`);
    }
    const peerManifest = JSON.parse(readFileSync(path.join(peerRoot, 'package.json'), 'utf8'));
    if (peerManifest.version !== peerVersions[name]) {
      throw new Error(
        `installed peer ${name} has ${String(peerManifest.version)}, expected ${peerVersions[name]}`,
      );
    }
  }
  run('npm', ['ls', '--all', '--no-audit', '--no-fund'], installRoot);

  const attestation = {
    artifactMode: 'immutable',
    installRoot,
    packageRoot: sdkRoot,
    packageVersion: sdkManifest.version,
    peerVersions,
    sha256: options.expectedSha256,
    tarball,
  };
  writeFileSync(attestationOutput, `${JSON.stringify(attestation, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(attestation)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
