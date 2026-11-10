// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { droppedFilterText, NEWLY_SENSITIVE, UNMAPPED_ITEMS_SENTENCE } from './mapping-notice-copy.js';

const guide = readFileSync(fileURLToPath(new URL('../../../../docs/mapping-guide.md', import.meta.url)), 'utf8');

describe('the words the mapping guide quotes from the mapping-changed notice', () => {
  it.each([
    ['the placeholder for a type that is no longer mapped', UNMAPPED_ITEMS_SENTENCE.slice(UNMAPPED_ITEMS_SENTENCE.indexOf('“'), UNMAPPED_ITEMS_SENTENCE.lastIndexOf('”') + 1)],
    ['the reason beside a dropped filter on a field that is now personal', droppedFilterText('x', 'now-personal').replace(/^x \(|\)$/g, '')],
    ['the sentence for fields that are newly sensitive', NEWLY_SENSITIVE],
  ])('are the product\'s: %s', (_name, phrase) => {
    expect(phrase).not.toBe('');
    expect(guide).toContain(phrase);
  });
});
