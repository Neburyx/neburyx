import { savedPatternSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { codeOf, jsonHeaders, patternApp, type PatternApp } from '../testing/saved-pattern-rig.js';

const LINKS = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
const definition = (...steps: Record<string, unknown>[]) => ({ anchorType: 'maker', steps });
const post = (context: PatternApp, url: string, body: string | object, headers: Record<string, string> = jsonHeaders) => context.app.inject({ method: 'POST', url, payload: typeof body === 'string' ? body : JSON.stringify(body), headers });

const HOSTILE: readonly [string, Record<string, unknown>[]][] = [
  ['an order on the first step', [{ ...LINKS, after: 'previous' }]],
  ['an order with another word', [LINKS, { ...LINKS, after: 'next' }]],
  ['an order that is not text', [LINKS, { ...LINKS, after: true }]],
  ['a fan below 2', [{ ...LINKS, fan: { atLeast: 1 } }]],
  ['a fan that is not whole', [{ ...LINKS, fan: { atLeast: 2.5 } }]],
  ['a fan above the count cap', [{ ...LINKS, fan: { atLeast: 100_000 } }]],
  ['a fan that is a number', [{ ...LINKS, fan: 3 }]],
  ['a fan with an unknown key', [{ ...LINKS, fan: { atLeast: 3, extra: 1 } }]],
  ['a closing that is false', [LINKS, { ...LINKS, closesAtAnchor: false }]],
  ['a closing on one step', [{ ...LINKS, closesAtAnchor: true }]],
  ['a closing on a step that is not the last', [LINKS, { ...LINKS, closesAtAnchor: true }, LINKS]],
  ['a closing at another type', [{ relationshipTypes: ['USES_TOOL'], direction: 'out', arrivesAt: 'tool' }, { relationshipTypes: ['STOCKED_AT'], direction: 'out', arrivesAt: 'shop', closesAtAnchor: true }]],
  ['a delay on the first step', [{ ...LINKS, within: { hours: 24 } }]],
  ['a delay on a step with no order', [LINKS, { ...LINKS, within: { hours: 24 } }]],
  ['a delay with two units', [LINKS, { ...LINKS, after: 'previous', within: { hours: 1, days: 1 } }]],
  ['a delay in a unit that is not known', [LINKS, { ...LINKS, after: 'previous', within: { weeks: 1 } }]],
  ['a delay that is not whole', [LINKS, { ...LINKS, after: 'previous', within: { hours: 1.5 } }]],
  ['a delay of zero', [LINKS, { ...LINKS, after: 'previous', within: { minutes: 0 } }]],
  ['a negative delay', [LINKS, { ...LINKS, after: 'previous', within: { hours: -1 } }]],
  ['a delay above the ceiling', [LINKS, { ...LINKS, after: 'previous', within: { hours: 8761 } }]],
  ['a delay in a unit every object has', [LINKS, { ...LINKS, after: 'previous', within: { valueOf: 1 } }]],
  ['a delay in the unit constructor', [LINKS, { ...LINKS, after: 'previous', within: { constructor: 1 } }]],
  ['a delay that is text', [LINKS, { ...LINKS, after: 'previous', within: { hours: '24' } }]],
  ['a delay that holds an object', [LINKS, { ...LINKS, after: 'previous', within: { hours: { value: 24 } } }]],
  ['a delay that is a number', [LINKS, { ...LINKS, after: 'previous', within: 24 }]],
  ['a delay with a run-time field of its own', [LINKS, { ...LINKS, after: 'previous', withinMinutes: 60 }]],
  ['an order on a relationship the mapping gives no time', [LINKS, { relationshipTypes: ['ALLIES'], direction: 'out', arrivesAt: 'maker', after: 'previous' }]],
];

describe('an invalid fan, order or closing, sent to every route that takes a definition', () => {
  it.each(HOSTILE)('is refused by validate and preview with problems, and by run, save and change with INVALID_REQUEST, and the source is never read: %s', async (_label, steps) => {
    const context = await patternApp();
    const asked = definition(...steps);
    for (const url of ['/v1/patterns/validate', '/v1/patterns/preview']) {
      const response = await post(context, url, { sourceId: 'demo', definition: asked });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toMatchObject({ status: 'invalid' });
    }
    const run = await post(context, '/v1/patterns/run', { sourceId: 'demo', definition: asked, anchor: { entityType: 'maker', stableId: 'x' } }, { ...jsonHeaders, 'idempotency-key': 'extension-hostile-run-key' });
    expect(run.statusCode).toBe(400);
    expect(codeOf(run)).toBe('INVALID_REQUEST');
    const save = await post(context, '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: 'Hostile', definition: asked });
    expect(save.statusCode).toBe(400);
    expect(context.store.patternRows).toEqual([]);
    const good = savedPatternSchema.parse((await post(context, '/v1/patterns', { sourceId: 'demo', kind: 'definition', name: 'Fine', definition: definition(LINKS) })).json());
    const change = await context.app.inject({ method: 'PUT', url: `/v1/patterns/${good.id}`, payload: JSON.stringify({ expectedVersion: 1, definition: asked }), headers: jsonHeaders });
    expect(change.statusCode).toBe(400);
    expect(context.store.patternRows.map((row) => row.definition)).toEqual([definition(LINKS)]);
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });

  it('is decided on the definition the body parser leaves when a key is given twice: the last one counts, and it is validated like any other', async () => {
    const context = await patternApp();
    const body = (first: number, second: number) => `{"sourceId":"demo","kind":"definition","name":"Twice ${first}${second}","definition":{"anchorType":"maker","steps":[{"relationshipTypes":["LINKS"],"direction":"out","arrivesAt":"maker","fan":{"atLeast":${first}},"fan":{"atLeast":${second}}}]}}`;
    const refused = await post(context, '/v1/patterns', body(3, 1));
    expect(refused.statusCode).toBe(400);
    const accepted = await post(context, '/v1/patterns', body(1, 3));
    expect(accepted.statusCode).toBe(201);
    expect(context.store.patternRows[0]?.definition).toEqual(definition({ ...LINKS, fan: { atLeast: 3 } }));
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });
});
