import { SENSITIVE_TITLE_KEY, type ElementRef, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { valueFromReads } from './stored-answer.js';

const REF: ElementRef = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const nodeWith = (title: string, properties: { key: string; value: unknown }[]): GraphNode => ({ ref: REF, display: { title, type: 'widget' }, properties, qualityFlags: [], provenanceRefs: [] }) as unknown as GraphNode;

/**
 * The rule that draws the value of a binding, as a table. The server draws the same bindings for the loop's text context by its own copy of the rule
 * (`ee/ask/src/assistant/thread-text-context.test.ts` holds the same table), so the two cannot differ without a test failing.
 */
const VALUE_RULE_CASES: readonly (readonly [unknown, string | undefined])[] = [
  ['Jordan', 'Jordan'],
  ['', undefined],
  [3, '3'],
  [true, 'true'],
  [false, 'false'],
  [{ nested: 1 }, undefined],
  [null, undefined],
];

describe('the value a binding draws', () => {
  it.each(VALUE_RULE_CASES)('draws the property value %j as %j', (value, expected) => {
    const reads = { nodes: new Map([[elementKey(REF), nodeWith('Title', [{ key: 'holder', value }])]]) };
    expect(valueFromReads(reads)({ element: REF, property: 'holder' })).toBe(expected);
  });

  it('draws the gate\'s display title for the title key, nothing for a property the element does not hold and nothing for an element that was not read', () => {
    const reads = { nodes: new Map([[elementKey(REF), nodeWith('Masked title', [])]]) };
    expect(valueFromReads(reads)({ element: REF, property: SENSITIVE_TITLE_KEY })).toBe('Masked title');
    expect(valueFromReads(reads)({ element: REF, property: 'holder' })).toBeUndefined();
    expect(valueFromReads({ nodes: new Map() })({ element: REF, property: SENSITIVE_TITLE_KEY })).toBeUndefined();
  });
});
