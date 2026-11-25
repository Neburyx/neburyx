import { describe, expect, it } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, node, ref } from '../state/test-data.js';
import { noteKeyOf } from './chat-selection.js';

describe('the key a chat selection puts a note under', () => {
  const entity = node('a', 'ent-1');
  const link = edge('a', 'rel-1', 'ent-1', 'ent-2');

  it('is the key of an entity of the graph', () => {
    expect(noteKeyOf(elementKey(entity.ref), [entity])).toBe(elementKey(entity.ref));
  });

  it('is none for a relationship, even a drawn one, and for an element the graph does not hold', () => {
    expect(noteKeyOf(edgeKey(link.ref), [entity])).toBeUndefined();
    expect(noteKeyOf(elementKey(ref('a', 'type-a', 'ent-9')), [entity])).toBeUndefined();
  });
});
