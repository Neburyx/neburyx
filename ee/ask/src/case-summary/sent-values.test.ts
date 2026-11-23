import type { GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { assembleText, sentValuesOf } from './assemble.js';

const node = (stableId: string, title: string, properties: GraphNode['properties']): GraphNode => ({ ref: { sourceId: 'demo', entityType: 'widget', stableId }, display: { title, type: 'widget' }, properties, qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const reading = (nodes: GraphNode[]): SummaryReading => ({ nodes, edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });

describe('the values sent, kept as structured pairs beside the text', () => {
  it('holds for each element the title and the key and text of each value, a masked one flagged, and none for a property with no value', () => {
    const built = assembleText(reading([node('W-1', 'Item One', [{ key: 'holder', value: 'Jordan Lee', dataClass: 'text', masked: false }, { key: 'size', value: 12, dataClass: 'number', masked: false }, { key: 'tags', value: ['a', 'b'], dataClass: 'list', masked: false }, { key: 'gone', dataClass: 'text', masked: false }, { key: 'mask', value: '*****', dataClass: 'text', masked: true }])]));
    expect(built.sentValues?.get('n1')).toEqual([
      { key: '(title)', text: 'Item One', masked: false },
      { key: 'holder', text: 'Jordan Lee', masked: false },
      { key: 'size', text: '12', masked: false },
      { key: 'tags', text: '["a","b"]', masked: false },
      { key: 'mask', text: '*****', masked: true },
    ]);
  });

  it('holds the title alone for an element with no properties, and none for a relationship that has no title', () => {
    expect(sentValuesOf([], 'Item')).toEqual([{ key: '(title)', text: 'Item', masked: false }]);
    expect(sentValuesOf([])).toEqual([]);
  });
});
