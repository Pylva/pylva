// Shared AST check — every withRLS callback in the given source file must
// name its transaction parameter `tx` and never touch the global `db`.
//
// Usage:
//   import { assertWithRlsCallbacksUseTransactionOnly } from '../_helpers/rls-discipline.js';
//   assertWithRlsCallbacksUseTransactionOnly(
//     fileURLToPath(new URL('../../src/app/api/v1/example/route.ts', import.meta.url)),
//   );

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';

function readableSourcePath(sourcePath: string): string {
  if (sourcePath.startsWith('file:')) return fileURLToPath(sourcePath);
  try {
    return sourcePath.includes('%') ? decodeURIComponent(sourcePath) : sourcePath;
  } catch {
    return sourcePath;
  }
}

export function assertWithRlsCallbacksUseTransactionOnly(sourcePath: string): void {
  const normalizedPath = readableSourcePath(sourcePath);
  const source = readFileSync(normalizedPath, 'utf8');
  const file = ts.createSourceFile(normalizedPath, source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];

  function scanForGlobalDb(node: ts.Node): boolean {
    let found = false;
    function visit(child: ts.Node): void {
      if (
        ts.isPropertyAccessExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === 'db'
      ) {
        found = true;
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'withRLS'
    ) {
      const callback = node.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const firstParam = callback.parameters[0]?.name.getText(file);
        if (firstParam !== 'tx') {
          failures.push(`withRLS callback parameter is ${firstParam ?? '(missing)'}`);
        }
        if (scanForGlobalDb(callback.body)) {
          failures.push('withRLS callback references global db');
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  expect(failures).toEqual([]);
}
