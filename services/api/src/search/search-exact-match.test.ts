import { searchResultSchema, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { SearchTarget } from '../gate/templates/search-exact.js';
import { redactItems } from '../gate/redact/index.js';
import { postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';
import { exactMatchesOf } from './matched-properties.js';

const nodeWith = (stableId: string, properties: GraphNode['properties']): GraphNode => ({
  ref: { sourceId: 'demo', entityType: 'widget', stableId },
  display: { title: stableId, type: 'widget' },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const prop = (key: string, value: unknown, masked = false): GraphNode['properties'][number] => ({ key, value, dataClass: 'text', masked });
const target = (property: string): SearchTarget => ({ entityType: 'widget', property, match: 'text' });

describe('which search properties of an exact hit hold the typed text', () => {
  it('gives one entry for each node, with its reference, in the order of the nodes', () => {
    const nodes = [nodeWith('W-2', [prop('a', 'X-1')]), nodeWith('W-1', [prop('b', 'X-1')])];
    expect(exactMatchesOf(nodes, [target('a'), target('b')], 'X-1')).toEqual([
      { ref: nodes[0]?.ref, matchedProperties: ['a'] },
      { ref: nodes[1]?.ref, matchedProperties: ['b'] },
    ]);
  });

  it('names no property of a node that holds the text in none of them', () => {
    expect(exactMatchesOf([nodeWith('W-1', [prop('a', 'other')])], [target('a')], 'X-1')).toEqual([{ ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, matchedProperties: [] }]);
  });

  it('names no property whose value was returned masked, even when the mask equals the text', () => {
    expect(exactMatchesOf([nodeWith('W-1', [prop('a', 'X-1', true)])], [target('a')], 'X-1')[0]?.matchedProperties).toEqual([]);
  });

  it('gives no entry for no node', () => {
    expect(exactMatchesOf([], [target('a')], 'X-1')).toEqual([]);
  });
});

const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe' } },
  { elementId: '4:s:2', label: 'Widget', properties: { widgetId: 'W-2', ownerName: 'W-1' } },
  { elementId: '4:s:3', label: 'Widget', properties: { widgetId: 'W-3', ownerName: 'W-3' } },
];
const matchesOf = (answer: ReturnType<typeof searchResultSchema.parse>) => answer.exactMatches.map((entry) => [entry.ref.stableId, entry.matchedProperties]);

describe('the matched properties in the exact group of the answer', () => {
  it('names, for each exact hit, the search property that held the text, hit by hit', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-1' })).json());
    expect(answer.exactMatches.map((entry) => entry.ref)).toEqual(answer.exact.map((node) => node.ref));
    expect(Object.fromEntries(matchesOf(answer))).toEqual({ 'W-1': ['widgetId'], 'W-2': ['ownerName'] });
    await app.close();
  });

  it('names both properties, in the order of the mapping, when a hit held the text in two', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-3' })).json());
    expect(matchesOf(answer)).toEqual([['W-3', ['widgetId', 'ownerName']]]);
    await app.close();
  });

  it('names the one property that held the text, when it is not the identifier', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'Ivo Lowe' })).json());
    expect(matchesOf(answer)).toEqual([['W-1', ['ownerName']]]);
    await app.close();
  });

  it('gives no entry when nothing matched', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'NONE-1' })).json());
    expect(answer.exact).toEqual([]);
    expect(answer.exactMatches).toEqual([]);
    await app.close();
  });
});

describe('the matched properties of a masked search and of personal data', () => {
  it('names no personal-data search property of a masked search: it is not a target, and the hit is found through its other property', async () => {
    const { app, executor } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-3', mask: true })).json());
    expect(matchesOf(answer)).toEqual([['W-3', ['widgetId']]]);
    expect(executor.calls.find((call) => call.templateId === 'entity-search')?.cypher).not.toContain('ownerName');
    await app.close();
  });

  it('finds nothing through a personal-data property while masked, and names it when the search is not masked', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const masked = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'Ivo Lowe', mask: true })).json());
    expect(masked.exactMatches).toEqual([]);
    const open = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'Ivo Lowe' })).json());
    expect(matchesOf(open)).toEqual([['W-1', ['ownerName']]]);
    await app.close();
  });

  it('never names a property the gate returned masked by a policy, even when its mask equals the typed text', async () => {
    const policy: NonNullable<Parameters<typeof startSearchApp>[0]>['redact'] = (items, context) =>
      redactItems(items, context).map((item) => {
        const nodes: unknown = item['nodes'];
        if (!Array.isArray(nodes)) return item;
        const masked = nodes.map((node: GraphNode) => ({ ...node, properties: node.properties.map((property) => (property.key === 'ownerName' ? { ...property, value: 'W-3', masked: true, maskedBy: 'policy' as const } : property)) }));
        return { ...item, nodes: masked };
      });
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored), redact: policy });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-3' })).json());
    expect(matchesOf(answer)).toEqual([['W-3', ['widgetId']]]);
    await app.close();
  });

  it('holds no property value in an entry: its keys are the reference and the names, and a keyed reference shows a token, not the typed value', async () => {
    const keyed = searchMappingOf({ entities: [{ type: 'phone', label: 'Handle', stable_id: 'phoneNumber', search: ['phoneNumber'], pii: [{ property: 'phoneNumber', class: 'phone' }] }] });
    const handle: StoredNode = { elementId: '4:p:1', label: 'Handle', properties: { phoneNumber: '+1-212-555-0100' } };
    const { app } = await startSearchApp({ mapping: keyed, respond: searchModelOf([handle]) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: '+1-212-555-0100' })).json());
    expect(answer.exactMatches).toHaveLength(1);
    const [entry] = answer.exactMatches;
    expect(Object.keys(entry ?? {}).sort()).toEqual(['matchedProperties', 'ref']);
    expect(entry?.matchedProperties).toEqual(['phoneNumber']);
    expect(entry?.ref.stableId).not.toBe('+1-212-555-0100');
    expect(JSON.stringify(answer.exactMatches)).not.toContain('555-0100');
    await app.close();
  });
});
