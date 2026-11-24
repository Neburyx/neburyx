import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/assistant.css'), 'utf8');

describe('the tip of a cut table cell', () => {
  it('is drawn in the window, outside the frame of the table, white, bordered and raised as the other tips, and the pointer can move onto it', () => {
    const rule = /\.assistant-table-tip \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('position: fixed;');
    expect(rule).toContain('border: var(--border-width) solid var(--color-tooltip-border);');
    expect(rule).toContain('box-shadow: var(--shadow-tooltip);');
    expect(rule).toContain('background: var(--color-surface);');
    expect(rule).not.toContain('pointer-events: none;');
  });
});
