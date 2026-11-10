import { describe, expect, it } from 'vitest';
import { notReadEdge, notReadNode, placeholderEdge, placeholderNode } from '../draft/unmapped.js';
import { testProfile } from '../dev/test-profile.js';
import { coverageEntitiesOf } from '../workspace/coverage-input.js';
import { idsOfSelection } from '../workspace/copy-ids.js';
import { menuHeader } from '../workspace/menu-header.js';
import { elementKey, edgeKey } from '../state/keys.js';
import { entityLook } from './entity-look.js';
import { relationshipLook } from './relationship-look.js';
import { describeWalked } from './walk.js';

const gone = placeholderNode('s', { t: 'gone', id: 'SECRET-ID' });
const edge = placeholderEdge('s', { t: 'REL', from: { t: 'gone', id: 'SECRET-ID' }, to: { t: 'gone', id: 'OTHER' }, ruleId: 'old' });
const count = { value: 1, quality: 'exact', scope: 'loaded in this view' } as const;
const graph = { nodes: [gone], edges: [edge], entities: count, relationships: count };

describe('placeholders for items the mapping no longer covers', () => {
  it('are drawn as "Unmapped item" and "No longer mapped", with no stored ID', () => {
    expect(entityLook(gone, undefined)).toEqual({ iconKey: 'generic', line1: 'Unmapped item', line2: 'No longer mapped' });
    expect(relationshipLook(edge)).toMatchObject({ label: 'No longer mapped', aggregate: false });
  });

  it('are announced as "Unmapped item, no longer mapped", and said to be pinned when they are', () => {
    const key = elementKey(gone.ref);
    expect(describeWalked(graph, undefined, new Set(), key)).toBe('Unmapped item, no longer mapped');
    expect(describeWalked(graph, undefined, new Set([key]), key)).toBe('Unmapped item, no longer mapped, pinned');
    expect(describeWalked(graph, undefined, new Set(), edgeKey(edge.ref))).toContain('No longer mapped, from Unmapped item to');
  });

  it('show no stored ID in the menu header', () => {
    const node = menuHeader({ kind: 'node', key: elementKey(gone.ref) } as never, graph, undefined);
    const line = menuHeader({ kind: 'relationship', key: edgeKey(edge.ref) } as never, graph, undefined);
    expect(JSON.stringify([node, line])).not.toContain('SECRET-ID');
  });

  it('are left out of the coverage a read asks for', () => {
    expect(coverageEntitiesOf(graph)).toEqual([]);
  });
});

describe('copying the IDs of placeholders', () => {
  it('copies none, and counts each placeholder among the items without an ID', () => {
    const stored = placeholderEdge('s', { t: 'REL', from: { t: 'gone', id: 'SECRET-ID' }, to: { t: 'gone', id: 'OTHER' }, id: 'EDGE-SECRET' });
    const all = { nodes: [gone], edges: [stored, edge], entities: count, relationships: count };
    const selection = new Set([elementKey(gone.ref), edgeKey(stored.ref), edgeKey(edge.ref)]);
    expect(idsOfSelection(all, selection)).toEqual({ ids: [], withoutId: 3 });
  });
});

describe('saved items of an investigation whose source changed', () => {
  const saved = notReadNode('source-a', { t: 'kind-a', id: 'SECRET-ID' });
  const unlisted = notReadNode('source-a', { t: 'gone', id: 'SECRET-ID' });
  const savedEdge = notReadEdge('source-a', { t: 'REL', from: { t: 'kind-a', id: 'SECRET-ID' }, to: { t: 'kind-a', id: 'OTHER' }, id: 'E-9' });
  const profile = testProfile('source-a');
  const typeName = profile.entityTypes.find((entry) => entry.type === 'kind-a')?.displayName ?? '';
  const saveGraph = { nodes: [saved, unlisted], edges: [savedEdge], entities: count, relationships: count };

  it('say "Saved layout · not read" under the type name the profile gives, or under "Unmapped item" for a type it does not hold', () => {
    expect(entityLook(saved, profile)).toEqual({ iconKey: 'generic', line1: typeName, line2: 'Saved layout · not read' });
    expect(entityLook(unlisted, profile)).toEqual({ iconKey: 'generic', line1: 'Unmapped item', line2: 'Saved layout · not read' });
    expect(entityLook(saved, undefined).line1).toBe('Unmapped item');
  });

  it('draw their relationships as plain lines with no label', () => {
    expect(relationshipLook(savedEdge)).toMatchObject({ label: '', aggregate: false });
  });

  it('are announced with the same words, and said to be pinned when they are, never with a stored ID', () => {
    const key = elementKey(saved.ref);
    expect(describeWalked(saveGraph, profile, new Set(), key)).toBe(`${typeName}, Saved layout · not read`);
    expect(describeWalked(saveGraph, profile, new Set([key]), key)).toBe(`${typeName}, Saved layout · not read, pinned`);
    expect(describeWalked(saveGraph, profile, new Set(), edgeKey(savedEdge.ref))).toContain('Saved layout · not read, from');
    for (const text of [describeWalked(saveGraph, profile, new Set(), key), describeWalked(saveGraph, profile, new Set(), edgeKey(savedEdge.ref))]) expect(text).not.toContain('SECRET-ID');
  });

  it('show no stored ID in the menu header and are left out of the coverage a read asks for', () => {
    const node = menuHeader({ kind: 'node', key: elementKey(saved.ref) } as never, saveGraph, profile);
    const line = menuHeader({ kind: 'relationship', key: edgeKey(savedEdge.ref) } as never, saveGraph, profile);
    expect(node).toEqual({ title: typeName, detail: 'Saved layout · not read' });
    expect(JSON.stringify([node, line])).not.toContain('SECRET-ID');
    expect(coverageEntitiesOf(saveGraph)).toEqual([]);
  });
});
