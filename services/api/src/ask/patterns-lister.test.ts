import { describe, expect, it } from 'vitest';
import type { PatternRow, PatternStore } from '../db/patterns-repository.js';
import { AppError } from '../errors.js';
import { createSourceAccess, type SourceAccess } from '../investigations/source-access.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Principal } from '../seams/seams.js';
import { memoryPatterns, type MemoryPatterns } from '../testing/memory-patterns.js';
import { PATTERN_ENTITIES } from '../testing/pattern-fixtures.js';
import { savedMappingOf } from '../testing/saved-pattern-fixtures.js';
import { ASK_PATTERN_CATALOG_MAX, ASK_PATTERN_READ_PAGES, createAskPatternFinder, createAskPatternLister } from './patterns-lister.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'administrator' });
const OWNER = person('0192f000-0000-7000-8000-000000000001');
const OTHER = person('0192f000-0000-7000-8000-000000000002');
const STEP = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'SECRET-REGION' } }, { on: 'relationship', property: 'lane', op: 'between', from: { kind: 'text', value: 'a' }, to: { kind: 'text', value: 'b' } }] };
const DEFINITION = { anchorType: 'maker', steps: [STEP] };
const GONE = { anchorType: 'maker', steps: [{ relationshipTypes: ['GONE'], direction: 'out', arrivesAt: 'maker' }] };
const audit = { record: () => Promise.resolve() };

let named = 0;

function rig(access?: SourceAccess, mapping = savedMappingOf()) {
  const patterns: MemoryPatterns = memoryPatterns();
  const real = createSourceAccess({ mapping, seams: communitySeams(), logger: { warn: () => undefined } });
  let reads = 0;
  const store: Pick<PatternStore, 'listOwnPatterns' | 'readPattern'> = { listOwnPatterns: (query) => ((reads += 1), patterns.listOwnPatterns(query)), readPattern: (id, ownerId) => patterns.readPattern(id, ownerId) };
  const deps = { store, mapping, access: access ?? real };
  const lister = createAskPatternLister(deps);
  const finder = createAskPatternFinder(deps);
  const save = async (definition: Record<string, unknown> = DEFINITION, owner: Principal = OWNER, over: Partial<Parameters<MemoryPatterns['savePattern']>[0]> = {}): Promise<PatternRow> => {
    const saved = await patterns.savePattern({ sourceId: 'demo', name: `SECRET-NAME-${(named += 1)}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition, anchor: null, ...over }, { principal: owner, traceId: 'tr', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    return saved.row;
  };
  const set = (row: PatternRow, change: Partial<PatternRow>): void => void patterns.patternRows.splice(patterns.patternRows.findIndex((held) => held.id === row.id), 1, { ...row, ...change });
  const list = (principal: Principal, sourceId = 'demo') => lister({ principal, traceId: 'tr' })(sourceId);
  const find = (principal: Principal, id: string, sourceId = 'demo') => finder({ principal, traceId: 'tr' })(sourceId, id);
  return { patterns, save, set, list, find, reads: () => reads };
}

const failureOf = async (promise: Promise<unknown>): Promise<AppError | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
};

describe('the saved patterns offered to Ask', () => {
  it('lists the caller’s own patterns, and leaves out the shared and the private patterns of another person, a deleted one and one of another source', async () => {
    const { save, set, list, patterns } = rig();
    const own = await save();
    const sharedByOther = await save(DEFINITION, OTHER);
    set(sharedByOther, { visibility: 'shared' });
    await save(DEFINITION, OTHER);
    const deleted = await save();
    patterns.deletedPatterns.set(deleted.id, { deletedAt: '2026-03-01T00:00:00.000Z', purgeAfter: '2026-04-01T00:00:00.000Z' });
    const elsewhere = await save();
    set(elsewhere, { sourceId: 'other' });
    const listing = await list(OWNER);
    expect(listing.offers.map((offer) => offer.id).sort()).toEqual([own.id]);
    expect(listing.offers.map((offer) => offer.id)).not.toContain(sharedByOther.id);
    expect(listing.cut).toBe(false);
  });

  it('gives each offer its structure as types, directions and kinds, with no property, value or id of an entity', async () => {
    const { save, list } = rig();
    const row = await save();
    const { offers } = await list(OWNER);
    expect(offers).toEqual([{ id: row.id, version: row.version, name: row.name, projection: { kind: 'definition', anchorType: 'maker', startingEntity: 'asked', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', conditions: [{ on: 'neighbor', kind: 'eq' }, { on: 'relationship', kind: 'between' }], windowed: false }] } }]);
    expect(JSON.stringify(offers.map((offer) => offer.projection))).not.toMatch(/SECRET|region|lane/);
  });

  it('tells of the three structural fields of a step, and of nothing else, so two definitions that differ only by them differ in their offers', async () => {
    const { save, list } = rig();
    const links = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
    const plain = await save({ anchorType: 'maker', steps: [links, links, links] });
    const extended = await save({ anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 3 } }, { ...links, after: 'previous' }, { ...links, closesAtAnchor: true }] });
    const other = await save({ anchorType: 'maker', steps: [{ ...links, fan: { atLeast: 4 } }, { ...links, after: 'previous' }, { ...links, closesAtAnchor: true }] });
    const { offers } = await list(OWNER);
    const projectionOf = (id: string) => offers.find((offer) => offer.id === id)?.projection;
    expect(projectionOf(plain.id)).toMatchObject({ steps: [{ windowed: false }, { windowed: false }, { windowed: false }] });
    expect(JSON.stringify(projectionOf(plain.id))).not.toMatch(/fanAtLeast|orderedAfterPrevious|closesAtAnchor/);
    expect(projectionOf(extended.id)).toMatchObject({ steps: [{ fanAtLeast: 3 }, { orderedAfterPrevious: true }, { closesAtAnchor: true }] });
    expect(projectionOf(extended.id)).not.toEqual(projectionOf(other.id));
    expect(JSON.stringify(projectionOf(extended.id))).not.toMatch(/SECRET|previous|seenAt/);
  });

  it('projects the delay of an ordered step as a length and a unit, so that patterns that differ only by it differ, and no time or property name comes with it', async () => {
    const { save, list } = rig();
    const links = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
    const day = await save({ anchorType: 'maker', steps: [links, { ...links, after: 'previous', within: { hours: 24 } }] });
    const week = await save({ anchorType: 'maker', steps: [links, { ...links, after: 'previous', within: { days: 7 } }] });
    const plain = await save({ anchorType: 'maker', steps: [links, { ...links, after: 'previous' }] });
    const { offers } = await list(OWNER);
    const projectionOf = (id: string) => offers.find((offer) => offer.id === id)?.projection;
    expect(projectionOf(day.id)).toMatchObject({ steps: [{}, { orderedAfterPrevious: true, within: { unit: 'hours', amount: 24 } }] });
    expect(projectionOf(week.id)).toMatchObject({ steps: [{}, { within: { unit: 'days', amount: 7 } }] });
    expect(projectionOf(day.id)).not.toEqual(projectionOf(week.id));
    expect(JSON.stringify(projectionOf(plain.id))).not.toContain('within');
    expect(JSON.stringify(projectionOf(day.id))).not.toMatch(/SECRET|seenAt|withinMinutes/);
  });

  it('says a pattern with a held starting entity holds it, and leaves out one that is unavailable against the mapping, without a reason', async () => {
    const { save, list } = rig();
    await save(DEFINITION, OWNER, { anchor: { entityType: 'maker', stableId: 'W-1' } });
    await save(GONE);
    const { offers } = await list(OWNER);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.projection).toMatchObject({ startingEntity: 'held' });
  });

  it('lists the newest changed first and stops at the size of the catalog, and says it was cut', async () => {
    const { save, list } = rig();
    for (let index = 0; index < ASK_PATTERN_CATALOG_MAX + 2; index += 1) await save();
    const listing = await list(OWNER);
    expect(listing.offers).toHaveLength(ASK_PATTERN_CATALOG_MAX);
    expect(listing.cut).toBe(true);
    expect(listing.offers[0]?.name).toBe(`SECRET-NAME-${named}`);
  });

  it('does not say it was cut when the patterns are exactly as many as the catalog holds', async () => {
    const { save, list } = rig();
    for (let index = 0; index < ASK_PATTERN_CATALOG_MAX; index += 1) await save();
    const listing = await list(OWNER);
    expect(listing.offers).toHaveLength(ASK_PATTERN_CATALOG_MAX);
    expect(listing.cut).toBe(false);
  });

  it('reads further pages while the first ones hold unavailable patterns, up to a bound, and says it was cut at the bound', async () => {
    const { save, list, reads } = rig();
    await save();
    for (let index = 0; index < ASK_PATTERN_READ_PAGES * 25; index += 1) await save(GONE);
    const listing = await list(OWNER);
    expect(listing.offers).toEqual([]);
    expect(listing.cut).toBe(true);
    expect(reads()).toBe(ASK_PATTERN_READ_PAGES);
  });

  it('finds an available pattern on a later page when the earlier ones are unavailable', async () => {
    const { save, list } = rig();
    const available = await save();
    for (let index = 0; index < 30; index += 1) await save(GONE);
    const listing = await list(OWNER);
    expect(listing.offers.map((offer) => offer.id)).toEqual([available.id]);
    expect(listing.cut).toBe(false);
  });

  it('answers NOT_FOUND, and reads no pattern, for a source the caller may not read and for a source that is not configured', async () => {
    const denying: SourceAccess = { require: () => Promise.reject(new AppError('NOT_FOUND')), admit: () => undefined, readable: () => Promise.resolve([]) };
    const denied = rig(denying);
    await denied.save();
    expect((await failureOf(denied.list(OWNER)))?.code).toBe('NOT_FOUND');
    expect(denied.reads()).toBe(0);
    const open = rig();
    expect((await failureOf(open.list(OWNER, 'gone')))?.code).toBe('NOT_FOUND');
    expect(open.reads()).toBe(0);
  });

  it('does not read the shared patterns of another person at all, so they neither appear nor use up a page', async () => {
    const { save, set, list, patterns } = rig();
    for (let index = 0; index < 30; index += 1) set(await save(DEFINITION, OTHER), { visibility: 'shared' });
    const own = await save();
    const listing = await list(OWNER);
    expect(listing.offers.map((offer) => offer.id)).toEqual([own.id]);
    expect(listing.cut).toBe(false);
    expect(patterns.patternRows.filter((row) => row.ownerId === OTHER.id)).toHaveLength(30);
  });

  const preset = (presetId: string, templateId: string, params: Record<string, unknown>) => ({ kind: 'preset-run' as const, presetId, templateId, templateVersion: 1, params, definition: null });

  it('offers a saved run of a preset by its template, the types and relationship the preset binds and the numbers it was saved with, and no date, value or limit', async () => {
    const { save, list } = rig();
    await save(DEFINITION, OWNER, preset('linked-makers', 'linked-entities', { direction: 'out', maxHops: 2, window: { from: '2026-01-01', to: '2026-02-01' }, limit: 7 }));
    await save(DEFINITION, OWNER, preset('shared-tools', 'shared-attribute', { minShared: 3, window: { days: 30 } }));
    const projections = (await list(OWNER)).offers.map((offer) => offer.projection);
    expect(projections).toEqual(expect.arrayContaining([
      { kind: 'preset-run', template: 'linked-entities', anchorType: 'maker', startingEntity: 'asked', otherType: 'maker', relationshipTypes: ['LINKS'], direction: 'out', maxHops: 2, windowed: true },
      { kind: 'preset-run', template: 'shared-attribute', anchorType: 'maker', startingEntity: 'asked', otherType: 'tool', relationshipTypes: ['USES_TOOL'], minShared: 3, windowed: true },
    ]));
    expect(JSON.stringify(projections)).not.toMatch(/2026|limit/);
  });

  it('leaves out a saved run of a preset the mapping no longer holds', async () => {
    const { save, list } = rig(undefined, savedMappingOf({ patterns: [] }));
    await save(DEFINITION, OWNER, preset('linked-makers', 'linked-entities', {}));
    expect((await list(OWNER)).offers).toEqual([]);
  });

  describe('found by id for an edit', () => {
    it('finds a pattern the listing no longer reaches, because it is beyond the size of the catalog, and says its structure', async () => {
      const { save, list, find } = rig();
      const old = await save();
      for (let index = 0; index < ASK_PATTERN_CATALOG_MAX + 1; index += 1) await save();
      expect((await list(OWNER)).offers.map((offer) => offer.id)).not.toContain(old.id);
      expect(await find(OWNER, old.id)).toMatchObject({ id: old.id, version: old.version, projection: { kind: 'definition', anchorType: 'maker' } });
    });

    it('finds the caller’s own pattern, and nothing for the shared or private pattern of another person, a deleted one, a pattern of another source, an unknown id or one the mapping no longer supports', async () => {
      const { save, set, find, patterns } = rig();
      const own = await save();
      expect((await find(OWNER, own.id))?.id).toBe(own.id);
      const shared = await save(DEFINITION, OTHER);
      set(shared, { visibility: 'shared' });
      expect(await find(OWNER, shared.id)).toBeUndefined();
      const privateOne = await save(DEFINITION, OTHER);
      expect(await find(OWNER, privateOne.id)).toBeUndefined();
      const deleted = await save();
      patterns.deletedPatterns.set(deleted.id, { deletedAt: '2026-03-01T00:00:00.000Z', purgeAfter: '2026-04-01T00:00:00.000Z' });
      expect(await find(OWNER, deleted.id)).toBeUndefined();
      const elsewhere = await save();
      set(elsewhere, { sourceId: 'other' });
      expect(await find(OWNER, elsewhere.id)).toBeUndefined();
      expect(await find(OWNER, 'not-an-id')).toBeUndefined();
      const gone = await save(GONE);
      expect(await find(OWNER, gone.id)).toBeUndefined();
    });

    it('answers NOT_FOUND for a source the caller may not read or that is not configured', async () => {
      const denying: SourceAccess = { require: () => Promise.reject(new AppError('NOT_FOUND')), admit: () => undefined, readable: () => Promise.resolve([]) };
      const denied = rig(denying);
      const row = await denied.save();
      expect((await failureOf(denied.find(OWNER, row.id)))?.code).toBe('NOT_FOUND');
      expect((await failureOf(rig().find(OWNER, row.id, 'gone')))?.code).toBe('NOT_FOUND');
    });
  });

  it('offers nothing of the owner, the held starting entity or the times: the offer holds the id, version and name and the structure, and no other string', async () => {
    const { save, set, list } = rig();
    const row = await save(DEFINITION, OWNER, { anchor: { entityType: 'maker', stableId: 'HELD-ENTITY-ID' } });
    const { offers } = await list(OWNER);
    expect(offers).toHaveLength(1);
    const { id, name, projection } = offers[0] ?? { id: '', name: '', projection: {} };
    expect(Object.keys(offers[0] ?? {}).sort()).toEqual(['id', 'name', 'projection', 'version']);
    const rest = JSON.stringify(projection);
    for (const secret of [OTHER.id, OTHER.displayName, 'HELD-ENTITY-ID', row.createdAt, row.updatedAt, id, name]) expect(rest).not.toContain(secret);
  });
});
