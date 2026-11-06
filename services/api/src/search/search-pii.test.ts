import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { plainNode } from '../testing/entity-fixtures.js';
import { gateRequest } from '../testing/gate.js';
import { postSearch, searchCalls, searchMappingOf, startSearchApp, widget } from '../testing/search-app.js';
import { searchModelOf } from '../testing/search-fixtures.js';

const ANA = widget(1, { ownerName: 'Ana Silva' });
const OVERLAP = widget(2, { widgetId: 'Ana Silva', ownerName: 'Bo Chen' });
const stored = [ANA, OVERLAP].map((node) => ({ elementId: String(node['elementId']), label: 'Widget', properties: Object.assign({}, node['properties']) }));

const searchFor = async (text: string, mask: boolean | undefined) => {
  const parts = await startSearchApp({ respond: searchModelOf(stored) });
  const response = await postSearch(parts.app, { sourceId: 'demo', text, ...(mask === undefined ? {} : { mask }) });
  return { ...parts, result: searchResultSchema.parse(response.json()) };
};

const refs = (result: { readonly exact: readonly { readonly ref: { readonly stableId: string } }[] }) => result.exact.map((node) => node.ref.stableId);

describe('a masked field is not an oracle for the search', () => {
  it('refuses a run that names a personal-data property while masking is asked, reads nothing and records it as refused', async () => {
    const { gate, executor, events } = await startSearchApp();
    const request = gateRequest({ sourceId: 'demo', templateId: 'entity-search', limit: 25, mask: true, params: { text: 'Bo Chen', targets: [{ entityType: 'widget', property: 'ownerName' }] } });
    const failure = await gate.run(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ action: 'entity.search', result: 'refused' })]);
  });

  it('does not search a personal-data property while masked, and finds the entity by it when not masked', async () => {
    const masked = await searchFor('Bo Chen', true);
    expect(masked.result.exact).toEqual([]);
    expect(masked.result.searchable).toBe(true);
    expect(searchCalls(masked.executor)[0]?.cypher).not.toContain('ownerName');
    for (const flag of [false, undefined]) {
      const plain = await searchFor('Bo Chen', flag);
      expect(refs(plain.result)).toEqual(['Ana Silva']);
      expect(searchCalls(plain.executor)[0]?.cypher).toContain('n.`ownerName` IN [$text, $textInteger]');
    }
  });

  it('finds only the entity an eligible property matches, when the value is also a personal-data value of another entity, and masks its personal-data properties', async () => {
    const masked = await searchFor('Ana Silva', true);
    expect(refs(masked.result)).toEqual(['Ana Silva']);
    expect(masked.result.exact[0]?.properties.find((property) => property.key === 'ownerName')).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(JSON.stringify(masked.result)).not.toContain('Bo Chen');
    const plain = await searchFor('Ana Silva', false);
    expect(refs(plain.result).sort()).toEqual(['Ana Silva', 'W-001']);
  });

  it('finds an entity by a property that is not personal data while masked, with its personal-data properties masked', async () => {
    const masked = await searchFor('W-001', true);
    expect(refs(masked.result)).toEqual(['W-001']);
    expect(masked.result.exact[0]?.properties.find((property) => property.key === 'ownerName')).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(JSON.stringify(masked.result)).not.toContain('Ana Silva');
  });

  it('gives the same text a different answer masked and unmasked, and builds neither from the other', async () => {
    const first = await searchFor('Bo Chen', true);
    const second = await searchFor('Bo Chen', false);
    expect(first.result.exact).not.toEqual(second.result.exact);
    expect(JSON.stringify(second.result)).toContain('Bo Chen');
    expect(JSON.stringify(first.result)).not.toContain('Bo Chen');
  });
});

describe('a masked search with no property left to search', () => {
  const onlyPersonal = () =>
    searchMappingOf({ entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['ownerName'], pii: [{ property: 'ownerName', class: 'name' }] }] });

  it('answers 200 with no hit and one audit event, and never calls the executor', async () => {
    const { app, executor, events } = await startSearchApp({ mapping: onlyPersonal(), rows: [plainNode(['Widget'], { widgetId: 'W-1', ownerName: 'Ana Silva' })] });
    const response = await postSearch(app, { sourceId: 'demo', text: 'Ana Silva', mask: true });
    expect(response.statusCode).toBe(200);
    const result = searchResultSchema.parse(response.json());
    expect(result.exact).toEqual([]);
    expect(result.counts.exact).toMatchObject({ value: 0, quality: 'exact' });
    expect(result.searchable).toBe(false);
    expect(executor.calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ action: 'entity.search', result: 'success' })]);
    await app.close();
  });

  it('still refuses a principal the policy refuses', async () => {
    const { app, executor } = await startSearchApp({ mapping: onlyPersonal(), policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } });
    const response = await postSearch(app, { sourceId: 'demo', text: 'Ana Silva', mask: true });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('searches the other types of the source as usual and leaves out only the personal-data branch', async () => {
    const { app, executor } = await startSearchApp({ respond: searchModelOf(stored) });
    await postSearch(app, { sourceId: 'demo', text: 'W-001', mask: true });
    const [call] = searchCalls(executor);
    expect(call?.cypher.match(/MATCH/g)).toHaveLength(2);
    expect(call?.cypher).toContain('MATCH (n:`Gadget`) WHERE n.`gadgetId` IN [$text, $textInteger]');
    await app.close();
  });
});
