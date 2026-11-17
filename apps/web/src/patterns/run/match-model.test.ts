import { describe, expect, it } from 'vitest';
import { patternRunOkSchema, type ElementRef, type PatternHop, type PatternMatch } from '@neburyx/contracts';
import { pathOf } from './match-model.js';

const ref = (stableId: string): ElementRef => ({ sourceId: 'a', entityType: 'kind-a', stableId });
const answer = patternRunOkSchema.parse({ status: 'ok', templateVersion: '1', count: { value: 1, quality: 'exact', scope: 'matches' }, matches: [], nodes: [], edges: [], notices: [], warnings: [] });
const hop = (from: string | null, to: string | null): PatternHop => ({ relationshipType: 'r-1', from: from === null ? null : ref(from), to: to === null ? null : ref(to) });
const match = (through: readonly (string | null)[], hops: readonly PatternHop[]): PatternMatch => ({ match: ref('m'), hops: hops.length, through: through.map((entry) => (entry === null ? null : ref(entry))), relationships: [...hops] });
const walk = (entry: PatternMatch): string[] => pathOf(entry, answer, false).map((part) => (part.kind === 'entity' ? part.text : `${{ out: '->', in: '<-', unknown: '--' }[part.direction]}${part.text}`));

describe('the path of a match', () => {
  it('reads from the start to the match along relationships that point the way it walked', () => {
    expect(walk(match([], [hop('s', 'm')]))).toEqual(['s', '->r-1', 'm']);
  });

  it('starts at the start and ends at the match when the step follows the relationship backwards, and marks the hop as inward', () => {
    expect(walk(match([], [hop('m', 's')]))).toEqual(['s', '<-r-1', 'm']);
  });

  it('marks each hop on its own when a path goes out and then in', () => {
    expect(walk(match(['x'], [hop('s', 'x'), hop('m', 'x')]))).toEqual(['s', '->r-1', 'x', '<-r-1', 'm']);
  });

  it('keeps the known start and the way of each hop when the entity between has no usable ID', () => {
    expect(walk(match([null], [hop(null, 's'), hop(null, 'm')]))).toEqual(['s', '<-r-1', 'an entity without an ID', '->r-1', 'm']);
  });

  it('says a direction no known end settles as unknown and does not give it an arrow', () => {
    expect(walk(match([null], [hop(null, null), hop(null, null)]))).toEqual(['an entity without an ID', '--r-1', 'an entity without an ID', '--r-1', 'm']);
  });
});
