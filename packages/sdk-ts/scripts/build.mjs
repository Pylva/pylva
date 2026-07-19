import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import ts from 'typescript';

const executable = process.platform === 'win32' ? 'tsup.cmd' : 'tsup';
const expectedTerserVersion = '5.49.0';
const terserCompressOptions = {
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
};
const terserMangleOptions = {
  eval: false,
  keep_classnames: true,
  keep_fnames: false,
  properties: false,
  safari10: false,
};
const terserFormatOptions = {
  ascii_only: true,
  comments: false,
  ecma: 2020,
  shebang: true,
};
const phases = [
  'tsup.config.ts',
  'tsup.canonical.config.ts',
  'tsup.providers.config.ts',
  'tsup.root.config.ts',
  'tsup.bridges.config.ts',
];

function assertTerserVersion() {
  const manifest = JSON.parse(
    readFileSync(new URL(import.meta.resolve('terser/package.json')), 'utf8'),
  );
  if (manifest.version !== expectedTerserVersion) {
    throw new Error(
      `[pylva-build] expected terser ${expectedTerserVersion}, received ${String(manifest.version)}`,
    );
  }
}

assertTerserVersion();

for (const config of phases) {
  const result = spawnSync(executable, ['--config', config], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const publicCjsEntries = new Set([
  'index.cjs',
  'openai.cjs',
  'anthropic.cjs',
  'vercel-ai.cjs',
  'langgraph.cjs',
]);

const freezeExports =
  'if(typeof module!=="undefined"){const e=Object.freeze(module.exports);Object.defineProperty(module,"exports",{value:e,writable:false,configurable:false})}';
const lockCompletedCache =
  'if(typeof module!=="undefined"){const c=require.cache;if(c){const p=__dirname+__filename.slice(__dirname.length,__dirname.length+1);for(const k of Object.keys(c)){if(k!==__filename&&k.startsWith(p)&&k.endsWith(".cjs")&&c[k]?.loaded===true){const d=Object.getOwnPropertyDescriptor(c,k);if(d?.configurable!==false)Object.defineProperty(c,k,{value:c[k],writable:false,configurable:false,enumerable:true})}}const d=Object.getOwnPropertyDescriptor(c,__filename);if(c[__filename]===module&&d?.configurable!==false)Object.defineProperty(c,__filename,{value:module,writable:false,configurable:false,enumerable:true})}}';

function runtimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeFiles(path);
    return entry.isFile() && /\.(?:cjs|js)$/u.test(entry.name) ? [path] : [];
  });
}

function sourceMapDirectives(source) {
  const file = ts.createSourceFile(
    'runtime.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const comments = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) comments.set(`${range.pos}:${range.end}`, range);
  };
  const visit = (node) => {
    for (const position of [node.pos, node.end, node.getFullStart(), node.getStart(file, false)]) {
      collect(ts.getLeadingCommentRanges(source, position));
      collect(ts.getTrailingCommentRanges(source, position));
    }
    ts.forEachChild(node, visit);
  };
  collect(ts.getLeadingCommentRanges(source, 0));
  collect(ts.getTrailingCommentRanges(source, source.length));
  visit(file);

  const directives = [];
  for (const range of comments.values()) {
    const comment = source.slice(range.pos, range.end);
    if (!comment.includes('sourceMappingURL')) continue;
    const match = /^\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+?)\s*$/u.exec(comment);
    directives.push({
      start: range.pos,
      end: range.end,
      reference: match?.[1] ?? null,
    });
  }
  return directives;
}

function normalizeSourceMapReferences(source, sourceMapName, relativePath) {
  const directives = sourceMapDirectives(source);
  if (
    directives.length === 0 ||
    directives.some((directive) => directive.reference !== sourceMapName)
  ) {
    throw new Error(`[pylva-build] invalid source map reference in ${relativePath}`);
  }

  let code = source;
  for (const directive of [...directives].sort((left, right) => right.start - left.start)) {
    code = `${code.slice(0, directive.start)}${code.slice(directive.end)}`;
  }
  return code.trimEnd();
}

function isPathSafeSourceMapLocation(value, allowEmpty = false) {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.startsWith('file:') &&
    !value.includes('\0')
  );
}

function assertPathSafeSourceMap(sourceMap, relativePath) {
  if (typeof sourceMap !== 'object' || sourceMap === null || Array.isArray(sourceMap)) {
    throw new Error(`[pylva-build] invalid source map object for ${relativePath}`);
  }
  if (sourceMap.version !== 3) {
    throw new Error(`[pylva-build] invalid source map version for ${relativePath}`);
  }
  if (
    sourceMap.file !== undefined &&
    (sourceMap.file !== basename(relativePath) || !isPathSafeSourceMapLocation(sourceMap.file))
  ) {
    throw new Error(`[pylva-build] unsafe source map file for ${relativePath}`);
  }
  if (
    sourceMap.sourceRoot !== undefined &&
    !isPathSafeSourceMapLocation(sourceMap.sourceRoot, true)
  ) {
    throw new Error(`[pylva-build] unsafe source map root for ${relativePath}`);
  }
  if (
    !Array.isArray(sourceMap.sources) ||
    sourceMap.sources.length === 0 ||
    sourceMap.sources.some((source) => !isPathSafeSourceMapLocation(source))
  ) {
    throw new Error(`[pylva-build] unsafe source map sources for ${relativePath}`);
  }
  if (
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sourcesContent.length !== sourceMap.sources.length ||
    sourceMap.sourcesContent.some((source) => typeof source !== 'string')
  ) {
    throw new Error(`[pylva-build] missing embedded source map content for ${relativePath}`);
  }
  if (typeof sourceMap.mappings !== 'string' || sourceMap.mappings.length === 0) {
    throw new Error(`[pylva-build] unusable source map mappings for ${relativePath}`);
  }
}

function preserveJsonImportAttributes(source, relativePath) {
  if (relativePath !== 'vercel-ai.cjs') return source;

  const legacy = /assert:\{type:(["'])json\1\}/g;
  const modern = /with\s*:\{type:(["'])json\1\}/g;
  const candidate = /(?:assert|with)\s*:\s*\{[^{}]*\btype\s*:\s*(["'])json\1[^{}]*\}/g;
  const legacyCount = [...source.matchAll(legacy)].length;
  const modernCount = [...source.matchAll(modern)].length;
  const candidateCount = [...source.matchAll(candidate)].length;
  if (candidateCount === 0) return source;
  if (legacyCount === 0 && modernCount === 1 && candidateCount === 1) return source;
  if (legacyCount !== 1 || modernCount !== 0 || candidateCount !== 1) {
    throw new Error(
      `[pylva-build] expected zero or exactly one valid JSON import attribute in ${relativePath}`,
    );
  }

  // tsup currently lowers `with` to Node's removed `assert` spelling for CJS.
  // The two spaces retain the generated column offsets and therefore keep the
  // existing source map accurate while restoring Node 20/22/24 compatibility.
  return source.replace(legacy, (attribute) => `with  ${attribute.slice('assert'.length)}`);
}

async function minifyAndHardenRuntime(path) {
  const relativePath = relative(distDirectory, path).replaceAll('\\', '/');
  const sourceMapName = `${basename(path)}.map`;
  const sourceMapPath = `${path}.map`;
  const source = readFileSync(path, 'utf8');
  const normalized = normalizeSourceMapReferences(source, sourceMapName, relativePath);
  const isCjs = relativePath.endsWith('.cjs');
  const originalSourceMap = JSON.parse(readFileSync(sourceMapPath, 'utf8'));
  assertPathSafeSourceMap(originalSourceMap, relativePath);
  const result = await minify(
    { [basename(path)]: normalized },
    {
      ecma: 2020,
      keep_classnames: true,
      keep_fnames: false,
      ...(isCjs ? { toplevel: true } : { module: true }),
      compress: terserCompressOptions,
      mangle: terserMangleOptions,
      format: terserFormatOptions,
      sourceMap: {
        content: originalSourceMap,
        asObject: true,
        filename: basename(path),
        includeSources: true,
      },
    },
  );
  if (typeof result.code !== 'string' || result.code.length === 0) {
    throw new Error(`[pylva-build] terser emitted no runtime code for ${relativePath}`);
  }
  if (typeof result.map !== 'object' || result.map === null || Array.isArray(result.map)) {
    throw new Error(`[pylva-build] terser emitted no source map for ${relativePath}`);
  }
  const sourceShebang = normalized.startsWith('#!') ? normalized.split(/\r?\n/u, 1)[0] : null;
  const outputShebang = result.code.startsWith('#!') ? result.code.split(/\r?\n/u, 1)[0] : null;
  if (outputShebang !== sourceShebang) {
    throw new Error(`[pylva-build] terser changed the shebang for ${relativePath}`);
  }

  const sourceMap = result.map;
  assertPathSafeSourceMap(sourceMap, relativePath);
  const code = isCjs ? preserveJsonImportAttributes(result.code, relativePath) : result.code;
  let output = code;
  if (isCjs) {
    const hardening = publicCjsEntries.has(relativePath)
      ? `${freezeExports};${lockCompletedCache}`
      : freezeExports;
    // The generated program keeps all existing lines, then adds one deliberately
    // unmapped hardening line. Preserve every original mapping and append exactly
    // one empty generated line before restoring a single final map reference.
    sourceMap.mappings += ';';
    output = `${code}\n${hardening}`;
  }
  assertPathSafeSourceMap(sourceMap, relativePath);
  writeFileSync(sourceMapPath, JSON.stringify(sourceMap));
  writeFileSync(path, `${output}\n//# sourceMappingURL=${sourceMapName}\n`);
}

for (const path of runtimeFiles(distDirectory).sort()) await minifyAndHardenRuntime(path);
