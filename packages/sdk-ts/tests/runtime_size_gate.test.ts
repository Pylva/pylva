import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const gate = path.resolve(import.meta.dirname, '../scripts/check-runtime-size.mjs');
const temporaryDirectories: string[] = [];

function runtimeSource(body: string, filename: string): string {
  return `${body}\n//# sourceMappingURL=${filename}.map\n`;
}

function writeRuntime(root: string, filename: string, body: string, raw = false): void {
  const target = path.join(root, 'dist', filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, raw ? body : runtimeSource(body, path.basename(filename)));
  writeFileSync(
    `${target}.map`,
    JSON.stringify({ version: 3, sources: [`${filename}.ts`], names: [], mappings: 'AAAA' }),
  );
}

function fixture(
  options: {
    cjs?: string;
    cjsFilename?: string;
    cjsRaw?: string;
    esm?: string;
    esmRaw?: string;
    dependencies?: Record<string, string>;
    peers?: Record<string, string>;
    imports?: Record<string, string>;
    extra?: Record<string, string>;
  } = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pylva-runtime-size-'));
  temporaryDirectories.push(root);
  const cjsFilename = options.cjsFilename ?? 'entry.cjs';
  const target = {
    import: { default: './dist/entry.js' },
    require: { default: `./dist/${cjsFilename}` },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: {
        '.': target,
        './openai': target,
        './anthropic': target,
        './vercel-ai': target,
        './langgraph': target,
      },
      imports: options.imports ?? { '#known': './dist/internal/known.cjs' },
      dependencies: options.dependencies ?? {},
      peerDependencies: options.peers ?? { openai: '>=4' },
    }),
  );
  writeRuntime(
    root,
    cjsFilename,
    options.cjsRaw ?? options.cjs ?? "require('#known');require('node:crypto')",
    options.cjsRaw !== undefined,
  );
  writeRuntime(
    root,
    'entry.js',
    options.esmRaw ??
      options.esm ??
      `import{createRequire}from'node:module';createRequire(import.meta.url)('./${cjsFilename}')`,
    options.esmRaw !== undefined,
  );
  writeRuntime(root, 'internal/known.cjs', "import('openai/version')");
  for (const [filename, source] of Object.entries(options.extra ?? {})) {
    writeRuntime(root, filename, source);
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [gate], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('honest TypeScript runtime-size graph', () => {
  it('follows mapped private, relative bridge, and declared peer edges', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('root: files=3');
  });

  it('recurses literal dynamic imports and static ESM imports', () => {
    const result = run(
      fixture({
        cjs: "import('#known')",
        esm: "import'./esm-helper.js'",
        extra: { 'esm-helper.js': 'export const loaded=true' },
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('root: files=4');
  });

  it('follows literal createRequire aliases and ignores loader-shaped text', () => {
    const result = run(
      fixture({
        cjs: [
          "const{createRequire:make}=require('node:module')",
          'const load=make(__filename)',
          'const alias=load',
          "alias('openai')",
          "load('./helper.cjs')",
          "load.resolve('ai/package.json')",
          '"require(\\\'not-a-real-package\\\')"',
          "/* import('also-not-real') */",
        ].join(';'),
        peers: { ai: '>=6 <7', openai: '>=4' },
        extra: { 'helper.cjs': 'module.exports=true' },
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('root: files=3');
  });

  it('accepts no-substitution template literals as finite loader targets', () => {
    const result = run(
      fixture({
        cjs: 'require(`openai`)',
        esm: 'import(`openai/version`)',
      }),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["require('#missing')", 'undeclared private import #missing'],
    ["require('not-declared')", 'undeclared external not-declared'],
    ["require('./missing.cjs')", 'missing relative runtime edge'],
  ])('rejects an unaccounted emitted edge: %s', (cjs, message) => {
    const result = run(fixture({ cjs }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('rejects a declared runtime dependency left outside the emitted closure', () => {
    const result = run(fixture({ cjs: "require('valibot')", dependencies: { valibot: '^1' } }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('leaves declared runtime dependency valibot outside');
  });

  it.each([
    ["const target='openai';require(target)", 'nonliteral load target'],
    ["const target='openai';import(target)", 'nonliteral dynamic import target'],
    ["const target='version';import(`openai/${target}`)", 'nonliteral dynamic import target'],
    [
      "const{createRequire}=require('node:module');const target='openai';createRequire(__filename)(target)",
      'nonliteral load target',
    ],
    [
      "const{createRequire}=require('node:module');const target='openai';const load=createRequire(__filename);load(target)",
      'nonliteral load target',
    ],
    [
      "const{createRequire}=require('node:module');const target='openai';const load=createRequire(__filename);load.resolve(target)",
      'nonliteral resolve target',
    ],
    [
      "const{createRequire}=require('node:module');const target='openai';const load=createRequire(__filename);const alias=load;alias(target)",
      'nonliteral load target',
    ],
  ])('rejects a nonliteral emitted loader edge: %s', (cjs, message) => {
    const result = run(fixture({ cjs }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["module.require('openai')", 'property-based require'],
    ["globalThis['require']('openai')", 'property-based require'],
    ["Module._load('openai')", 'runtime loader _load'],
    ["process.getBuiltinModule('fs')", 'runtime loader getBuiltinModule'],
    ["require.call(null,'openai')", 'loader through .call'],
    ["require.apply(null,['openai'])", 'loader through .apply'],
    ["require.extensions['.js']", 'accesses loader .extensions'],
    ['eval("require(\'openai\')")', 'runtime code generation'],
    ['Function("return require(\'openai\')")()', 'runtime code generation'],
    [
      "require('node:vm').runInThisContext(\"require('openai')\")",
      'unsupported VM loader runInThisContext',
    ],
  ])('rejects an indirect runtime-loader bypass: %s', (cjs, message) => {
    const result = run(fixture({ cjs }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["require('./asset.json')", 'missing relative runtime edge'],
    ["import('./asset.wasm')", 'missing relative runtime edge'],
    [
      "require('node:fs').readFileSync('./asset.json','utf8')",
      'unaccounted runtime asset reader readFileSync',
    ],
    [
      "const read=require('node:fs').readFileSync;read('./asset.json','utf8')",
      'unaccounted runtime asset reader read',
    ],
    ["new URL('./worker.js',import.meta.url)", 'unaccounted runtime asset ./worker.js'],
    ["new Worker('./worker.js')", 'unaccounted runtime worker asset'],
    ['WebAssembly.instantiate(bytes)', 'unsupported WebAssembly loader instantiate'],
    ["process.dlopen(module,'addon.node')", 'unaccounted native runtime asset'],
  ])('rejects an unaccounted runtime asset edge: %s', (cjs, message) => {
    const result = run(fixture({ cjs }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('allows the exact reviewed AI peer-manifest attestation edge', () => {
    const result = run(
      fixture({
        cjs: [
          "const{readFileSync}=require('node:fs')",
          "const{createRequire}=require('node:module')",
          'const load=createRequire(__filename)',
          "JSON.parse(readFileSync(load.resolve('ai/package.json'),'utf8'))",
        ].join(';'),
        peers: { ai: '>=6 <7', openai: '>=4' },
      }),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('allows only a read-only direct-provider cache attestation', () => {
    const prefix = [
      "const{createRequire}=require('node:module')",
      'const load=createRequire(__filename)',
      "const resolved=load.resolve('openai')",
      "const loaded=load('openai')",
    ].join(';');
    const valid = run(
      fixture({
        cjsFilename: 'openai.cjs',
        cjs: `${prefix};const cached=load.cache[resolved]`,
      }),
    );
    expect(valid.status, valid.stderr).toBe(0);

    for (const mutation of [
      'load.cache[resolved]=loaded',
      'delete load.cache[resolved]',
      'load.cache[resolved]++',
      'Object.assign(load.cache[resolved],{exports:loaded})',
    ]) {
      const result = run(fixture({ cjsFilename: 'openai.cjs', cjs: `${prefix};${mutation}` }));
      expect(result.status, mutation).not.toBe(0);
      expect(result.stderr).toContain('accesses loader .cache');
    }
  });

  it.each([
    [
      "const{readFileSync}=require('node:fs');const{createRequire}=require('node:module');const load=createRequire(__filename);readFileSync(load.resolve('openai/package.json'),'utf8')",
      { ai: '>=6 <7', openai: '>=4' },
    ],
    [
      "const{readFileSync}=require('node:fs');const{createRequire}=require('node:module');const load=createRequire(__filename);readFileSync(load.resolve('ai/package.json'),'buffer')",
      { ai: '>=6 <7', openai: '>=4' },
    ],
    [
      "const fakeFs={readFileSync(){return ''}};const{createRequire}=require('node:module');const load=createRequire(__filename);fakeFs.readFileSync(load.resolve('ai/package.json'),'utf8')",
      { ai: '>=6 <7', openai: '>=4' },
    ],
  ])('rejects a broadened peer-manifest read: %s', (cjs, peers) => {
    const result = run(fixture({ cjs, peers }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unaccounted runtime asset reader readFileSync');
  });

  it('rejects createRequire lookalikes without node:module provenance', () => {
    const result = run(
      fixture({
        cjs: "const fake={createRequire:()=>require};const load=fake.createRequire(__filename);load('openai')",
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('createRequire from an untrusted source');
  });

  it('ignores source-map-shaped text inside JavaScript literals', () => {
    const result = run(
      fixture({
        cjs: "const text='//# sourceMappingURL=wrong.map';module.exports=text",
      }),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['module.exports=true', 'exactly one terminal source-map reference'],
    [
      'module.exports=true\n//# sourceMappingURL=wrong.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true\n//# sourceMappingURL=entry.cjs.map\n//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true;//# sourceMappingURL=entry.cjs.map\n//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true;//# sourceMappingURL=wrong.map\n//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true;//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true;/*# sourceMappingURL=entry.cjs.map */\n//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      'module.exports=true;// sourceMappingURL=entry.cjs.map\n//# sourceMappingURL=entry.cjs.map\n',
      'exactly one terminal source-map reference',
    ],
    [
      '//# sourceMappingURL=entry.cjs.map\nmodule.exports=true\n',
      'exactly one terminal source-map reference',
    ],
  ])('rejects a malformed emitted source-map reference', (cjsRaw, message) => {
    const result = run(fixture({ cjsRaw }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
