#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const JWT_HELPERS = new Set(['refreshJwtIfNeeded', 'signJwt', 'verifyJwt']);
const JWT_INTERFACES = new Set(['JwtAuthContext', 'SignJwtOptions', 'VerifyJwtResult']);

function normalizeSnippet(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function sourceFiles(root) {
  const srcRoot = path.join(root, 'src');
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (/\.[cm]?[jt]sx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(absolute);
      }
    }
  }

  visit(srcRoot);
  return files.sort();
}

function importsJwtHelper(sourceFile) {
  if (sourceFile.fileName.replaceAll('\\', '/').endsWith('/src/lib/auth/jwt.ts')) return true;

  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(?:^|\/)(?:auth\/)?jwt(?:\.js)?$/u.test(statement.moduleSpecifier.text)
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) =>
        JWT_HELPERS.has(element.propertyName?.text ?? element.name.text),
      )
    );
  });
}

function isSignJwtCall(node) {
  if (!ts.isCallExpression(node)) return false;
  return (
    (ts.isIdentifier(node.expression) && node.expression.text === 'signJwt') ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'signJwt')
  );
}

function tierProperties(node) {
  const matches = [];
  function visit(current) {
    if (
      (ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      propertyName(current.name) === 'tier'
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return matches;
}

export function collectJwtTierClaimInventory(root = process.cwd()) {
  const inventory = [];

  for (const absolute of sourceFiles(root)) {
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    const source = fs.readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(
      absolute,
      source,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const jwtSurface = importsJwtHelper(sourceFile);

    function add(kind, node) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      inventory.push({
        kind,
        path: relative,
        line: line + 1,
        snippet: normalizeSnippet(node, sourceFile),
      });
    }

    function visit(node) {
      if (isSignJwtCall(node) && node.arguments[0]) {
        for (const property of tierProperties(node.arguments[0])) add('producer', property);
      }

      if (
        jwtSurface &&
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'tier' &&
        ts.isIdentifier(node.expression) &&
        ['context', 'options', 'payload'].includes(node.expression.text)
      ) {
        add('read', node);
      }

      if (ts.isInterfaceDeclaration(node) && JWT_INTERFACES.has(node.name.text)) {
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && propertyName(member.name) === 'tier') {
            add('schema', member);
          }
        }
      }

      if (
        relative === 'src/lib/auth/jwt.ts' &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'RESERVED_JWT_CLAIMS' &&
        node.initializer
      ) {
        const reservedTier = [];
        function findReserved(current) {
          if (ts.isStringLiteral(current) && current.text === 'tier') reservedTier.push(current);
          ts.forEachChild(current, findReserved);
        }
        findReserved(node.initializer);
        for (const literal of reservedTier) add('reserved', literal);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  inventory.sort((left, right) =>
    `${left.path}:${left.line}:${left.kind}:${left.snippet}`.localeCompare(
      `${right.path}:${right.line}:${right.kind}:${right.snippet}`,
    ),
  );

  const occurrences = new Map();
  return inventory.map((entry) => {
    const base = `${entry.kind}\0${entry.path}\0${entry.snippet}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { ...entry, occurrence };
  });
}

function stableEntry(entry) {
  return {
    kind: entry.kind,
    path: entry.path,
    snippet: entry.snippet,
    occurrence: entry.occurrence,
  };
}

function signature(entry) {
  return JSON.stringify(stableEntry(entry));
}

export function validateJwtTierClaimInventory(observed, expected, { requireZero = false } = {}) {
  const observedBySignature = new Map(observed.map((entry) => [signature(entry), entry]));
  const expectedBySignature = new Map(expected.map((entry) => [signature(entry), entry]));
  const unexpected = observed
    .filter((entry) => !expectedBySignature.has(signature(entry)))
    .map(stableEntry);
  const missing = expected
    .filter((entry) => !observedBySignature.has(signature(entry)))
    .map(stableEntry);
  const errors = [];

  if (unexpected.length > 0) errors.push(`unreviewed JWT tier-claim sites: ${unexpected.length}`);
  if (missing.length > 0) errors.push(`stale JWT tier-claim inventory sites: ${missing.length}`);
  if (requireZero && observed.length > 0) {
    errors.push(`JWT tier-claim compatibility surface is not zero: ${observed.length}`);
  }

  return { ok: errors.length === 0, errors, unexpected, missing };
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    manifest: 'scripts/jwt-tier-claim-inventory.json',
    requireZero: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--manifest') options.manifest = argv[++index];
    else if (arg === '--require-zero') options.requireZero = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(options.root, options.manifest);
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(expected)) throw new Error('JWT tier-claim manifest must be an array');

  const observed = collectJwtTierClaimInventory(options.root);
  const validation = validateJwtTierClaimInventory(observed, expected, {
    requireZero: options.requireZero,
  });
  const output = { observed, ...validation };

  if (options.json || !validation.ok) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(
      `JWT tier-claim inventory passed (${observed.length} reviewed compatibility sites).\n`,
    );
  }
  if (!validation.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
