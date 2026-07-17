import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

const packageDir = process.cwd();
const distDir = path.join(packageDir, 'dist');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');

const caps = new Map([
  // D088 fixes these constants from the hardened immutable-candidate
  // baselines. Never derive a cap from the artifact currently under test.
  ['.', 49_700],
  ['./openai', 25_900],
  ['./anthropic', 25_900],
  ['./vercel-ai', 21_000],
  ['./langgraph', 15_700],
]);
const labels = new Map([
  ['.', 'root'],
  ['./openai', 'openai'],
  ['./anthropic', 'anthropic'],
  ['./vercel-ai', 'vercel-ai'],
  ['./langgraph', 'langgraph'],
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
const declaredRuntimeDependencies = new Set(Object.keys(manifest.dependencies ?? {}));

function fail(message) {
  throw new Error(`[pylva-size] ${message}`);
}

function targetFor(subpath, branch) {
  const target = manifest.exports?.[subpath]?.[branch]?.default;
  if (typeof target !== 'string' || !target.startsWith('./dist/')) {
    fail(`missing exports.${subpath}.${branch}.default`);
  }
  return target.slice('./dist/'.length);
}

const publicCjsTargets = new Set([...caps.keys()].map((subpath) => targetFor(subpath, 'require')));
// Must stay byte-for-byte equal to build.mjs's lockCompletedCache. A static
// test binds the two constants so this exception cannot drift silently.
const reviewedCompletedCacheHardening =
  'if(typeof module!=="undefined"){const c=require.cache;if(c){const p=__dirname+__filename.slice(__dirname.length,__dirname.length+1);for(const k of Object.keys(c)){if(k!==__filename&&k.startsWith(p)&&k.endsWith(".cjs")&&c[k]?.loaded===true){const d=Object.getOwnPropertyDescriptor(c,k);if(d?.configurable!==false)Object.defineProperty(c,k,{value:c[k],writable:false,configurable:false,enumerable:true})}}const d=Object.getOwnPropertyDescriptor(c,__filename);if(c[__filename]===module&&d?.configurable!==false)Object.defineProperty(c,__filename,{value:module,writable:false,configurable:false,enumerable:true})}}';

const privateTargets = new Map();
for (const [specifier, target] of Object.entries(manifest.imports ?? {})) {
  if (typeof target !== 'string' || !target.startsWith('./dist/')) {
    fail(`private import ${specifier} must target ./dist`);
  }
  privateTargets.set(specifier, target.slice('./dist/'.length));
}

function source(relative) {
  try {
    return readFileSync(path.join(distDir, relative));
  } catch {
    fail(`missing emitted file dist/${relative}`);
  }
}

const analysisCache = new Map();
const assetReaderNames = new Set([
  'createReadStream',
  'open',
  'openSync',
  'readFile',
  'readFileSync',
]);
const vmLoaderNames = new Set([
  'compileFunction',
  'runInContext',
  'runInNewContext',
  'runInThisContext',
  'Script',
  'SourceTextModule',
  'SyntheticModule',
]);
const webAssemblyLoaderNames = new Set([
  'compile',
  'compileStreaming',
  'instantiate',
  'instantiateStreaming',
  'Module',
]);

function unwrapExpression(expression) {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isPartiallyEmittedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

function propertyName(expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current)) {
    const argument = unwrapExpression(current.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return undefined;
}

function literalText(expression) {
  if (expression === undefined) return undefined;
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  return undefined;
}

function objectBindingPropertyName(element) {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
}

function containsImportMetaUrl(node) {
  let found = false;
  const visit = (current) => {
    if (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === 'url' &&
      ts.isMetaProperty(unwrapExpression(current.expression)) &&
      unwrapExpression(current.expression).keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function emittedAnalysis(relative) {
  const cached = analysisCache.get(relative);
  if (cached !== undefined) return cached;

  const text = source(relative).toString('utf8');
  const compilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(compilerOptions);
  host.fileExists = (filename) => filename === relative;
  host.readFile = (filename) => (filename === relative ? text : undefined);
  host.getSourceFile = (filename, languageVersion) =>
    filename === relative
      ? ts.createSourceFile(filename, text, languageVersion, true, ts.ScriptKind.JS)
      : undefined;
  const program = ts.createProgram([relative], compilerOptions, host);
  const file = program.getSourceFile(relative);
  if (file === undefined) fail(`cannot bind emitted file dist/${relative}`);
  const checker = program.getTypeChecker();
  const specifiers = new Set();
  const violations = new Set();
  const factoryAliases = new Set();
  const loaderAliases = new Set();
  const assetReaderAliases = new Set();
  const readFileSyncAliases = new Set();
  const moduleNamespaceAliases = new Set();
  const fsNamespaceAliases = new Set();
  const nodes = [];

  const symbolAt = (identifier) => checker.getSymbolAtLocation(identifier);
  const hasAlias = (aliases, identifier) => {
    const symbol = symbolAt(identifier);
    return symbol !== undefined && aliases.has(symbol);
  };
  const addAlias = (aliases, identifier) => {
    const symbol = symbolAt(identifier);
    if (symbol === undefined || aliases.has(symbol)) return false;
    aliases.add(symbol);
    return true;
  };
  const isUnboundNamedIdentifier = (expression, name) => {
    const current = unwrapExpression(expression);
    if (!ts.isIdentifier(current) || current.text !== name) return false;
    const symbol = symbolAt(current);
    return symbol === undefined || (symbol.declarations?.length ?? 0) === 0;
  };
  const isBuiltinRequireCall = (expression, names) => {
    const current = unwrapExpression(expression);
    return (
      ts.isCallExpression(current) &&
      isUnboundNamedIdentifier(current.expression, 'require') &&
      current.arguments.length === 1 &&
      names.has(literalText(current.arguments[0]))
    );
  };
  const moduleSpecifiers = new Set(['module', 'node:module']);
  const fsSpecifiers = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);
  const isNamespaceReference = (expression, aliases, specifiers) => {
    const current = unwrapExpression(expression);
    return (
      (ts.isIdentifier(current) && hasAlias(aliases, current)) ||
      isBuiltinRequireCall(current, specifiers)
    );
  };

  const location = (node) => {
    const start = file.getLineAndCharacterOfPosition(node.getStart(file, false));
    return `dist/${relative}:${start.line + 1}:${start.character + 1}`;
  };
  const reject = (node, message) => violations.add(`${message} at ${location(node)}`);
  const collect = (node) => {
    nodes.push(node);
    ts.forEachChild(node, collect);
  };
  collect(file);

  for (const diagnostic of file.parseDiagnostics) {
    const start = diagnostic.start ?? 0;
    const point = file.getLineAndCharacterOfPosition(start);
    violations.add(
      `cannot parse emitted JavaScript at dist/${relative}:${point.line + 1}:${point.character + 1}`,
    );
  }

  for (const node of nodes) {
    if (!ts.isImportDeclaration(node)) continue;
    const imported = literalText(node.moduleSpecifier);
    if (imported === undefined) continue;
    const defaultBinding = node.importClause?.name;
    if (defaultBinding !== undefined) {
      if (moduleSpecifiers.has(imported)) addAlias(moduleNamespaceAliases, defaultBinding);
      if (fsSpecifiers.has(imported)) addAlias(fsNamespaceAliases, defaultBinding);
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      if (moduleSpecifiers.has(imported)) addAlias(moduleNamespaceAliases, bindings.name);
      if (fsSpecifiers.has(imported)) addAlias(fsNamespaceAliases, bindings.name);
      continue;
    }
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (moduleSpecifiers.has(imported)) {
        if (importedName === 'createRequire') addAlias(factoryAliases, element.name);
      }
      if (fsSpecifiers.has(imported)) {
        if (assetReaderNames.has(importedName)) addAlias(assetReaderAliases, element.name);
        if (importedName === 'readFileSync') addAlias(readFileSyncAliases, element.name);
      }
    }
  }

  const isFactoryReference = (expression) => {
    const current = unwrapExpression(expression);
    return (
      (ts.isIdentifier(current) && hasAlias(factoryAliases, current)) ||
      ((ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
        propertyName(current) === 'createRequire' &&
        isNamespaceReference(current.expression, moduleNamespaceAliases, moduleSpecifiers))
    );
  };
  const isCreateRequireCall = (expression) => {
    const current = unwrapExpression(expression);
    return ts.isCallExpression(current) && isFactoryReference(current.expression);
  };
  const isLoaderExpression = (expression) => {
    const current = unwrapExpression(expression);
    return (
      (ts.isIdentifier(current) &&
        (hasAlias(loaderAliases, current) || isUnboundNamedIdentifier(current, 'require'))) ||
      isCreateRequireCall(current)
    );
  };
  const isAssetReaderReference = (expression) => {
    const current = unwrapExpression(expression);
    return (
      (ts.isIdentifier(current) &&
        (hasAlias(assetReaderAliases, current) ||
          [...assetReaderNames].some((name) => isUnboundNamedIdentifier(current, name)))) ||
      assetReaderNames.has(propertyName(current))
    );
  };
  const isReadFileSyncReference = (expression) => {
    const current = unwrapExpression(expression);
    return (
      (ts.isIdentifier(current) && hasAlias(readFileSyncAliases, current)) ||
      ((ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
        propertyName(current) === 'readFileSync' &&
        isNamespaceReference(current.expression, fsNamespaceAliases, fsSpecifiers))
    );
  };

  const addBindingAliases = (name, initializer) => {
    if (!ts.isObjectBindingPattern(name)) return false;
    let changed = false;
    const moduleSource =
      initializer !== undefined &&
      isNamespaceReference(initializer, moduleNamespaceAliases, moduleSpecifiers);
    const fsSource =
      initializer !== undefined &&
      isNamespaceReference(initializer, fsNamespaceAliases, fsSpecifiers);
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const sourceName = objectBindingPropertyName(element);
      if (moduleSource && sourceName === 'createRequire' && addAlias(factoryAliases, element.name))
        changed = true;
      if (sourceName !== undefined && assetReaderNames.has(sourceName)) {
        if (addAlias(assetReaderAliases, element.name)) changed = true;
        if (
          fsSource &&
          sourceName === 'readFileSync' &&
          addAlias(readFileSyncAliases, element.name)
        )
          changed = true;
      }
    }
    return changed;
  };

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const node of nodes) {
      let binding;
      let initializer;
      if (ts.isVariableDeclaration(node)) {
        if (addBindingAliases(node.name, node.initializer)) aliasesChanged = true;
        if (ts.isIdentifier(node.name)) binding = node.name;
        initializer = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        binding = node.left;
        initializer = node.right;
      }
      if (binding === undefined || initializer === undefined) continue;
      const current = unwrapExpression(initializer);
      if (
        isNamespaceReference(current, moduleNamespaceAliases, moduleSpecifiers) &&
        addAlias(moduleNamespaceAliases, binding)
      )
        aliasesChanged = true;
      if (
        isNamespaceReference(current, fsNamespaceAliases, fsSpecifiers) &&
        addAlias(fsNamespaceAliases, binding)
      )
        aliasesChanged = true;
      if (isFactoryReference(current) && addAlias(factoryAliases, binding)) aliasesChanged = true;
      if (
        (isCreateRequireCall(current) || isLoaderExpression(current)) &&
        addAlias(loaderAliases, binding)
      )
        aliasesChanged = true;
      if (isAssetReaderReference(current) && addAlias(assetReaderAliases, binding))
        aliasesChanged = true;
      if (isReadFileSyncReference(current) && addAlias(readFileSyncAliases, binding))
        aliasesChanged = true;
    }
  }

  const loaderCall = (expression) => {
    const current = unwrapExpression(expression);
    if (isLoaderExpression(current)) return 'load';
    if (
      (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
      propertyName(current) === 'resolve' &&
      isLoaderExpression(current.expression)
    ) {
      return 'resolve';
    }
    return undefined;
  };
  const loaderAliasSymbol = (expression) => {
    const current = unwrapExpression(expression);
    return ts.isIdentifier(current) && hasAlias(loaderAliases, current)
      ? symbolAt(current)
      : undefined;
  };
  const providerCachePeer = new Map([
    ['openai.cjs', 'openai'],
    ['anthropic.cjs', '@anthropic-ai/sdk'],
  ]).get(relative);
  const providerCacheEvidence = new Map();
  if (providerCachePeer !== undefined) {
    for (const node of nodes) {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.initializer === undefined
      )
        continue;
      const initializer = unwrapExpression(node.initializer);
      if (!ts.isCallExpression(initializer)) continue;
      const kind = loaderCall(initializer.expression);
      const callee = unwrapExpression(initializer.expression);
      const loader =
        kind === 'load'
          ? loaderAliasSymbol(callee)
          : kind === 'resolve' &&
              (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
            ? loaderAliasSymbol(callee.expression)
            : undefined;
      if (loader === undefined || literalText(initializer.arguments[0]) !== providerCachePeer)
        continue;
      const evidence = providerCacheEvidence.get(loader) ?? {
        loaded: false,
        resolvedPathSymbols: new Set(),
      };
      if (kind === 'load') evidence.loaded = true;
      if (kind === 'resolve') {
        const pathSymbol = symbolAt(node.name);
        if (pathSymbol !== undefined) evidence.resolvedPathSymbols.add(pathSymbol);
      }
      providerCacheEvidence.set(loader, evidence);
    }
  }
  const isReviewedProviderCacheAccess = (node) => {
    if (
      providerCachePeer === undefined ||
      propertyName(node) !== 'cache' ||
      !ts.isElementAccessExpression(node.parent) ||
      node.parent.expression !== node ||
      !ts.isVariableDeclaration(node.parent.parent) ||
      node.parent.parent.initializer !== node.parent ||
      !ts.isIdentifier(node.parent.parent.name)
    )
      return false;
    const loader = loaderAliasSymbol(node.expression);
    const index = unwrapExpression(node.parent.argumentExpression);
    if (loader === undefined || !ts.isIdentifier(index)) return false;
    const indexSymbol = symbolAt(index);
    const evidence = providerCacheEvidence.get(loader);
    return (
      indexSymbol !== undefined &&
      evidence?.loaded === true &&
      evidence.resolvedPathSymbols.has(indexSymbol)
    );
  };
  const hardeningSuffix = `;${reviewedCompletedCacheHardening}\n//# sourceMappingURL=${path.posix.basename(relative)}.map\n`;
  const hardeningStart =
    publicCjsTargets.has(relative) && text.endsWith(hardeningSuffix)
      ? text.length - hardeningSuffix.length + 1
      : -1;
  const hardeningEnd =
    hardeningStart < 0 ? -1 : hardeningStart + reviewedCompletedCacheHardening.length;
  const isReviewedBuildCacheAccess = (node) =>
    hardeningStart >= 0 &&
    node.getStart(file, false) >= hardeningStart &&
    node.end <= hardeningEnd &&
    propertyName(node) === 'cache' &&
    isUnboundNamedIdentifier(node.expression, 'require');
  const isReviewedAiManifestResolution = (expression) => {
    const current = unwrapExpression(expression);
    return (
      ts.isCallExpression(current) &&
      loaderCall(current.expression) === 'resolve' &&
      current.arguments.length >= 1 &&
      literalText(current.arguments[0]) === 'ai/package.json'
    );
  };
  const isReviewedAiManifestRead = (call) =>
    peers.has('ai') &&
    isReadFileSyncReference(call.expression) &&
    call.arguments.length === 2 &&
    isReviewedAiManifestResolution(call.arguments[0]) &&
    literalText(call.arguments[1]) === 'utf8';

  for (const node of nodes) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.add(specifier);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) => objectBindingPropertyName(element) === 'createRequire',
      ) &&
      (node.initializer === undefined ||
        !isNamespaceReference(node.initializer, moduleNamespaceAliases, moduleSpecifiers))
    ) {
      reject(node, 'destructures createRequire from an untrusted source');
    }

    if (ts.isNewExpression(node)) {
      const name = propertyName(node.expression);
      if (name === 'Function') reject(node, 'uses runtime code generation');
      if (name === 'Worker' || name === 'SharedWorker') {
        reject(node, 'uses an unaccounted runtime worker asset');
      }
      if (vmLoaderNames.has(name)) reject(node, 'uses an unsupported VM loader');
      if (name === 'URL' && node.arguments?.[0] !== undefined) {
        const target = literalText(node.arguments[0]);
        if (
          target !== undefined &&
          (target.startsWith('./') || target.startsWith('../')) &&
          node.arguments[1] !== undefined &&
          containsImportMetaUrl(node.arguments[1])
        ) {
          reject(node, `uses an unaccounted runtime asset ${target}`);
        }
      }
    }

    if (!ts.isCallExpression(node)) continue;
    const callee = unwrapExpression(node.expression);
    const name = propertyName(callee);

    if (name === 'createRequire' && !isFactoryReference(callee)) {
      reject(node, 'uses createRequire from an untrusted source');
    }

    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === undefined) reject(node, 'uses a nonliteral dynamic import target');
      else specifiers.add(specifier);
      if (node.arguments.length < 1 || node.arguments.length > 2) {
        reject(node, 'uses a dynamic import with an unsupported argument shape');
      }
      continue;
    }

    const loadKind = loaderCall(callee);
    if (loadKind !== undefined) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === undefined) reject(node, `uses a nonliteral ${loadKind} target`);
      else specifiers.add(specifier);
      const allowedArguments = loadKind === 'resolve' ? [1, 2] : [1];
      if (!allowedArguments.includes(node.arguments.length)) {
        reject(node, `uses ${loadKind} with an unsupported argument shape`);
      }
    }

    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      ['apply', 'bind', 'call'].includes(name) &&
      isLoaderExpression(callee.expression)
    ) {
      reject(node, `invokes a loader through .${name}`);
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      name === 'require'
    ) {
      reject(node, 'uses unsupported property-based require');
    }
    if (name === '_load' || name === 'getBuiltinModule' || name === 'importScripts') {
      reject(node, `uses unsupported runtime loader ${name}`);
    }
    if (name === 'eval' || name === 'Function') reject(node, 'uses runtime code generation');
    if (vmLoaderNames.has(name)) reject(node, `uses unsupported VM loader ${name}`);
    if (name === 'dlopen') reject(node, 'uses an unaccounted native runtime asset');
    if (
      webAssemblyLoaderNames.has(name) &&
      ts.isPropertyAccessExpression(callee) &&
      propertyName(callee.expression) === 'WebAssembly'
    ) {
      reject(node, `uses unsupported WebAssembly loader ${name}`);
    }
    if (isAssetReaderReference(callee) && !isReviewedAiManifestRead(node)) {
      reject(node, `uses an unaccounted runtime asset reader ${name ?? '<alias>'}`);
    }
  }

  for (const node of nodes) {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) continue;
    const name = propertyName(node);
    if (['cache', 'extensions'].includes(name) && isLoaderExpression(node.expression)) {
      if (
        name === 'cache' &&
        (isReviewedProviderCacheAccess(node) || isReviewedBuildCacheAccess(node))
      )
        continue;
      reject(node, `accesses loader .${name}`);
    }
  }

  const result = { specifiers: [...specifiers], violations: [...violations] };
  analysisCache.set(relative, result);
  return result;
}

const runtimeFiles = readdirSync(distDir, { recursive: true })
  .map(String)
  .filter((file) => /\.(?:cjs|js)$/u.test(file))
  .sort();
const runtimeFileSet = new Set(runtimeFiles);

function resolveRelativeTarget(importer, specifier) {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (unresolved === '..' || unresolved.startsWith('../') || path.posix.isAbsolute(unresolved)) {
    fail(`dist/${importer} has relative edge outside dist: ${specifier}`);
  }
  const extension = path.posix.extname(unresolved);
  const candidates = extension
    ? [unresolved]
    : [
        unresolved,
        `${unresolved}.cjs`,
        `${unresolved}.js`,
        `${unresolved}/index.cjs`,
        `${unresolved}/index.js`,
      ];
  const target = candidates.find((candidate) => runtimeFileSet.has(candidate));
  if (target === undefined)
    fail(`dist/${importer} has missing relative runtime edge: ${specifier}`);
  return target;
}

function internalDependencies(relative, label, failures) {
  const dependencies = [];
  const analysis = emittedAnalysis(relative);
  for (const violation of analysis.violations) failures.add(`${label} ${violation}`);
  for (const specifier of analysis.specifiers) {
    if (specifier.startsWith('#')) {
      const target = privateTargets.get(specifier);
      if (target === undefined) {
        failures.add(
          `${label} reaches undeclared private import ${specifier} from dist/${relative}`,
        );
      } else {
        dependencies.push(target);
      }
      continue;
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      dependencies.push(resolveRelativeTarget(relative, specifier));
      continue;
    }
    if (builtins.has(specifier)) continue;
    const name = packageName(specifier);
    if (peers.has(name)) continue;
    if (declaredRuntimeDependencies.has(name)) {
      failures.add(
        `${label} leaves declared runtime dependency ${specifier} outside its measured emitted closure`,
      );
      continue;
    }
    failures.add(`${label} reaches undeclared external ${specifier} from dist/${relative}`);
  }
  return [...new Set(dependencies)];
}

function dependencyFirstClosure(entry, bridge, label, failures) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (relative) => {
    if (visited.has(relative)) return;
    if (visiting.has(relative)) fail(`runtime dependency cycle reaches dist/${relative}`);
    visiting.add(relative);
    for (const dependency of internalDependencies(relative, label, failures)) visit(dependency);
    visiting.delete(relative);
    visited.add(relative);
    ordered.push(relative);
  };
  visit(entry);
  visit(bridge);
  return ordered;
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function sourceMapDirectives(runtime) {
  const file = ts.createSourceFile(
    'runtime.js',
    runtime,
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
      collect(ts.getLeadingCommentRanges(runtime, position));
      collect(ts.getTrailingCommentRanges(runtime, position));
    }
    ts.forEachChild(node, visit);
  };
  collect(ts.getLeadingCommentRanges(runtime, 0));
  collect(ts.getTrailingCommentRanges(runtime, runtime.length));
  visit(file);

  const directives = [];
  for (const range of comments.values()) {
    const comment = runtime.slice(range.pos, range.end);
    if (!comment.includes('sourceMappingURL')) continue;
    const match = /^\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+?)\s*$/u.exec(comment);
    directives.push(match?.[1] ?? null);
  }
  return directives;
}

function assertSourceMap(relative) {
  const runtime = source(relative).toString('utf8');
  const mapName = `${relative}.map`;
  const expectedReference = path.posix.basename(mapName);
  const directives = sourceMapDirectives(runtime);
  const escapedReference = expectedReference.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const terminalReference = new RegExp(
    `(?:^|\\r?\\n)//# sourceMappingURL=${escapedReference}\\r?\\n?$`,
    'u',
  );
  if (
    directives.length !== 1 ||
    directives[0] !== expectedReference ||
    !terminalReference.test(runtime)
  ) {
    fail(
      `dist/${relative} must contain exactly one terminal source-map reference to ${expectedReference}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source(mapName).toString('utf8'));
  } catch {
    fail(`dist/${mapName} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed.sources) ||
    parsed.sources.length === 0 ||
    typeof parsed.mappings !== 'string' ||
    parsed.mappings.length === 0
  ) {
    fail(`dist/${mapName} is not a usable source map`);
  }
}

for (const file of runtimeFiles) assertSourceMap(file);

if (verbose) {
  for (const file of runtimeFiles) {
    const bytes = source(file);
    console.log(
      `file dist/${file}: raw=${bytes.length} gzip9=${gzipSync(bytes, { level: 9 }).length}`,
    );
  }
}

const failures = new Set();
for (const [subpath, cap] of caps) {
  const label = labels.get(subpath);
  const cjs = targetFor(subpath, 'require');
  const esm = targetFor(subpath, 'import');
  const files = dependencyFirstClosure(cjs, esm, label, failures);
  const buffers = files.map(source);
  const raw = buffers.reduce((total, value) => total + value.length, 0);
  const sumGzip = buffers.reduce((total, value) => total + gzipSync(value, { level: 9 }).length, 0);
  const gzipOnce = gzipSync(Buffer.concat(buffers), { level: 9 }).length;
  const margin = cap - gzipOnce;
  console.log(
    `${label}: files=${files.length} raw=${raw} sum-gzip9=${sumGzip} gzip-once=${gzipOnce} cap=${cap} margin=${margin}`,
  );
  if (verbose) console.log(`  ${files.map((file) => `dist/${file}`).join(' -> ')}`);
  if (gzipOnce > cap) failures.add(`${label} exceeds its cap by ${-margin} bytes`);
}

if (failures.size > 0) fail([...failures].join('; '));
