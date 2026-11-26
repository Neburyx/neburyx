// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const base = readFileSync(join(import.meta.dirname, 'base.css'), 'utf8');

describe('the spinner of a waiting line', () => {
  it('turns, and stands still for a person who asks for reduced motion', () => {
    expect(base).toMatch(/\n\.waiting-spinner \{[^}]*animation: waiting-turn/);
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.waiting-spinner \{\s*animation: none;\s*\}\s*\}/);
  });

  it('is stilled by a rule that comes after the one that turns it', () => {
    expect(base.indexOf('animation: waiting-turn')).toBeLessThan(base.search(/@media \(prefers-reduced-motion: reduce\) \{\s*\.waiting-spinner/));
  });
});
