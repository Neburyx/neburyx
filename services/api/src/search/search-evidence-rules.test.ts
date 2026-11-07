import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { evidenceCalls, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const row = (type: string, from: string, to: string) => ({ type, from, to, stable_id: 'linkId', evidence: ['recordId'] });
const RELATIONSHIPS = [row('ONE', 'widget', 'gadget'), row('TWO', 'widget', 'gadget'), row('NONE', 'widget', 'gadget'), row('gadget', 'gadget', 'widget')];
const RULES = [
  { id: 'first', from: 'widget', to: 'widget', via: ['ONE', 'gadget', 'ONE'], rule_version: 1 },
  { id: 'second', from: 'widget', to: 'widget', via: ['TWO', 'gadget', 'TWO'], rule_version: 2 },
  { id: 'third', from: 'widget', to: 'widget', via: ['TWO', 'gadget', 'TWO'], rule_version: 3 },
];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS, derived: RULES });

const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1' } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
const link = (type: string, from: StoredNode, to: StoredNode): StoredRelationship => ({ elementId: `5:r:${type}`, type, from, to, properties: { linkId: `L-${type}`, recordId: 'REC-1' } });
const relationships = [link('ONE', widgetNode, gadgetNode), link('TWO', widgetNode, gadgetNode), link('NONE', widgetNode, gadgetNode), link('gadget', gadgetNode, widgetNode)];

async function answer() {
  const { app, executor } = await startSearchApp({ mapping, respond: searchModelOf([widgetNode, gadgetNode], () => undefined, relationships) });
  const response = await postSearch(app, { sourceId: 'demo', text: 'REC-1' });
  const result = searchResultSchema.parse(response.json());
  await app.close();
  return { result, executor };
}

const rulesOf = (result: Awaited<ReturnType<typeof answer>>['result'], type: string) => result.evidence.hits.find((hit) => hit.supports.type === type)?.rules;

describe('the configured rules of an evidence hit', () => {
  it('is empty for a relationship type that no rule uses', async () => {
    expect(rulesOf((await answer()).result, 'NONE')).toEqual([]);
  });

  it('holds the rule and its version for a type that one rule uses', async () => {
    expect(rulesOf((await answer()).result, 'ONE')).toEqual([{ ruleId: 'first', ruleVersion: 1 }]);
  });

  it('holds every rule that uses the type, in the order of the mapping', async () => {
    expect(rulesOf((await answer()).result, 'TWO')).toEqual([{ ruleId: 'second', ruleVersion: 2 }, { ruleId: 'third', ruleVersion: 3 }]);
  });

  it('does not list a rule whose entity-type place holds the name of the relationship type', async () => {
    expect(rulesOf((await answer()).result, 'gadget')).toEqual([]);
  });

  it('builds the rules from the mapping alone, with one evidence read and no read made for them', async () => {
    const { executor } = await answer();
    expect(evidenceCalls(executor)).toHaveLength(1);
    expect(executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-related', 'entity-search', 'relationship-evidence', 'schema-indexes', 'search-facets']);
  });
});
