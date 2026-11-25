import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/assistant.css'), 'utf8');
const rule = (selector: string): string => new RegExp(`${selector.replace(/[[\]().]/g, '\\$&')} \\{[^}]*\\}`).exec(css)?.[0] ?? '';

describe('the state of a source row selected from another window', () => {
  it('has its own attribute and rules, and shares neither the shade of a marked row nor the focus ring', () => {
    const highlighted = rule('.assistant-source-state[data-selection="highlighted"]');
    expect(highlighted).toContain('background: var(--color-success-surface);');
    expect(highlighted).not.toContain('--color-accent-surface');
    expect(rule('.assistant-source-row[data-marked]')).toContain('background: var(--color-accent-surface);');
    expect(css).not.toMatch(/\.assistant-source-row\[data-selection\][^{]*\{[^}]*(outline|--color-focus)/);
  });

  it('gives the line that ends an opened group of the page the padding and the indent of the rows, and a rule above it', () => {
    const more = rule('.assistant-surface-page .assistant-sources-list .assistant-group-more');
    expect(more).toContain('margin: 0;');
    expect(more).toContain('padding: calc(var(--space-10) - var(--border-width)) var(--space-12) calc(var(--space-10) - var(--border-width)) calc(var(--space-20) + var(--space-12));');
    expect(more).toContain('border-top: var(--border-width) solid var(--color-workspace-border);');
  });
});
