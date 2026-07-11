import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dashboard sidebar grouping', () => {
  it('renders Observe / React / Bill / Configure groups', async () => {
    const src = await readFile(
      path.resolve(__dirname, '../../src/components/dashboard/Sidebar.tsx'),
      'utf8',
    );
    for (const title of ['Observe', 'React', 'Bill', 'Configure']) {
      expect(src, title).toContain(`title: '${title}'`);
    }
    expect(src).not.toContain('/subscription');
  });
});
