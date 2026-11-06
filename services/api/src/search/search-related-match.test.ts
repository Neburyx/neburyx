import { searchResultSchema, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { redactItems } from '../gate/redact/index.js';
import type { SearchTarget } from '../gate/templates/search-exact.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';
import { matchedPropertiesOf } from './matched-properties.js';

const nodeWith = (properties: GraphNode['properties'], entityType = 'widget'): GraphNode => ({
  ref: { sourceId: 'demo', entityType, stableId: 'W-1' },
  display: { title: 'W-1', type: entityType },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const prop = (key: string, value: unknown, dataClass: GraphNode['properties'][number]['dataClass'] = 'text', masked = false): GraphNode['properties'][number] => ({ key, value, dataClass, masked });
const target = (property: string, match: 'value' | 'text' = 'value', entityType = 'widget'): SearchTarget => ({ entityType, property, match });

describe('which properties of a related record hold the typed text', () => {
  it.each<readonly [string, GraphNode['properties'], SearchTarget, string, boolean]>([
    ['a text equal to the typed text', [prop('ref', 'X-1')], target('ref'), 'X-1', true],
    ['a text that differs in case', [prop('ref', 'x-1')], target('ref'), 'X-1', false],
    ['a text equal to the typed text on a text-form target', [prop('ref', '123')], target('ref', 'text'), '123', true],
    ['an integer equal to the canonical integer text', [prop('ref', 7, 'number')], target('ref'), '7', true],
    ['an integer against the non-canonical text of it', [prop('ref', 7, 'number')], target('ref'), '007', false],
    ['an integer against a signed text of it', [prop('ref', 7, 'number')], target('ref'), '+7', false],
    ['an integer on a target of the text form, a TEXT index holding no integers', [prop('ref', 7, 'number')], target('ref', 'text'), '7', false],
    ['an integer beyond the safe range, which arrives as tagged text', [prop('ref', '9007199254740993', 'number')], target('ref'), '9007199254740993', true],
    ['the neighbouring integer beyond the safe range', [prop('ref', '9007199254740992', 'number')], target('ref'), '9007199254740993', false],
    ['a float that is the integer exactly, beyond the safe range', [prop('ref', 1000000000000000128, 'number')], target('ref'), '1000000000000000128', true],
    ['a float against the integer its rounded decimal text spells', [prop('ref', 1000000000000000128, 'number')], target('ref'), '1000000000000000100', false],
    ['a float with a fraction against the integer it is near', [prop('ref', 7.5, 'number')], target('ref'), '7', false],
    ['a date rendered as text', [prop('ref', '2024-01-01', 'date')], target('ref'), '2024-01-01', false],
    ['a date-time rendered as text', [prop('ref', '2024-01-01T00:00:00Z', 'dateTime')], target('ref'), '2024-01-01T00:00:00Z', false],
    ['a property returned masked, whose mask equals the typed text', [prop('ref', '••••', 'text', true)], target('ref'), '••••', false],
    ['a property that is not a target of the request', [prop('other', 'X-1')], target('ref'), 'X-1', false],
    ['a target of another entity type', [prop('ref', 'X-1')], target('ref', 'value', 'gadget'), 'X-1', false],
    ['a property the record does not return', [], target('ref'), 'X-1', false],
  ])('%s', (_name, properties, aTarget, text, named) => {
    expect(matchedPropertiesOf(nodeWith(properties), [aTarget], text)).toEqual(named ? [aTarget.property] : []);
  });

  it('names only the properties that hold the text, in the order of the targets', () => {
    const node = nodeWith([prop('a', 'X-1'), prop('b', 'other'), prop('c', 'X-1')]);
    expect(matchedPropertiesOf(node, [target('c'), target('a'), target('b')], 'X-1')).toEqual(['c', 'a']);
  });
});

const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe', batchRef: 'X-1', ownerRef: 'X-1' } },
  { elementId: '4:s:2', label: 'Widget', properties: { widgetId: 'W-2', batchRef: 'X-1', ownerRef: 'O-2' } },
  { elementId: '4:s:3', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: 'X-1' } },
];

describe('the matched properties in the answer', () => {
  it('names, for each related record, the reference properties that hold the typed text', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1' })).json());
    expect(answer.related.hits.map((hit) => [hit.node.ref.stableId, hit.matchedProperties])).toEqual([
      ['W-1', ['batchRef', 'ownerRef']],
      ['W-2', ['batchRef']],
      ['GT-1', ['widgetRef']],
    ]);
    await app.close();
  });

  it('names no personal-data property in a masked search: it is not a target, it is not read for matching, and the record is found through its other property', async () => {
    const { app, executor } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1', mask: true })).json());
    expect(answer.related.hits.map((hit) => [hit.node.ref.stableId, hit.matchedProperties])).toEqual([
      ['W-1', ['batchRef']],
      ['W-2', ['batchRef']],
      ['GT-1', ['widgetRef']],
    ]);
    const call = executor.calls.find((candidate) => candidate.templateId === 'entity-related');
    expect(call?.cypher).not.toContain('ownerRef');
    expect(JSON.stringify(answer.related.hits.map((hit) => hit.matchedProperties))).not.toContain('ownerRef');
    await app.close();
  });

  it('names a personal-data reference property when the search is not masked, and only that one for a record found through it alone', async () => {
    const only: StoredNode[] = [{ elementId: '4:s:9', label: 'Widget', properties: { widgetId: 'W-9', batchRef: 'BT-0', ownerRef: 'O-7' } }];
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(only) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'O-7' })).json());
    expect(answer.related.hits.map((hit) => hit.matchedProperties)).toEqual([['ownerRef']]);
    await app.close();
  });

  it('names a property as an empty list when none of the targets holds the text, as when the source returns a record that does not', async () => {
    const lying = (call: Parameters<ReturnType<typeof searchModelOf>>[0]) =>
      call.templateId === 'entity-related' ? Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-8', batchRef: 'X-1' }, '4:s:8'))) : searchModelOf([])(call);
    const { app } = await startSearchApp({ mapping, respond: lying });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'x-1' })).json());
    expect(answer.related.hits.map((hit) => hit.matchedProperties)).toEqual([[]]);
    await app.close();
  });

  it('never names a property that the gate returned masked by a policy, even when its mask equals the typed text', async () => {
    const policy: NonNullable<Parameters<typeof startSearchApp>[0]>['redact'] = (items, context) =>
      redactItems(items, context).map((item) => {
        const nodes: unknown = item['nodes'];
        if (!Array.isArray(nodes)) return item;
        const masked = nodes.map((node: GraphNode) => ({ ...node, properties: node.properties.map((property) => (property.key === 'batchRef' ? { ...property, value: 'X-1', masked: true, maskedBy: 'policy' as const } : property)) }));
        return { ...item, nodes: masked };
      });
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored), redact: policy });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1' })).json());
    expect(answer.related.hits.flatMap((hit) => hit.matchedProperties)).not.toContain('batchRef');
    expect(answer.related.hits.find((hit) => hit.node.ref.stableId === 'W-1')?.matchedProperties).toEqual(['ownerRef']);
    await app.close();
  });
});
