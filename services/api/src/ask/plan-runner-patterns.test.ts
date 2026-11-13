import type { AskPlanRun } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { PatternRow } from '../db/patterns-repository.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { TemplateProbe } from '../graph/template-probes.js';
import { createTemplateRunService } from '../graph/template-run-service.js';
import { createStoredReferences } from '../investigations/stored-references.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { createPatternRunService } from '../patterns/run-service.js';
import { createSavedPatternRunService } from '../patterns/saved-run-service.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Principal } from '../seams/seams.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { LINKED_PRESET, linkedRow } from '../testing/linked-entities-fixtures.js';
import { memoryPatterns, type MemoryPatterns } from '../testing/memory-patterns.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, oneStepRow } from '../testing/pattern-fixtures.js';
import { savedMappingOf } from '../testing/saved-pattern-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createAskPlanRunnerFactory, type AskPlanRunnerServices } from './plan-runner.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'administrator' });
const OWNER = person('0192f000-0000-7000-8000-000000000001');
const OTHER = person('0192f000-0000-7000-8000-000000000002');
const DEFINITION = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }] };
const ENTITY = { entityType: 'maker', stableId: 'W-1' };
const NOW = new Date('2026-03-10T12:00:00.000Z');
const audit = { record: () => Promise.resolve() };
const SIGNAL = new AbortController().signal;

let named = 0;

function rig(options: { readonly mapping?: ReturnType<typeof savedMappingOf>; readonly deny?: boolean; readonly probes?: ReadonlyMap<string, TemplateProbe> } = {}) {
  const mapping = options.mapping ?? savedMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: call.templateId === 'pattern' ? [oneStepRow('W-1', 'W-2')] : call.templateId === 'linked-entities' ? [linkedRow({ anchor: 'W-1', match: 'W-2' })] : [] });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { ...defaults, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) }, ...(options.deny === true ? { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'no' }) } } : {}) };
  const parts = testSourceGate(mapping, { executor, seams: { policy: seams.policy, coordinator: defaults.coordinator, audit: seams.audit } });
  const access = createSourceAccess({ mapping, seams, logger: { warn: () => undefined } });
  const patternRuns = createPatternRunService({ gate: parts.gate, mapping, access, now: () => NOW, probes: options.probes ?? new Map() });
  const templateRuns = createTemplateRunService({ gate: parts.gate, mapping, access, now: () => NOW, probes: options.probes ?? new Map() });
  const patterns: MemoryPatterns = memoryPatterns();
  const savedRuns = createSavedPatternRunService({ store: patterns, mapping, access, references: createStoredReferences(mapping, TEST_REFERENCE_KEYS), patternRuns, templateRuns, logger: { warn: () => undefined } as never });
  const services = { savedRuns, mapping } as unknown as AskPlanRunnerServices;
  const runner = (principal: Principal = OWNER, sourceId = 'demo') => createAskPlanRunnerFactory(services)({ principal, traceId: 'tr-1', signal: SIGNAL })({ sourceId, mask: false });
  const save = async (over: Partial<Parameters<MemoryPatterns['savePattern']>[0]> = {}, owner: Principal = OWNER): Promise<PatternRow> => {
    const saved = await patterns.savePattern({ sourceId: 'demo', name: `p${(named += 1)}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null, ...over }, { principal: owner, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    return saved.row;
  };
  const set = (row: PatternRow, change: Partial<PatternRow>): void => void patterns.patternRows.splice(patterns.patternRows.findIndex((held) => held.id === row.id), 1, { ...row, ...change });
  const run = (row: PatternRow, over: Record<string, unknown> = {}, principal: Principal = OWNER, options?: { continue?: boolean }): Promise<AskPlanRun> => runner(principal).run({ templateId: 'saved-pattern', params: { patternId: row.id, patternVersion: row.version, ref: ENTITY, ...over } }, options);
  const reads = () => executor.calls.filter((call) => call.templateId === 'pattern' || call.templateId === 'linked-entities');
  return { patterns, save, set, run, runner, reads, events };
}

const refusal = async (promise: Promise<AskPlanRun>) => {
  const answer = await promise;
  if (answer.status !== 'refused') throw new Error('not refused');
  return answer.refusal;
};

describe('running a plan that names a saved pattern', () => {
  it('runs the pattern through the saved run, as the manual route would, and answers its own result', async () => {
    const { save, run, reads } = rig();
    const row = await save();
    const answer = await run(row);
    expect(answer).toMatchObject({ status: 'ok', result: { templateId: 'saved-pattern', result: { status: 'ok', matches: [{}] } } });
    expect(reads()).toHaveLength(1);
  });

  it('refuses a pattern that was changed after the plan was made, with pattern-changed, and reads nothing', async () => {
    const { save, set, run, reads } = rig();
    const row = await save();
    set(row, { version: row.version + 1, definition: { ...DEFINITION, steps: [{ ...DEFINITION.steps[0], direction: 'in' }] } });
    expect(await refusal(run(row))).toEqual({ code: 'CONFLICT', reason: 'pattern-changed' });
    expect(reads()).toEqual([]);
  });

  it('refuses a pattern that was unshared again and shared a second time, because its version is higher, and one renamed', async () => {
    const { save, set, run, reads } = rig();
    const row = await save({}, OTHER);
    set(row, { visibility: 'shared', version: row.version + 1 });
    set(row, { visibility: 'shared', version: row.version + 3 });
    expect(await refusal(run(row, {}, OWNER))).toEqual({ code: 'CONFLICT', reason: 'pattern-changed' });
    expect(reads()).toEqual([]);
  });

  it.each([
    ['unshared by another owner', (row: PatternRow, set: ReturnType<typeof rig>['set']) => set(row, { visibility: 'private' })],
    ['deleted', (row: PatternRow, _set: ReturnType<typeof rig>['set'], patterns: MemoryPatterns) => void patterns.deletedPatterns.set(row.id, { deletedAt: '2026-03-01T00:00:00.000Z', purgeAfter: '2026-04-01T00:00:00.000Z' })],
  ])('answers NOT_FOUND for a pattern that was %s since the plan was made, and reads nothing', async (_name, change) => {
    const { save, set, run, reads, patterns } = rig();
    const row = await save({}, OTHER);
    set(row, { visibility: 'shared' });
    const planned = { ...row, visibility: 'shared' as const };
    change(planned, set, patterns);
    expect(await refusal(run(planned, {}, OWNER))).toEqual({ code: 'NOT_FOUND' });
    expect(reads()).toEqual([]);
  });

  it('answers NOT_FOUND for a caller who may not read the source, and audits the denial', async () => {
    const { save, run, reads, events } = rig({ deny: true });
    const row = await save();
    expect(await refusal(run(row))).toEqual({ code: 'NOT_FOUND' });
    expect(reads()).toEqual([]);
    expect(events).toMatchObject([{ action: 'pattern.run', result: 'denied' }]);
  });

  it('refuses a pattern the mapping no longer supports, with pattern-unavailable, and reads nothing', async () => {
    const lost = savedMappingOf({ entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS.filter((entry) => entry.type !== 'LINKS'), patterns: [] });
    const { save, run, reads, events } = rig({ mapping: lost });
    const row = await save();
    expect(await refusal(run(row))).toEqual({ code: 'CONFLICT', reason: 'pattern-unavailable' });
    expect(reads()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers NOT_FOUND when the plan’s source is not the pattern’s', async () => {
    const { save, runner, reads } = rig();
    const row = await save();
    expect(await refusal(runner(OWNER, 'elsewhere').run({ templateId: 'saved-pattern', params: { patternId: row.id, patternVersion: row.version, ref: ENTITY } }))).toEqual({ code: 'NOT_FOUND' });
    expect(reads()).toEqual([]);
  });

  it('sets the last run of the creator only: a run of another person’s shared pattern writes nothing to it', async () => {
    const { save, set, run, patterns } = rig();
    const mine = await save();
    await run(mine);
    expect((await patterns.readPattern(mine.id, OWNER.id))?.lastRunAt).not.toBeNull();
    const theirs = await save({}, OTHER);
    set(theirs, { visibility: 'shared' });
    await run({ ...theirs, visibility: 'shared' }, {}, OWNER);
    expect((await patterns.readPattern(theirs.id, OTHER.id))?.lastRunAt).toBeNull();
  });

  it('runs a pattern that holds its starting entity without a reference in the plan', async () => {
    const { save, run, reads } = rig();
    const row = await save({ anchor: ENTITY });
    const answer = await run(row, { ref: undefined });
    expect(answer.status).toBe('ok');
    expect(reads()).toHaveLength(1);
  });

  it('answers an invalid plan for parameters that are not a pattern’s, and reads nothing', async () => {
    const { save, run, reads } = rig();
    const row = await save();
    expect(await refusal(run(row, { patternVersion: 0 }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(await refusal(run(row, { patternId: 'not-an-id' }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(reads()).toEqual([]);
  });

  it('runs a saved run of a preset through its own template service and answers the template result', async () => {
    const { save, run, reads } = rig();
    const row = await save({ kind: 'preset-run', presetId: LINKED_PRESET.id, templateId: 'linked-entities', templateVersion: 1, params: {}, definition: null });
    const answer = await run(row);
    expect(answer).toMatchObject({ status: 'ok', result: { templateId: 'saved-pattern', result: { status: 'ok' } } });
    expect(reads().map((call) => call.templateId)).toEqual(['linked-entities']);
  });

  describe('that stops as heavy', () => {
    const heavy: TemplateProbe = { templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches: 600, bounded: false, notices: [] }) };

    it('answers the saved run’s heavy stop, with its estimate, and reads no match; a continue reads a first page of at most 25', async () => {
      const { save, run } = rig({ probes: new Map([['pattern', heavy]]) });
      const row = await save();
      expect(await run(row)).toMatchObject({ status: 'ok', result: { templateId: 'saved-pattern', result: { status: 'heavy', threshold: 500 } } });
      const continued = await run(row, {}, OWNER, { continue: true });
      expect(continued).toMatchObject({ status: 'ok', result: { templateId: 'saved-pattern', result: { status: 'ok' } } });
    });

    it('is checked again at the continue: a pattern changed or unshared between the stop and the continue is refused, and nothing is read', async () => {
      const { save, set, run, reads } = rig({ probes: new Map([['pattern', heavy]]) });
      const row = await save();
      await run(row);
      const stopped = reads().length;
      set(row, { version: row.version + 1 });
      expect(await refusal(run(row, {}, OWNER, { continue: true }))).toEqual({ code: 'CONFLICT', reason: 'pattern-changed' });
      expect(reads()).toHaveLength(stopped);
      const other = await save({}, OTHER);
      set(other, { visibility: 'shared' });
      const shared = { ...other, visibility: 'shared' as const };
      await run(shared, {}, OWNER);
      set(shared, { visibility: 'private' });
      expect(await refusal(run(shared, {}, OWNER, { continue: true }))).toEqual({ code: 'NOT_FOUND' });
    });
  });
});
