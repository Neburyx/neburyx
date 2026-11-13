import { savedPatternSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { makeToken } from '../reference/token.js';
import { sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';
import { linkedEntitiesTemplate } from '../gate/templates/linked-entities.js';
import { codeOf, DEFINITION, jsonHeaders, patternApp, SAVED_PATTERN_MAPPING, TEST_KEYS, type PatternApp } from '../testing/saved-pattern-rig.js';
import { templateVersionNumber } from './saved-pattern-service.js';

const save = (context: PatternApp, body: unknown) => context.app.inject({ method: 'POST', url: '/v1/patterns', payload: JSON.stringify(body), headers: jsonHeaders });
let named = 0;
const presetBody = (extra: Record<string, unknown> = {}) => ({ sourceId: 'demo', kind: 'preset-run', name: `Linked makers ${(named += 1)}`, presetId: 'linked-makers', params: { maxHops: 2 }, ...extra });

describe('POST /v1/patterns, a preset run', () => {
  it('saves a run of a preset of each template with its template, version and parameters, and no entity id', async () => {
    const context = await patternApp();
    const linked = await save(context, presetBody());
    expect(linked.statusCode).toBe(201);
    expect(savedPatternSchema.parse(linked.json())).toMatchObject({ kind: 'preset-run', presetId: 'linked-makers', templateId: 'linked-entities', templateVersion: 1, params: { maxHops: 2 }, askForStartingEntity: true, anchor: null, version: 1 });
    const shared = await save(context, presetBody({ presetId: 'shared-tools', params: { minShared: 2 } }));
    expect(shared.statusCode).toBe(201);
    expect(savedPatternSchema.parse(shared.json())).toMatchObject({ presetId: 'shared-tools', templateId: 'shared-attribute', params: { minShared: 2 } });
    expect(context.store.patternRows.map((row) => row.params)).toEqual([{ maxHops: 2 }, { minShared: 2 }]);
    expect(context.store.patternRows.every((row) => row.definition === null && row.anchorStableId === null)).toBe(true);
    expect(context.store.patternEvents.map((event) => [event.action, event.version])).toEqual([['saved', 1], ['saved', 1]]);
    expect(JSON.stringify(context.store.patternEvents)).not.toContain('maxHops');
    expect(context.executor.calls).toEqual([]);
    await context.app.close();
  });

  it.each([
    ['a ref in the parameters', { params: { ref: { entityType: 'maker', stableId: 'm-1' } } }],
    ['an unknown key', { params: { nope: 1 } }],
    ['a value the template refuses', { params: { maxHops: 99 } }],
    ['a target type, which the preset binds', { params: { targetType: 'maker' } }],
    ['a relationship type, which the preset binds', { params: { via: ['LINKS'] } }],
    ['a preset the source does not have', { presetId: 'nope' }],
  ])('refuses %s with no row and no event', async (_label, change) => {
    const context = await patternApp();
    const response = await save(context, presetBody(change));
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_REQUEST');
    expect(context.store.patternRows).toEqual([]);
    expect(context.store.patternEvents).toEqual([]);
    await context.app.close();
  });

  it('refuses the attribute type and the relationship type of a shared-attribute preset, which the preset binds', async () => {
    const context = await patternApp();
    for (const params of [{ attributeType: 'tool' }, { via: 'USES_TOOL' }]) expect((await save(context, presetBody({ presetId: 'shared-tools', params }))).statusCode).toBe(400);
    expect(context.store.patternRows).toEqual([]);
    await context.app.close();
  });

  it('has an integer version for the template of every preset the API offers', () => {
    expect(templateVersionNumber(sharedAttributeTemplate.version)).toBeGreaterThanOrEqual(1);
    expect(templateVersionNumber(linkedEntitiesTemplate.version)).toBeGreaterThanOrEqual(1);
    expect(() => templateVersionNumber('1.2')).toThrow();
    expect(() => templateVersionNumber('0')).toThrow();
  });
});

describe('the held starting entity', () => {
  it('is held when sent, for either kind, of the type the pattern starts at, and is shown as it was sent', async () => {
    const context = await patternApp();
    const preset = await save(context, presetBody({ anchor: { entityType: 'maker', stableId: 'm-1' } }));
    expect(preset.statusCode).toBe(201);
    expect(savedPatternSchema.parse(preset.json())).toMatchObject({ askForStartingEntity: false, anchor: { entityType: 'maker', stableId: 'm-1' } });
    const definition = await save(context, { sourceId: 'demo', kind: 'definition', name: 'Ring', definition: DEFINITION, anchor: { entityType: 'maker', stableId: 'm-2' } });
    expect(definition.statusCode).toBe(201);
    expect(context.store.patternRows.map((row) => [row.askForStartingEntity, row.anchorEntityType, row.anchorStableId])).toEqual([[false, 'maker', 'm-1'], [false, 'maker', 'm-2']]);
    await context.app.close();
  });

  it('holds a keyed type only as a token of this deployment, never the raw value', async () => {
    const context = await patternApp();
    const keyed = { anchorType: 'handle', steps: [{ relationshipTypes: ['CALLS'], direction: 'out', arrivesAt: 'maker' }] };
    const raw = await save(context, { sourceId: 'demo', kind: 'definition', name: 'Calls', definition: keyed, anchor: { entityType: 'handle', stableId: '555-0100' } });
    expect(raw.statusCode).toBe(400);
    expect(context.store.patternRows).toEqual([]);
    const token = makeToken(TEST_KEYS, { sourceId: 'demo', entityType: 'handle' }, '555-0100');
    const held = await save(context, { sourceId: 'demo', kind: 'definition', name: 'Calls', definition: keyed, anchor: { entityType: 'handle', stableId: token } });
    expect(held.statusCode).toBe(201);
    expect(context.store.patternRows[0]?.anchorStableId).toBe(token);
    expect(JSON.stringify(context.store.patternRows)).not.toContain('555-0100');
    expect(savedPatternSchema.parse(held.json()).anchor).toEqual({ entityType: 'handle', stableId: token });
    await context.app.close();
  });

  it.each([
    ['a type the mapping does not name', { entityType: 'nothing', stableId: 'x' }],
    ['a type that is not the type the pattern starts at', { entityType: 'tool', stableId: 'x' }],
  ])('refuses %s and stores nothing', async (_label, anchor) => {
    const context = await patternApp();
    expect((await save(context, presetBody({ anchor }))).statusCode).toBe(400);
    expect((await save(context, { sourceId: 'demo', kind: 'definition', name: 'Ring', definition: DEFINITION, anchor })).statusCode).toBe(400);
    expect(context.store.patternRows).toEqual([]);
    await context.app.close();
  });

  it('is a mapped entity type of the source (the preset names the type the pattern starts at)', () => {
    expect(SAVED_PATTERN_MAPPING.sources[0]?.presets.map((preset) => preset.bind['anchor'])).toEqual(['maker', 'maker']);
  });
});
