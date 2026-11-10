import { describe, expect, it } from 'vitest';
import { placeholderEdge } from '../draft/unmapped.js';
import { edge } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { entity, inspectorRig } from '../inspector/inspector-kit.js';

describe('the evidence of a placeholder relationship', () => {
  it('is not offered, while a relationship of a mapped type still is', () => {
    const rig = inspectorRig({ nodes: [entity('n1'), entity('n2')], evidence: true });
    const gone = placeholderEdge('a', { t: 'REL', from: { t: 'type-a', id: 'n1' }, to: { t: 'type-a', id: 'n2' }, id: 'r9' });
    const mapped = edge('a', 'r1', 'n1', 'n2');
    loadGraph(rig.state, [entity('n1'), entity('n2')], [mapped, { ...gone }]);
    expect(rig.evidence?.offers(gone.ref)).toBe(false);
    expect(rig.evidence?.open(gone.ref)).toBe(false);
    expect(rig.evidence?.offers(mapped.ref)).toBe(true);
  });
});
