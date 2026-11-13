import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the pattern events module', () => {
  it('names the table as the pattern history written in every edition and the sink record as the second one in Enterprise', () => {
    const text = readFileSync(new URL('./pattern-events.ts', import.meta.url), 'utf8');
    const header = text.slice(text.indexOf('/**'), text.indexOf('*/') + 2);
    expect(header).toContain('`pattern_events` is the pattern\'s own history');
    expect(header).toContain('every edition');
    expect(header).toContain('`audit_events`, the second record');
    expect(header).toContain('Enterprise');
  });
});
