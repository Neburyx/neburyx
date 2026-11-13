import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { PatternRow, PatternStore } from '../db/patterns-repository.js';
import { createTemplateRunService } from '../graph/template-run-service.js';
import type { TemplateProbe } from '../graph/template-probes.js';
import { createStoredReferences } from '../investigations/stored-references.js';
import { createSourceAccess, type SourceAccess } from '../investigations/source-access.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Principal } from '../seams/seams.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { LINKED_PRESET, linkedRow } from '../testing/linked-entities-fixtures.js';
import { memoryPatterns, type MemoryPatterns } from '../testing/memory-patterns.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, oneStepRow } from '../testing/pattern-fixtures.js';
import { savedMappingOf } from '../testing/saved-pattern-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createPatternRunService } from './run-service.js';
import { createSavedPatternRunService } from './saved-run-service.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'administrator' });
const OWNER = person('0192f000-0000-7000-8000-000000000001');
const OTHER = person('0192f000-0000-7000-8000-000000000002');
const LINKS_STEP = { relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' };
const DEFINITION = { anchorType: 'maker', steps: [LINKS_STEP] };
const ENTITY = { entityType: 'maker', stableId: 'W-1' };
const NOW = new Date('2026-03-10T12:00:00.000Z');

interface Options {
  readonly mapping?: ReturnType<typeof savedMappingOf>;
  readonly probes?: ReadonlyMap<string, TemplateProbe>;
  readonly deny?: boolean;
  readonly failRecord?: boolean;
  readonly patternRows?: readonly Record<string, unknown>[];
}

function rig(options: Options = {}) {
  const mapping = options.mapping ?? savedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> =>
    Promise.resolve({ status: 'rows', rows: call.templateId === 'pattern' ? (options.patternRows ?? [oneStepRow('W-1', 'W-2')]) : call.templateId === 'linked-entities' ? [linkedRow({ anchor: 'W-1', match: 'W-2' })] : [] });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { ...defaults, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) }, ...(options.deny === true ? { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'no' }) } } : {}) };
  const parts = testSourceGate(mapping, { executor, seams: { policy: seams.policy, coordinator: defaults.coordinator, audit: seams.audit } });
  const real = createSourceAccess({ mapping, seams, logger: { warn: () => undefined } });
  const counted = { requests: 0 };
  const access: SourceAccess = {
    require: (call) => (call.rate === 'count' && (counted.requests += 1), real.require(call)),
    admit: (call) => ((counted.requests += 1), real.admit(call)),
    readable: (call) => real.readable(call),
  };
  const probes = options.probes ?? new Map<string, TemplateProbe>();
  const patternRuns = createPatternRunService({ gate: parts.gate, mapping, access, now: () => NOW, probes });
  const templateRuns = createTemplateRunService({ gate: parts.gate, mapping, access, now: () => NOW, probes });
  const patterns: MemoryPatterns = memoryPatterns();
  const store: Pick<PatternStore, 'readRunnablePattern' | 'recordPatternRun'> = options.failRecord === true ? { readRunnablePattern: patterns.readRunnablePattern, recordPatternRun: () => Promise.reject(new Error('the store is down')) } : patterns;
  const warned: unknown[] = [];
  const service = createSavedPatternRunService({ store, mapping, access, references: createStoredReferences(mapping, TEST_REFERENCE_KEYS), patternRuns, templateRuns, logger: { warn: (fields: unknown) => void warned.push(fields) } as never });
  const audit = { record: () => Promise.resolve() };
  const save = async (over: Partial<Parameters<MemoryPatterns['savePattern']>[0]> = {}, owner: Principal = OWNER): Promise<PatternRow> => {
    const saved = await patterns.savePattern({ sourceId: 'demo', name: 'p', kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null, ...over }, { principal: owner, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    return saved.row;
  };
  const share = (row: PatternRow): void => void patterns.patternRows.splice(patterns.patternRows.findIndex((held) => held.id === row.id), 1, { ...row, visibility: 'shared' });
  const saveRun = async (pattern: PatternRow, over: Record<string, unknown> = {}, principal: Principal = OWNER) => service.run({ traceId: 'tr', principal, pattern, mask: false, anchor: ENTITY, ...over });
  const calls = (templateId: string) => executor.calls.filter((call) => call.templateId === templateId);
  return { service, patterns, executor, events, counted, warned, save, share, saveRun, patternRuns, templateRuns, calls, access };
}

const preset = (over: Record<string, unknown> = {}) => ({ kind: 'preset-run' as const, presetId: LINKED_PRESET.id, templateId: 'linked-entities', templateVersion: 1, params: {}, definition: null, ...over });
const failureOf = async (promise: Promise<unknown>): Promise<AppError | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
};

describe('finding the pattern to run', () => {
  it('finds the caller’s own pattern and a shared one, and answers NOT_FOUND for another person’s private pattern, an unknown id and an id that is not a uuid', async () => {
    const { service, save, share } = rig();
    const row = await save();
    expect((await service.find({ principal: OWNER, id: row.id })).id).toBe(row.id);
    expect((await failureOf(service.find({ principal: OTHER, id: row.id })))?.code).toBe('NOT_FOUND');
    share(row);
    expect((await service.find({ principal: OTHER, id: row.id })).id).toBe(row.id);
    expect((await failureOf(service.find({ principal: OWNER, id: 'nothing' })))?.code).toBe('NOT_FOUND');
  });

  it('says a replay may be answered only while the caller still finds the pattern and the source is still configured', async () => {
    const { service, save, share, patterns } = rig();
    const row = await save();
    share(row);
    expect(await service.stillRunnable({ principal: OTHER, id: row.id, sourceId: 'demo' })).toBe(true);
    expect(await service.stillRunnable({ principal: OTHER, id: row.id, sourceId: 'gone' })).toBe(false);
    patterns.patternRows.splice(patterns.patternRows.findIndex((held) => held.id === row.id), 1, { ...row, visibility: 'private' });
    expect(await service.stillRunnable({ principal: OTHER, id: row.id, sourceId: 'demo' })).toBe(false);
  });
});

describe('running a saved pattern: access and what is settled before a read', () => {
  it('answers NOT_FOUND for a runner who may not read the source, audits the denial under the action of the kind, and reads nothing', async () => {
    const denied = rig({ deny: true });
    const row = await denied.save();
    expect((await failureOf(denied.saveRun(row)))?.code).toBe('NOT_FOUND');
    expect(denied.events).toMatchObject([{ action: 'pattern.run', result: 'denied' }]);
    const presetDenied = rig({ deny: true });
    const presetRow = await presetDenied.save(preset());
    await failureOf(presetDenied.saveRun(presetRow));
    expect(presetDenied.events).toMatchObject([{ action: 'entity.linked_entities_run', result: 'denied' }]);
    expect(denied.executor.calls.filter((call) => call.templateId === 'pattern')).toHaveLength(0);
  });

  it('runs a shared pattern for another person under that person’s access, and writes nothing to the pattern', async () => {
    const { saveRun, save, share, patterns } = rig();
    const row = await save();
    share(row);
    const answer = await saveRun(row, {}, OTHER);
    expect(answer.status).toBe('ok');
    expect((await patterns.readRunnablePattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
  });

  it('says a pattern the mapping no longer supports is unavailable, reads nothing, counts the request once and writes no audit event', async () => {
    const lost = savedMappingOf({ entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS.filter((row) => row.type !== 'LINKS'), patterns: [] });
    const { saveRun, save, executor, counted, events, patterns } = rig({ mapping: lost });
    const row = await save();
    const answer = await saveRun(row);
    expect(answer).toEqual({ status: 'unavailable', reasons: [{ code: 'unknown-relationship-type', path: ['steps', 0, 'relationshipTypes', 0] }] });
    expect(executor.calls.filter((call) => call.templateId === 'pattern' || call.templateId === 'linked-entities')).toHaveLength(0);
    expect(counted.requests).toBe(1);
    expect(events).toEqual([]);
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
  });

  it('counts an ok run and a heavy stop once each', async () => {
    const okRig = rig();
    await okRig.saveRun(await okRig.save());
    expect(okRig.counted.requests).toBe(1);
    const heavyProbe: TemplateProbe = { templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches: 600, bounded: false, notices: [] }) };
    const heavyRig = rig({ probes: new Map([['pattern', heavyProbe]]) });
    expect((await heavyRig.saveRun(await heavyRig.save())).status).toBe('heavy');
    expect(heavyRig.counted.requests).toBe(1);
  });
});

describe('running a saved pattern: the starting entity', () => {
  it('runs from the entity of the request, and else from the one the pattern holds', async () => {
    const { saveRun, save, calls } = rig();
    const holding = await save({ anchor: { entityType: 'maker', stableId: 'H-9' } });
    await saveRun(holding, { anchor: undefined });
    expect(calls('pattern')[0]?.parameters['stableId']).toBe('H-9');
    await saveRun(holding, { anchor: { entityType: 'maker', stableId: 'W-3' } });
    expect(calls('pattern')[1]?.parameters['stableId']).toBe('W-3');
  });

  it('refuses a run with no entity at all and one of another type than the pattern starts at, and reads nothing', async () => {
    const { saveRun, save, executor } = rig();
    const row = await save();
    expect((await failureOf(saveRun(row, { anchor: undefined })))?.code).toBe('INVALID_REQUEST');
    expect((await failureOf(saveRun(row, { anchor: { entityType: 'tool', stableId: 'T-1' } })))?.code).toBe('INVALID_REQUEST');
    const linked = await save(preset());
    expect((await failureOf(saveRun(linked, { anchor: { entityType: 'nothing', stableId: 'T-1' } })))?.code).toBe('INVALID_REQUEST');
    expect(executor.calls.filter((call) => call.templateId === 'pattern' || call.templateId === 'linked-entities')).toHaveLength(0);
  });
});

describe('running a saved pattern: what it returns', () => {
  it('returns for a definition exactly what the run service returns for the same definition, entity, limit and mask', async () => {
    const { saveRun, save, patternRuns } = rig();
    const row = await save();
    const direct = await patternRuns.run({ traceId: 'tr', principal: OWNER, sourceId: 'demo', definition: DEFINITION, anchor: ENTITY, limit: 7, mask: true });
    expect(await saveRun(row, { limit: 7, mask: true })).toEqual(direct);
  });

  it('returns for a saved run of a preset exactly what the template run returns, with the request’s limit replacing the stored one and the entity as ref', async () => {
    const { saveRun, save, templateRuns, calls } = rig();
    const row = await save(preset({ params: { limit: 3, direction: 'out' } }));
    const direct = await templateRuns.run({ traceId: 'tr', principal: OWNER, sourceId: 'demo', id: LINKED_PRESET.id, params: { direction: 'out', limit: 9, ref: ENTITY }, mask: false });
    expect(await saveRun(row, { limit: 9 })).toEqual(direct);
    expect(calls('linked-entities').at(-1)?.parameters).toMatchObject({ direction: 'out', limit: 9, stableId: 'W-1' });
    await saveRun(row);
    expect(calls('linked-entities').at(-1)?.parameters['limit']).toBe(3);
  });

  it('stops as heavy over the threshold, reads a first page of at most 25 for a continue, and gives the run route’s refusals', async () => {
    const probe: TemplateProbe = { templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches: 600, bounded: false, notices: [] }) };
    const { saveRun, save, calls } = rig({ probes: new Map([['pattern', probe]]) });
    const row = await save();
    expect(await saveRun(row)).toMatchObject({ status: 'heavy', threshold: 500, continueLimit: 25 });
    const continued = await saveRun(row, { continue: true, limit: 40 });
    expect(continued.status).toBe('ok');
    expect(calls('pattern').at(-1)?.parameters['limit']).toBe(25);
    const tight = rig({ mapping: savedMappingOf({ budgets: { max_hops: 1 } }) });
    const two = await tight.save({ definition: { anchorType: 'maker', steps: [LINKS_STEP, LINKS_STEP] } });
    expect(await failureOf(tight.saveRun(two))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 1 } });
  });

  it('refuses a condition on a personal-data property while the runner masks, as the run route does, and does not call that unavailable', async () => {
    const personal = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'region', class: 'text' }] } : entity));
    const { saveRun, save, executor } = rig({ mapping: savedMappingOf({ entities: personal }) });
    const row = await save({ definition: { anchorType: 'maker', steps: [{ ...LINKS_STEP, conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }] }] } });
    expect((await failureOf(saveRun(row, { mask: true })))?.code).toBe('INVALID_REQUEST');
    expect(executor.calls.filter((call) => call.templateId === 'pattern')).toHaveLength(0);
    expect((await saveRun(row, { mask: false })).status).toBe('ok');
  });
});

describe('running a saved pattern: the time of the last run', () => {
  it('is recorded after the creator’s run that ran, also for their own shared pattern and after a continue that followed a heavy stop', async () => {
    const probe: TemplateProbe = { templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches: 600, bounded: false, notices: [] }) };
    const { saveRun, save, share, patterns } = rig({ probes: new Map([['pattern', probe]]) });
    const row = await save();
    expect((await saveRun(row)).status).toBe('heavy');
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
    await saveRun(row, { continue: true });
    const first = (await patterns.readPattern(row.id, OWNER.id))?.lastRunAt;
    expect(first).not.toBeNull();
    share(row);
    await saveRun(row, { continue: true });
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).not.toBe(first);
  });

  it('is not recorded after another person’s run, an unavailable answer or a refusal', async () => {
    const { saveRun, save, share, patterns } = rig();
    const row = await save();
    share(row);
    await saveRun(row, {}, OTHER);
    await failureOf(saveRun(row, { anchor: undefined }));
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
  });

  it('does not change the answer when it cannot be recorded, and logs the failure', async () => {
    const { saveRun, save, warned } = rig({ failRecord: true });
    const answer = await saveRun(await save());
    expect(answer.status).toBe('ok');
    expect(warned).toMatchObject([{ event: 'pattern.last_run_failed' }]);
  });
});

describe('running a saved pattern: the pages after the first', () => {
  const rows = ['W-2', 'W-3', 'W-4'].map((end) => oneStepRow('W-1', end));

  it('is served a cursor of the run route for the same definition and entity, and one of its own for the next page, recording the time of the last run on the first page only', async () => {
    const { saveRun, save, patterns, patternRuns } = rig({ patternRows: rows });
    const row = await save();
    const direct = (await patternRuns.run({ traceId: 'tr', principal: OWNER, sourceId: 'demo', definition: DEFINITION, anchor: ENTITY, limit: 2, mask: false })) as { nextCursor?: string };
    expect(direct.nextCursor).toBeDefined();
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
    const second = await saveRun(row, { limit: 2, cursor: direct.nextCursor });
    expect(second).toMatchObject({ status: 'ok' });
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
    const first = (await saveRun(row, { limit: 2 })) as { nextCursor?: string };
    expect(first.nextCursor).toBeDefined();
    const recorded = (await patterns.readPattern(row.id, OWNER.id))?.lastRunAt;
    expect(recorded).not.toBeNull();
    await saveRun(row, { limit: 2, cursor: first.nextCursor });
    expect((await patterns.readPattern(row.id, OWNER.id))?.lastRunAt).toBe(recorded);
  });

  it('refuses a cursor for a saved run of a preset as INVALID_REQUEST before any read, with no gate or executor call', async () => {
    const { saveRun, save, executor } = rig({ patternRows: rows });
    const row = await save(preset());
    const before = executor.calls.length;
    expect((await failureOf(saveRun(row, { cursor: 'v1.x.y' })))?.code).toBe('INVALID_REQUEST');
    expect(executor.calls).toHaveLength(before);
  });

  it('is refused as invalidated for a cursor made for another entity', async () => {
    const { saveRun, save } = rig({ patternRows: rows });
    const row = await save();
    const first = (await saveRun(row, { limit: 2 })) as { nextCursor?: string };
    expect((await failureOf(saveRun(row, { limit: 2, cursor: first.nextCursor, anchor: { entityType: 'maker', stableId: 'W-9' } })))?.code).toBe('CURSOR_INVALIDATED');
  });

  it('keeps a cursor valid across a rename and a share, which change only the version, and invalidates it for an edited definition, reading nothing', async () => {
    const { saveRun, save, executor } = rig({ patternRows: rows });
    const row = await save();
    const first = (await saveRun(row, { limit: 2 })) as { nextCursor?: string };
    expect(first.nextCursor).toBeDefined();
    const renamed = { ...row, name: 'renamed', version: row.version + 1, visibility: 'shared' as const };
    expect(await saveRun(renamed, { limit: 2, cursor: first.nextCursor })).toMatchObject({ status: 'ok' });
    const edited = { ...row, version: row.version + 2, definition: { ...DEFINITION, steps: [{ ...LINKS_STEP, direction: 'both' }] } };
    const before = executor.calls.length;
    expect((await failureOf(saveRun(edited, { limit: 2, cursor: first.nextCursor })))?.code).toBe('CURSOR_INVALIDATED');
    expect(executor.calls).toHaveLength(before);
  });
});

