import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migration 041 — api key scope constraint ordering', () => {
  it('keeps a transition constraint until the final scope constraint is validated', async () => {
    const src = await readFile(
      path.resolve(__dirname, '../../db/migrations/041_rename_api_key_scopes.sql'),
      'utf8',
    );

    const pos = (pattern: RegExp): number => {
      const index = src.search(pattern);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    const addTransition = pos(/ADD CONSTRAINT\s+api_keys_scope_transition_check\s+CHECK/i);
    const validateTransition = pos(/VALIDATE CONSTRAINT\s+api_keys_scope_transition_check/i);
    const dropOld = pos(/DROP CONSTRAINT IF EXISTS\s+api_keys_scope_check\s*;/i);
    const updateScopes = pos(/UPDATE api_keys\s+SET scope = CASE scope/i);
    const addFinal = pos(/ADD CONSTRAINT\s+api_keys_scope_check\s+CHECK/i);
    const validateFinal = pos(/VALIDATE CONSTRAINT\s+api_keys_scope_check/i);
    const dropTransition = pos(/DROP CONSTRAINT IF EXISTS\s+api_keys_scope_transition_check\s*;/i);

    expect(addTransition).toBeLessThan(validateTransition);
    expect(validateTransition).toBeLessThan(dropOld);
    expect(dropOld).toBeLessThan(updateScopes);
    expect(updateScopes).toBeLessThan(addFinal);
    expect(addFinal).toBeLessThan(validateFinal);
    expect(validateFinal).toBeLessThan(dropTransition);
    expect(src).not.toMatch(
      /^\s*(BEGIN(\s+(TRANSACTION|WORK))?|START\s+TRANSACTION|COMMIT(\s+(TRANSACTION|WORK))?|ROLLBACK(\s+(TRANSACTION|WORK))?)\s*;/im,
    );
  });
});
