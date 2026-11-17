import { PATTERN_LIMITS, savedPatternSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { definitionRow, presetRow } from '../testing/saved-pattern-fixtures.js';
import { codeOf, DEFINITION, jsonHeaders, patternApp, reasonOf, type PatternApp } from '../testing/saved-pattern-rig.js';

const save = (context: PatternApp, body: unknown, query = '') => context.app.inject({ method: 'POST', url: `/v1/patterns${query}`, payload: JSON.stringify(body), headers: jsonHeaders });
const definitionBody = (extra: Record<string, unknown> = {}) => ({ sourceId: 'demo', kind: 'definition', name: 'My ring', definition: DEFINITION, ...extra });

describe('POST /v1/patterns, a definition', () => {
  it('saves it privately for the caller, shows it, records one saved event, and reads nothing from the source', async () => {
    const context = await patternApp();
    const response = await save(context, definitionBody());
    expect(response.statusCode).toBe(201);
    const saved = savedPatternSchema.parse(response.json());
    expect(saved).toMatchObject({ sourceId: 'demo', name: 'My ring', kind: 'definition', definition: DEFINITION, askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, version: 1 });
    expect(response.headers['etag']).toBe('"1"');
    expect(context.store.patternRows).toHaveLength(1);
    expect(context.store.patternRows[0]?.definition).toEqual(DEFINITION);
    expect(context.store.patternEvents).toMatchObject([{ patternId: saved.id, sourceId: 'demo', action: 'saved', version: 1 }]);
    expect(context.audit.events.map((event) => event.action)).toEqual(['pattern.save']);
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });

  it('refuses a definition the validator refuses with a plain INVALID_REQUEST, no row and no event, and no value in the body', async () => {
    const context = await patternApp();
    const bad = { anchorType: 'maker', steps: [{ relationshipTypes: ['NOT_THERE'], direction: 'out', arrivesAt: 'secretvalue' }] };
    const response = await save(context, definitionBody({ definition: bad }));
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_REQUEST');
    expect(JSON.stringify(response.json())).not.toContain('secretvalue');
    expect((response.json() as { error: { details?: unknown } }).error.details).toBeUndefined();
    expect(context.store.patternRows).toEqual([]);
    expect(context.store.patternEvents).toEqual([]);
    expect(context.audit.events).toEqual([]);
    await context.app.close();
  });

  it('refuses a condition on a personal-data property with its own reason, and stores nothing', async () => {
    const context = await patternApp();
    const withCondition = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ on: 'neighbor', property: 'phoneNum', op: 'eq', value: { kind: 'text', value: '555-0100' } }] }] };
    const response = await save(context, definitionBody({ definition: withCondition }));
    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe('pattern-personal-condition');
    expect(JSON.stringify(response.json())).not.toContain('555-0100');
    expect(context.store.patternRows).toEqual([]);
    const allowed = { ...withCondition, steps: [{ ...withCondition.steps[0], conditions: [{ on: 'neighbor', property: 'tier', op: 'eq', value: { kind: 'text', value: 'gold' } }] }] };
    expect((await save(context, definitionBody({ definition: allowed }))).statusCode).toBe(201);
    await context.app.close();
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a name of 101 characters', { name: 'x'.repeat(PATTERN_LIMITS.nameLength + 1) }],
    ['a name of 101 non-BMP characters', { name: '\u{1F600}'.repeat(PATTERN_LIMITS.nameLength + 1) }],
    ['an unknown key', { extra: true }],
    ['a missing definition', { definition: undefined }],
  ])('refuses %s', async (_label, change) => {
    const context = await patternApp();
    const response = await save(context, definitionBody(change));
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_REQUEST');
    expect(context.store.patternRows).toEqual([]);
    await context.app.close();
  });

  it('saves a definition with a time order, a fan and a cycle as it was sent, shows it unchanged in the answer and in the row, and refuses a fan above the source’s count cap with no row', async () => {
    const context = await patternApp();
    const links = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
    const extended = { anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 3 } }, { ...links, after: 'previous' }, { ...links, closesAtAnchor: true }] };
    const response = await save(context, definitionBody({ definition: extended }));
    expect(response.statusCode).toBe(201);
    const saved = savedPatternSchema.parse(response.json());
    expect(saved.kind === 'definition' ? saved.definition : undefined).toEqual(extended);
    expect(context.store.patternRows[0]?.definition).toEqual(extended);
    const over = { anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 100_000 } }] };
    expect((await save(context, definitionBody({ definition: over, name: 'Too wide' }))).statusCode).toBe(400);
    expect(context.store.patternRows).toHaveLength(1);
    await context.app.close();
  });

  it('lists rows stored before the extension and one with the three added fields, and keeps the added fields whole through a change and a copy', async () => {
    const context = await patternApp();
    const links = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
    const extended = { anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 3 } }, { ...links, after: 'previous' }, { ...links, closesAtAnchor: true }] };
    const owner = '0192f000-0000-7000-8000-000000000001';
    const stored = [definitionRow({ id: '0192f000-0000-7000-8000-0000000000c1', name: 'Stored before', ownerId: owner, definition: DEFINITION }), presetRow({ id: '0192f000-0000-7000-8000-0000000000c2', name: 'Stored preset', ownerId: owner })];
    context.store.patternRows.push(...stored);
    const listed = await context.app.inject({ method: 'GET', url: '/v1/patterns?sourceId=demo' });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: { name: string; availability: { status: string } }[] }).items.map((item) => [item.name, item.availability.status]).sort()).toEqual([['Stored before', 'available'], ['Stored preset', 'available']]);
    const saved = savedPatternSchema.parse((await save(context, definitionBody({ definition: extended }))).json());
    const renamed = await context.app.inject({ method: 'PUT', url: `/v1/patterns/${saved.id}`, payload: JSON.stringify({ expectedVersion: 1, name: 'Renamed' }), headers: jsonHeaders });
    expect(renamed.statusCode).toBe(200);
    const same = savedPatternSchema.parse(renamed.json());
    expect(same.kind === 'definition' ? same.definition : undefined).toEqual(extended);
    const less = { anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 5 } }, { ...links, after: 'previous' }, { ...links, closesAtAnchor: true }] };
    const changed = await context.app.inject({ method: 'PUT', url: `/v1/patterns/${saved.id}`, payload: JSON.stringify({ expectedVersion: 2, definition: less }), headers: jsonHeaders });
    expect(savedPatternSchema.parse(changed.json())).toMatchObject({ version: 3, definition: less });
    const copied = await context.app.inject({ method: 'POST', url: `/v1/patterns/${saved.id}/copy` });
    expect(copied.statusCode).toBe(201);
    expect(savedPatternSchema.parse(copied.json())).toMatchObject({ definition: less });
    expect(context.store.patternRows.filter((row) => row.name.startsWith('Renamed')).map((row) => row.definition)).toEqual([less, less]);
    await context.app.close();
  });

  it('saves a definition with a delay as it was sent, lists it, and keeps it whole through a rename, a change that keeps it and a copy, and refuses one that has none of an order', async () => {
    const context = await patternApp();
    const links = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
    const bounded = { anchorType: 'maker', steps: [links, { ...links, after: 'previous', within: { hours: 24 } }] };
    const saved = savedPatternSchema.parse((await save(context, definitionBody({ definition: bounded }))).json());
    expect(saved.kind === 'definition' ? saved.definition : undefined).toEqual(bounded);
    expect(context.store.patternRows[0]?.definition).toEqual(bounded);
    const listed = await context.app.inject({ method: 'GET', url: '/v1/patterns?sourceId=demo' });
    expect((listed.json() as { items: { kind: string; definition?: unknown; availability: { status: string } }[] }).items[0]).toMatchObject({ definition: bounded, availability: { status: 'available' } });
    const renamed = await context.app.inject({ method: 'PUT', url: `/v1/patterns/${saved.id}`, payload: JSON.stringify({ expectedVersion: 1, name: 'Renamed' }), headers: jsonHeaders });
    expect(savedPatternSchema.parse(renamed.json())).toMatchObject({ definition: bounded });
    const longer = { anchorType: 'maker', steps: [links, { ...links, after: 'previous', within: { days: 3 } }] };
    const changed = await context.app.inject({ method: 'PUT', url: `/v1/patterns/${saved.id}`, payload: JSON.stringify({ expectedVersion: 2, definition: longer }), headers: jsonHeaders });
    expect(savedPatternSchema.parse(changed.json())).toMatchObject({ definition: longer });
    const copied = await context.app.inject({ method: 'POST', url: `/v1/patterns/${saved.id}/copy` });
    expect(savedPatternSchema.parse(copied.json())).toMatchObject({ definition: longer });
    const loose = { anchorType: 'maker', steps: [links, { ...links, within: { hours: 24 } }] };
    expect((await save(context, definitionBody({ definition: loose, name: 'No order' }))).statusCode).toBe(400);
    expect(context.store.patternRows).toHaveLength(2);
    await context.app.close();
  });

  it('refuses a query string', async () => {
    const context = await patternApp();
    expect(codeOf(await save(context, definitionBody(), '?x=1'))).toBe('INVALID_REQUEST');
    await context.app.close();
  });

  it('accepts a name of 100 non-BMP characters with spaces around it and stores it trimmed', async () => {
    const context = await patternApp();
    const name = '\u{1F600}'.repeat(PATTERN_LIMITS.nameLength);
    const response = await save(context, definitionBody({ name: `  ${name}  ` }));
    expect(response.statusCode).toBe(201);
    expect(context.store.patternRows[0]?.name).toBe(name);
    await context.app.close();
  });

  it('answers NOT_FOUND for an unknown source', async () => {
    const context = await patternApp();
    const response = await save(context, definitionBody({ sourceId: 'nowhere' }));
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('NOT_FOUND');
    await context.app.close();
  });

  it('answers NOT_FOUND for a source the caller may not read, and writes nothing', async () => {
    const context = await patternApp({ deny: true });
    const response = await save(context, definitionBody());
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('NOT_FOUND');
    expect(context.store.patternRows).toEqual([]);
    expect(context.store.patternEvents).toEqual([]);
    expect(context.audit.events.map((event) => event.result)).toEqual(['denied']);
    await context.app.close();
  });

  it('refuses the 201st pattern of the caller on a source with pattern-limit and no row', async () => {
    const context = await patternApp();
    const owner = (await context.store.current()).principal;
    for (let index = 0; index < PATTERN_LIMITS.patternsPerSource; index += 1) {
      const filled = await context.store.savePattern({ sourceId: 'demo', name: `p${index}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null }, { principal: owner, traceId: 't', audit: context.audit.sink });
      expect(filled.outcome).toBe('saved');
    }
    const response = await save(context, definitionBody({ name: 'one too many' }));
    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe('pattern-limit');
    expect(context.store.patternRows).toHaveLength(PATTERN_LIMITS.patternsPerSource);
    await context.app.close();
  });

  it('keeps the pattern and answers 201 when the history cannot take the event, and still passes the audit event on', async () => {
    const context = await patternApp({ failPatternEvent: true });
    const response = await save(context, definitionBody());
    expect(response.statusCode).toBe(201);
    expect(context.store.patternRows).toHaveLength(1);
    expect(context.store.patternEvents).toEqual([]);
    expect(context.audit.events.map((event) => event.action)).toEqual(['pattern.save']);
    await context.app.close();
  });
});
