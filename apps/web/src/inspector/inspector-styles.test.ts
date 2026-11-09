// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../styles/workspace.css'), 'utf8');

describe('the inspector stylesheet', () => {
  it('breaks a long value inside the panel instead of scrolling sideways', () => {
    const block = /\.inspector \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('overflow-wrap: anywhere;');
    expect(block).not.toMatch(/white-space:\s*nowrap/);
  });
});
