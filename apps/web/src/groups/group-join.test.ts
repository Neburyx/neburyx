import { describe, expect, it } from 'vitest';
import { entityOf, keyOf } from './group-kit.js';
import { joinedGroups } from './group-join.js';
import type { Group } from './group-model.js';

const a1 = entityOf('kind-a', 'A1');
const a2 = entityOf('kind-a', 'A2');
const d1 = entityOf('kind-d', 'DV1');
const full: Group = { id: 'type:kind-a', by: 'entityType', members: [keyOf(a1)], collapsed: true };

describe('entities added to a grouped view', () => {
  it('join the entity-type group of their type when it held every loaded entity of the type', () => {
    const groups = joinedGroups([full], [a1, d1], [a1, d1, a2]);
    expect(groups[0]?.members).toEqual([keyOf(a1), keyOf(a2)]);
  });

  it('do not join a group that held only some of the loaded entities of its type', () => {
    const partial: Group = { id: 'type:kind-a', by: 'entityType', members: [keyOf(a1)], collapsed: true };
    expect(joinedGroups([partial], [a1, a2], [a1, a2, entityOf('kind-a', 'A3')])).toEqual([partial]);
  });

  it('are left ungrouped under a grouping by property or component, and change nothing when nothing is added or nothing was loaded', () => {
    const property: Group = { id: 'property:x:1', by: 'property:x', members: [keyOf(a1)], collapsed: true };
    const groups = [property];
    expect(joinedGroups(groups, [a1], [a1, a2])).toBe(groups);
    expect(joinedGroups([full], [a1], [a1])).toEqual([full]);
    expect(joinedGroups([full], [], [a1, a2])).toEqual([full]);
  });

  it('join the group of their type only, whichever groups exist', () => {
    const kindD: Group = { id: 'type:kind-d', by: 'entityType', members: [keyOf(d1)], collapsed: false };
    const next = joinedGroups([full, kindD], [a1, d1], [a1, d1, a2]);
    expect(next.map((group) => group.members.length)).toEqual([2, 1]);
  });
});
