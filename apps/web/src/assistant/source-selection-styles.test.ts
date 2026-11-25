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
});
