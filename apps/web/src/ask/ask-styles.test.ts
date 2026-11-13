// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '..', 'styles', 'ask.css'), 'utf8');

describe('the Ask stylesheet', () => {
  it('draws the field and the copy behind it with one rule, so they wrap alike and the underline stays on its word', () => {
    const shared = /\.ask-mirror,\s*\.ask-input \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const declaration of ['font: inherit;', 'line-height: inherit;', 'scrollbar-gutter: stable;', 'white-space: pre-wrap;', 'overflow-wrap: anywhere;', 'box-sizing: border-box;', 'width: 100%;']) {
      expect(shared).toContain(declaration);
    }
  });

  it('hides the copy from the pointer and draws only the underline of a blocked word', () => {
    expect(/\.ask-mirror \{[^}]*pointer-events: none;/.test(css)).toBe(true);
    expect(/\.ask-blocked \{[^}]*text-decoration: underline wavy var\(--color-danger\);/.test(css)).toBe(true);
  });
});
