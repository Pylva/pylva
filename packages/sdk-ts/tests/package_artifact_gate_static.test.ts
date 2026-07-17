import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const sdkRoot = path.join(repoRoot, 'packages/sdk-ts');

function json(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as Record<string, unknown>;
}

type WorkflowStep = Readonly<Record<string, unknown>>;
type WorkflowJob = Readonly<Record<string, unknown>> & { readonly steps?: readonly WorkflowStep[] };

function workflow(relative: string): Readonly<Record<string, unknown>> {
  const value = parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${relative} did not parse as a workflow object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function job(document: Readonly<Record<string, unknown>>, name: string): WorkflowJob {
  const jobs = document['jobs'];
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) {
    throw new Error('workflow jobs are missing');
  }
  const value = (jobs as Record<string, unknown>)[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`workflow job ${name} is missing`);
  }
  return value as WorkflowJob;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const matches = (workflowJob.steps ?? []).filter((candidate) => candidate['name'] === name);
  if (matches.length !== 1) throw new Error(`expected exactly one workflow step named ${name}`);
  return matches[0] as WorkflowStep;
}

function runSource(workflowStep: WorkflowStep): string {
  const value = workflowStep['run'];
  if (typeof value !== 'string') throw new Error('workflow step is missing a run program');
  return value;
}

function allRunSources(workflowJob: WorkflowJob): string {
  return (workflowJob.steps ?? [])
    .map((candidate) => candidate['run'])
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .join('\n');
}

function jsonAttributePreserver(): (source: string, relativePath: string) => string {
  const source = readFileSync(path.join(sdkRoot, 'scripts/build.mjs'), 'utf8');
  const file = ts.createSourceFile(
    'build.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'preserveJsonImportAttributes',
  );
  if (declaration === undefined) throw new Error('missing JSON import attribute gate');
  return runInNewContext(`(${source.slice(declaration.getStart(file), declaration.end)})`) as (
    source: string,
    relativePath: string,
  ) => string;
}

function sourceMapNormalizer(): (
  source: string,
  sourceMapName: string,
  relativePath: string,
) => string {
  const source = readFileSync(path.join(sdkRoot, 'scripts/build.mjs'), 'utf8');
  const file = ts.createSourceFile(
    'build.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set(['sourceMapDirectives', 'normalizeSourceMapReferences']);
  const declarations = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      names.has(statement.name.text),
  );
  if (declarations.length !== names.size) throw new Error('missing source-map normalizer');
  const program = declarations
    .map((declaration) => source.slice(declaration.getStart(file), declaration.end))
    .join('\n');
  return runInNewContext(`(() => { ${program}; return normalizeSourceMapReferences; })()`, {
    ts,
  }) as (source: string, sourceMapName: string, relativePath: string) => string;
}

function sourceMapValidator(): (sourceMap: unknown, relativePath: string) => void {
  const source = readFileSync(path.join(sdkRoot, 'scripts/build.mjs'), 'utf8');
  const file = ts.createSourceFile(
    'build.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set(['isPathSafeSourceMapLocation', 'assertPathSafeSourceMap']);
  const declarations = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      names.has(statement.name.text),
  );
  if (declarations.length !== names.size) throw new Error('missing source-map validator');
  const program = declarations
    .map((declaration) => source.slice(declaration.getStart(file), declaration.end))
    .join('\n');
  return runInNewContext(`(() => { ${program}; return assertPathSafeSourceMap; })()`, {
    basename: path.basename,
    posix: path.posix,
    win32: path.win32,
  }) as (sourceMap: unknown, relativePath: string) => void;
}

function scriptStaticValue(relative: string, name: string): unknown {
  const source = readFileSync(path.join(sdkRoot, relative), 'utf8');
  const file = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        return runInNewContext(`(${source.slice(declaration.initializer.pos, declaration.end)})`);
      }
    }
  }
  throw new Error(`missing static value ${name} in ${relative}`);
}

function scriptFunction(relative: string, name: string): string {
  const source = readFileSync(path.join(sdkRoot, relative), 'utf8');
  const file = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declaration === undefined) throw new Error(`missing function ${name} in ${relative}`);
  return source.slice(declaration.getStart(file), declaration.end);
}

function scriptStringConstant(relative: string, name: string): string {
  const source = readFileSync(path.join(sdkRoot, relative), 'utf8');
  const file = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        ts.isStringLiteralLike(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }
  throw new Error(`missing string constant ${name} in ${relative}`);
}

function generatedInstallScript(name: string): string {
  const source = readFileSync(
    path.join(repoRoot, 'scripts/ci/smoke-typescript-package.mjs'),
    'utf8',
  );
  const file = ts.createSourceFile(
    'smoke-typescript-package.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let result: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'writeFileSync' &&
      node.arguments.length >= 2
    ) {
      const destination = node.arguments[0];
      const contents = node.arguments[1];
      if (ts.isCallExpression(destination)) {
        const filename = destination.arguments.at(-1);
        if (filename !== undefined && ts.isStringLiteral(filename) && filename.text === name) {
          if (contents === undefined || !ts.isNoSubstitutionTemplateLiteral(contents)) {
            throw new Error(`${name} must be one static generated script`);
          }
          result = contents.text;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (result === undefined) throw new Error(`missing generated install script ${name}`);
  const generated = ts.createSourceFile(
    name,
    result,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  if (generated.parseDiagnostics.length > 0) {
    throw new Error(
      `${name} has syntax errors: ${generated.parseDiagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ')}`,
    );
  }
  return result;
}

describe('immutable TypeScript package gate configuration', () => {
  it('locks publishable manifest routing, scripts, publication, and passive install posture', () => {
    const manifest = json('packages/sdk-ts/package.json');
    expect(manifest['imports']).toEqual({
      '#pylva/anthropic-runtime': './dist/anthropic.cjs',
      '#pylva/budget-enforcement-runtime': './dist/internal/budget-enforcement-runtime.cjs',
      '#pylva/budget-runtime': './dist/internal/budget-runtime.cjs',
      '#pylva/control-runtime': './dist/internal/control-runtime.cjs',
      '#pylva/core-runtime': './dist/internal/core-runtime.cjs',
      '#pylva/engine-runtime': './dist/internal/engine-runtime.cjs',
      '#pylva/execution-runtime': './dist/internal/execution-runtime.cjs',
      '#pylva/init-validation-runtime': './dist/internal/init-validation-runtime.cjs',
      '#pylva/nonllm-runtime': './dist/internal/nonllm-runtime.cjs',
      '#pylva/openai-runtime': './dist/openai.cjs',
      '#pylva/public-errors': './dist/internal/public-errors.cjs',
      '#pylva/routing-runtime': './dist/internal/routing-runtime.cjs',
      '#pylva/strict-unwrapper-runtime': './dist/internal/strict-unwrapper-runtime.cjs',
      '#pylva/telemetry-runtime': './dist/internal/telemetry-runtime.cjs',
      '#pylva/usage-snapshot-runtime': './dist/internal/usage-snapshot-runtime.cjs',
      '#pylva/vercel-ai-runtime': './dist/vercel-ai.cjs',
    });
    expect(manifest['scripts']).toEqual({
      build: 'node scripts/build.mjs',
      dev: 'node scripts/build.mjs',
      prepublishOnly: 'npm run test && npm run typecheck && npm run build && npm run size',
      size: 'node scripts/check-runtime-size.mjs',
      test: 'vitest run',
      typecheck: 'tsc --noEmit && tsc -p tsconfig.type-tests.json',
    });
    expect(manifest['publishConfig']).toEqual({ access: 'public' });
    const scripts = manifest['scripts'] as Record<string, unknown>;
    for (const hook of [
      'preinstall',
      'install',
      'postinstall',
      'preuninstall',
      'uninstall',
      'postuninstall',
    ]) {
      expect(scripts[hook], hook).toBeUndefined();
    }
    expect(existsSync(path.join(sdkRoot, 'README.md'))).toBe(true);
    expect(existsSync(path.join(sdkRoot, 'LICENSE'))).toBe(true);
  });

  it('pins the lowest mutually installable strict peer profile exactly', () => {
    expect(json('scripts/ci/typescript-package-peers-floor.json')).toEqual({
      '@ai-sdk/openai': '3.0.0',
      '@anthropic-ai/sdk': '0.30.1',
      '@langchain/core': '1.1.48',
      '@langchain/langgraph': '1.0.0',
      ai: '6.0.0',
      openai: '4.104.0',
    });
  });

  it('keeps the current peer profile equal to the installed lockfile graph', () => {
    const current = json('scripts/ci/typescript-package-peers-current.json');
    expect(Object.keys(current).sort()).toEqual([
      '@ai-sdk/openai',
      '@anthropic-ai/sdk',
      '@langchain/core',
      '@langchain/langgraph',
      'ai',
      'openai',
    ]);
    for (const [name, expected] of Object.entries(current)) {
      const manifest = JSON.parse(
        readFileSync(
          path.join(sdkRoot, 'node_modules', ...name.split('/'), 'package.json'),
          'utf8',
        ),
      ) as { version: string };
      expect(manifest.version, name).toBe(expected);
    }
  });

  it('uses real unsupported AI SDK majors for refusal profiles', () => {
    expect(json('scripts/ci/typescript-package-peers-ai3.json')).toEqual({
      '@ai-sdk/openai': '3.0.0',
      ai: '3.0.0',
    });
    expect(json('scripts/ci/typescript-package-peers-ai4.json')).toEqual({
      '@ai-sdk/openai': '3.0.0',
      ai: '4.0.0',
    });
    expect(json('scripts/ci/typescript-package-peers-ai5.json')).toEqual({
      '@ai-sdk/openai': '3.0.0',
      ai: '5.0.0',
    });
  });

  it('semantically binds every Node leg to one uploaded tarball and its recorded SHA', () => {
    const ci = workflow('.github/workflows/authoritative-budget-control-ci.yml');
    const artifact = job(ci, 'typescript-package-artifact');
    const matrix = job(ci, 'typescript-package-matrix');
    const aggregate = job(ci, 'authoritative-control-full-gate');

    expect(matrix['needs']).toBe('typescript-package-artifact');
    expect((matrix['strategy'] as Record<string, unknown>)['fail-fast']).toBe(false);
    expect(
      ((matrix['strategy'] as Record<string, unknown>)['matrix'] as Record<string, unknown>)[
        'node'
      ],
    ).toEqual(['20.18.1', '22', '24']);
    expect(aggregate['needs']).toContain('typescript-package-matrix');

    const pack = runSource(step(artifact, 'Pack, inspect, and fingerprint one immutable artifact'));
    expect(pack.match(/--pack-output/gu)).toHaveLength(1);
    expect(pack).toContain('--artifact-only');
    expect(pack).toContain('--metadata-output "$ARTIFACT_DIR/metadata.json"');
    expect(allRunSources(artifact).match(/--pack-output/gu)).toHaveLength(1);
    expect(allRunSources(matrix)).not.toContain('--pack-output');
    expect(step(artifact, 'Upload immutable TypeScript artifact')['uses']).toBe(
      'actions/upload-artifact@v4',
    );
    expect(step(matrix, 'Download the one immutable npm artifact')['uses']).toBe(
      'actions/download-artifact@v4',
    );

    const identity = runSource(step(matrix, 'Verify downloaded artifact identity'));
    expect(identity).toContain('test "${#TARBALLS[@]}" -eq 1');
    expect(identity).toContain('p.resolve(p.dirname(process.argv[1]),m.tarball)');
    expect(identity).toContain('test "$(realpath "${TARBALLS[0]}")" = "$(realpath "$TARBALL")"');
    expect(identity).toContain('--artifact-only');
    expect(identity).toContain('--tarball "$TARBALL"');
    expect(identity).toContain('--expected-sha256 "$SHA256"');

    for (const name of [
      'Verify optional-peer-free installed artifact',
      'Verify strict-supported peer floors from the same artifact',
      'Verify repository-current peers from the same artifact',
      'Verify actual AI SDK 3 refusal from the same artifact',
      'Verify actual AI SDK 4 refusal from the same artifact',
      'Verify actual AI SDK 5 refusal from the same artifact',
    ]) {
      const source = runSource(step(matrix, name));
      expect(source, name).toContain('--tarball "$PYLVA_TYPESCRIPT_TARBALL"');
      expect(source, name).toContain('--expected-sha256 "$PYLVA_TYPESCRIPT_TARBALL_SHA256"');
    }
  });

  it('canonicalizes the metadata parent before proving the tarball is its sibling', () => {
    const harness = readFileSync(
      path.join(repoRoot, 'scripts/ci/smoke-typescript-package.mjs'),
      'utf8',
    );

    expect(harness).toContain('realpathSync(metadataDirectory)');
    expect(harness).toContain('path.relative(path.dirname(metadataTarget), realpathSync(tarball))');
    expect(harness).not.toContain(
      'path.relative(path.dirname(metadataPath), realpathSync(tarball))',
    );
  });

  it('semantically binds trusted publication to exact-SHA CI and the verified tarball', () => {
    const release = workflow('.github/workflows/publish-typescript-sdk.yml');
    const publish = job(release, 'publish-typescript');
    expect((publish['permissions'] as Record<string, unknown>)['actions']).toBe('read');
    expect((publish['permissions'] as Record<string, unknown>)['id-token']).toBe('write');

    const releaseCommit = step(publish, 'Verify release tag is on main');
    expect(releaseCommit['id']).toBe('release_commit');
    expect(runSource(releaseCommit)).toContain('echo "sha=$TAG_COMMIT" >> "$GITHUB_OUTPUT"');
    const attestation = runSource(
      step(publish, 'Require successful authoritative-control CI for the exact release commit'),
    );
    for (const invariant of [
      'head_sha=${RELEASE_SHA}',
      'run.head_sha === expectedSha',
      "run.head_branch === 'main'",
      "run.status === 'completed'",
      "run.conclusion === 'success'",
      "new Set(['push', 'workflow_dispatch', 'schedule'])",
    ]) {
      expect(attestation).toContain(invariant);
    }

    const pack = runSource(step(publish, 'Pack and fingerprint immutable release artifact'));
    expect(pack.match(/--pack-output/gu)).toHaveLength(1);
    expect(pack).toContain('p.resolve(p.dirname(process.argv[1]),m.tarball)');
    expect(allRunSources(publish).match(/--pack-output/gu)).toHaveLength(1);
    expect(allRunSources(publish).match(/npm publish/gu)).toHaveLength(1);
    for (const name of [
      'Verify optional-peer-free release artifact',
      'Verify strict-supported peer floors from release artifact',
      'Verify repository-current peers from release artifact',
      'Verify actual unsupported AI SDK majors from release artifact',
    ]) {
      const source = runSource(step(publish, name));
      expect(source, name).toContain('--tarball "$PYLVA_TYPESCRIPT_TARBALL"');
      expect(source, name).toContain('--expected-sha256 "$PYLVA_TYPESCRIPT_TARBALL_SHA256"');
    }
    const published = runSource(step(publish, 'Publish exact verified artifact'));
    expect(published).toContain('test "$ACTUAL_SHA256" = "$PYLVA_TYPESCRIPT_TARBALL_SHA256"');
    expect(published).toContain(
      'npm publish "$PYLVA_TYPESCRIPT_TARBALL" --access public --ignore-scripts',
    );
  });

  it('runs installed official stream, cancellation, close, and cache-poison subprocess proofs', () => {
    const harness = readFileSync(
      path.join(repoRoot, 'scripts/ci/smoke-typescript-package.mjs'),
      'utf8',
    );
    for (const generated of [
      'vercel-official.mjs',
      'direct-provider-official.mjs',
      'vercel-cache-poison.mjs',
    ]) {
      expect(harness, generated).toContain(`path.join(installDir, '${generated}')`);
    }
    expect(harness).toContain("['direct-provider-official.mjs', branch]");
    expect(harness).toContain("'vercel-cache-poison.mjs'");
    expect(harness).toContain("options.profile === 'full' ? 'v6' : 'refuse'");
    expect(harness).toContain('const openAiNeedsWebShim = /^4\\./u.test');
    expect(harness).toContain(
      "const anthropicNeedsWebShim = peerVersions['@anthropic-ai/sdk'] === '0.30.1'",
    );
    expect(harness).toContain(
      "PYLVA_PACKAGE_SMOKE_OPENAI_WEB_SHIM: openAiNeedsWebShim ? '1' : '0'",
    );
    expect(harness).toContain(
      "PYLVA_PACKAGE_SMOKE_ANTHROPIC_WEB_SHIM: anthropicNeedsWebShim ? '1' : '0'",
    );
    expect(harness).toContain("path.dirname(relativeTarball) === '.'");
    expect(harness).toContain("['package/README.md', 'package/LICENSE']");
    expect(harness).not.toMatch(/writeFileSync\(\s*installedAiManifestPath/u);

    expect(harness).toContain('Object.is(left?.value, right?.value)');
    expect(harness).not.toContain('left?.value === right?.value');
    expect(harness).toContain('void globalThis.fetch;');
    expect(harness).toContain("new Request('https://pylva.invalid');");
    expect(harness).toContain("Symbol.for('undici.globalDispatcher.1')");
    expect(harness).toContain(
      "const nanDescriptorSymbol = Symbol('pylva.package-smoke.nan-descriptor');",
    );
    expect(harness).toContain(
      "const arbitraryGlobalSymbol = Symbol('pylva.package-smoke.arbitrary-global');",
    );
    expect(harness).toContain(
      "throw new Error('process-global mutation gate allowed an arbitrary symbol');",
    );
    const globalGateStart = harness.indexOf('const globalStateChanged = () => {');
    const globalGateEnd = harness.indexOf('const arbitraryGlobalSymbol', globalGateStart);
    expect(globalGateStart).toBeGreaterThan(-1);
    expect(globalGateEnd).toBeGreaterThan(globalGateStart);
    const globalGate = harness.slice(globalGateStart, globalGateEnd);
    expect(globalGate).toContain('keys.length !== globalSnapshot.size');
    expect(globalGate).toContain('!globalSnapshot.has(key)');
    expect(globalGate).not.toContain('undiciGlobalDispatcherSymbol');
    expect(globalGate).not.toMatch(/allow(?:ed|list)|typeof key === ['"]symbol['"]/u);

    const vercel = generatedInstallScript('vercel-official.mjs');
    expect(vercel).toContain('commit.actual_input_tokens !== 8');
    expect(vercel).toContain('commit.actual_output_tokens !== 4');
    expect(vercel).toContain('reservationSequence !== 3');
    expect(vercel).toContain('await vercel.controlledStreamText(request)');

    const direct = generatedInstallScript('direct-provider-official.mjs');
    expect(direct).toContain("await import('openai/shims/web')");
    expect(direct).toContain("await import('@anthropic-ai/sdk/shims/web')");
    expect(direct.indexOf("await import('openai/shims/web')")).toBeLessThan(
      direct.indexOf("import('@pylva/sdk')"),
    );
    expect(direct.indexOf("await import('@anthropic-ai/sdk/shims/web')")).toBeLessThan(
      direct.indexOf("import('@pylva/sdk')"),
    );
    expect(direct).toContain('await anthropicIterator.return?.()');
    expect(direct).toContain('anthropicAbortCount + anthropicCancelCount');
    expect(direct).toContain('reservationSequence !== 4');
    expect(direct).toContain("error.reason !== 'client_is_closed'");

    const cachePoison = generatedInstallScript('vercel-cache-poison.mjs');
    expect(cachePoison).toContain('function poisonedGenerateText()');
    expect(cachePoison).toContain('function poisonedStreamText()');
    expect(cachePoison).toContain("await expectRefusal('controlledStreamText'");
    expect(cachePoison).toContain('const stream = await vercel.controlledStreamText');
    expect(cachePoison).toContain('providerCalls !== 2');
  });

  it('accepts no JSON import attribute while rejecting duplicate or malformed attributes', () => {
    const preserve = jsonAttributePreserver();
    const noAttribute = 'const manifest=readFileSync(path,"utf8")';
    const modern = 'import(path,{with:{type:"json"}})';
    const legacy = 'import(path,{assert:{type:"json"}})';

    expect(preserve(noAttribute, 'vercel-ai.cjs')).toBe(noAttribute);
    expect(preserve(modern, 'vercel-ai.cjs')).toBe(modern);
    expect(preserve(legacy, 'vercel-ai.cjs')).toBe('import(path,{with  :{type:"json"}})');
    expect(() => preserve(`${modern};${modern}`, 'vercel-ai.cjs')).toThrow(
      'zero or exactly one valid JSON import attribute',
    );
    expect(() =>
      preserve('import(path,{assert:{type:"json",extra:true}})', 'vercel-ai.cjs'),
    ).toThrow('zero or exactly one valid JSON import attribute');
  });

  it('normalizes inline and duplicate source-map comments without moving generated code', () => {
    const normalize = sourceMapNormalizer();
    const expected = 'entry.js.map';
    expect(
      normalize(
        `const first=1;//# sourceMappingURL=${expected}\nconst second=2;\n//# sourceMappingURL=${expected}\n`,
        expected,
        'entry.js',
      ),
    ).toBe('const first=1;\nconst second=2;');
    expect(
      normalize(
        `const marker="//# sourceMappingURL=wrong.map";//# sourceMappingURL=${expected}\n`,
        expected,
        'entry.js',
      ),
    ).toBe('const marker="//# sourceMappingURL=wrong.map";');
  });

  it('rejects missing, malformed, block, or wrong source-map comments before hardening', () => {
    const normalize = sourceMapNormalizer();
    const expected = 'entry.js.map';
    for (const source of [
      'const value=true;',
      'const value=true;// sourceMappingURL=entry.js.map',
      'const value=true;/*# sourceMappingURL=entry.js.map */',
      'const value=true;//# sourceMappingURL=wrong.map',
      'const value=true;//# sourceMappingURL=entry.js.map extra',
    ]) {
      expect(() => normalize(source, expected, 'entry.js'), source).toThrow(
        'invalid source map reference',
      );
    }
  });

  it('pins one conservative Terser pass after every unminified runtime phase', () => {
    const manifest = json('packages/sdk-ts/package.json');
    expect((manifest['devDependencies'] as Record<string, unknown>)['terser']).toBe('5.46.1');
    expect(scriptStaticValue('scripts/build.mjs', 'expectedTerserVersion')).toBe('5.46.1');
    expect(scriptStaticValue('scripts/build.mjs', 'phases')).toEqual([
      'tsup.config.ts',
      'tsup.canonical.config.ts',
      'tsup.providers.config.ts',
      'tsup.root.config.ts',
      'tsup.bridges.config.ts',
    ]);
    expect(scriptStaticValue('scripts/build.mjs', 'terserCompressOptions')).toEqual({
      ecma: 2020,
      passes: 2,
      arguments: false,
      arrows: false,
      booleans_as_integers: false,
      computed_props: false,
      conditionals: false,
      drop_console: false,
      drop_debugger: false,
      inline: 1,
      keep_classnames: true,
      keep_fargs: true,
      keep_fnames: false,
      pure_getters: false,
      typeofs: false,
      unsafe: false,
      unsafe_arrows: false,
      unsafe_comps: false,
      unsafe_Function: false,
      unsafe_math: false,
      unsafe_methods: false,
      unsafe_proto: false,
      unsafe_regexp: false,
      unsafe_symbols: false,
      unsafe_undefined: false,
    });
    expect(scriptStaticValue('scripts/build.mjs', 'terserMangleOptions')).toEqual({
      eval: false,
      keep_classnames: true,
      keep_fnames: false,
      properties: false,
      safari10: false,
    });
    expect(scriptStaticValue('scripts/build.mjs', 'terserFormatOptions')).toEqual({
      ascii_only: true,
      comments: false,
      ecma: 2020,
      shebang: true,
    });

    for (const relative of ['tsup.config.ts', 'tsup.shared.ts']) {
      const source = readFileSync(path.join(sdkRoot, relative), 'utf8');
      expect(source, relative).toMatch(/\bminify:\s*false\b/u);
      expect(source, relative).not.toMatch(/\bminify:\s*true\b/u);
    }

    const build = readFileSync(path.join(sdkRoot, 'scripts/build.mjs'), 'utf8');
    expect(build).toContain(
      'for (const path of runtimeFiles(distDirectory).sort()) await minifyAndHardenRuntime(path);',
    );
    expect(build).not.toContain('nth_identifier');
    const pipeline = scriptFunction('scripts/build.mjs', 'minifyAndHardenRuntime');
    for (const invariant of [
      '{ [basename(path)]: normalized }',
      '...(isCjs ? { toplevel: true } : { module: true })',
      'content: originalSourceMap',
      'asObject: true',
      'filename: basename(path)',
      'includeSources: true',
    ]) {
      expect(pipeline).toContain(invariant);
    }
    const ordered = [
      'normalizeSourceMapReferences(',
      'assertPathSafeSourceMap(originalSourceMap',
      'const result = await minify(',
      'assertPathSafeSourceMap(sourceMap',
      'preserveJsonImportAttributes(result.code',
      'const hardening =',
      "sourceMap.mappings += ';'",
      'writeFileSync(sourceMapPath',
      'writeFileSync(path',
    ].map((marker) => pipeline.indexOf(marker));
    expect(ordered.every((position) => position >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
  });

  it('pins D088 complete-closure caps as fixed constants rather than a self-adjusting gate', () => {
    const caps = scriptStaticValue('scripts/check-runtime-size.mjs', 'caps') as Map<string, number>;
    expect([...caps.entries()]).toEqual([
      ['.', 49_700],
      ['./openai', 25_900],
      ['./anthropic', 25_900],
      ['./vercel-ai', 21_000],
      ['./langgraph', 15_700],
    ]);

    const sizeGate = readFileSync(path.join(sdkRoot, 'scripts/check-runtime-size.mjs'), 'utf8');
    const capDeclaration = sizeGate.slice(
      sizeGate.indexOf('const caps ='),
      sizeGate.indexOf('const labels ='),
    );
    expect(capDeclaration).toContain('D088');
    expect(capDeclaration).not.toMatch(/Math\.|gzip|1\.04|ceil/iu);
  });

  it('rejects absolute, file-URL, incomplete, or unembedded chained source maps', () => {
    const validate = sourceMapValidator();
    const valid = {
      version: 3,
      file: 'entry.js',
      sourceRoot: '../src',
      sources: ['entry.ts'],
      sourcesContent: ['export const entry = true;'],
      names: [],
      mappings: 'AAAA',
    };
    expect(() => validate(valid, 'entry.js')).not.toThrow();

    for (const sourceMap of [
      { ...valid, file: '/tmp/entry.js' },
      { ...valid, sourceRoot: '/Users/example/project' },
      { ...valid, sourceRoot: 'C:\\workspace\\project' },
      { ...valid, sources: ['/tmp/entry.ts'] },
      { ...valid, sources: ['C:\\workspace\\entry.ts'] },
      { ...valid, sources: ['file:///tmp/entry.ts'] },
      { ...valid, sourcesContent: [null] },
      { ...valid, sourcesContent: [] },
      { ...valid, mappings: '' },
    ]) {
      expect(() => validate(sourceMap, 'entry.js'), JSON.stringify(sourceMap)).toThrow(
        /source map/u,
      );
    }
  });

  it('binds the emitted-cache hardening exception to the exact build output', () => {
    expect(
      scriptStringConstant('scripts/check-runtime-size.mjs', 'reviewedCompletedCacheHardening'),
    ).toBe(scriptStringConstant('scripts/build.mjs', 'lockCompletedCache'));
  });
});
