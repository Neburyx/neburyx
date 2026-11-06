import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode } from '../testing/search-fixtures.js';
import { postSearch, relatedCalls, RELATED_ENTITIES, searchCalls, searchMappingOf, startSearchApp } from '../testing/search-app.js';

const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const stored: StoredNode[] = [{ elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', batchRef: 'X-1', ownerRef: 'X-1' } }];

describe('the related group while the request asks for masking', () => {
  it('leaves a personal-data reference property out of the targets, and checks the indexes of a type only through the targets that remain', async () => {
    const withoutOwnerIndex = onlineIndexesOf(source).filter((row) => row.property !== 'ownerRef');
    const respond = withSchema(() => schemaAnswer(withoutOwnerIndex), searchModelOf(stored));
    const masked = await startSearchApp({ mapping, ownSchema: true, respond });
    const maskedAnswer = searchResultSchema.parse((await postSearch(masked.app, { sourceId: 'demo', text: 'X-1', mask: true })).json());
    expect(maskedAnswer.related.disabledTypes).toEqual([]);
    expect(maskedAnswer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['W-1']);
    expect(relatedCalls(masked.executor)[0]?.cypher).not.toContain('ownerRef');
    await masked.app.close();
    const plain = await startSearchApp({ mapping, ownSchema: true, respond });
    const plainAnswer = searchResultSchema.parse((await postSearch(plain.app, { sourceId: 'demo', text: 'X-1' })).json());
    expect(plainAnswer.related.disabledTypes).toEqual([{ entityType: 'widget', reason: 'index-unavailable' }]);
    await plain.app.close();
  });

  it('does not report a type with no reference property as disabled', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1' })).json());
    expect(answer.related.disabledTypes.map((disabled) => disabled.entityType)).not.toContain('part');
    await app.close();
  });

  it('masks the personal-data values of a related record that is found through another property', async () => {
    const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1', mask: true })).json());
    const owner = answer.related.hits[0]?.node.properties.find((property) => property.key === 'ownerRef');
    expect(owner).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(owner?.value).not.toBe('X-1');
    await app.close();
  });

  it('answers a group that is not searchable, with no related run, when only personal-data reference properties remain unmasked', async () => {
    const onlyPii = searchMappingOf({ entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId'], reference: ['ownerRef'], pii: [{ property: 'ownerRef', class: 'text' }] }] });
    const masked = await startSearchApp({ mapping: onlyPii, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(masked.app, { sourceId: 'demo', text: 'W-1', mask: true })).json());
    expect(answer.related).toMatchObject({ hits: [], searchable: false, disabledTypes: [] });
    expect(relatedCalls(masked.executor)).toEqual([]);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['W-1']);
    expect(searchCalls(masked.executor)).toHaveLength(1);
    await masked.app.close();
    const plain = await startSearchApp({ mapping: onlyPii, respond: searchModelOf(stored) });
    const plainAnswer = searchResultSchema.parse((await postSearch(plain.app, { sourceId: 'demo', text: 'X-1' })).json());
    expect(plainAnswer.related.searchable).toBe(true);
    expect(relatedCalls(plain.executor)).toHaveLength(1);
    await plain.app.close();
  });

  it('answers a group that is not searchable for a source with no reference property, and the exact group as it would alone, when nothing at all can be searched', async () => {
    const nothing = searchMappingOf({ entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', pii: [] }] });
    const { app, executor } = await startSearchApp({ mapping: nothing, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1', mask: true })).json());
    expect(answer).toMatchObject({ searchable: false, exact: [], related: { searchable: false, hits: [] } });
    expect(executor.calls.map((call) => call.templateId)).toEqual([]);
    await app.close();
  });
});
