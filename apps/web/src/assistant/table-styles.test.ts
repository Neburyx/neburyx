import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/assistant.css'), 'utf8');

describe('the full title drawn over a cut title cell', () => {
  it('has an empty alternative text so a screen reader reads the title once, and is bounded by the room before the Source column', () => {
    const rule = /td\.assistant-table-title-cell::after \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('content: attr(data-full) / "";');
    expect(rule).toContain('max-width: var(--assistant-table-room');
  });
});
