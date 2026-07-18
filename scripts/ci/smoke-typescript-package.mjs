#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exactConsumerTypescriptVersion = '6.0.2';

const usage = `Usage:
  node scripts/ci/smoke-typescript-package.mjs [package-dir]
  node scripts/ci/smoke-typescript-package.mjs --package-dir <dir> [--pack-output <dir>]
  node scripts/ci/smoke-typescript-package.mjs --tarball <file.tgz> --expected-sha256 <sha256>

Options:
  --artifact-only             Inspect the immutable artifact without installing it.
  --expected-sha256 <hex>     Required with --tarball; the exact bytes to verify.
  --metadata-output <file>    Write { tarball, sha256, name, version } JSON.
  --optional-peer-free        Install with --omit=optional and assert every peer is absent.
  --package-dir <dir>         Source package used only by deliberate pack mode.
  --pack-output <dir>         Keep the newly packed tarball in this stable directory.
  --peer-set <file.json>      Exact peer versions to install and assert.
  --profile <name>            full (default), optional-free, or vercel-refuse.
`;

function parseArgs(argv) {
  const options = {
    artifactOnly: false,
    expectedSha256: null,
    metadataOutput: null,
    optionalPeerFree: false,
    packageDir: null,
    packOutput: null,
    peerSet: null,
    profile: 'full',
    tarball: null,
  };
  const valueOptions = new Map([
    ['--expected-sha256', 'expectedSha256'],
    ['--metadata-output', 'metadataOutput'],
    ['--package-dir', 'packageDir'],
    ['--pack-output', 'packOutput'],
    ['--peer-set', 'peerSet'],
    ['--profile', 'profile'],
    ['--tarball', 'tarball'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(usage);
      process.exit(0);
    }
    if (argument === '--artifact-only') {
      options.artifactOnly = true;
      continue;
    }
    if (argument === '--optional-peer-free') {
      options.optionalPeerFree = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (property !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[property] = value;
      index += 1;
      continue;
    }
    if (!argument.startsWith('-') && options.packageDir === null) {
      // Backward-compatible deliberate build-and-pack mode.
      options.packageDir = argument;
      continue;
    }
    throw new Error(`unknown argument: ${argument}\n${usage}`);
  }
  if (!['full', 'optional-free', 'vercel-refuse'].includes(options.profile)) {
    throw new Error(`invalid --profile ${options.profile}`);
  }
  if (options.optionalPeerFree) options.profile = 'optional-free';
  if (options.profile === 'optional-free' && options.peerSet !== null) {
    throw new Error('--optional-peer-free/optional-free cannot be combined with --peer-set');
  }
  if (options.tarball !== null) {
    if (options.expectedSha256 === null) {
      throw new Error('--tarball requires --expected-sha256');
    }
    if (options.packOutput !== null) {
      throw new Error('--tarball cannot be combined with --pack-output');
    }
  } else if (options.expectedSha256 !== null) {
    throw new Error('--expected-sha256 requires --tarball');
  }
  if (options.metadataOutput !== null && options.tarball === null && options.packOutput === null) {
    throw new Error('--metadata-output in pack mode requires --pack-output');
  }
  if (options.artifactOnly && (options.peerSet !== null || options.profile !== 'full')) {
    throw new Error('--artifact-only cannot be combined with an install profile or peer set');
  }
  if (
    options.tarball !== null &&
    !options.artifactOnly &&
    options.profile !== 'optional-free' &&
    options.peerSet === null
  ) {
    throw new Error('immutable install verification requires --peer-set or --optional-peer-free');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const packageDir = path.resolve(repoRoot, options.packageDir ?? 'packages/sdk-ts');
const sourceManifest =
  options.tarball === null
    ? JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    : null;

const exactExports = Object.freeze({
  '.': {
    import: { types: './dist/index.d.ts', default: './dist/index.js' },
    require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
  },
  './openai': {
    import: { types: './dist/openai.d.ts', default: './dist/openai.js' },
    require: { types: './dist/openai.d.cts', default: './dist/openai.cjs' },
  },
  './anthropic': {
    import: { types: './dist/anthropic.d.ts', default: './dist/anthropic.js' },
    require: { types: './dist/anthropic.d.cts', default: './dist/anthropic.cjs' },
  },
  './vercel-ai': {
    import: { types: './dist/vercel-ai.d.ts', default: './dist/vercel-ai.js' },
    require: { types: './dist/vercel-ai.d.cts', default: './dist/vercel-ai.cjs' },
  },
  './langgraph': {
    import: { types: './dist/langgraph.d.ts', default: './dist/langgraph.js' },
    require: { types: './dist/langgraph.d.cts', default: './dist/langgraph.cjs' },
  },
  './langchain': {
    import: { types: './dist/langgraph.d.ts', default: './dist/langgraph.js' },
    require: { types: './dist/langgraph.d.cts', default: './dist/langgraph.cjs' },
  },
});
const exactImports = Object.freeze({
  '#pylva/core-runtime': './dist/internal/core-runtime.cjs',
  '#pylva/execution-runtime': './dist/internal/execution-runtime.cjs',
  '#pylva/public-errors': './dist/internal/public-errors.cjs',
  '#pylva/budget-runtime': './dist/internal/budget-runtime.cjs',
  '#pylva/routing-runtime': './dist/internal/routing-runtime.cjs',
  '#pylva/nonllm-runtime': './dist/internal/nonllm-runtime.cjs',
  '#pylva/telemetry-runtime': './dist/internal/telemetry-runtime.cjs',
  '#pylva/control-runtime': './dist/internal/control-runtime.cjs',
  '#pylva/engine-runtime': './dist/internal/engine-runtime.cjs',
  '#pylva/budget-enforcement-runtime': './dist/internal/budget-enforcement-runtime.cjs',
  '#pylva/usage-snapshot-runtime': './dist/internal/usage-snapshot-runtime.cjs',
  '#pylva/init-validation-runtime': './dist/internal/init-validation-runtime.cjs',
  '#pylva/strict-unwrapper-runtime': './dist/internal/strict-unwrapper-runtime.cjs',
  '#pylva/openai-runtime': './dist/openai.cjs',
  '#pylva/anthropic-runtime': './dist/anthropic.cjs',
  '#pylva/vercel-ai-runtime': './dist/vercel-ai.cjs',
});
const exactScripts = Object.freeze({
  build: 'node scripts/build.mjs',
  dev: 'node scripts/build.mjs',
  test: 'vitest run',
  size: 'node scripts/check-runtime-size.mjs',
  typecheck: 'tsc --noEmit && tsc -p tsconfig.type-tests.json',
  prepublishOnly: 'npm run test && npm run typecheck && npm run build && npm run size',
});
const exactPublishConfig = Object.freeze({ access: 'public' });
const exactPeerRanges = Object.freeze({
  '@ai-sdk/openai': '>=3 <4',
  '@anthropic-ai/sdk': '>=0.30.1 <1',
  '@langchain/core': '>=1 <2',
  '@langchain/langgraph': '>=1 <2',
  ai: '>=3',
  openai: '>=4.104.0 <6',
});
const peerNames = Object.freeze(Object.keys(exactPeerRanges));

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function exactJson(actual, expected, label) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  assert(
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)),
    `${label} differs: ${JSON.stringify(actual)}`,
  );
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? 'utf8',
    env: { ...process.env, NODE_PATH: '', ...options.env },
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
  });
}

function runBytes(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, NODE_PATH: '', ...options.env },
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactBytes(actual, expected, label) {
  assert(
    Buffer.isBuffer(actual) && Buffer.isBuffer(expected),
    `${label} must compare byte buffers`,
  );
  assert(actual.equals(expected), `${label} bytes differ from the release source`);
}

function installedPeerSpec(name) {
  assert(sourceManifest !== null, 'source peer discovery is unavailable in immutable mode');
  const manifestPath = path.join(packageDir, 'node_modules', ...name.split('/'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(
    typeof manifest.version === 'string' && manifest.version.length > 0,
    `${name} installed peer version is missing`,
  );
  return `${name}@${manifest.version}`;
}

function loadPeerSet(file) {
  const absolute = path.resolve(repoRoot, file);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  assert(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    '--peer-set must contain one JSON object',
  );
  const entries = Object.entries(parsed);
  assert(entries.length > 0, '--peer-set cannot be empty; use --optional-peer-free instead');
  for (const [name, version] of entries) {
    assert(peerNames.includes(name), `peer set contains undeclared peer ${name}`);
    assert(
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version),
      `peer set ${name} must use one exact version`,
    );
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function archivePath(entry) {
  assert(typeof entry === 'string' && entry.startsWith('./'), `invalid export path: ${entry}`);
  return `package/${entry.slice(2)}`;
}

function exportTarget(manifest, subpath, branch, condition) {
  const conditions = manifest.exports?.[subpath];
  assert(
    conditions && typeof conditions === 'object' && !Array.isArray(conditions),
    `exports.${subpath} is not a conditional export`,
  );
  const branchConditions = conditions[branch];
  assert(
    branchConditions && typeof branchConditions === 'object' && !Array.isArray(branchConditions),
    `exports.${subpath}.${branch} is not a conditional branch`,
  );
  const target = branchConditions[condition];
  assert(typeof target === 'string', `exports.${subpath}.${branch}.${condition} is missing`);
  return target;
}

function assertPackedManifest(manifest, files, tarball, expectedVersion) {
  assert(manifest.name === '@pylva/sdk', `unexpected packed package name: ${manifest.name}`);
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'version is missing');
  if (expectedVersion !== null) {
    assert(
      manifest.version === expectedVersion,
      `packed version ${manifest.version} does not match source ${expectedVersion}`,
    );
  }
  assert(
    manifest.engines?.node === '>=20.18.1',
    `packed Node engine ${manifest.engines?.node ?? 'missing'} does not match >=20.18.1`,
  );
  assert(manifest.type === 'module', 'packed package must remain type=module');
  assert(manifest.license === 'MIT', 'packed package must remain MIT licensed');
  assert(manifest.sideEffects === false, 'packed package must remain sideEffects=false');
  assert(manifest.main === './dist/index.cjs', 'legacy main must target the root CJS entry');
  assert(manifest.module === './dist/index.js', 'legacy module must target the root ESM entry');
  assert(manifest.types === './dist/index.d.ts', 'legacy types must target the root ESM types');
  exactJson(manifest.bin, { pylva: 'dist/cli/validate.js' }, 'packed CLI bin allowlist');
  exactJson(manifest.files, ['dist', 'README.md', 'LICENSE'], 'packed files allowlist');
  exactJson(manifest.imports, exactImports, 'packed private import-map allowlist');
  exactJson(manifest.exports, exactExports, 'packed exports allowlist');
  exactJson(manifest.scripts, exactScripts, 'packed package scripts allowlist');
  exactJson(manifest.publishConfig, exactPublishConfig, 'packed publish configuration');
  exactJson(manifest.peerDependencies, exactPeerRanges, 'packed peer dependency ranges');
  for (const peer of peerNames) {
    assert(
      manifest.peerDependenciesMeta?.[peer]?.optional === true,
      `${peer} must remain an optional peer`,
    );
  }
  exactJson(
    manifest.peerDependenciesMeta,
    Object.fromEntries(peerNames.map((peer) => [peer, { optional: true }])),
    'packed optional-peer metadata',
  );
  exactJson(manifest.dependencies, { valibot: '^1.4.2' }, 'packed runtime dependencies');
  exactJson(manifest.optionalDependencies ?? {}, {}, 'packed optional dependencies');
  assert(
    manifest.bundleDependencies === undefined && manifest.bundledDependencies === undefined,
    'packed package must not bundle dependency trees',
  );
  for (const lifecycle of [
    'preinstall',
    'install',
    'postinstall',
    'preuninstall',
    'uninstall',
    'postuninstall',
  ]) {
    assert(
      manifest.scripts?.[lifecycle] === undefined,
      `consumer lifecycle hook ${lifecycle} exists`,
    );
  }

  for (const required of ['package/README.md', 'package/LICENSE']) {
    assert(files.has(required), `${required} is absent from the tarball`);
  }
  for (const [specifier, target] of Object.entries(exactImports)) {
    assert(files.has(archivePath(target)), `imports.${specifier} target is absent`);
  }

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      assert(typeof spec === 'string', `${field}.${name} is not a string`);
      assert(!spec.startsWith('workspace:'), `${field}.${name} contains ${spec}`);
      assert(!name.startsWith('@pylva/'), `${field}.${name} leaked a private workspace package`);
    }
  }

  for (const subpath of Object.keys(exactExports)) {
    for (const branch of ['import', 'require']) {
      for (const condition of ['types', 'default']) {
        const target = exportTarget(manifest, subpath, branch, condition);
        const packedTarget = archivePath(target);
        assert(
          files.has(packedTarget),
          `exports.${subpath}.${branch}.${condition} target is absent`,
        );
      }
    }
  }

  const runtimeFiles = [...files]
    .filter((file) => /^package\/dist\/.*\.(?:js|cjs)$/u.test(file))
    .sort();
  assert(runtimeFiles.length > 0, 'tarball contains no runtime JavaScript');
  for (const packedRuntime of runtimeFiles) {
    const packedMap = `${packedRuntime}.map`;
    assert(files.has(packedMap), `${packedMap} is absent from the tarball`);
    const runtime = run('tar', ['-xzOf', tarball, packedRuntime]);
    const references = [...runtime.matchAll(/\/\/# sourceMappingURL=([^\r\n]+)(?:\r?\n|$)/gu)].map(
      (match) => match[1],
    );
    const expectedMapName = path.posix.basename(packedMap);
    assert(
      references.length === 1 && references[0] === expectedMapName,
      `${packedRuntime} must have exactly one ${expectedMapName} source-map reference`,
    );
    assert(
      runtime.trimEnd().endsWith(`//# sourceMappingURL=${expectedMapName}`),
      `${packedRuntime} source-map reference is not terminal`,
    );
    const sourceMap = JSON.parse(run('tar', ['-xzOf', tarball, packedMap]));
    assert(sourceMap.version === 3, `${packedMap} is not source-map version 3`);
    assert(
      sourceMap.file === undefined || sourceMap.file === path.posix.basename(packedRuntime),
      `${packedMap} has an incorrect file field`,
    );
    assert(
      Array.isArray(sourceMap.sources) &&
        sourceMap.sources.length > 0 &&
        sourceMap.sources.every(
          (source) =>
            typeof source === 'string' &&
            source.length > 0 &&
            !path.posix.isAbsolute(source) &&
            !path.win32.isAbsolute(source) &&
            !source.startsWith('file:') &&
            !source.includes('\0'),
        ) &&
        typeof sourceMap.mappings === 'string' &&
        sourceMap.mappings.length > 0 &&
        Array.isArray(sourceMap.sourcesContent) &&
        sourceMap.sourcesContent.length === sourceMap.sources.length &&
        sourceMap.sourcesContent.every((source) => typeof source === 'string'),
      `${packedMap} is not a usable, path-safe source map with embedded sources`,
    );
    assert(
      sourceMap.sourceRoot === undefined ||
        (typeof sourceMap.sourceRoot === 'string' &&
          !path.posix.isAbsolute(sourceMap.sourceRoot) &&
          !path.win32.isAbsolute(sourceMap.sourceRoot) &&
          !sourceMap.sourceRoot.startsWith('file:') &&
          !sourceMap.sourceRoot.includes('\0')),
      `${packedMap} leaks an absolute sourceRoot`,
    );
  }

  const binTarget = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pylva;
  assert(typeof binTarget === 'string', 'pylva CLI bin is missing');
  const packedBin = `package/${binTarget.replace(/^\.\//, '')}`;
  assert(files.has(packedBin), `${packedBin} is absent from the tarball`);
  const bin = run('tar', ['-xzOf', tarball, packedBin]);
  assert(bin.startsWith('#!/usr/bin/env node'), 'pylva CLI bin lost its node shebang');

  assert(
    ![...files].some((file) => /package\/(?:src|tests|type-tests)\//.test(file)),
    'source or test files leaked into the npm artifact',
  );

  const distributableFiles = [...files].filter((file) =>
    /^package\/dist\/.*\.(?:js|cjs|d\.ts|d\.cts)$/.test(file),
  );
  assert(distributableFiles.length > 0, 'tarball contains no distributable JavaScript or types');
  for (const file of distributableFiles) {
    const source = run('tar', ['-xzOf', tarball, file]);
    assert(
      !source.includes('@pylva/shared'),
      `${file} still references the private @pylva/shared workspace package`,
    );
    if (/\.d\.(?:ts|cts)$/u.test(file)) {
      assert(
        !/\b(?:_original[A-Za-z0-9_]*|_reset[A-Za-z0-9_]*|[A-Za-z0-9_]*ForTests)\b/u.test(source),
        `${file} exposes a test or unwrap hook in public declarations`,
      );
    }
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'pylva-ts-package-smoke-'));
let verifiedArtifact = null;

try {
  const artifactDir =
    options.packOutput === null
      ? path.join(scratch, 'artifact')
      : path.resolve(repoRoot, options.packOutput);
  const installDir = path.join(scratch, 'install');
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(installDir);

  let tarball;
  if (options.tarball !== null) {
    tarball = path.resolve(repoRoot, options.tarball);
    assert(existsSync(tarball), `tarball does not exist: ${tarball}`);
  } else {
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', artifactDir], {
      cwd: packageDir,
    });
    const packResult = JSON.parse(packOutput);
    assert(
      Array.isArray(packResult) && packResult.length === 1,
      'npm pack returned no single artifact',
    );
    const filename = packResult[0]?.filename;
    assert(typeof filename === 'string', 'npm pack did not report its artifact filename');
    tarball = path.join(artifactDir, filename);
  }
  const artifactSha256 = sha256(tarball);
  verifiedArtifact = { tarball, sha256: artifactSha256 };
  if (options.expectedSha256 !== null) {
    assert(
      /^[a-f0-9]{64}$/u.test(options.expectedSha256),
      '--expected-sha256 must be 64 lowercase hexadecimal characters',
    );
    assert(
      artifactSha256 === options.expectedSha256,
      `tarball SHA-256 ${artifactSha256} does not match ${options.expectedSha256}`,
    );
  }

  const files = new Set(run('tar', ['-tzf', tarball]).split('\n').filter(Boolean));
  const packedManifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
  assertPackedManifest(packedManifest, files, tarball, sourceManifest?.version ?? null);
  const sourceReadme = readFileSync(path.join(packageDir, 'README.md'));
  const packedReadme = runBytes('tar', ['-xzOf', tarball, 'package/README.md']);
  assertExactBytes(packedReadme, sourceReadme, 'packed README.md');
  assert(sourceReadme.length > 0, 'release README.md must not be empty');
  const oneByteMismatch = Buffer.from(sourceReadme);
  oneByteMismatch[oneByteMismatch.length - 1] ^= 1;
  let mismatchRejected = false;
  try {
    assertExactBytes(oneByteMismatch, sourceReadme, 'README one-byte negative self-test');
  } catch {
    mismatchRejected = true;
  }
  assert(mismatchRejected, 'README byte-identity gate accepted a one-byte mismatch');
  if (options.metadataOutput !== null) {
    const metadataPath = path.resolve(repoRoot, options.metadataOutput);
    const metadataDirectory = path.dirname(metadataPath);
    mkdirSync(metadataDirectory, { recursive: true });
    // Canonicalize the parent even when the metadata file does not exist yet.
    // On macOS, /tmp resolves to /private/tmp; without this, two physical
    // siblings can look as if they live in different directories.
    const canonicalMetadataPath = path.join(
      realpathSync(metadataDirectory),
      path.basename(metadataPath),
    );
    const metadataTarget = existsSync(metadataPath)
      ? realpathSync(metadataPath)
      : canonicalMetadataPath;
    assert(
      metadataTarget !== realpathSync(tarball),
      'metadata output must not overwrite the immutable tarball',
    );
    const relativeTarball = path.relative(path.dirname(metadataTarget), realpathSync(tarball));
    assert(
      relativeTarball.length > 0 &&
        !path.isAbsolute(relativeTarball) &&
        path.dirname(relativeTarball) === '.',
      'metadata must identify a sibling tarball with one portable relative path',
    );
    writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          tarball: relativeTarball,
          sha256: artifactSha256,
          name: packedManifest.name,
          version: packedManifest.version,
        },
        null,
        2,
      )}\n`,
    );
  }
  console.log(
    `immutable TypeScript artifact passed: ${realpathSync(tarball)} sha256=${artifactSha256}`,
  );

  if (!options.artifactOnly) {
    run('npm', ['init', '-y'], { cwd: installDir, stdio: 'ignore' });
    const initialInstallArguments = [
      'install',
      tarball,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ];
    if (options.profile === 'optional-free') initialInstallArguments.push('--omit=optional');
    run('npm', initialInstallArguments, {
      cwd: installDir,
      stdio: 'inherit',
    });
    const typescriptInstallArguments = [
      'install',
      `typescript@${exactConsumerTypescriptVersion}`,
      '--save-dev',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ];
    if (options.profile === 'optional-free') typescriptInstallArguments.push('--omit=optional');
    run('npm', typescriptInstallArguments, { cwd: installDir, stdio: 'inherit' });
    const installedTypescript = JSON.parse(
      readFileSync(path.join(installDir, 'node_modules', 'typescript', 'package.json'), 'utf8'),
    );
    assert(
      installedTypescript.version === exactConsumerTypescriptVersion,
      `consumer TypeScript installed ${installedTypescript.version}, expected ${exactConsumerTypescriptVersion}`,
    );
    const peerVersions =
      options.profile === 'optional-free'
        ? {}
        : options.peerSet === null
          ? Object.fromEntries(
              peerNames.map((name) => {
                const specifier = installedPeerSpec(name);
                return [name, specifier.slice(specifier.lastIndexOf('@') + 1)];
              }),
            )
          : loadPeerSet(options.peerSet);
    const openAiNeedsWebShim = /^4\./u.test(peerVersions['openai'] ?? '');
    const anthropicNeedsWebShim = peerVersions['@anthropic-ai/sdk'] === '0.30.1';
    if (options.profile === 'full') {
      exactJson(Object.keys(peerVersions).sort(), [...peerNames].sort(), 'full peer-set keys');
    } else if (options.profile === 'vercel-refuse') {
      for (const name of ['ai', '@ai-sdk/openai']) {
        assert(peerVersions[name] !== undefined, `${options.profile} requires ${name}`);
      }
    }
    if (Object.keys(peerVersions).length > 0) {
      run(
        'npm',
        [
          'install',
          ...Object.entries(peerVersions).map(([name, version]) => `${name}@${version}`),
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--save-exact',
        ],
        { cwd: installDir, stdio: 'inherit' },
      );
    }
    for (const name of peerNames) {
      const installedManifestPath = path.join(
        installDir,
        'node_modules',
        ...name.split('/'),
        'package.json',
      );
      if (options.profile === 'optional-free') {
        assert(
          !existsSync(installedManifestPath),
          `optional peer ${name} was unexpectedly installed`,
        );
        continue;
      }
      const expectedPeerVersion = peerVersions[name];
      if (expectedPeerVersion === undefined) {
        assert(!existsSync(installedManifestPath), `undeclared profile peer ${name} was installed`);
        continue;
      }
      const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
      assert(
        installedManifest.version === expectedPeerVersion,
        `${name} installed ${installedManifest.version}, expected ${expectedPeerVersion}`,
      );
    }
    run('npm', ['ls', '--all', '--no-audit', '--no-fund'], {
      cwd: installDir,
      stdio: 'inherit',
    });

    const smokeInput = {
      kind: 'llm',
      operationId: '11111111-1111-4111-8111-111111111111',
      customerId: 'package-smoke',
      traceId: '22222222-2222-4222-8222-222222222222',
      spanId: '33333333-3333-4333-8333-333333333333',
      parentSpanId: null,
      provider: 'openai',
      model: 'gpt-4.1',
      estimatedInputTokens: 1,
      maxOutputTokens: 1,
    };
    const expectedVersion = JSON.stringify(packedManifest.version);
    const serializedInput = JSON.stringify(smokeInput);
    const requiredExports = JSON.stringify([
      'ready',
      'controlStatus',
      'reserveUsage',
      'commitUsage',
      'releaseUsage',
      'extendUsage',
      'shouldSuppressLegacyTelemetry',
      'currentControlledAttempt',
      'wrapOpenAI',
      'wrapAnthropic',
      'createControlledOpenAIChatModel',
      'controlledGenerateText',
      'controlledStreamText',
      'PylvaBudgetExceeded',
      'PylvaControlUnavailableError',
      'PylvaControlApiError',
      'PylvaControlValidationError',
      'PylvaStrictProviderError',
      'controlledUsage',
      'controlledExactUsage',
      'controlledTavilySearch',
    ]);
    const publicSubpaths = JSON.stringify([
      'openai',
      'anthropic',
      'vercel-ai',
      'langgraph',
      'langchain',
    ]);
    const bundleIdentityKeys = JSON.stringify({
      first: `pv_live_aabbccdd_${'a'.repeat(32)}`,
      second: `pv_live_bbccddee_${'b'.repeat(32)}`,
      denied: `pv_live_ccddeeff_${'c'.repeat(32)}`,
      unavailable: `pv_live_ddeeffaa_${'d'.repeat(32)}`,
    });
    const installedPublicSurfaces = JSON.stringify({
      root: [
        'SDK_VERSION',
        'init',
        'isInitialized',
        'InvalidApiKeyError',
        'InvalidControlConfigError',
        'ControlMode',
        'ControlUnavailablePolicy',
        'ready',
        'controlStatus',
        'reserveUsage',
        'commitUsage',
        'releaseUsage',
        'extendUsage',
        'shouldSuppressLegacyTelemetry',
        'currentControlledAttempt',
        'wrapOpenAI',
        'wrapAnthropic',
        'createControlledOpenAIChatModel',
        'controlledGenerateText',
        'controlledStreamText',
        'PylvaStrictProviderError',
        'controlledUsage',
        'controlledExactUsage',
        'controlledTavilySearch',
        'TAVILY_SEARCH_COST_SOURCE_SLUG',
        'TAVILY_SEARCH_TOOL_NAME',
        'TAVILY_SEARCH_METRIC',
        'TAVILY_BASIC_SEARCH_CREDITS',
        'Pylva',
        'getRegisteredClient',
        'hasRegisteredClient',
        'track',
        'currentContext',
        'flush',
        'enqueue',
        'bufferSize',
        'isDegraded',
        'reportUsage',
        'flushNonLlmDiscoveries',
        'normalizeNonLlmMatcher',
        'verifyWebhook',
        'signWebhook',
        'InvalidSignatureFormat',
        'PylvaBudgetExceeded',
        'BudgetExceededSource',
        'PYLVA_CONTROL_UNAVAILABLE_CODE',
        'PylvaControlUnavailableReason',
        'PylvaControlUnavailableError',
        'PylvaControlApiError',
        'PylvaControlValidationError',
        'TelemetryEventSchema',
        'TelemetryBatchSchema',
        'IngestRequestSchema',
        'IngestResponseSchema',
        'Provider',
        'EventStatus',
        'Framework',
        'InstrumentationTier',
        'CostSource',
        'TokenCountSource',
        'IngestWarningCode',
      ],
      openai: ['applyOpenAiPatch', 'wrapOpenAI', 'PylvaStrictProviderError'],
      anthropic: ['applyAnthropicPatch', 'wrapAnthropic', 'PylvaStrictProviderError'],
      'vercel-ai': [
        'applyVercelAiPatch',
        'createControlledOpenAIChatModel',
        'controlledGenerateText',
        'controlledStreamText',
        'PylvaStrictProviderError',
      ],
      langgraph: ['withLangGraphControlScope', 'PylvaCallbackHandler', 'AsyncPylvaCallbackHandler'],
      langchain: ['withLangGraphControlScope', 'PylvaCallbackHandler', 'AsyncPylvaCallbackHandler'],
    });

    writeFileSync(
      path.join(installDir, 'installed-surface.mjs'),
      `
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const expected = ${installedPublicSurfaces};
const specifiers = {
  root: '@pylva/sdk',
  openai: '@pylva/sdk/openai',
  anthropic: '@pylva/sdk/anthropic',
  'vercel-ai': '@pylva/sdk/vercel-ai',
  langgraph: '@pylva/sdk/langgraph',
  langchain: '@pylva/sdk/langchain',
};
const symbolNames = [
  '@pylva/sdk-runtime/v1/e',
  '@pylva/sdk-runtime/v1/so',
  '@pylva/sdk-runtime/v1/controlled-openai-chat-models',
  '@pylva/sdk-runtime/v2/core-coordinator',
];
const symbols = symbolNames.map((name) => Symbol.for(name));
for (const symbol of symbols) {
  if (Object.prototype.hasOwnProperty.call(globalThis, symbol)) {
    throw new Error('pre-existing Pylva process-global runtime symbol: ' + String(symbol));
  }
}

const descriptorEqual = (left, right) =>
  Object.is(left?.value, right?.value) &&
  left?.get === right?.get &&
  left?.set === right?.set &&
  left?.writable === right?.writable &&
  left?.enumerable === right?.enumerable &&
  left?.configurable === right?.configurable;
const fetchPrimeProfiles = new Map([
  ['20.18.1', {
    additions: ['Symbol(undici.globalDispatcher.1)'],
    materializations: [
      'AbortController',
      'AbortSignal',
      'TextEncoder',
      'TextDecoder',
      'ReadableStream',
      'File',
      'Request',
    ],
  }],
  ['22.23.1', {
    additions: ['Symbol(undici.globalDispatcher.1)'],
    materializations: [],
  }],
  ['24.18.0', {
    additions: [
      'Symbol(undici.globalDispatcher.1)',
      'Symbol(undici.globalDispatcher.2)',
    ],
    materializations: [],
  }],
]);
const fetchPrimeProfile = fetchPrimeProfiles.get(process.versions.node);
if (fetchPrimeProfile === undefined) {
  throw new Error('no exact Fetch/Undici global profile for Node ' + process.versions.node);
}
const fetchPrimeSnapshot = new Map(
  Reflect.ownKeys(globalThis).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
void globalThis.fetch;
new Request('https://pylva.invalid');
if (typeof globalThis.fetch !== 'function') {
  throw new Error('the supported Node runtime does not expose builtin fetch');
}
const fetchPrimeKeys = Reflect.ownKeys(globalThis);
const fetchPrimeAdditions = fetchPrimeKeys.filter((key) => !fetchPrimeSnapshot.has(key));
const fetchPrimeRemovals = [...fetchPrimeSnapshot.keys()].filter(
  (key) => !Object.prototype.hasOwnProperty.call(globalThis, key),
);
const fetchPrimeMutations = fetchPrimeKeys.filter(
  (key) =>
    fetchPrimeSnapshot.has(key) &&
    !descriptorEqual(
      Object.getOwnPropertyDescriptor(globalThis, key),
      fetchPrimeSnapshot.get(key),
    ),
);
const keyLabels = (keys) => keys.map((key) => String(key)).sort();
const exactStringArray = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const observedAdditions = keyLabels(fetchPrimeAdditions);
const expectedAdditions = [...fetchPrimeProfile.additions].sort();
const observedMutations = keyLabels(fetchPrimeMutations);
const expectedMutations = [...fetchPrimeProfile.materializations].sort();
if (
  fetchPrimeRemovals.length !== 0 ||
  !exactStringArray(observedAdditions, expectedAdditions) ||
  !exactStringArray(observedMutations, expectedMutations)
) {
  throw new Error(
    'builtin Fetch/Undici global delta differs for Node ' + process.versions.node + ': ' +
    JSON.stringify({
      additions: observedAdditions,
      expectedAdditions,
      removals: keyLabels(fetchPrimeRemovals),
      materializations: observedMutations,
      expectedMaterializations: expectedMutations,
    }),
  );
}
for (const key of fetchPrimeAdditions) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    descriptor.value === null ||
    typeof descriptor.value !== 'object' ||
    descriptor.writable !== true ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false
  ) {
    throw new Error('builtin Fetch/Undici installed an invalid dispatcher: ' + String(key));
  }
}
for (const name of fetchPrimeProfile.materializations) {
  const before = fetchPrimeSnapshot.get(name);
  const after = Object.getOwnPropertyDescriptor(globalThis, name);
  if (
    before === undefined ||
    after === undefined ||
    Object.prototype.hasOwnProperty.call(before, 'value') ||
    typeof before?.get !== 'function' ||
    typeof before?.set !== 'function' ||
    before.enumerable !== false ||
    before.configurable !== true ||
    !Object.prototype.hasOwnProperty.call(after, 'value') ||
    typeof after.value !== 'function' ||
    after.writable !== true ||
    after.enumerable !== false ||
    after.configurable !== true
  ) {
    throw new Error('builtin Fetch/Undici materialized an invalid lazy global: ' + name);
  }
}

let providerIo = 0;
const opaqueCreate = Object.defineProperty(
  function opaqueCreate() {
    providerIo += 1;
    throw new Error('opaque provider function was invoked');
  },
  '__pylva_patched',
  { value: true },
);
const poisonedOriginal = function poisonedOriginal() {
  providerIo += 1;
  throw new Error('poisoned legacy unwrap function was invoked');
};
const legacyUnwrapPoison = new WeakMap([[opaqueCreate, poisonedOriginal]]);
const decoys = [
  Object.freeze({ PylvaBudgetExceeded: class PoisonedBudgetError extends Error {} }),
  legacyUnwrapPoison,
  new WeakMap(),
  Object.freeze({
    apiKey: 'pv_live_deadbeef_' + '0'.repeat(32),
    authenticatedFetch: () => {
      providerIo += 1;
      throw new Error('poisoned coordinator fetch was invoked');
    },
  }),
];
for (let index = 0; index < symbols.length; index += 1) {
  Object.defineProperty(globalThis, symbols[index], {
    value: decoys[index],
    writable: true,
    configurable: true,
  });
}
globalThis.fetch = async () => {
  providerIo += 1;
  throw new Error('public surface smoke performed network I/O');
};

const peerCacheSnapshots = [];
for (const peer of ['openai', '@anthropic-ai/sdk', 'ai', '@ai-sdk/openai']) {
  try {
    const filename = require.resolve(peer);
    try { require(peer); } catch (error) {
      if (error?.code !== 'ERR_REQUIRE_ESM') throw error;
    }
    const cached = require.cache[filename];
    if (cached !== undefined) {
      peerCacheSnapshots.push({
        filename,
        cacheDescriptor: Object.getOwnPropertyDescriptor(require.cache, filename),
        module: cached,
        exports: cached.exports,
        exportsDescriptor: Object.getOwnPropertyDescriptor(cached, 'exports'),
      });
    }
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }
}
const nanDescriptorSymbol = Symbol('pylva.package-smoke.nan-descriptor');
Object.defineProperty(globalThis, nanDescriptorSymbol, {
  value: Number.NaN,
  writable: false,
  enumerable: false,
  configurable: true,
});
const globalSnapshot = new Map(
  Reflect.ownKeys(globalThis).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
const globalStateChanged = () => {
  const keys = Reflect.ownKeys(globalThis);
  return (
    keys.length !== globalSnapshot.size ||
    keys.some(
      (key) =>
        !globalSnapshot.has(key) ||
        !descriptorEqual(
          Object.getOwnPropertyDescriptor(globalThis, key),
          globalSnapshot.get(key),
        ),
    )
  );
};
const arbitraryGlobalSymbol = Symbol('pylva.package-smoke.arbitrary-global');
Object.defineProperty(globalThis, arbitraryGlobalSymbol, {
  value: true,
  configurable: true,
});
if (!globalStateChanged()) {
  throw new Error('process-global mutation gate allowed an arbitrary symbol');
}
if (!Reflect.deleteProperty(globalThis, arbitraryGlobalSymbol) || globalStateChanged()) {
  throw new Error('process-global mutation self-test did not restore the exact baseline');
}

const esm = Object.create(null);
const cjs = Object.create(null);
for (const [name, specifier] of Object.entries(specifiers)) {
  esm[name] = await import(specifier);
  cjs[name] = require(specifier);
}

if (globalStateChanged()) {
  throw new Error('SDK import added or mutated a process-global property');
}
const nanDescriptor = Object.getOwnPropertyDescriptor(globalThis, nanDescriptorSymbol);
if (
  !Object.is(nanDescriptor?.value, Number.NaN) ||
  nanDescriptor.writable !== false ||
  nanDescriptor.enumerable !== false ||
  nanDescriptor.configurable !== true
) {
  throw new Error('SDK import mutated the NaN process-global descriptor');
}
for (const snapshot of peerCacheSnapshots) {
  if (
    require.cache[snapshot.filename] !== snapshot.module ||
    snapshot.module.exports !== snapshot.exports ||
    !descriptorEqual(
      Object.getOwnPropertyDescriptor(require.cache, snapshot.filename),
      snapshot.cacheDescriptor,
    ) ||
    !descriptorEqual(
      Object.getOwnPropertyDescriptor(snapshot.module, 'exports'),
      snapshot.exportsDescriptor,
    )
  ) {
    throw new Error('SDK import mutated a peer module cache record: ' + snapshot.filename);
  }
}
const installedPackageRoot = realpathSync(
  path.dirname(path.dirname(require.resolve('@pylva/sdk'))),
);
for (const specifier of Object.values(specifiers)) {
  for (const resolved of [require.resolve(specifier), fileURLToPath(import.meta.resolve(specifier))]) {
    const real = realpathSync(resolved);
    const relative = path.relative(installedPackageRoot, real);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('SDK entry resolved outside the isolated install: ' + real);
    }
  }
}

const forbiddenExportName = (name) =>
  /^_original/i.test(name) ||
  /^_reset/i.test(name) ||
  /ForTests$/i.test(name) ||
  /^(?:get|require|resolve|read|raw|unsafe|internal)(?:Raw)?(?:Config|ApiKey|AuthHeaders?|Headers?|Fetch|ProviderClient|ProviderModel|Evidence|Registry|Map|AsyncLocalStorage|ALS|Resolver)$/i.test(name) ||
  /^(?:originalProviderMethod|registerPatchedOriginal|loadPeer|runtimeSingleton|coreCoordinator|authenticatedFetch)$/i.test(name);

function assertSurface(surface, name, format) {
  const expectedKeys = [...expected[name]].sort();
  const actualKeys = Object.keys(surface)
    .filter((key) => key !== '__esModule')
    .sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      format + ' ' + name + ' export keys differ: ' + JSON.stringify(actualKeys),
    );
  }
  for (const key of actualKeys) {
    if (forbiddenExportName(key)) {
      throw new Error(format + ' ' + name + ' exposes forbidden capability ' + key);
    }
    if (surface[key] === undefined) {
      throw new Error(format + ' ' + name + '.' + key + ' is undefined');
    }
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== false ||
      descriptor.set !== undefined ||
      (descriptor.get === undefined && !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
    ) {
      throw new Error(format + ' ' + name + '.' + key + ' has an unsafe descriptor');
    }
  }
  for (const key of Reflect.ownKeys(surface)) {
    if (typeof key === 'string') {
      if (key === '__esModule') {
        const descriptor = Object.getOwnPropertyDescriptor(surface, key);
        if (
          descriptor?.value !== true ||
          descriptor.enumerable !== false ||
          descriptor.writable !== false ||
          descriptor.configurable !== false
        ) {
          throw new Error(format + ' ' + name + ' has an unsafe __esModule marker');
        }
      } else if (!expectedKeys.includes(key) || forbiddenExportName(key)) {
        throw new Error(format + ' ' + name + ' exposes hidden capability ' + key);
      }
    } else if (key !== Symbol.toStringTag) {
      throw new Error(format + ' ' + name + ' exposes symbol key ' + String(key));
    } else {
      const descriptor = Object.getOwnPropertyDescriptor(surface, key);
      if (
        descriptor?.value !== 'Module' ||
        descriptor.enumerable !== false ||
        descriptor.writable !== false ||
        descriptor.configurable !== false
      ) {
        throw new Error(format + ' ' + name + ' has an unsafe toStringTag descriptor');
      }
    }
  }
  if (format === 'ESM') {
    if (Object.getPrototypeOf(surface) !== null || Object.isExtensible(surface)) {
      throw new Error('ESM ' + name + ' namespace is mutable');
    }
  } else if (
    !Object.isFrozen(surface) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(surface))
  ) {
    throw new Error('CJS ' + name + ' exports are mutable or have a custom prototype');
  }
  const probe = expectedKeys[0];
  const value = surface[probe];
  if (
    Reflect.set(surface, probe, Object.freeze({ poisoned: true })) ||
    Reflect.deleteProperty(surface, probe) ||
    surface[probe] !== value
  ) {
    throw new Error(format + ' ' + name + ' export mutation succeeded');
  }
}

for (const name of Object.keys(specifiers)) {
  assertSurface(esm[name], name, 'ESM');
  assertSurface(cjs[name], name, 'CJS');
  for (const key of expected[name]) {
    if (esm[name][key] !== cjs[name][key]) {
      throw new Error(name + '.' + key + ' differs between ESM and CJS');
    }
  }
}

const constructors = {
  InvalidApiKeyError: () => new esm.root.InvalidApiKeyError(),
  InvalidControlConfigError: () => new esm.root.InvalidControlConfigError('surface probe'),
  InvalidSignatureFormat: () => new esm.root.InvalidSignatureFormat('surface probe'),
  PylvaBudgetExceeded: () =>
    new esm.root.PylvaBudgetExceeded({
      source: 'authoritative_control',
      rule_id: 'rule-surface',
      customer_id: null,
      period: 'day',
      period_start: '2026-07-14T00:00:00.000Z',
      limit_usd: 1,
      accumulated_usd: 1,
      estimated_usd: 0.1,
    }),
  PylvaControlUnavailableError: () =>
    new esm.root.PylvaControlUnavailableError({
      reason: 'network_error',
      retryable: true,
      operation: 'reserveUsage',
    }),
  PylvaControlApiError: () => new esm.root.PylvaControlApiError(409, 'operation_conflict'),
  PylvaControlValidationError: () =>
    new esm.root.PylvaControlValidationError('reserveUsage'),
  PylvaStrictProviderError: () =>
    new esm.root.PylvaStrictProviderError('openai', 'surface_probe'),
};
for (const [name, construct] of Object.entries(constructors)) {
  const Constructor = esm.root[name];
  if (
    Constructor !== cjs.root[name] ||
    Constructor.name !== name ||
    Constructor.prototype.constructor !== Constructor
  ) {
    throw new Error(name + ' lost constructor identity or name');
  }
  const instance = construct();
  if (
    instance.name !== name ||
    !(instance instanceof Constructor) ||
    Object.getPrototypeOf(instance) !== Constructor.prototype
  ) {
    throw new Error(name + ' lost its exact public prototype');
  }
}

const publicClasses = {
  Pylva: [esm.root.Pylva, cjs.root.Pylva],
  PylvaCallbackHandler: [esm.langgraph.PylvaCallbackHandler, cjs.langgraph.PylvaCallbackHandler],
  AsyncPylvaCallbackHandler: [
    esm.langgraph.AsyncPylvaCallbackHandler,
    cjs.langgraph.AsyncPylvaCallbackHandler,
  ],
};
for (const [name, [esmClass, cjsClass]] of Object.entries(publicClasses)) {
  if (
    esmClass !== cjsClass ||
    esmClass.name !== name ||
    esmClass.prototype.constructor !== esmClass
  ) {
    throw new Error(name + ' lost public class identity or name');
  }
}
if (
  esm.langchain.PylvaCallbackHandler !== esm.langgraph.PylvaCallbackHandler ||
  cjs.langchain.PylvaCallbackHandler !== cjs.langgraph.PylvaCallbackHandler ||
  esm.langchain.AsyncPylvaCallbackHandler !== esm.langgraph.AsyncPylvaCallbackHandler ||
  cjs.langchain.AsyncPylvaCallbackHandler !== cjs.langgraph.AsyncPylvaCallbackHandler ||
  esm.langchain.withLangGraphControlScope !== esm.langgraph.withLangGraphControlScope ||
  cjs.langchain.withLangGraphControlScope !== cjs.langgraph.withLangGraphControlScope
) {
  throw new Error('LangChain and LangGraph aliases do not share exact runtime identities');
}
for (const [Handler, Base] of [
  [esm.langgraph.PylvaCallbackHandler, esm.langgraph.PylvaCallbackHandler],
  [esm.langchain.AsyncPylvaCallbackHandler, esm.langgraph.PylvaCallbackHandler],
  [cjs.langgraph.PylvaCallbackHandler, cjs.langgraph.PylvaCallbackHandler],
  [cjs.langchain.AsyncPylvaCallbackHandler, cjs.langgraph.PylvaCallbackHandler],
]) {
  const instance = new Handler();
  if (!(instance instanceof Base) || Object.getPrototypeOf(instance) !== Handler.prototype) {
    throw new Error(Handler.name + ' lost its exact callback prototype');
  }
}

for (let index = 0; index < symbols.length; index += 1) {
  if (globalThis[symbols[index]] !== decoys[index]) {
    throw new Error('SDK consumed or replaced process-global symbol ' + symbolNames[index]);
  }
  globalThis[symbols[index]] = Object.freeze({ replacement: symbolNames[index] });
}
const sdkSymbols = Reflect.ownKeys(globalThis)
  .filter((key) => typeof key === 'symbol')
  .map((key) => Symbol.keyFor(key))
  .filter((key) => key?.startsWith('@pylva/sdk-runtime/'))
  .sort();
if (JSON.stringify(sdkSymbols) !== JSON.stringify([...symbolNames].sort())) {
  throw new Error('SDK published unexpected process-global symbols: ' + JSON.stringify(sdkSymbols));
}

let opaqueError;
try {
  await cjs.openai.wrapOpenAI({
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    chat: { completions: { create: opaqueCreate } },
  });
} catch (error) {
  opaqueError = error;
}
if (
  !(opaqueError instanceof esm.root.PylvaStrictProviderError) ||
  opaqueError.reason !== 'invalid_client' ||
  Object.getPrototypeOf(opaqueError) !== esm.root.PylvaStrictProviderError.prototype ||
  providerIo !== 0
) {
  throw new Error('forged opaque client did not refuse with zero provider I/O');
}

const rootCjsPath = require.resolve('@pylva/sdk');
const packageDist = path.dirname(rootCjsPath);
const publicCjsPaths = Object.values(specifiers).map((specifier) => require.resolve(specifier));
const packageCjsPaths = Object.keys(require.cache).filter((filename) => {
  const relative = path.relative(packageDist, filename);
  return relative !== '' && !relative.startsWith('..' + path.sep) && filename.endsWith('.cjs');
});
for (const filename of publicCjsPaths) {
  if (!packageCjsPaths.includes(filename)) {
    throw new Error('canonical public CJS was not loaded: ' + filename);
  }
}
if (!packageCjsPaths.some((filename) => filename.includes(path.sep + 'internal' + path.sep))) {
  throw new Error('canonical internal CJS modules were not loaded');
}
for (const filename of packageCjsPaths) {
  const cacheDescriptor = Object.getOwnPropertyDescriptor(require.cache, filename);
  const cachedModule = require.cache[filename];
  const exportsDescriptor = Object.getOwnPropertyDescriptor(cachedModule, 'exports');
  if (
    cacheDescriptor?.value !== cachedModule ||
    cacheDescriptor.writable !== false ||
    cacheDescriptor.configurable !== false ||
    exportsDescriptor?.value !== cachedModule.exports ||
    exportsDescriptor.writable !== false ||
    exportsDescriptor.configurable !== false ||
    !Object.isFrozen(cachedModule.exports)
  ) {
    throw new Error('canonical CJS hardening is incomplete: ' + filename);
  }
  const originalModule = cachedModule;
  const originalExports = cachedModule.exports;
  if (
    Reflect.deleteProperty(require.cache, filename) ||
    Reflect.set(require.cache, filename, { exports: { poisoned: true } }) ||
    Reflect.set(cachedModule, 'exports', { poisoned: true }) ||
    require.cache[filename] !== originalModule ||
    cachedModule.exports !== originalExports ||
    require(filename) !== originalExports
  ) {
    throw new Error('canonical CJS cache mutation succeeded: ' + filename);
  }
}

console.log('installed ESM/CJS public surface and hardening smoke passed');
`,
    );

    writeFileSync(
      path.join(installDir, 'esm-smoke.mjs'),
      `
const lifecycleReservationId = '44444444-4444-4444-8444-444444444444';
const lifecycleOperationId = '11111111-1111-4111-8111-111111111111';
const lifecycleExtensionId = '55555555-5555-4555-8555-555555555555';
const lifecycleJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_package_smoke' },
});
globalThis.fetch = async (input) => {
  const href = input instanceof Request ? input.url : String(input);
  if (href.endsWith('/' + lifecycleReservationId + '/commit')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'committed', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, reserved_usd: '1', actual_usd: '0.25',
      released_usd: '0.75', overage_usd: '0', budget_exceeded_after_commit: false,
      committed_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false, late: false,
    });
  }
  if (href.endsWith('/' + lifecycleReservationId + '/release')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'released', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, released_usd: '1',
      released_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false,
    });
  }
  if (href.endsWith('/' + lifecycleReservationId + '/extend')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'reserved', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, extension_id: lifecycleExtensionId,
      expires_at: '2026-07-14T09:10:00.000Z', idempotent_replay: false,
    });
  }
  throw new Error('network access in ESM package smoke: ' + href);
};
const sdk = await import('@pylva/sdk');
const expectedVersion = ${expectedVersion};
if (sdk.SDK_VERSION !== expectedVersion) throw new Error(\`ESM version \${sdk.SDK_VERSION} !== \${expectedVersion}\`);
for (const name of ${requiredExports}) {
  if (typeof sdk[name] !== 'function') throw new Error(\`ESM export \${name} is missing\`);
}
for (const subpath of ${publicSubpaths}) {
  await import(\`@pylva/sdk/\${subpath}\`);
}
if (typeof sdk.PylvaControlUnavailableError !== 'function') throw new Error('ESM control error is missing');
const openaiSubpath = await import('@pylva/sdk/openai');
const anthropicSubpath = await import('@pylva/sdk/anthropic');
const vercelSubpath = await import('@pylva/sdk/vercel-ai');
const langgraphSubpath = await import('@pylva/sdk/langgraph');
if (typeof openaiSubpath.wrapOpenAI !== 'function' || typeof anthropicSubpath.wrapAnthropic !== 'function') {
  throw new Error('ESM strict provider subpath exports are missing');
}
if (typeof vercelSubpath.controlledGenerateText !== 'function' || typeof vercelSubpath.controlledStreamText !== 'function') {
  throw new Error('ESM strict Vercel AI exports are missing');
}
if (typeof langgraphSubpath.withLangGraphControlScope !== 'function') {
  throw new Error('ESM LangGraph control scope export is missing');
}
let strictError;
try { await sdk.wrapOpenAI({}); } catch (error) { strictError = error; }
if (!(strictError instanceof sdk.PylvaStrictProviderError) || strictError.code !== 'strict_provider_unsupported') {
  throw new Error('ESM strict provider error identity is missing');
}
if (sdk.currentControlledAttempt() !== undefined) throw new Error('ESM ownership leaked outside dispatch');
sdk.init({ apiKey: 'pv_live_aabbccdd_${'a'.repeat(32)}', localMode: true });
const isReady = await sdk.ready();
if (typeof isReady !== 'boolean' || isReady !== false) throw new Error(\`ESM ready() was not false: \${String(isReady)}\`);
if (sdk.shouldSuppressLegacyTelemetry({}, { operationId: '11111111-1111-4111-8111-111111111111', reservationId: '44444444-4444-4444-8444-444444444444' })) {
  throw new Error('ESM suppression accepted an unowned object');
}
const result = await sdk.reserveUsage(${serializedInput});
if (result.decision !== 'bypassed' || result.reason !== 'control_disabled' || result.local !== true) {
  throw new Error(\`ESM local legacy smoke failed: \${JSON.stringify(result)}\`);
}
const committed = await sdk.commitUsage({
  reservationId: lifecycleReservationId,
  kind: 'llm',
  status: 'success',
  latencyMs: 25,
  streamAborted: false,
  actualInputTokens: 2,
  actualOutputTokens: 1,
});
if (committed.state !== 'committed' || committed.operationId !== lifecycleOperationId || committed.actualUsd !== '0.25') {
  throw new Error('ESM commit lifecycle mapping failed: ' + JSON.stringify(committed));
}
const released = await sdk.releaseUsage({
  reservationId: lifecycleReservationId,
  reason: 'provider_not_called',
});
if (released.state !== 'released' || released.operationId !== lifecycleOperationId || released.releasedUsd !== '1') {
  throw new Error('ESM release lifecycle mapping failed: ' + JSON.stringify(released));
}
const extended = await sdk.extendUsage({
  reservationId: lifecycleReservationId,
  extensionId: lifecycleExtensionId,
  extendBySeconds: 300,
});
if (extended.state !== 'reserved' || extended.operationId !== lifecycleOperationId || extended.extensionId !== lifecycleExtensionId) {
  throw new Error('ESM extend lifecycle mapping failed: ' + JSON.stringify(extended));
}
const controlled = await sdk.controlledExactUsage({
  costSourceSlug: 'document-parser',
  toolName: 'Document Parser',
  metric: 'page',
  value: 1,
  customerId: 'package-smoke',
  invoke: () => 'controlled-provider-value',
});
if (controlled.value !== 'controlled-provider-value' || controlled.control.decision !== 'bypassed' || controlled.control.settlement !== 'bypassed' || controlled.control.actualValue !== '1') {
  throw new Error('ESM controlled exact usage smoke failed: ' + JSON.stringify(controlled.control));
}
const tavily = await sdk.controlledTavilySearch(
  {
    search: async (query, options) => {
      if (query !== 'private package smoke query' || options?.searchDepth !== 'basic' || options?.autoParameters !== false || options?.includeUsage !== true) {
        throw new Error('ESM Tavily adapter did not lock its one-credit options');
      }
      return { results: [], usage: { credits: 1 } };
    },
  },
  { query: 'private package smoke query', customerId: 'package-smoke' },
);
if (tavily.control.decision !== 'bypassed' || tavily.control.actualValue !== '1' || sdk.TAVILY_SEARCH_COST_SOURCE_SLUG !== 'tavily-search' || sdk.TAVILY_SEARCH_METRIC !== 'credit' || sdk.TAVILY_BASIC_SEARCH_CREDITS !== '1') {
  throw new Error('ESM controlled Tavily smoke failed: ' + JSON.stringify(tavily.control));
}
`,
    );
    writeFileSync(
      path.join(installDir, 'cjs-smoke.cjs'),
      `
const lifecycleReservationId = '44444444-4444-4444-8444-444444444444';
const lifecycleOperationId = '11111111-1111-4111-8111-111111111111';
const lifecycleExtensionId = '55555555-5555-4555-8555-555555555555';
const lifecycleJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_package_smoke' },
});
global.fetch = async (input) => {
  const href = input instanceof Request ? input.url : String(input);
  if (href.endsWith('/' + lifecycleReservationId + '/commit')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'committed', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, reserved_usd: '1', actual_usd: '0.25',
      released_usd: '0.75', overage_usd: '0', budget_exceeded_after_commit: false,
      committed_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false, late: false,
    });
  }
  if (href.endsWith('/' + lifecycleReservationId + '/release')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'released', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, released_usd: '1',
      released_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false,
    });
  }
  if (href.endsWith('/' + lifecycleReservationId + '/extend')) {
    return lifecycleJson({
      schema_version: '1.0', state: 'reserved', reservation_id: lifecycleReservationId,
      operation_id: lifecycleOperationId, extension_id: lifecycleExtensionId,
      expires_at: '2026-07-14T09:10:00.000Z', idempotent_replay: false,
    });
  }
  throw new Error('network access in CJS package smoke: ' + href);
};
const sdk = require('@pylva/sdk');
const expectedVersion = ${expectedVersion};
if (sdk.SDK_VERSION !== expectedVersion) throw new Error(\`CJS version \${sdk.SDK_VERSION} !== \${expectedVersion}\`);
for (const name of ${requiredExports}) {
  if (typeof sdk[name] !== 'function') throw new Error(\`CJS export \${name} is missing\`);
}
for (const subpath of ${publicSubpaths}) {
  require(\`@pylva/sdk/\${subpath}\`);
}
if (typeof sdk.PylvaControlUnavailableError !== 'function') throw new Error('CJS control error is missing');
const openaiSubpath = require('@pylva/sdk/openai');
const anthropicSubpath = require('@pylva/sdk/anthropic');
const vercelSubpath = require('@pylva/sdk/vercel-ai');
const langgraphSubpath = require('@pylva/sdk/langgraph');
if (typeof openaiSubpath.wrapOpenAI !== 'function' || typeof anthropicSubpath.wrapAnthropic !== 'function') {
  throw new Error('CJS strict provider subpath exports are missing');
}
if (typeof vercelSubpath.controlledGenerateText !== 'function' || typeof vercelSubpath.controlledStreamText !== 'function') {
  throw new Error('CJS strict Vercel AI exports are missing');
}
if (typeof langgraphSubpath.withLangGraphControlScope !== 'function') {
  throw new Error('CJS LangGraph control scope export is missing');
}
if (sdk.currentControlledAttempt() !== undefined) throw new Error('CJS ownership leaked outside dispatch');
(async () => {
  let strictError;
  try { await sdk.wrapOpenAI({}); } catch (error) { strictError = error; }
  if (!(strictError instanceof sdk.PylvaStrictProviderError) || strictError.code !== 'strict_provider_unsupported') {
    throw new Error('CJS strict provider error identity is missing');
  }
  sdk.init({ apiKey: 'pv_live_aabbccdd_${'a'.repeat(32)}', localMode: true });
  const isReady = await sdk.ready();
  if (typeof isReady !== 'boolean' || isReady !== false) throw new Error(\`CJS ready() was not false: \${String(isReady)}\`);
  if (sdk.shouldSuppressLegacyTelemetry({}, { operationId: '11111111-1111-4111-8111-111111111111', reservationId: '44444444-4444-4444-8444-444444444444' })) {
    throw new Error('CJS suppression accepted an unowned object');
  }
  const committed = await sdk.commitUsage({
    reservationId: lifecycleReservationId,
    kind: 'llm',
    status: 'success',
    latencyMs: 25,
    streamAborted: false,
    actualInputTokens: 2,
    actualOutputTokens: 1,
  });
  if (committed.state !== 'committed' || committed.operationId !== lifecycleOperationId || committed.actualUsd !== '0.25') {
    throw new Error('CJS commit lifecycle mapping failed: ' + JSON.stringify(committed));
  }
  const released = await sdk.releaseUsage({
    reservationId: lifecycleReservationId,
    reason: 'provider_not_called',
  });
  if (released.state !== 'released' || released.operationId !== lifecycleOperationId || released.releasedUsd !== '1') {
    throw new Error('CJS release lifecycle mapping failed: ' + JSON.stringify(released));
  }
  const extended = await sdk.extendUsage({
    reservationId: lifecycleReservationId,
    extensionId: lifecycleExtensionId,
    extendBySeconds: 300,
  });
  if (extended.state !== 'reserved' || extended.operationId !== lifecycleOperationId || extended.extensionId !== lifecycleExtensionId) {
    throw new Error('CJS extend lifecycle mapping failed: ' + JSON.stringify(extended));
  }
  const controlled = await sdk.controlledExactUsage({
    costSourceSlug: 'document-parser',
    toolName: 'Document Parser',
    metric: 'page',
    value: 1,
    customerId: 'package-smoke',
    invoke: () => 'controlled-provider-value',
  });
  if (controlled.value !== 'controlled-provider-value' || controlled.control.decision !== 'bypassed' || controlled.control.settlement !== 'bypassed' || controlled.control.actualValue !== '1') {
    throw new Error('CJS controlled exact usage smoke failed: ' + JSON.stringify(controlled.control));
  }
  const tavily = await sdk.controlledTavilySearch(
    {
      search: async (query, options) => {
        if (query !== 'private package smoke query' || options?.searchDepth !== 'basic' || options?.autoParameters !== false || options?.includeUsage !== true) {
          throw new Error('CJS Tavily adapter did not lock its one-credit options');
        }
        return { results: [], usage: { credits: 1 } };
      },
    },
    { query: 'private package smoke query', customerId: 'package-smoke' },
  );
  if (tavily.control.decision !== 'bypassed' || tavily.control.actualValue !== '1' || sdk.TAVILY_SEARCH_COST_SOURCE_SLUG !== 'tavily-search' || sdk.TAVILY_SEARCH_METRIC !== 'credit' || sdk.TAVILY_BASIC_SEARCH_CREDITS !== '1') {
    throw new Error('CJS controlled Tavily smoke failed: ' + JSON.stringify(tavily.control));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    );

    writeFileSync(
      path.join(installDir, 'source-map-stack.mjs'),
      `
import { createRequire } from 'node:module';

const format = process.argv[2];
if (format !== 'esm' && format !== 'cjs') throw new Error('invalid stack format');
const require = createRequire(import.meta.url);
let io = 0;
globalThis.fetch = async () => {
  io += 1;
  throw new Error('source-map smoke performed network I/O');
};
const sdk = format === 'esm' ? await import('@pylva/sdk') : require('@pylva/sdk');
let refusal;
try {
  await sdk.wrapOpenAI({});
} catch (error) {
  refusal = error;
}
const stack = String(refusal?.stack ?? '');
if (
  !(refusal instanceof sdk.PylvaStrictProviderError) ||
  refusal.name !== 'PylvaStrictProviderError' ||
  Object.getPrototypeOf(refusal) !== sdk.PylvaStrictProviderError.prototype ||
  !/[\\\\/](?:src|shared[\\\\/]src)[\\\\/].+\\.ts:\\d+:\\d+/u.test(stack) ||
  stack.includes(${JSON.stringify(repoRoot)}) ||
  io !== 0
) {
  throw new Error('source-mapped ' + format + ' refusal stack is invalid: ' + stack);
}
console.log('source-mapped strict refusal passed (' + format + ')');
`,
    );

    writeFileSync(
      path.join(installDir, 'esm-bundle-identity.mjs'),
      `
const order = process.argv[2];
if (order !== 'root-first' && order !== 'subpath-first') {
  throw new Error('invalid ESM bundle identity import order: ' + order);
}
const keys = ${bundleIdentityKeys};
const responseJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_bundle_identity' },
});
const urlOf = (input) => input instanceof Request ? input.url : String(input);
const bodyOf = async (input, request) => {
  if (input instanceof Request) return input.clone().text();
  return request?.body == null ? '' : String(request.body);
};
let mode = 'success';
let providerCalls = 0;
globalThis.fetch = async (input, request) => {
  const url = urlOf(input);
  if (url.endsWith('/api/v1/pricing')) return responseJson({ models: [] });
  if (url.endsWith('/api/v1/rules')) return responseJson({ rules: [] });
  if (url.endsWith('/api/v1/budget/capabilities')) {
    if (mode === 'unavailable') throw new Error('control is offline');
    return responseJson({
      schema_version: '1.0', control_enabled: true,
      min_reservation_ttl_seconds: 30, default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600, server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (url.endsWith('/api/v1/budget/reservations')) {
    if (mode !== 'denied') throw new Error('unexpected reservation in mode ' + mode);
    const body = JSON.parse(await bodyOf(input, request));
    return responseJson({
      schema_version: '1.0', decision: 'denied', allowed: false,
      decision_id: '55555555-5555-4555-8555-555555555555', operation_id: body.operation_id,
      state: 'refused',
      deciding_rule: {
        rule_id: '66666666-6666-4666-8666-666666666666', scope: 'pooled', customer_id: null,
        period: 'day', period_start: '2026-07-14T00:00:00.000Z',
        period_end: '2026-07-15T00:00:00.000Z',
      },
      committed_usd: '1', reserved_usd: '0', unresolved_usd: '0', requested_usd: '0.1',
      limit_usd: '1', remaining_usd: '0', warnings: [],
    });
  }
  if (url === 'https://api.openai.com/v1/chat/completions') {
    providerCalls += 1;
    return responseJson({
      id: 'chatcmpl_bundle', object: 'chat.completion', created: 1784009600,
      model: 'gpt-4o-mini', service_tier: 'default', choices: [],
      usage: {
        prompt_tokens: 2, completion_tokens: 1, total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    });
  }
  if (url === 'https://api.anthropic.com/v1/messages') {
    providerCalls += 1;
    return responseJson({
      id: 'msg_bundle', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      service_tier: 'standard', content: [{ type: 'text', text: 'bundle identity' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0, server_tool_use: null, service_tier: 'standard',
      },
    });
  }
  throw new Error('unexpected ESM bundle identity fetch: ' + url);
};

if (process.env.PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM === '1') {
  await import('openai/shims/web');
}
if (process.env.PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM === '1') {
  await import('@anthropic-ai/sdk/shims/web');
}
const [{ default: OpenAI }, { default: Anthropic }] = await Promise.all([
  import('openai'), import('@anthropic-ai/sdk'),
]);
const waitForPatch = async (read, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read().__pylva_patched === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('ESM root auto-patch did not reach ' + label);
};

let sdk;
let openaiSubpath;
let anthropicSubpath;
let vercelSubpath;
let openai;
let anthropic;
if (order === 'subpath-first') {
  [openaiSubpath, anthropicSubpath, vercelSubpath] = await Promise.all([
    import('@pylva/sdk/openai'),
    import('@pylva/sdk/anthropic'),
    import('@pylva/sdk/vercel-ai'),
  ]);
  openaiSubpath.applyOpenAiPatch();
  anthropicSubpath.applyAnthropicPatch();
  openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
  anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
  await waitForPatch(() => openai.chat.completions.create, 'OpenAI from subpath');
  await waitForPatch(() => anthropic.messages.create, 'Anthropic from subpath');
  sdk = await import('@pylva/sdk');
} else {
  sdk = await import('@pylva/sdk');
  [openaiSubpath, anthropicSubpath, vercelSubpath] = await Promise.all([
    import('@pylva/sdk/openai'),
    import('@pylva/sdk/anthropic'),
    import('@pylva/sdk/vercel-ai'),
  ]);
  openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
  anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
  await waitForPatch(() => openai.chat.completions.create, 'OpenAI from root');
  await waitForPatch(() => anthropic.messages.create, 'Anthropic from root');
}

if (
  openaiSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
  anthropicSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
  vercelSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
  vercelSubpath.createControlledOpenAIChatModel !== sdk.createControlledOpenAIChatModel ||
  vercelSubpath.controlledGenerateText !== sdk.controlledGenerateText ||
  vercelSubpath.controlledStreamText !== sdk.controlledStreamText
) {
  throw new Error('ESM strict root/deep identity differs across standalone bundles');
}
const esmDeepToken = await vercelSubpath.createControlledOpenAIChatModel({
  apiKey: 'esm-order-private-provider-key', model: 'gpt-4o-mini',
});
if (!Object.isFrozen(esmDeepToken) || Object.getPrototypeOf(esmDeepToken) !== null || Reflect.ownKeys(esmDeepToken).length !== 0) {
  throw new Error('ESM ordered Vercel model token lost its opaque prototype');
}
sdk.init({ apiKey: keys.first, endpoint: 'https://identity-first.test', localMode: true });
sdk.init({ apiKey: keys.second, endpoint: 'https://identity-second.test', localMode: true });

const rootOpenAI = await sdk.wrapOpenAI(openai);
const rootAnthropic = await sdk.wrapAnthropic(anthropic);
const subpathOpenAI = await openaiSubpath.wrapOpenAI(openai);
const subpathAnthropic = await anthropicSubpath.wrapAnthropic(anthropic);
const openaiBody = {
  model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'private bundle prompt' }],
  max_completion_tokens: 2,
};
const anthropicBody = {
  model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'private bundle prompt' }],
  max_tokens: 2,
};
for (const wrapped of [rootOpenAI, subpathOpenAI]) {
  const result = await wrapped.chat.completions.create(openaiBody);
  if (result.model !== 'gpt-4o-mini') throw new Error('ESM official OpenAI result changed');
}
for (const wrapped of [rootAnthropic, subpathAnthropic]) {
  const result = await wrapped.messages.create(anthropicBody);
  if (result.model !== 'claude-sonnet-4-5') throw new Error('ESM official Anthropic result changed');
}
if (providerCalls !== 4) throw new Error('ESM official provider dispatch count was ' + providerCalls);

const opaqueCreate = Object.defineProperty(function opaqueCreate() {}, '__pylva_patched', {
  value: true,
});
let opaqueError;
try {
  await openaiSubpath.wrapOpenAI({
    baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    chat: { completions: { create: opaqueCreate } },
  });
} catch (error) {
  opaqueError = error;
}
if (
  !(opaqueError instanceof sdk.PylvaStrictProviderError) ||
  opaqueError.reason !== 'invalid_client' ||
  Object.getPrototypeOf(opaqueError) !== sdk.PylvaStrictProviderError.prototype ||
  sdk.PylvaStrictProviderError.name !== 'PylvaStrictProviderError'
) {
  throw new Error('ESM forged-client refusal lost root strict-error identity');
}

mode = 'denied';
sdk.init({
  apiKey: keys.denied, endpoint: 'https://identity-denied.test',
  control: { mode: 'enforce', onUnavailable: 'deny' },
});
let denial;
try {
  await subpathOpenAI.chat.completions.create(openaiBody);
} catch (error) {
  denial = error;
}
if (
  !(denial instanceof sdk.PylvaBudgetExceeded) || denial.name !== 'PylvaBudgetExceeded' ||
  denial.code !== 'budget_exceeded' || denial.source !== 'authoritative_control' ||
  denial.rule_id !== '66666666-6666-4666-8666-666666666666' ||
  Object.getPrototypeOf(denial) !== sdk.PylvaBudgetExceeded.prototype ||
  sdk.PylvaBudgetExceeded.name !== 'PylvaBudgetExceeded'
) {
  throw new Error('ESM subpath denial lost root budget-error identity');
}

mode = 'unavailable';
sdk.init({
  apiKey: keys.unavailable, endpoint: 'https://identity-unavailable.test',
  control: { mode: 'enforce', onUnavailable: 'deny' },
});
let unavailable;
try {
  await subpathAnthropic.messages.create(anthropicBody);
} catch (error) {
  unavailable = error;
}
if (
  !(unavailable instanceof sdk.PylvaControlUnavailableError) ||
  unavailable.name !== 'PylvaControlUnavailableError' ||
  unavailable.code !== 'control_unavailable' || unavailable.reason !== 'network_error' ||
  unavailable.operation !== 'reserveUsage' ||
  Object.getPrototypeOf(unavailable) !== sdk.PylvaControlUnavailableError.prototype ||
  sdk.PylvaControlUnavailableError.name !== 'PylvaControlUnavailableError'
) {
  throw new Error('ESM subpath unavailable lost root control-error identity');
}
if (providerCalls !== 4) throw new Error('ESM refusal dispatched an official provider call');

const apiError = new sdk.PylvaControlApiError(409, 'operation_conflict', 'operation_id');
const validationError = new sdk.PylvaControlValidationError('reserveUsage');
if (
  apiError.name !== 'PylvaControlApiError' || apiError.status !== 409 ||
  apiError.code !== 'operation_conflict' || apiError.param !== 'operation_id' ||
  Object.getPrototypeOf(apiError) !== sdk.PylvaControlApiError.prototype ||
  sdk.PylvaControlApiError.name !== 'PylvaControlApiError' ||
  !(validationError instanceof TypeError) || validationError.name !== 'PylvaControlValidationError' ||
  validationError.operation !== 'reserveUsage' ||
  Object.getPrototypeOf(validationError) !== sdk.PylvaControlValidationError.prototype ||
  sdk.PylvaControlValidationError.name !== 'PylvaControlValidationError'
) {
  throw new Error('ESM public control constructors lost class fields or prototypes');
}
console.log('ESM bundle identity smoke passed (' + order + ')');
`,
    );

    writeFileSync(
      path.join(installDir, 'cjs-bundle-identity.cjs'),
      `
const order = process.argv[2];
if (order !== 'root-first' && order !== 'subpath-first') {
  throw new Error('invalid CJS bundle identity import order: ' + order);
}
const keys = ${bundleIdentityKeys};
const responseJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_bundle_identity' },
});
const urlOf = (input) => input instanceof Request ? input.url : String(input);
const bodyOf = async (input, request) => {
  if (input instanceof Request) return input.clone().text();
  return request?.body == null ? '' : String(request.body);
};
let mode = 'success';
let providerCalls = 0;
global.fetch = async (input, request) => {
  const url = urlOf(input);
  if (url.endsWith('/api/v1/pricing')) return responseJson({ models: [] });
  if (url.endsWith('/api/v1/rules')) return responseJson({ rules: [] });
  if (url.endsWith('/api/v1/budget/capabilities')) {
    if (mode === 'unavailable') throw new Error('control is offline');
    return responseJson({
      schema_version: '1.0', control_enabled: true,
      min_reservation_ttl_seconds: 30, default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600, server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (url.endsWith('/api/v1/budget/reservations')) {
    if (mode !== 'denied') throw new Error('unexpected reservation in mode ' + mode);
    const body = JSON.parse(await bodyOf(input, request));
    return responseJson({
      schema_version: '1.0', decision: 'denied', allowed: false,
      decision_id: '55555555-5555-4555-8555-555555555555', operation_id: body.operation_id,
      state: 'refused',
      deciding_rule: {
        rule_id: '66666666-6666-4666-8666-666666666666', scope: 'pooled', customer_id: null,
        period: 'day', period_start: '2026-07-14T00:00:00.000Z',
        period_end: '2026-07-15T00:00:00.000Z',
      },
      committed_usd: '1', reserved_usd: '0', unresolved_usd: '0', requested_usd: '0.1',
      limit_usd: '1', remaining_usd: '0', warnings: [],
    });
  }
  if (url === 'https://api.openai.com/v1/chat/completions') {
    providerCalls += 1;
    return responseJson({
      id: 'chatcmpl_bundle', object: 'chat.completion', created: 1784009600,
      model: 'gpt-4o-mini', service_tier: 'default', choices: [],
      usage: {
        prompt_tokens: 2, completion_tokens: 1, total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    });
  }
  if (url === 'https://api.anthropic.com/v1/messages') {
    providerCalls += 1;
    return responseJson({
      id: 'msg_bundle', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      service_tier: 'standard', content: [{ type: 'text', text: 'bundle identity' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0, server_tool_use: null, service_tier: 'standard',
      },
    });
  }
  throw new Error('unexpected CJS bundle identity fetch: ' + url);
};

if (process.env.PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM === '1') {
  require('openai/shims/web');
}
if (process.env.PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM === '1') {
  require('@anthropic-ai/sdk/shims/web');
}
const openaiModule = require('openai');
const anthropicModule = require('@anthropic-ai/sdk');
const OpenAI = openaiModule.default || openaiModule.OpenAI || openaiModule;
const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;
const waitForPatch = async (read, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read().__pylva_patched === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('CJS root auto-patch did not reach ' + label);
};

(async () => {
  if (process.env.PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM === '1') {
    await import('openai/shims/web');
  }
  if (process.env.PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM === '1') {
    await import('@anthropic-ai/sdk/shims/web');
  }
  let sdk;
  let openaiSubpath;
  let anthropicSubpath;
  let vercelSubpath;
  let openai;
  let anthropic;
  if (order === 'subpath-first') {
    openaiSubpath = require('@pylva/sdk/openai');
    anthropicSubpath = require('@pylva/sdk/anthropic');
    vercelSubpath = require('@pylva/sdk/vercel-ai');
    openaiSubpath.applyOpenAiPatch();
    anthropicSubpath.applyAnthropicPatch();
    openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
    await waitForPatch(() => openai.chat.completions.create, 'OpenAI from subpath');
    await waitForPatch(() => anthropic.messages.create, 'Anthropic from subpath');
    sdk = require('@pylva/sdk');
  } else {
    sdk = require('@pylva/sdk');
    openaiSubpath = require('@pylva/sdk/openai');
    anthropicSubpath = require('@pylva/sdk/anthropic');
    vercelSubpath = require('@pylva/sdk/vercel-ai');
    openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
    await waitForPatch(() => openai.chat.completions.create, 'OpenAI from root');
    await waitForPatch(() => anthropic.messages.create, 'Anthropic from root');
  }

  if (
    openaiSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
    anthropicSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
    vercelSubpath.PylvaStrictProviderError !== sdk.PylvaStrictProviderError ||
    vercelSubpath.createControlledOpenAIChatModel !== sdk.createControlledOpenAIChatModel ||
    vercelSubpath.controlledGenerateText !== sdk.controlledGenerateText ||
    vercelSubpath.controlledStreamText !== sdk.controlledStreamText
  ) {
    throw new Error('CJS strict root/deep identity differs across standalone bundles');
  }
  const cjsDeepToken = await vercelSubpath.createControlledOpenAIChatModel({
    apiKey: 'cjs-order-private-provider-key', model: 'gpt-4o-mini',
  });
  if (!Object.isFrozen(cjsDeepToken) || Object.getPrototypeOf(cjsDeepToken) !== null || Reflect.ownKeys(cjsDeepToken).length !== 0) {
    throw new Error('CJS ordered Vercel model token lost its opaque prototype');
  }
  sdk.init({ apiKey: keys.first, endpoint: 'https://identity-first.test', localMode: true });
  sdk.init({ apiKey: keys.second, endpoint: 'https://identity-second.test', localMode: true });

  const rootOpenAI = await sdk.wrapOpenAI(openai);
  const rootAnthropic = await sdk.wrapAnthropic(anthropic);
  const subpathOpenAI = await openaiSubpath.wrapOpenAI(openai);
  const subpathAnthropic = await anthropicSubpath.wrapAnthropic(anthropic);
  const openaiBody = {
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'private bundle prompt' }],
    max_completion_tokens: 2,
  };
  const anthropicBody = {
    model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'private bundle prompt' }],
    max_tokens: 2,
  };
  for (const wrapped of [rootOpenAI, subpathOpenAI]) {
    const result = await wrapped.chat.completions.create(openaiBody);
    if (result.model !== 'gpt-4o-mini') throw new Error('CJS official OpenAI result changed');
  }
  for (const wrapped of [rootAnthropic, subpathAnthropic]) {
    const result = await wrapped.messages.create(anthropicBody);
    if (result.model !== 'claude-sonnet-4-5') throw new Error('CJS official Anthropic result changed');
  }
  if (providerCalls !== 4) throw new Error('CJS official provider dispatch count was ' + providerCalls);

  const opaqueCreate = Object.defineProperty(function opaqueCreate() {}, '__pylva_patched', {
    value: true,
  });
  let opaqueError;
  try {
    await openaiSubpath.wrapOpenAI({
      baseURL: 'https://api.openai.com/v1', maxRetries: 0,
      chat: { completions: { create: opaqueCreate } },
    });
  } catch (error) {
    opaqueError = error;
  }
  if (
    !(opaqueError instanceof sdk.PylvaStrictProviderError) ||
    opaqueError.reason !== 'invalid_client' ||
    Object.getPrototypeOf(opaqueError) !== sdk.PylvaStrictProviderError.prototype ||
    sdk.PylvaStrictProviderError.name !== 'PylvaStrictProviderError'
  ) {
    throw new Error('CJS forged-client refusal lost root strict-error identity');
  }

  mode = 'denied';
  sdk.init({
    apiKey: keys.denied, endpoint: 'https://identity-denied.test',
    control: { mode: 'enforce', onUnavailable: 'deny' },
  });
  let denial;
  try {
    await subpathOpenAI.chat.completions.create(openaiBody);
  } catch (error) {
    denial = error;
  }
  if (
    !(denial instanceof sdk.PylvaBudgetExceeded) || denial.name !== 'PylvaBudgetExceeded' ||
    denial.code !== 'budget_exceeded' || denial.source !== 'authoritative_control' ||
    denial.rule_id !== '66666666-6666-4666-8666-666666666666' ||
    Object.getPrototypeOf(denial) !== sdk.PylvaBudgetExceeded.prototype ||
    sdk.PylvaBudgetExceeded.name !== 'PylvaBudgetExceeded'
  ) {
    throw new Error('CJS subpath denial lost root budget-error identity');
  }

  mode = 'unavailable';
  sdk.init({
    apiKey: keys.unavailable, endpoint: 'https://identity-unavailable.test',
    control: { mode: 'enforce', onUnavailable: 'deny' },
  });
  let unavailable;
  try {
    await subpathAnthropic.messages.create(anthropicBody);
  } catch (error) {
    unavailable = error;
  }
  if (
    !(unavailable instanceof sdk.PylvaControlUnavailableError) ||
    unavailable.name !== 'PylvaControlUnavailableError' ||
    unavailable.code !== 'control_unavailable' || unavailable.reason !== 'network_error' ||
    unavailable.operation !== 'reserveUsage' ||
    Object.getPrototypeOf(unavailable) !== sdk.PylvaControlUnavailableError.prototype ||
    sdk.PylvaControlUnavailableError.name !== 'PylvaControlUnavailableError'
  ) {
    throw new Error('CJS subpath unavailable lost root control-error identity');
  }
  if (providerCalls !== 4) throw new Error('CJS refusal dispatched an official provider call');

  const apiError = new sdk.PylvaControlApiError(409, 'operation_conflict', 'operation_id');
  const validationError = new sdk.PylvaControlValidationError('reserveUsage');
  if (
    apiError.name !== 'PylvaControlApiError' || apiError.status !== 409 ||
    apiError.code !== 'operation_conflict' || apiError.param !== 'operation_id' ||
    Object.getPrototypeOf(apiError) !== sdk.PylvaControlApiError.prototype ||
    sdk.PylvaControlApiError.name !== 'PylvaControlApiError' ||
    !(validationError instanceof TypeError) || validationError.name !== 'PylvaControlValidationError' ||
    validationError.operation !== 'reserveUsage' ||
    Object.getPrototypeOf(validationError) !== sdk.PylvaControlValidationError.prototype ||
    sdk.PylvaControlValidationError.name !== 'PylvaControlValidationError'
  ) {
    throw new Error('CJS public control constructors lost class fields or prototypes');
  }
  console.log('CJS bundle identity smoke passed (' + order + ')');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
    );

    writeFileSync(
      path.join(installDir, 'mixed-bundle-identity.mjs'),
      `
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scenarioName = process.argv[2];
const scenarios = {
  'esm-root-cjs-deep': { rootFormat: 'esm', deepFormat: 'cjs', order: 'root-first' },
  'cjs-deep-esm-root': { rootFormat: 'esm', deepFormat: 'cjs', order: 'deep-first' },
  'cjs-root-esm-deep': { rootFormat: 'cjs', deepFormat: 'esm', order: 'root-first' },
  'esm-deep-cjs-root': { rootFormat: 'cjs', deepFormat: 'esm', order: 'deep-first' },
};
const scenario = scenarios[scenarioName];
if (scenario === undefined) throw new Error('invalid mixed bundle scenario: ' + scenarioName);

const keys = ${bundleIdentityKeys};
const legacySymbols = [
  Symbol.for('@pylva/sdk-runtime/v1/e'),
  Symbol.for('@pylva/sdk-runtime/v1/so'),
  Symbol.for('@pylva/sdk-runtime/v1/controlled-openai-chat-models'),
  Symbol.for('@pylva/sdk-runtime/v2/core-coordinator'),
];
const symbolDecoys = [Object.freeze({}), new WeakMap(), new WeakMap(), Object.freeze({})];
for (let index = 0; index < legacySymbols.length; index += 1) {
  Object.defineProperty(globalThis, legacySymbols[index], {
    value: symbolDecoys[index],
    writable: true,
    configurable: true,
  });
}

const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_mixed_identity' },
  });
const requestParts = async (input, request) => ({
  href: input instanceof Request ? input.url : String(input),
  body:
    input instanceof Request
      ? await input.clone().text()
      : request?.body == null
        ? ''
        : String(request.body),
  headers: input instanceof Request ? input.headers : new Headers(request?.headers),
});
let mode = 'success';
let providerCalls = 0;
let deniedControlCalls = 0;
globalThis.fetch = async (input, request) => {
  const { href, body, headers } = await requestParts(input, request);
  const url = new URL(href);
  if (url.pathname === '/api/v1/pricing') return json({ models: [] });
  if (url.pathname === '/api/v1/rules') return json({ rules: [] });
  if (url.pathname === '/api/v1/sdk/non-llm-policy') {
    return json({ schema_version: '1.0', sources: [] });
  }
  if (url.pathname === '/api/v1/budget/capabilities') {
    if (mode !== 'denied') throw new Error('unexpected capabilities request in ' + mode);
    if (
      url.origin !== 'https://identity-second.test' ||
      headers.get('x-pylva-key') !== keys.second
    ) {
      throw new Error('mixed reinit did not use the second endpoint and credential');
    }
    return json({
      schema_version: '1.0',
      control_enabled: true,
      min_reservation_ttl_seconds: 30,
      default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600,
      server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (url.pathname === '/api/v1/budget/reservations') {
    if (mode !== 'denied') throw new Error('unexpected reservation request in ' + mode);
    if (
      url.origin !== 'https://identity-second.test' ||
      headers.get('x-pylva-key') !== keys.second
    ) {
      throw new Error('mixed reserve did not use the reinitialized identity');
    }
    deniedControlCalls += 1;
    const reservation = JSON.parse(body);
    return json({
      schema_version: '1.0',
      decision: 'denied',
      allowed: false,
      decision_id: '55555555-5555-4555-8555-555555555555',
      operation_id: reservation.operation_id,
      state: 'refused',
      deciding_rule: {
        rule_id: '66666666-6666-4666-8666-666666666666',
        scope: 'pooled',
        customer_id: null,
        period: 'day',
        period_start: '2026-07-14T00:00:00.000Z',
        period_end: '2026-07-15T00:00:00.000Z',
      },
      committed_usd: '1',
      reserved_usd: '0',
      unresolved_usd: '0',
      requested_usd: '0.1',
      limit_usd: '1',
      remaining_usd: '0',
      warnings: [],
    });
  }
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/chat/completions') {
    providerCalls += 1;
    return json({
      id: 'chatcmpl_mixed',
      object: 'chat.completion',
      created: 1784009600,
      model: 'gpt-4o-mini',
      service_tier: 'default',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'mixed answer', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    });
  }
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    providerCalls += 1;
    return json({
      id: 'msg_mixed',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      service_tier: 'standard',
      content: [{ type: 'text', text: 'mixed answer' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard',
      },
    });
  }
  throw new Error('unexpected mixed bundle fetch: ' + href);
};

if (process.env.PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM === '1') {
  require('openai/shims/web');
  await import('openai/shims/web');
}
if (process.env.PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM === '1') {
  require('@anthropic-ai/sdk/shims/web');
  await import('@anthropic-ai/sdk/shims/web');
}
const [{ default: OpenAI }, { default: Anthropic }] = await Promise.all([
  import('openai'),
  import('@anthropic-ai/sdk'),
]);
const loadRoot = async () =>
  scenario.rootFormat === 'esm' ? await import('@pylva/sdk') : require('@pylva/sdk');
const loadDeep = async () => {
  const load = (specifier) =>
    scenario.deepFormat === 'esm' ? import(specifier) : Promise.resolve(require(specifier));
  const [openai, anthropic, vercel, langgraph, langchain] = await Promise.all([
    load('@pylva/sdk/openai'),
    load('@pylva/sdk/anthropic'),
    load('@pylva/sdk/vercel-ai'),
    load('@pylva/sdk/langgraph'),
    load('@pylva/sdk/langchain'),
  ]);
  return { openai, anthropic, vercel, langgraph, langchain };
};

let root;
let deep;
if (scenario.order === 'root-first') {
  root = await loadRoot();
  deep = await loadDeep();
} else {
  deep = await loadDeep();
  root = await loadRoot();
}
const alternateRoot = scenario.rootFormat === 'esm'
  ? require('@pylva/sdk')
  : await import('@pylva/sdk');

if (
  root.InvalidApiKeyError !== alternateRoot.InvalidApiKeyError ||
  root.InvalidControlConfigError !== alternateRoot.InvalidControlConfigError
) {
  throw new Error('mixed root ESM/CJS config-error constructors are not exact identities');
}

if (
  root.wrapOpenAI !== deep.openai.wrapOpenAI ||
  root.wrapAnthropic !== deep.anthropic.wrapAnthropic ||
  root.createControlledOpenAIChatModel !== deep.vercel.createControlledOpenAIChatModel ||
  root.controlledGenerateText !== deep.vercel.controlledGenerateText ||
  root.controlledStreamText !== deep.vercel.controlledStreamText ||
  root.PylvaStrictProviderError !== deep.openai.PylvaStrictProviderError ||
  root.PylvaStrictProviderError !== deep.anthropic.PylvaStrictProviderError ||
  root.PylvaStrictProviderError !== deep.vercel.PylvaStrictProviderError ||
  deep.langchain.PylvaCallbackHandler !== deep.langgraph.PylvaCallbackHandler ||
  deep.langchain.AsyncPylvaCallbackHandler !== deep.langgraph.AsyncPylvaCallbackHandler ||
  deep.langchain.withLangGraphControlScope !== deep.langgraph.withLangGraphControlScope
) {
  throw new Error('mixed root/deep functions, callbacks, or constructors are not exact identities');
}
if (
  root.PylvaBudgetExceeded.name !== 'PylvaBudgetExceeded' ||
  root.PylvaControlUnavailableError.name !== 'PylvaControlUnavailableError' ||
  root.PylvaControlApiError.name !== 'PylvaControlApiError' ||
  root.PylvaControlValidationError.name !== 'PylvaControlValidationError' ||
  root.PylvaStrictProviderError.name !== 'PylvaStrictProviderError'
) {
  throw new Error('mixed root constructors lost stable names');
}
const assertHandlerConfigError = (options, Expected, label) => {
  let thrown;
  try {
    new deep.langchain.PylvaCallbackHandler(options);
  } catch (error) {
    thrown = error;
  }
  if (
    !(thrown instanceof Expected) ||
    thrown.name !== Expected.name ||
    Object.getPrototypeOf(thrown) !== Expected.prototype
  ) {
    throw new Error('mixed LangGraph ' + label + ' lost root constructor identity');
  }
  if (root.isInitialized() || alternateRoot.isInitialized()) {
    throw new Error('failed mixed LangGraph ' + label + ' initialized the SDK');
  }
};
assertHandlerConfigError({ apiKey: 'invalid' }, root.InvalidApiKeyError, 'API-key error');
assertHandlerConfigError(
  {
    apiKey: 'pv_live_aabbccdd_' + 'a'.repeat(32),
    control: { mode: 'blocking' },
  },
  root.InvalidControlConfigError,
  'control-config error',
);
const mixedCallback = new deep.langchain.AsyncPylvaCallbackHandler();
if (
  !(mixedCallback instanceof deep.langgraph.PylvaCallbackHandler) ||
  Object.getPrototypeOf(mixedCallback) !== deep.langgraph.AsyncPylvaCallbackHandler.prototype
) {
  throw new Error('mixed LangChain callback lost its exact LangGraph prototype');
}
for (let index = 0; index < legacySymbols.length; index += 1) {
  if (globalThis[legacySymbols[index]] !== symbolDecoys[index]) {
    throw new Error('mixed import consumed process-global runtime state');
  }
}

deep.openai.applyOpenAiPatch();
deep.anthropic.applyAnthropicPatch();
deep.vercel.applyVercelAiPatch();
const waitForPatch = async (read, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read().__pylva_patched === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('mixed patch did not reach ' + label);
};
const openai = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
const anthropic = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
await waitForPatch(() => openai.chat.completions.create, 'OpenAI');
await waitForPatch(() => anthropic.messages.create, 'Anthropic');

root.init({
  apiKey: keys.first,
  endpoint: 'https://identity-first.test',
  localMode: true,
});
const wrappedOpenAI = await root.wrapOpenAI(openai);
const wrappedAnthropic = await root.wrapAnthropic(anthropic);
const openaiResult = await wrappedOpenAI.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'private mixed prompt' }],
  max_completion_tokens: 2,
});
const anthropicResult = await wrappedAnthropic.messages.create({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'private mixed prompt' }],
  max_tokens: 2,
});
if (openaiResult.model !== 'gpt-4o-mini' || anthropicResult.model !== 'claude-sonnet-4-5') {
  throw new Error('mixed provider unwrapping changed an official result');
}

const deepSecret = 'private-deep-managed-model-key';
const rootSecret = 'private-root-managed-model-key';
const deepToken = await deep.vercel.createControlledOpenAIChatModel({
  apiKey: deepSecret,
  model: 'gpt-4o-mini',
});
const rootToken = await root.createControlledOpenAIChatModel({
  apiKey: rootSecret,
  model: 'gpt-4o-mini',
});
for (const [token, secret] of [
  [deepToken, deepSecret],
  [rootToken, rootSecret],
]) {
  if (
    !Object.isFrozen(token) ||
    Object.getPrototypeOf(token) !== null ||
    Reflect.ownKeys(token).length !== 0 ||
    JSON.stringify(token).includes(secret)
  ) {
    throw new Error('mixed managed model token exposed provider state');
  }
}
const vercelRequest = (model) => ({
  model,
  prompt: 'private mixed Vercel prompt',
  maxOutputTokens: 20,
  maxRetries: 0,
  providerOptions: { openai: { serviceTier: 'default' } },
});
const rootVercelResult = await root.controlledGenerateText(vercelRequest(deepToken));
const deepVercelResult = await deep.vercel.controlledGenerateText(vercelRequest(rootToken));
if (rootVercelResult.text !== 'mixed answer' || deepVercelResult.text !== 'mixed answer') {
  throw new Error('mixed managed model token did not cross root/deep formats');
}
if (providerCalls !== 4) {
  throw new Error('mixed successful provider dispatch count was ' + providerCalls + ', expected 4');
}

for (let index = 0; index < legacySymbols.length; index += 1) {
  globalThis[legacySymbols[index]] = Object.freeze({ replaced: index });
}
mode = 'denied';
root.init({
  apiKey: keys.second,
  endpoint: 'https://identity-second.test',
  control: { mode: 'enforce', onUnavailable: 'deny' },
});
let denial;
try {
  const deniedOpenAI = await deep.openai.wrapOpenAI(openai);
  await deniedOpenAI.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'must never dispatch' }],
    max_completion_tokens: 2,
  });
} catch (error) {
  denial = error;
}
if (
  !(denial instanceof root.PylvaBudgetExceeded) ||
  denial.name !== 'PylvaBudgetExceeded' ||
  denial.code !== 'budget_exceeded' ||
  denial.source !== 'authoritative_control' ||
  Object.getPrototypeOf(denial) !== root.PylvaBudgetExceeded.prototype ||
  deniedControlCalls !== 1 ||
  providerCalls !== 4
) {
  throw new Error('mixed reinit denial lost identity or dispatched a provider twice');
}

console.log('mixed bundle identity smoke passed (' + scenarioName + ')');
`,
    );

    writeFileSync(
      path.join(installDir, 'vercel-official.mjs'),
      `
import { createRequire } from 'node:module';

const branch = process.argv[2];
const expected = process.argv[3];
if (!['esm', 'cjs'].includes(branch) || !['v6', 'refuse'].includes(expected)) {
  throw new Error('invalid Vercel official smoke mode');
}

let fetchCalls = 0;
let providerCalls = 0;
let commits = 0;
let releases = 0;
let providerAbortCount = 0;
let providerCancelCount = 0;
let reservationSequence = 0;
const operationByReservation = new Map();
const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_vercel_package_smoke' },
});
const requestParts = async (input, request) => ({
  href: input instanceof Request ? input.url : String(input),
  body: input instanceof Request
    ? await input.clone().text()
    : request?.body == null ? '' : String(request.body),
  signal: input instanceof Request ? input.signal : request?.signal,
});
const reservationId = (sequence) =>
  '44444444-4444-4444-8444-' + String(sequence).padStart(12, '0');
const reservationFromLifecycleUrl = (href) => new URL(href).pathname.split('/').at(-2);
const waitFor = async (read, expectedValue, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read() === expectedValue) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label + ' did not reach ' + expectedValue + '; observed ' + read());
};
const openAiChunk = (content, finishReason = null, withUsage = false) => ({
  id: 'chatcmpl_stream_installed',
  object: 'chat.completion.chunk',
  created: 1784009600,
  model: 'gpt-4o-mini',
  service_tier: 'default',
  choices: [{
    index: 0,
    delta: content.length > 0 ? { role: 'assistant', content } : {},
    finish_reason: finishReason,
    logprobs: null,
  }],
  ...(withUsage ? {
    usage: {
      prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  } : {}),
});
const completeSse = [openAiChunk('official stream'), openAiChunk('', 'stop', true)]
  .map((event) => 'data: ' + JSON.stringify(event) + '\\n\\n')
  .join('') + 'data: [DONE]\\n\\n';

globalThis.fetch = async (input, request) => {
  fetchCalls += 1;
  const { href, body, signal } = await requestParts(input, request);
  if (href.endsWith('/api/v1/pricing')) return json({ models: [] });
  if (href.endsWith('/api/v1/rules')) return json({ rules: [] });
  if (href.endsWith('/api/v1/budget/capabilities')) {
    return json({
      schema_version: '1.0', control_enabled: true,
      min_reservation_ttl_seconds: 30, default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600, server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (href.endsWith('/api/v1/budget/reservations')) {
    if (
      body.includes('private installed Vercel prompt') ||
      body.includes('provider-private-installed-vercel-key')
    ) {
      throw new Error('private Vercel data leaked into the reservation request');
    }
    const reserve = JSON.parse(body);
    if (reserve.provider !== 'openai' || reserve.model !== 'gpt-4o-mini') {
      throw new Error('installed Vercel reservation lost provider/model identity');
    }
    reservationSequence += 1;
    const currentReservationId = reservationId(reservationSequence);
    operationByReservation.set(currentReservationId, reserve.operation_id);
    return json({
      schema_version: '1.0', decision: 'reserved', allowed: true,
      decision_id: '55555555-5555-4555-8555-555555555555',
      operation_id: reserve.operation_id, reservation_id: currentReservationId, state: 'reserved',
      reserved_usd: '0.1', remaining_usd: '1',
      expires_at: '2026-07-14T09:05:00.000Z', warnings: [],
    });
  }
  if (href.endsWith('/commit')) {
    const currentReservationId = reservationFromLifecycleUrl(href);
    const operationId = operationByReservation.get(currentReservationId);
    if (operationId === undefined) throw new Error('commit used an unknown reservation');
    const commit = JSON.parse(body);
    if (
      commit.kind !== 'llm' ||
      commit.status !== 'success' ||
      commit.actual_input_tokens !== 8 ||
      commit.actual_output_tokens !== 4 ||
      commit.stream_aborted !== false
    ) {
      throw new Error('installed Vercel commit lost exact terminal usage evidence');
    }
    commits += 1;
    return json({
      schema_version: '1.0', state: 'committed', reservation_id: currentReservationId,
      operation_id: operationId, reserved_usd: '0.1', actual_usd: '0.01',
      released_usd: '0.09', overage_usd: '0', budget_exceeded_after_commit: false,
      committed_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false, late: false,
    });
  }
  if (href.endsWith('/release')) {
    releases += 1;
    throw new Error('installed Vercel cancellation must remain unresolved, not release');
  }
  if (href === 'https://api.openai.com/v1/chat/completions') {
    providerCalls += 1;
    const providerBody = JSON.parse(body);
    if (providerBody.model !== 'gpt-4o-mini' || providerBody.service_tier !== 'default') {
      throw new Error('installed Vercel provider request lost the strict priced shape');
    }
    if (providerBody.stream !== true) {
      return json({
        id: 'chatcmpl_installed_vercel', object: 'chat.completion', created: 1784009600,
        model: 'gpt-4o-mini', service_tier: 'default',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'official installed answer' },
          finish_reason: 'stop', logprobs: null,
        }],
        usage: {
          prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      });
    }
    if (providerBody.stream_options?.include_usage !== true) {
      throw new Error('installed Vercel stream did not request terminal exact usage');
    }
    if (providerCalls === 2) {
      return new Response(completeSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (providerCalls !== 3) throw new Error('unexpected Vercel streaming provider call count');
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: ' + JSON.stringify(openAiChunk('official stream')) + '\\n\\n'),
        );
        signal?.addEventListener('abort', () => {
          providerAbortCount += 1;
          controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
      cancel() {
        providerCancelCount += 1;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  throw new Error('unexpected installed Vercel fetch: ' + href);
};

let sdk;
let vercel;
if (branch === 'esm') {
  sdk = await import('@pylva/sdk');
  vercel = await import('@pylva/sdk/vercel-ai');
} else {
  const require = createRequire(import.meta.url);
  sdk = require('@pylva/sdk');
  vercel = require('@pylva/sdk/vercel-ai');
}
const providerSecret = 'provider-private-installed-vercel-key';
const controlledModel = await vercel.createControlledOpenAIChatModel({
  apiKey: providerSecret,
  model: 'gpt-4o-mini',
});
if (
  !Object.isFrozen(controlledModel) ||
  Object.getPrototypeOf(controlledModel) !== null ||
  Reflect.ownKeys(controlledModel).length !== 0 ||
  JSON.stringify(controlledModel).includes(providerSecret)
) {
  throw new Error('installed Vercel managed model exposed private provider state');
}
const request = {
  model: controlledModel,
  prompt: 'private installed Vercel prompt',
  maxOutputTokens: 20,
  maxRetries: 0,
  providerOptions: { openai: { serviceTier: 'default' } },
};

if (expected === 'refuse') {
  let refusal;
  try {
    await vercel.controlledGenerateText(request);
  } catch (error) {
    refusal = error;
  }
  if (
    !(refusal instanceof sdk.PylvaStrictProviderError) ||
    refusal.reason !== 'ai_sdk_v6_is_required' ||
    refusal.provider !== 'vercel-ai' ||
    Object.getPrototypeOf(refusal) !== sdk.PylvaStrictProviderError.prototype
  ) {
    throw new Error('installed strict helper did not refuse unsupported AI SDK major');
  }
  if (fetchCalls !== 0 || providerCalls !== 0 || commits !== 0) {
    throw new Error('unsupported AI SDK major performed I/O');
  }
  console.log('Vercel official package refusal passed (' + branch + ')');
} else {
  sdk.init({
    apiKey: 'pv_live_aabbccdd_' + 'a'.repeat(32),
    endpoint: 'https://vercel-package-smoke.test',
    control: { mode: 'enforce', onUnavailable: 'deny' },
  });
  const result = await vercel.controlledGenerateText(request);
  if (result.text !== 'official installed answer') {
    throw new Error('installed Vercel helper changed the official AI SDK result');
  }
  if (providerCalls !== 1 || commits !== 1 || releases !== 0) {
    throw new Error('installed Vercel generate lifecycle mismatch');
  }

  const complete = await vercel.controlledStreamText(request);
  if (Object.getPrototypeOf(complete)?.constructor?.name !== 'DefaultStreamTextResult') {
    throw new Error('installed Vercel stream lost the official native result prototype');
  }
  let completeText = '';
  for await (const delta of complete.textStream) completeText += delta;
  if (
    completeText !== 'official stream' ||
    (await complete.text) !== 'official stream' ||
    (await complete.totalUsage).inputTokens !== 8 ||
    (await complete.totalUsage).outputTokens !== 4
  ) {
    throw new Error('installed Vercel stream changed its official terminal result');
  }
  await waitFor(() => commits, 2, 'completed Vercel stream commit');

  const cancelled = await vercel.controlledStreamText(request);
  const iterator = cancelled.textStream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value !== 'official stream') {
    throw new Error('installed Vercel cancellable stream lost its first native delta');
  }
  const returned = await iterator.return?.();
  if (returned?.done !== true) throw new Error('installed Vercel iterator did not close');
  await waitFor(() => providerAbortCount, 1, 'cancelled Vercel provider abort');
  if (
    providerCalls !== 3 ||
    reservationSequence !== 3 ||
    commits !== 2 ||
    releases !== 0 ||
    providerAbortCount !== 1 ||
    providerCancelCount > 1
  ) {
    throw new Error('installed Vercel cancel lifecycle mismatch');
  }
  console.log('Vercel official package generate/stream/cancel smoke passed (' + branch + ')');
}
`,
    );

    writeFileSync(
      path.join(installDir, 'direct-provider-official.mjs'),
      `
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const branch = process.argv[2];
if (!['esm', 'cjs'].includes(branch)) throw new Error('invalid direct-provider smoke branch');

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_direct_package_smoke' },
});
const requestParts = async (input, request) => ({
  href: input instanceof Request ? input.url : String(input),
  body: input instanceof Request
    ? await input.clone().text()
    : request?.body == null ? '' : String(request.body),
  headers: input instanceof Request ? input.headers : new Headers(request?.headers),
  signal: input instanceof Request ? input.signal : request?.signal,
});
const reservationId = (sequence) =>
  '44444444-4444-4444-8444-' + String(sequence).padStart(12, '0');
const lifecycleReservation = (href) => new URL(href).pathname.split('/').at(-2);
const waitFor = async (read, expectedValue, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read() === expectedValue) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label + ' did not reach ' + expectedValue + '; observed ' + read());
};
const openAiChunk = (content, finishReason = null, withUsage = false) => ({
  id: 'chatcmpl_direct_stream',
  object: 'chat.completion.chunk',
  created: 1784009600,
  model: 'gpt-4o-mini',
  service_tier: 'default',
  choices: [{
    index: 0,
    delta: content.length > 0 ? { role: 'assistant', content } : {},
    finish_reason: finishReason,
    logprobs: null,
  }],
  ...(withUsage ? {
    usage: {
      prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  } : {}),
});
const openAiCompleteSse = [
  openAiChunk('direct openai stream'),
  openAiChunk('', 'stop', true),
].map((event) => 'data: ' + JSON.stringify(event) + '\\n\\n').join('') +
  'data: [DONE]\\n\\n';
const anthropicEvents = [
  {
    type: 'message_start',
    message: {
      id: 'msg_direct_stream', type: 'message', role: 'assistant',
      model: 'claude-sonnet-4-5', container: null, content: [],
      stop_details: null, stop_reason: null, stop_sequence: null,
      usage: {
        cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        inference_geo: null, input_tokens: 8, output_tokens: 1,
        server_tool_use: null, service_tier: 'standard',
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'direct anthropic stream' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: {
      container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null,
    },
    usage: {
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      input_tokens: 8, output_tokens: 4, server_tool_use: null,
    },
  },
  { type: 'message_stop' },
];
const anthropicSse = anthropicEvents
  .map((event) => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n')
  .join('');

let reservationSequence = 0;
let commits = 0;
let releases = 0;
let openAiProviderCalls = 0;
let anthropicProviderCalls = 0;
let openAiAbortCount = 0;
let openAiCancelCount = 0;
let anthropicAbortCount = 0;
let anthropicCancelCount = 0;
const operationByReservation = new Map();
const controlBodies = [];
const providerBodies = [];
globalThis.fetch = async (input, request) => {
  const { href, body, headers, signal } = await requestParts(input, request);
  if (href.startsWith('https://direct-package-smoke.test')) controlBodies.push(body);
  if (href.endsWith('/api/v1/pricing')) return json({ models: [] });
  if (href.endsWith('/api/v1/rules')) return json({ rules: [] });
  if (href.endsWith('/api/v1/budget/capabilities')) {
    return json({
      schema_version: '1.0', control_enabled: true,
      min_reservation_ttl_seconds: 30, default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600, server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (href.endsWith('/api/v1/budget/reservations')) {
    const reserve = JSON.parse(body);
    if (
      body.includes('private direct provider prompt') ||
      body.includes('provider-private-direct-key')
    ) {
      throw new Error('private direct-provider data leaked into the control request');
    }
    const expected = reservationSequence % 2 === 1
      ? ['anthropic', 'claude-sonnet-4-5']
      : ['openai', 'gpt-4o-mini'];
    if (reserve.provider !== expected[0] || reserve.model !== expected[1]) {
      throw new Error('direct-provider reservation lost provider/model identity');
    }
    reservationSequence += 1;
    const currentReservationId = reservationId(reservationSequence);
    operationByReservation.set(currentReservationId, reserve.operation_id);
    return json({
      schema_version: '1.0', decision: 'reserved', allowed: true,
      decision_id: '55555555-5555-4555-8555-555555555555',
      operation_id: reserve.operation_id, reservation_id: currentReservationId, state: 'reserved',
      reserved_usd: '0.1', remaining_usd: '1',
      expires_at: '2026-07-14T09:05:00.000Z', warnings: [],
    });
  }
  if (href.endsWith('/commit')) {
    const currentReservationId = lifecycleReservation(href);
    const operationId = operationByReservation.get(currentReservationId);
    if (operationId === undefined) throw new Error('direct commit used an unknown reservation');
    const commit = JSON.parse(body);
    if (
      commit.kind !== 'llm' ||
      commit.status !== 'success' ||
      commit.actual_input_tokens !== 8 ||
      commit.actual_output_tokens !== 4 ||
      commit.stream_aborted !== false
    ) {
      throw new Error('direct stream did not commit exact terminal usage');
    }
    commits += 1;
    return json({
      schema_version: '1.0', state: 'committed', reservation_id: currentReservationId,
      operation_id: operationId, reserved_usd: '0.1', actual_usd: '0.01',
      released_usd: '0.09', overage_usd: '0', budget_exceeded_after_commit: false,
      committed_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false, late: false,
    });
  }
  if (href.endsWith('/release')) {
    releases += 1;
    throw new Error('direct stream cancellation must remain unresolved, not release');
  }
  if (href === 'https://api.openai.com/v1/chat/completions') {
    openAiProviderCalls += 1;
    const providerBody = JSON.parse(body);
    providerBodies.push(providerBody);
    if (
      providerBody.model !== 'gpt-4o-mini' ||
      providerBody.stream !== true ||
      providerBody.stream_options?.include_usage !== true ||
      providerBody.service_tier !== 'default'
    ) {
      throw new Error('direct OpenAI stream lost the strict priced request shape');
    }
    if (openAiProviderCalls === 1) {
      return new Response(openAiCompleteSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_openai_stream' },
      });
    }
    if (openAiProviderCalls !== 2) throw new Error('unexpected direct OpenAI provider call');
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: ' + JSON.stringify(openAiChunk('direct openai stream')) + '\\n\\n'),
        );
        signal?.addEventListener('abort', () => {
          openAiAbortCount += 1;
          controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
      cancel() {
        openAiCancelCount += 1;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  if (href === 'https://api.anthropic.com/v1/messages') {
    anthropicProviderCalls += 1;
    const providerBody = JSON.parse(body);
    providerBodies.push(providerBody);
    if (
      providerBody.model !== 'claude-sonnet-4-5' ||
      providerBody.stream !== true ||
      providerBody.service_tier !== 'standard_only' ||
      headers.get('x-stainless-helper-method') !== 'stream'
    ) {
      throw new Error('direct Anthropic stream lost the strict native helper shape');
    }
    if (anthropicProviderCalls === 1) {
      return new Response(anthropicSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'request-id': 'req_anthropic_stream' },
      });
    }
    if (anthropicProviderCalls !== 2) {
      throw new Error('unexpected direct Anthropic provider call');
    }
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\\ndata: ' + JSON.stringify(anthropicEvents[0]) + '\\n\\n' +
          'event: content_block_start\\ndata: ' + JSON.stringify(anthropicEvents[1]) + '\\n\\n',
        ));
        signal?.addEventListener('abort', () => {
          anthropicAbortCount += 1;
          controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
      cancel() {
        anthropicCancelCount += 1;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_anthropic_cancel' },
    });
  }
  throw new Error('unexpected direct-provider fetch: ' + href);
};

if (process.env.PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM === '1') {
  require('openai/shims/web');
  await import('openai/shims/web');
}
if (process.env.PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM === '1') {
  require('@anthropic-ai/sdk/shims/web');
  await import('@anthropic-ai/sdk/shims/web');
}
let sdk;
let openaiSurface;
let anthropicSurface;
let openaiPeer;
let anthropicPeer;
if (branch === 'esm') {
  [sdk, openaiSurface, anthropicSurface, openaiPeer, anthropicPeer] = await Promise.all([
    import('@pylva/sdk'),
    import('@pylva/sdk/openai'),
    import('@pylva/sdk/anthropic'),
    import('openai'),
    import('@anthropic-ai/sdk'),
  ]);
} else {
  sdk = require('@pylva/sdk');
  openaiSurface = require('@pylva/sdk/openai');
  anthropicSurface = require('@pylva/sdk/anthropic');
  openaiPeer = require('openai');
  anthropicPeer = require('@anthropic-ai/sdk');
}
const constructorFrom = (module, name) =>
  typeof module === 'function' ? module : module[name] ?? module.default;
const OpenAI = constructorFrom(openaiPeer, 'OpenAI');
const Anthropic = constructorFrom(anthropicPeer, 'Anthropic');
if (typeof OpenAI !== 'function' || typeof Anthropic !== 'function') {
  throw new Error('official direct-provider constructors are unavailable');
}

sdk.init({
  apiKey: 'pv_live_aabbccdd_' + 'a'.repeat(32),
  endpoint: 'https://direct-package-smoke.test',
  control: { mode: 'enforce', onUnavailable: 'deny' },
});
const openai = await openaiSurface.wrapOpenAI(
  new OpenAI({ apiKey: 'provider-private-direct-key-openai', maxRetries: 0 }),
);
const anthropic = await anthropicSurface.wrapAnthropic(
  new Anthropic({ apiKey: 'provider-private-direct-key-anthropic', maxRetries: 0 }),
);

const openAiPending = openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'private direct provider prompt' }],
  max_completion_tokens: 20,
  stream: true,
});
if (typeof openAiPending.withResponse !== 'function' || typeof openAiPending.asResponse !== 'function') {
  throw new Error('controlled OpenAI stream lost official APIPromise helpers');
}
const openAiStream = await openAiPending;
let openAiChunks = 0;
let openAiTerminal;
for await (const chunk of openAiStream) {
  openAiChunks += 1;
  openAiTerminal = chunk;
}
if (
  openAiChunks !== 2 ||
  openAiTerminal?.usage?.prompt_tokens !== 8 ||
  openAiTerminal?.usage?.completion_tokens !== 4
) {
  throw new Error('controlled OpenAI stream changed official terminal evidence');
}
await waitFor(() => commits, 1, 'direct OpenAI stream commit');

const anthropicManager = anthropic.messages.stream({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'private direct provider prompt' }],
  max_tokens: 20,
});
if (anthropicManager instanceof Promise || typeof anthropicManager.finalMessage !== 'function') {
  throw new Error('controlled Anthropic stream lost its native synchronous manager');
}
const anthropicMessage = await anthropicManager.finalMessage();
if (
  anthropicMessage.model !== 'claude-sonnet-4-5' ||
  anthropicMessage.content?.[0]?.text !== 'direct anthropic stream'
) {
  throw new Error('controlled Anthropic stream changed the official final message');
}
await waitFor(() => commits, 2, 'direct Anthropic stream commit');

const cancellable = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'private direct provider prompt' }],
  max_completion_tokens: 20,
  stream: true,
});
const iterator = cancellable[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done || first.value?.choices?.[0]?.delta?.content !== 'direct openai stream') {
  throw new Error('controlled cancellable OpenAI stream lost its first official chunk');
}
const returned = await iterator.return?.();
if (returned?.done !== true) throw new Error('controlled OpenAI stream iterator did not close');
await waitFor(
  () => Math.min(1, openAiAbortCount + openAiCancelCount),
  1,
  'direct OpenAI stream cancellation',
);
if (
  commits !== 2 ||
  releases !== 0 ||
  openAiAbortCount > 1 ||
  openAiCancelCount > 1
) {
  throw new Error('cancelled direct OpenAI stream incorrectly settled its reservation');
}

const cancellableAnthropic = anthropic.messages.stream({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'private direct provider prompt' }],
  max_tokens: 20,
});
const anthropicIterator = cancellableAnthropic[Symbol.asyncIterator]();
const anthropicFirst = await anthropicIterator.next();
if (anthropicFirst.done || anthropicFirst.value?.type !== 'message_start') {
  throw new Error('controlled cancellable Anthropic stream lost its first official event');
}
const anthropicReturned = await anthropicIterator.return?.();
if (anthropicReturned?.done !== true) {
  throw new Error('controlled Anthropic stream iterator did not close');
}
let anthropicAbortRejected = false;
try {
  await cancellableAnthropic.done();
} catch {
  anthropicAbortRejected = true;
}
if (!anthropicAbortRejected) {
  throw new Error('controlled Anthropic manager did not terminate as an aborted native stream');
}
await waitFor(
  () => Math.min(1, anthropicAbortCount + anthropicCancelCount),
  1,
  'direct Anthropic stream cancellation',
);
if (
  commits !== 2 ||
  releases !== 0 ||
  anthropicAbortCount > 1 ||
  anthropicCancelCount > 1
) {
  throw new Error('cancelled direct Anthropic stream incorrectly settled its reservation');
}

await openai.close();
await openai.close();
await anthropic.close();
await anthropic.close();
const closedError = (call) => {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('closed direct-provider facade did not refuse synchronously');
};
const openAiClosed = closedError(() => openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'must not dispatch' }],
  max_completion_tokens: 2,
}));
const anthropicClosed = closedError(() => anthropic.messages.create({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'must not dispatch' }],
  max_tokens: 2,
}));
for (const [error, provider] of [[openAiClosed, 'openai'], [anthropicClosed, 'anthropic']]) {
  if (
    !(error instanceof sdk.PylvaStrictProviderError) ||
    error.reason !== 'client_is_closed' ||
    error.provider !== provider ||
    Object.getPrototypeOf(error) !== sdk.PylvaStrictProviderError.prototype
  ) {
    throw new Error('closed direct-provider refusal lost root error identity');
  }
}
if (
  reservationSequence !== 4 ||
  commits !== 2 ||
  releases !== 0 ||
  openAiProviderCalls !== 2 ||
  anthropicProviderCalls !== 2 ||
  providerBodies.length !== 4 ||
  controlBodies.join('\\n').includes('provider-private-direct-key')
) {
  throw new Error('installed direct-provider stream/cancel/close lifecycle mismatch');
}

console.log('direct-provider official stream/cancel/close smoke passed (' + branch + ')');
`,
    );

    writeFileSync(
      path.join(installDir, 'vercel-cache-poison.mjs'),
      `
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const branch = process.argv[2];
const expected = process.argv[3];
if (!['esm', 'cjs'].includes(branch) || !['v6', 'refuse'].includes(expected)) {
  throw new Error('invalid Vercel cache-poison smoke mode');
}

const aiEntryPath = require.resolve('ai');
const aiManifestPath = require.resolve('ai/package.json');
const diskManifest = JSON.parse(readFileSync(aiManifestPath, 'utf8'));
if (expected === 'v6' ? !/^6\\./.test(diskManifest.version) : /^6\\./.test(diskManifest.version)) {
  throw new Error('cache-poison smoke received the wrong real installed AI SDK major');
}
let poisonCalls = 0;
const poisonedGenerateText = Object.freeze(function poisonedGenerateText() {
  poisonCalls += 1;
  throw new Error('poisoned CommonJS AI executable was called');
});
const poisonedStreamText = Object.freeze(function poisonedStreamText() {
  poisonCalls += 1;
  throw new Error('poisoned CommonJS AI executable was called');
});
const poisonedExecutable = Object.freeze({
  generateText: poisonedGenerateText,
  streamText: poisonedStreamText,
});
const poisonedManifest = Object.freeze({ version: expected === 'v6' ? '5.0.0' : '6.0.0' });
const cacheEntry = (filename, exports) => ({
  id: filename,
  path: path.dirname(filename),
  exports,
  filename,
  loaded: true,
  children: [],
  paths: [],
  parent: null,
});
const previousExecutableEntry = require.cache[aiEntryPath];
const previousManifestEntry = require.cache[aiManifestPath];
const poisonedExecutableEntry = cacheEntry(aiEntryPath, poisonedExecutable);
const poisonedManifestEntry = cacheEntry(aiManifestPath, poisonedManifest);
require.cache[aiEntryPath] = poisonedExecutableEntry;
require.cache[aiManifestPath] = poisonedManifestEntry;

let fetchCalls = 0;
let providerCalls = 0;
let commits = 0;
let reservationSequence = 0;
const operationByReservation = new Map();
const reservationId = (sequence) =>
  '44444444-4444-4444-8444-' + String(sequence).padStart(12, '0');
const lifecycleReservation = (href) => new URL(href).pathname.split('/').at(-2);
const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_cache_poison_smoke' },
});
const requestParts = async (input, request) => ({
  href: input instanceof Request ? input.url : String(input),
  body: input instanceof Request
    ? await input.clone().text()
    : request?.body == null ? '' : String(request.body),
});
const waitFor = async (read, expectedValue, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read() === expectedValue) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label + ' did not reach ' + expectedValue + '; observed ' + read());
};
const openAiChunk = (content, finishReason = null, withUsage = false) => ({
  id: 'chatcmpl_cache_poison_stream',
  object: 'chat.completion.chunk',
  created: 1784009600,
  model: 'gpt-4o-mini',
  service_tier: 'default',
  choices: [{
    index: 0,
    delta: content.length > 0 ? { role: 'assistant', content } : {},
    finish_reason: finishReason,
    logprobs: null,
  }],
  ...(withUsage ? {
    usage: {
      prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  } : {}),
});
const streamSse = [openAiChunk('real ESM stream answer'), openAiChunk('', 'stop', true)]
  .map((event) => 'data: ' + JSON.stringify(event) + '\\n\\n')
  .join('') + 'data: [DONE]\\n\\n';
globalThis.fetch = async (input, request) => {
  fetchCalls += 1;
  const { href, body } = await requestParts(input, request);
  if (href.endsWith('/api/v1/pricing')) return json({ models: [] });
  if (href.endsWith('/api/v1/rules')) return json({ rules: [] });
  if (href.endsWith('/api/v1/budget/capabilities')) {
    return json({
      schema_version: '1.0', control_enabled: true,
      min_reservation_ttl_seconds: 30, default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600, server_time: '2026-07-14T09:00:00.000Z',
    });
  }
  if (href.endsWith('/api/v1/budget/reservations')) {
    if (
      body.includes('private cache poison prompt') ||
      body.includes('provider-private-cache-poison-key')
    ) {
      throw new Error('private cache-poison data leaked into control');
    }
    const reserve = JSON.parse(body);
    reservationSequence += 1;
    const currentReservationId = reservationId(reservationSequence);
    operationByReservation.set(currentReservationId, reserve.operation_id);
    return json({
      schema_version: '1.0', decision: 'reserved', allowed: true,
      decision_id: '55555555-5555-4555-8555-555555555555',
      operation_id: reserve.operation_id, reservation_id: currentReservationId, state: 'reserved',
      reserved_usd: '0.1', remaining_usd: '1',
      expires_at: '2026-07-14T09:05:00.000Z', warnings: [],
    });
  }
  if (href.endsWith('/commit')) {
    const currentReservationId = lifecycleReservation(href);
    const operationId = operationByReservation.get(currentReservationId);
    if (operationId === undefined) throw new Error('cache-poison commit used an unknown reservation');
    const commit = JSON.parse(body);
    if (
      commit.kind !== 'llm' ||
      commit.status !== 'success' ||
      commit.actual_input_tokens !== 8 ||
      commit.actual_output_tokens !== 4 ||
      commit.stream_aborted !== false
    ) {
      throw new Error('cache-poison commit lost exact terminal usage evidence');
    }
    commits += 1;
    return json({
      schema_version: '1.0', state: 'committed', reservation_id: currentReservationId,
      operation_id: operationId, reserved_usd: '0.1', actual_usd: '0.01',
      released_usd: '0.09', overage_usd: '0', budget_exceeded_after_commit: false,
      committed_at: '2026-07-14T09:01:00.000Z', idempotent_replay: false, late: false,
    });
  }
  if (href === 'https://api.openai.com/v1/chat/completions') {
    providerCalls += 1;
    const providerBody = JSON.parse(body);
    if (providerBody.model !== 'gpt-4o-mini' || providerBody.service_tier !== 'default') {
      throw new Error('real cache-poison provider call lost the strict priced shape');
    }
    if (providerBody.stream === true) {
      if (providerBody.stream_options?.include_usage !== true) {
        throw new Error('real cache-poison stream lost terminal usage request evidence');
      }
      return new Response(streamSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return json({
      id: 'chatcmpl_cache_poison', object: 'chat.completion', created: 1784009600,
      model: 'gpt-4o-mini', service_tier: 'default',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'real ESM executable answer' },
        finish_reason: 'stop', logprobs: null,
      }],
      usage: {
        prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    });
  }
  throw new Error('unexpected cache-poison fetch: ' + href);
};

try {
  if (require('ai') !== poisonedExecutable || require('ai/package.json') !== poisonedManifest) {
    throw new Error('failed to prime the real CommonJS executable and manifest caches');
  }
  let sdk;
  let vercel;
  if (branch === 'esm') {
    sdk = await import('@pylva/sdk');
    vercel = await import('@pylva/sdk/vercel-ai');
  } else {
    sdk = require('@pylva/sdk');
    vercel = require('@pylva/sdk/vercel-ai');
  }
  const model = await vercel.createControlledOpenAIChatModel({
    apiKey: 'provider-private-cache-poison-key',
    model: 'gpt-4o-mini',
  });
  const controlledRequest = {
    model,
    prompt: 'private cache poison prompt',
    maxOutputTokens: 20,
    maxRetries: 0,
    providerOptions: { openai: { serviceTier: 'default' } },
  };
  if (expected === 'refuse') {
    const expectRefusal = async (label, invoke) => {
      let refusal;
      try {
        await invoke();
      } catch (error) {
        refusal = error;
      }
      if (
        !(refusal instanceof sdk.PylvaStrictProviderError) ||
        refusal.reason !== 'ai_sdk_v6_is_required' ||
        refusal.provider !== 'vercel-ai' ||
        Object.getPrototypeOf(refusal) !== sdk.PylvaStrictProviderError.prototype
      ) {
        throw new Error(label + ' did not honor the real unsupported AI manifest');
      }
    };
    await expectRefusal('controlledGenerateText', () =>
      vercel.controlledGenerateText(controlledRequest),
    );
    await expectRefusal('controlledStreamText', () =>
      vercel.controlledStreamText(controlledRequest),
    );
    if (fetchCalls !== 0 || providerCalls !== 0 || commits !== 0 || reservationSequence !== 0) {
      throw new Error('real unsupported manifest did not win over poisoned major-six cache');
    }
  } else {
    sdk.init({
      apiKey: 'pv_live_aabbccdd_' + 'a'.repeat(32),
      endpoint: 'https://cache-poison-package-smoke.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const result = await vercel.controlledGenerateText(controlledRequest);
    if (
      result.text !== 'real ESM executable answer' ||
      providerCalls !== 1 ||
      commits !== 1
    ) {
      throw new Error('real AI SDK 6 executable did not win over poisoned CommonJS cache');
    }
    const stream = await vercel.controlledStreamText(controlledRequest);
    let streamText = '';
    for await (const delta of stream.textStream) streamText += delta;
    const streamUsage = await stream.totalUsage;
    if (
      streamText !== 'real ESM stream answer' ||
      (await stream.text) !== 'real ESM stream answer' ||
      streamUsage.inputTokens !== 8 ||
      streamUsage.outputTokens !== 4
    ) {
      throw new Error('real AI SDK 6 stream did not win over poisoned CommonJS cache');
    }
    await waitFor(() => commits, 2, 'cache-poison stream commit');
    if (providerCalls !== 2 || reservationSequence !== 2) {
      throw new Error('real cache-poison generate/stream lifecycle mismatch');
    }
  }
  if (
    poisonCalls !== 0 ||
    require.cache[aiEntryPath] !== poisonedExecutableEntry ||
    require.cache[aiManifestPath] !== poisonedManifestEntry
  ) {
    throw new Error('installed strict helper consulted or replaced a poisoned CommonJS cache');
  }
  console.log('Vercel executable/manifest cache-poison smoke passed (' + branch + ', ' + expected + ')');
} finally {
  if (previousExecutableEntry === undefined) delete require.cache[aiEntryPath];
  else require.cache[aiEntryPath] = previousExecutableEntry;
  if (previousManifestEntry === undefined) delete require.cache[aiManifestPath];
  else require.cache[aiManifestPath] = previousManifestEntry;
}
`,
    );

    writeFileSync(
      path.join(installDir, 'consumer.mts'),
      `
import {
  PylvaBudgetExceeded,
  PylvaControlApiError,
  PylvaControlUnavailableError,
  PylvaControlValidationError,
  PylvaStrictProviderError,
  commitUsage,
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
  controlledTavilySearch,
  controlledUsage,
  currentControlledAttempt,
  extendUsage,
  ready,
  releaseUsage,
  wrapAnthropic,
  wrapOpenAI,
  type ControlledTavilySearchInput,
  type ControlledUsageOutcome,
  type ControlledUsageResult,
  type CommitUsageResult,
  type ExtendUsageResult,
  type ReleaseUsageResult,
} from '@pylva/sdk';
import { applyOpenAiPatch, wrapOpenAI as wrapOpenAISubpath } from '@pylva/sdk/openai';
import { applyAnthropicPatch, wrapAnthropic as wrapAnthropicSubpath } from '@pylva/sdk/anthropic';
import { applyVercelAiPatch, controlledGenerateText as controlledGenerateTextSubpath } from '@pylva/sdk/vercel-ai';
import {
  PylvaCallbackHandler,
  withLangGraphControlScope,
  type PylvaCallbackLlmTrackingMode,
} from '@pylva/sdk/langgraph';
import { AsyncPylvaCallbackHandler } from '@pylva/sdk/langchain';
const readiness: Promise<boolean> = ready();
const lifecycleReservationId = '44444444-4444-4444-8444-444444444444';
const lifecycleExtensionId = '55555555-5555-4555-8555-555555555555';
const committed: Promise<CommitUsageResult> = commitUsage({
  reservationId: lifecycleReservationId, kind: 'llm', status: 'success', latencyMs: 25,
  streamAborted: false, actualInputTokens: 2, actualOutputTokens: 1,
});
const released: Promise<ReleaseUsageResult> = releaseUsage({
  reservationId: lifecycleReservationId, reason: 'provider_not_called',
});
const extended: Promise<ExtendUsageResult> = extendUsage({
  reservationId: lifecycleReservationId, extensionId: lifecycleExtensionId, extendBySeconds: 300,
});
declare const openAIClient: { chat: unknown };
declare const anthropicClient: { messages: unknown };
const strictOpenAI = wrapOpenAI(openAIClient, { reservationTtlSeconds: 300 });
const strictAnthropic = wrapAnthropic(anthropicClient, { reservationTtlSeconds: 300 });
const activeAttempt = currentControlledAttempt();
const generated: Promise<unknown> = controlledGenerateText({});
const streamed: Promise<unknown> = controlledStreamText({});
const controlledModel = createControlledOpenAIChatModel({
  apiKey: 'provider-key',
  model: 'gpt-4o-mini',
});
declare const strictError: PylvaStrictProviderError;
const budgetError: PylvaBudgetExceeded = new PylvaBudgetExceeded({
  source: 'authoritative_control', rule_id: 'rule-package-smoke', customer_id: 'customer',
  period: 'day', period_start: '2026-07-14T00:00:00.000Z', limit_usd: 1,
  accumulated_usd: 1, estimated_usd: 0.1,
});
const unavailableError: PylvaControlUnavailableError = new PylvaControlUnavailableError({
  reason: 'network_error', retryable: true, operation: 'reserveUsage',
});
const apiError: PylvaControlApiError = new PylvaControlApiError(409, 'operation_conflict');
const validationError: PylvaControlValidationError = new PylvaControlValidationError('reserveUsage');
class DerivedUnavailableError extends PylvaControlUnavailableError {}
const derivedUnavailable: PylvaControlUnavailableError = new DerivedUnavailableError({
  reason: 'network_error', retryable: true, operation: 'ready',
});
const controlledResult: Promise<ControlledUsageResult<{ pages: number }>> = controlledUsage({
  costSourceSlug: 'document-parser',
  toolName: 'Document Parser',
  metric: 'page',
  maximumValue: 2,
  customerId: 'package-smoke',
  invoke: async () => ({ pages: 1 }),
  extractActual: (value) => value.pages,
});
const tavilyInput: ControlledTavilySearchInput = {
  query: 'typed package smoke query',
  customerId: 'package-smoke',
};
const tavilyResult = controlledTavilySearch(
  { search: async () => ({ results: [], usage: { credits: 1 } }) },
  tavilyInput,
);
const outcome: ControlledUsageOutcome | undefined = undefined;
const trackingMode: PylvaCallbackLlmTrackingMode = 'auto';
const exportsAreTyped = [applyOpenAiPatch, applyAnthropicPatch, applyVercelAiPatch, PylvaCallbackHandler, AsyncPylvaCallbackHandler, withLangGraphControlScope, wrapOpenAISubpath, wrapAnthropicSubpath, controlledGenerateTextSubpath, strictOpenAI, strictAnthropic, activeAttempt, generated, streamed, controlledModel, strictError.reason, budgetError.code, unavailableError.reason, apiError.status, validationError.operation, derivedUnavailable.operation, PylvaBudgetExceeded.name, PylvaControlUnavailableError.name, PylvaControlApiError.name, PylvaControlValidationError.name, trackingMode];
void readiness;
void committed;
void released;
void extended;
void controlledResult;
void tavilyResult;
void outcome;
void exportsAreTyped;
`,
    );
    writeFileSync(
      path.join(installDir, 'consumer.cts'),
      `
import sdk = require('@pylva/sdk');
import openai = require('@pylva/sdk/openai');
import anthropic = require('@pylva/sdk/anthropic');
import vercelAi = require('@pylva/sdk/vercel-ai');
import langgraph = require('@pylva/sdk/langgraph');
import langchain = require('@pylva/sdk/langchain');
const readiness: Promise<boolean> = sdk.ready();
const commitUsage: typeof sdk.commitUsage = sdk.commitUsage;
const releaseUsage: typeof sdk.releaseUsage = sdk.releaseUsage;
const extendUsage: typeof sdk.extendUsage = sdk.extendUsage;
const controlledUsage: typeof sdk.controlledUsage = sdk.controlledUsage;
const controlledTavilySearch: typeof sdk.controlledTavilySearch = sdk.controlledTavilySearch;
const wrapOpenAI: typeof sdk.wrapOpenAI = openai.wrapOpenAI;
const wrapAnthropic: typeof sdk.wrapAnthropic = anthropic.wrapAnthropic;
const createControlledOpenAIChatModel: typeof sdk.createControlledOpenAIChatModel = vercelAi.createControlledOpenAIChatModel;
const controlledGenerateText: typeof sdk.controlledGenerateText = vercelAi.controlledGenerateText;
const currentControlledAttempt: typeof sdk.currentControlledAttempt = sdk.currentControlledAttempt;
const strictError: typeof sdk.PylvaStrictProviderError = sdk.PylvaStrictProviderError;
const budgetError: sdk.PylvaBudgetExceeded = new sdk.PylvaBudgetExceeded({
  source: 'authoritative_control', rule_id: 'rule-package-smoke', customer_id: 'customer',
  period: 'day', period_start: '2026-07-14T00:00:00.000Z', limit_usd: 1,
  accumulated_usd: 1, estimated_usd: 0.1,
});
const unavailableError: sdk.PylvaControlUnavailableError = new sdk.PylvaControlUnavailableError({
  reason: 'network_error', retryable: true, operation: 'reserveUsage',
});
const apiError: sdk.PylvaControlApiError = new sdk.PylvaControlApiError(409, 'operation_conflict');
const validationError: sdk.PylvaControlValidationError = new sdk.PylvaControlValidationError('reserveUsage');
class DerivedUnavailableError extends sdk.PylvaControlUnavailableError {}
const derivedUnavailable: sdk.PylvaControlUnavailableError = new DerivedUnavailableError({
  reason: 'network_error', retryable: true, operation: 'ready',
});
const withLangGraphControlScope: typeof langgraph.withLangGraphControlScope = langgraph.withLangGraphControlScope;
const trackingMode: langgraph.PylvaCallbackLlmTrackingMode = 'auto';
const exportsAreTyped = [openai.applyOpenAiPatch, anthropic.applyAnthropicPatch, vercelAi.applyVercelAiPatch, langgraph.PylvaCallbackHandler, langchain.AsyncPylvaCallbackHandler, commitUsage, releaseUsage, extendUsage, controlledUsage, controlledTavilySearch, wrapOpenAI, wrapAnthropic, createControlledOpenAIChatModel, controlledGenerateText, currentControlledAttempt, strictError, budgetError.code, unavailableError.reason, apiError.status, validationError.operation, derivedUnavailable.operation, sdk.PylvaBudgetExceeded.name, sdk.PylvaControlUnavailableError.name, sdk.PylvaControlApiError.name, sdk.PylvaControlValidationError.name, withLangGraphControlScope, trackingMode];
void readiness;
void exportsAreTyped;
`,
    );
    writeFileSync(
      path.join(installDir, 'consumer-core.mts'),
      `
import { PylvaControlUnavailableError, ready, type ControlReadyResult } from '@pylva/sdk';
const readiness: Promise<boolean> = ready();
const status: ControlReadyResult | undefined = undefined;
const ErrorConstructor: typeof PylvaControlUnavailableError = PylvaControlUnavailableError;
void [readiness, status, ErrorConstructor];
`,
    );
    writeFileSync(
      path.join(installDir, 'consumer-core.cts'),
      `
import sdk = require('@pylva/sdk');
const readiness: Promise<boolean> = sdk.ready();
const ErrorConstructor: typeof sdk.PylvaControlUnavailableError = sdk.PylvaControlUnavailableError;
void [readiness, ErrorConstructor];
`,
    );

    run(process.execPath, ['esm-smoke.mjs'], { cwd: installDir, stdio: 'inherit' });
    run(process.execPath, ['cjs-smoke.cjs'], { cwd: installDir, stdio: 'inherit' });
    run(process.execPath, ['installed-surface.mjs'], { cwd: installDir, stdio: 'inherit' });
    for (const format of ['esm', 'cjs']) {
      run(process.execPath, ['--enable-source-maps', 'source-map-stack.mjs', format], {
        cwd: installDir,
        stdio: 'inherit',
      });
    }
    const officialProviderSmokeEnv = {
      PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM: anthropicNeedsWebShim ? '1' : '0',
      PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM: openAiNeedsWebShim ? '1' : '0',
    };
    if (options.profile === 'full')
      for (const order of ['root-first', 'subpath-first']) {
        run(process.execPath, ['esm-bundle-identity.mjs', order], {
          cwd: installDir,
          env: officialProviderSmokeEnv,
          stdio: 'inherit',
        });
        run(process.execPath, ['cjs-bundle-identity.cjs', order], {
          cwd: installDir,
          env: officialProviderSmokeEnv,
          stdio: 'inherit',
        });
      }
    if (options.profile === 'full')
      for (const scenario of [
        'esm-root-cjs-deep',
        'cjs-deep-esm-root',
        'cjs-root-esm-deep',
        'esm-deep-cjs-root',
      ]) {
        run(process.execPath, ['mixed-bundle-identity.mjs', scenario], {
          cwd: installDir,
          env: officialProviderSmokeEnv,
          stdio: 'inherit',
        });
      }
    if (options.profile === 'full')
      for (const branch of ['esm', 'cjs']) {
        run(process.execPath, ['vercel-official.mjs', branch, 'v6'], {
          cwd: installDir,
          stdio: 'inherit',
        });
        run(process.execPath, ['direct-provider-official.mjs', branch], {
          cwd: installDir,
          env: officialProviderSmokeEnv,
          stdio: 'inherit',
        });
      }
    if (options.profile !== 'optional-free') {
      const installedAiManifestPath = path.join(installDir, 'node_modules', 'ai', 'package.json');
      const installedOpenAiProviderManifestPath = path.join(
        installDir,
        'node_modules',
        '@ai-sdk',
        'openai',
        'package.json',
      );
      const installedAiManifest = JSON.parse(readFileSync(installedAiManifestPath, 'utf8'));
      const installedOpenAiProviderManifest = JSON.parse(
        readFileSync(installedOpenAiProviderManifestPath, 'utf8'),
      );
      assert(
        /^3\./.test(installedOpenAiProviderManifest.version),
        'package smoke must use official @ai-sdk/openai 3.x',
      );
      if (options.profile === 'full') {
        assert(/^6\./.test(installedAiManifest.version), 'full smoke requires official AI SDK 6.x');
      } else {
        assert(!/^6\./.test(installedAiManifest.version), 'refusal profile requires non-v6 AI SDK');
        for (const branch of ['esm', 'cjs']) {
          run(process.execPath, ['vercel-official.mjs', branch, 'refuse'], {
            cwd: installDir,
            stdio: 'inherit',
          });
        }
      }
      for (const branch of ['esm', 'cjs']) {
        run(
          process.execPath,
          ['vercel-cache-poison.mjs', branch, options.profile === 'full' ? 'v6' : 'refuse'],
          { cwd: installDir, stdio: 'inherit' },
        );
      }
    }
    const typeConsumers =
      options.profile === 'optional-free'
        ? ['consumer-core.mts', 'consumer-core.cts']
        : ['consumer.mts', 'consumer.cts'];
    run(
      path.join(installDir, 'node_modules', '.bin', 'tsc'),
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'Node16',
        '--moduleResolution',
        'Node16',
        ...typeConsumers,
      ],
      { cwd: installDir, stdio: 'inherit' },
    );

    const cli = path.join(installDir, 'node_modules', '.bin', 'pylva');
    assert(run(cli, ['--help'], { cwd: installDir }).includes('pylva validate'), 'CLI help failed');
    assert(
      run(cli, ['validate', '--help'], { cwd: installDir }).includes('pylva validate'),
      'validate CLI help failed',
    );

    console.log(
      `packed TypeScript SDK smoke passed: @pylva/sdk@${packedManifest.version} (ESM, CJS, ESM/CJS types, all public subpaths, CLI)`,
    );
  }
} finally {
  try {
    if (verifiedArtifact !== null) {
      assert(
        sha256(verifiedArtifact.tarball) === verifiedArtifact.sha256,
        'immutable TypeScript tarball changed while it was being verified',
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
