import { SOURCE_READS_IN_A_ROW, searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { inRounds } from '../testing/read-rounds.js';
import { postMore, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: [{ type: 'FOR', from: 'gadget', to: 'widget' }] });
const gadgets: StoredNode[] = Array.from({ length: 40 }, (_unused, index) => ({ elementId: `4:g:${String(index).padStart(3, '0')}`, label: 'Gadget', properties: { gadgetId: `GT-${index}`, widgetRef: TEXT } }));
const stored: StoredNode[] = [{ elementId: '4:s:3', label: 'Widget', properties: { widgetId: TEXT } }, ...gadgets];
const related = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: (call.parameters['hits'] as unknown[]).map((_hit, hi) => ({ hi, bi: 0, ei: 0, rtype: 'FOR', dir: 'out' })) });

async function counted() {
  let counter: ReturnType<typeof inRounds> | undefined;
  const { app } = await startSearchApp({ mapping, respond: searchModelOf(stored), context: related, between: (parts) => (counter = inRounds(parts)) });
  if (counter === undefined) throw new Error('the reads are not counted');
  return { app, counter };
}

describe('how long a search can take', () => {
  it('reads the source as many times in a row as the clients are told to wait for', async () => {
    const { app, counter } = await counted();
    const { rounds, answer } = await counter.roundsOf(async () => await postSearch(app, { sourceId: 'demo', text: TEXT }));
    expect(answer.statusCode).toBe(200);
    expect(rounds).toBe(SOURCE_READS_IN_A_ROW.search);
    await app.close();
  });

  it('reads the source that many times in a row for the next page of the related records', async () => {
    const { app, counter } = await counted();
    const first = searchResultSchema.parse((await counter.roundsOf(async () => await postSearch(app, { sourceId: 'demo', text: TEXT }))).answer.json());
    const { rounds, answer } = await counter.roundsOf(async () => await postMore(app, { sourceId: 'demo', text: TEXT, group: 'related', cursor: first.related.nextCursor, exactRefs: first.exact.map((node) => node.ref) }));
    expect(answer.statusCode).toBe(200);
    expect(rounds).toBe(SOURCE_READS_IN_A_ROW.searchMore);
    await app.close();
  });

  it('reads the source that many times in a row for type-ahead', async () => {
    const { app, counter } = await counted();
    const { rounds, answer } = await counter.roundsOf(async () => await postSearch(app, { sourceId: 'demo', text: TEXT, typeahead: true }));
    expect(answer.statusCode).toBe(200);
    expect(rounds).toBe(SOURCE_READS_IN_A_ROW.typeahead);
    await app.close();
  });
});
