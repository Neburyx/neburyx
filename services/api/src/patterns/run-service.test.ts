import { patternRunResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { defaultTemplateProbes, type TemplateProbe } from '../graph/template-probes.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, noMatchRow, oneStepRow, patternMappingOf, plainMaker, plainRel, twoStepRow } from '../testing/pattern-fixtures.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createPatternRunService, type PatternRunCall } from './run-service.js';

const step = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in' });
const definition = (steps: readonly unknown[] = [step()]) => ({ anchorType: 'maker', steps });
const NOW = new Date('2026-03-10T12:00:00.000Z');

function rig(options: { readonly mapping?: ReturnType<typeof patternMappingOf>; readonly rows?: readonly Record<string, unknown>[]; readonly probes?: ReadonlyMap<string, TemplateProbe>; readonly deny?: boolean; readonly count?: ExecuteOutcome; readonly denyGate?: boolean } = {}) {
  const mapping = options.mapping ?? patternMappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): ExecuteOutcome => (call.templateId === 'pattern-count' ? (options.count ?? { status: 'rows', rows: [] }) : call.templateId === 'pattern' ? { status: 'rows', rows: options.rows ?? [] } : { status: 'rows', rows: [] });
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const defaults = communitySeams();
  const gateSeams = options.denyGate === true ? { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'no' }) }, coordinator: defaults.coordinator, audit: defaults.audit } : undefined;
  const parts = testSourceGate(mapping, { executor, ...(gateSeams === undefined ? {} : { seams: gateSeams }) });
  const seams = options.deny === true ? { ...defaults, policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'no' }) } } : defaults;
  const real = createSourceAccess({ mapping, seams, logger: { warn: () => undefined } });
  let requires = 0;
  const access: typeof real = { ...real, require: (...args: Parameters<typeof real.require>) => ((requires += 1), real.require(...args)) };
  const service = createPatternRunService({ gate: parts.gate, mapping, access, now: () => NOW, probes: options.probes ?? new Map() });
  const run = (over: Partial<PatternRunCall> = {}) => service.run({ traceId: 'tr-run', principal: LOCAL_PRINCIPAL, sourceId: 'demo', definition: definition(), anchor: { entityType: 'maker', stableId: 'W-1' }, mask: false, ...over });
  return { run, executor, requires: () => requires, countReads: () => executor.calls.filter((call) => call.templateId === 'pattern-count'), reads: () => executor.calls.filter((call) => call.templateId === 'pattern' && call.parameters['limit'] !== 1) };
}

const failureOf = async (promise: Promise<unknown>): Promise<AppError | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
};

describe('a pattern run: what is refused before anything is read', () => {
  it('answers an unknown source and one the person may not read the same way: not found', async () => {
    const missing = rig();
    expect((await failureOf(missing.run({ sourceId: 'nowhere' })))?.code).toBe('NOT_FOUND');
    const denied = rig({ deny: true });
    expect((await failureOf(denied.run()))?.code).toBe('NOT_FOUND');
    expect(denied.reads()).toHaveLength(0);
  });

  it('refuses an anchor of another type than the definition starts from', async () => {
    const { run, reads } = rig();
    expect((await failureOf(run({ anchor: { entityType: 'tool', stableId: 'T-1' } })))?.code).toBe('INVALID_REQUEST');
    expect(reads()).toHaveLength(0);
  });

  it.each([
    ['a type the mapping does not have', { anchorType: 'maker', steps: [step({ arrivesAt: 'nothing' })] }],
    ['a relationship type that does not join', { anchorType: 'maker', steps: [step({ relationshipTypes: ['STOCKED_AT'] })] }],
    ['a key the schema does not name', { anchorType: 'maker', steps: [step()], extra: 1 }],
    ['no steps', { anchorType: 'maker', steps: [] }],
    ['five steps', definition(Array.from({ length: 5 }, () => step()))],
  ])('refuses %s, without a problem in the error and without reading', async (_name, input) => {
    const { run, reads } = rig();
    const error = await failureOf(run({ definition: input }));
    expect(error?.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(error)).not.toMatch(/nothing|STOCKED_AT|extra/);
    expect(reads()).toHaveLength(0);
  });

  it('refuses a condition on a personal-data property while masking is asked, and serves it otherwise', async () => {
    const entities = PATTERN_ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, pii: [{ property: 'region', class: 'text' }] } : entity));
    const mapping = linkedMappingOf({ entities, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [] });
    const conditions = [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }];
    const masked = rig({ mapping, rows: [noMatchRow('W-1')] });
    expect((await failureOf(masked.run({ definition: definition([step({ conditions })]), mask: true })))?.code).toBe('INVALID_REQUEST');
    expect(masked.reads()).toHaveLength(0);
    const open = rig({ mapping, rows: [noMatchRow('W-1')] });
    expect(await failureOf(open.run({ definition: definition([step({ conditions })]), mask: false }))).toBeUndefined();
  });

  it('refuses more steps than the source allows with the cap, three steps on a source that allows two', async () => {
    const { run, reads } = rig({ mapping: patternMappingOf({ max_hops: 2 }) });
    const three = definition([step(), step(), step()]);
    expect(await failureOf(run({ definition: three }))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
    expect(reads()).toHaveLength(0);
  });

  it('decides the hops before the page when both are over: the cap on hops, with the page above max_page also asked', async () => {
    const { run } = rig({ mapping: patternMappingOf({ max_hops: 2, max_page: 10 }) });
    expect(await failureOf(run({ definition: definition([step(), step(), step()]), limit: 11 }))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
  });

  it('refuses a page above max_page with the maximum, read by the gate before any data is read', async () => {
    const { run, reads } = rig({ mapping: patternMappingOf({ max_page: 10 }) });
    expect(await failureOf(run({ limit: 11 }))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 10 } });
    expect(reads()).toHaveLength(0);
  });

  it('answers the same cap from the gate when the service’s own check is bypassed', async () => {
    const mapping = patternMappingOf({ max_hops: 2 });
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve({ status: 'rows', rows: [] })));
    const parts = testSourceGate(mapping, { executor });
    const params = { anchorType: 'maker', stableId: 'W-1', steps: [step(), step(), step()] };
    const error = await failureOf(parts.gate.run({ traceId: 't', principal: LOCAL_PRINCIPAL, sourceId: 'demo', templateId: 'pattern', params, limit: 10 }));
    expect(error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
  });
});

describe('a pattern run: the read', () => {
  it('runs the template with the parameters of the definition, the windows as instants at the time of the call, the limit, the mask and the signal', async () => {
    const { run, reads } = rig({ rows: [noMatchRow('W-1')] });
    const controller = new AbortController();
    await run({ definition: definition([step({ window: { days: 2 } }), step({ window: { from: '2026-01-01', to: '2026-01-31' } })]), limit: 7, mask: true, signal: controller.signal });
    const [call] = reads();
    expect(call?.parameters).toMatchObject({
      stableId: 'W-1',
      limit: 7,
      steps: [
        { windowFrom: '2026-03-08T12:00:00.000Z', windowTo: '2026-03-10T12:00:00.000Z' },
        { windowFrom: '2026-01-01T00:00:00.000Z', windowTo: '2026-02-01T00:00:00.000Z' },
      ],
    });
    expect(call?.signal).toBeDefined();
  });

  it('reads the source’s default page when no limit is asked', async () => {
    const { run, reads } = rig({ rows: [noMatchRow('W-1')] });
    await run();
    expect(reads()[0]?.parameters['limit']).toBe(patternMappingOf().sources[0]?.budgets.defaultPage);
  });

  it('answers the matches with the path of each, the count exact and its scope, when nothing cut or skipped the read', async () => {
    const { run } = rig({ rows: [oneStepRow('W-1', 'W-2'), oneStepRow('W-1', 'W-3')] });
    const answer = patternRunResponseSchema.parse(await run());
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.count).toEqual({ value: 2, quality: 'exact', scope: 'template:pattern' });
    expect(answer.matches.map((entry) => [entry.match.stableId, entry.hops, entry.through, entry.relationships.map((hop) => [hop.relationshipType, hop.from?.stableId, hop.to?.stableId])])).toEqual([
      ['W-2', 1, [], [['LINKS', 'W-1', 'W-2']]],
      ['W-3', 1, [], [['LINKS', 'W-1', 'W-3']]],
    ]);
    expect(answer.nodes.length).toBeGreaterThan(0);
    expect(answer.templateVersion).toBe('2');
  });

  it('answers a two-step match with the entity between', async () => {
    const { run } = rig({ rows: [twoStepRow('W-1', 'T-1', 'W-2')] });
    const answer = await run({ definition: definition([TOOL, BACK]) });
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.matches).toHaveLength(1);
    expect(answer.matches[0]).toMatchObject({ hops: 2, through: [{ entityType: 'tool', stableId: 'T-1' }] });
    expect(answer.matches[0]?.relationships).toHaveLength(2);
  });

  it('keeps the position of an entity between that has no stable ID, and writes an unusable relationship type as null', async () => {
    const [a, x] = [plainMaker('W-1'), plainMaker('W-2')];
    const unnamed = { elementId: 'e-bad', labels: ['Tool'], properties: {}, $type: 'node' as const };
    const row = { a, bounded: false, stopListed: false, heavy: [], x, mid: [unnamed], r1: plainRel('USES_TOOL', a, unnamed, 'U-1'), r2: 'not a relationship', hops: 2 };
    const { run } = rig({ rows: [row] });
    const answer = patternRunResponseSchema.parse(await run({ definition: definition([TOOL, BACK]) }));
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.matches[0]?.through).toEqual([null]);
    expect(answer.matches[0]?.relationships[1]).toEqual({ relationshipType: null, from: null, to: null });
  });

  it('labels the count a lower bound when the page was cut, a bound was hit or an entity was skipped, and says so in the notices', async () => {
    const cut = rig({ rows: [oneStepRow('W-1', 'W-2'), oneStepRow('W-1', 'W-3'), oneStepRow('W-1', 'W-4')] });
    const page = await cut.run({ limit: 2 });
    if (page.status !== 'ok') throw new Error('not ok');
    expect(page.count.quality).toBe('lowerBound');
    const bounded = rig({ rows: [oneStepRow('W-1', 'W-2', { bounded: true })] });
    const answer = await bounded.run();
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer).toMatchObject({ count: { value: 1, quality: 'lowerBound' }, notices: [{ code: 'readBounded' }] });
    const stopped = rig({ rows: [oneStepRow('W-1', 'W-2', { stopListed: true })] });
    const skipped = await stopped.run({ definition: definition([TOOL, BACK]) });
    if (skipped.status !== 'ok') throw new Error('not ok');
    expect(skipped.count.quality).toBe('lowerBound');
    expect(skipped.notices.map((notice) => notice.code)).toContain('stopListSkipped');
  });

  it('says the window did not apply to a type with no time, and that undated relationships were left out when it applied', async () => {
    const { run } = rig({ rows: [noMatchRow('W-1')] });
    const window = { days: 5 };
    const untimed = await run({ definition: definition([step({ relationshipTypes: ['TRUSTS'], window })]) });
    if (untimed.status !== 'ok') throw new Error('not ok');
    expect(untimed.notices).toEqual([{ code: 'windowNotApplied', relationshipTypes: ['TRUSTS'] }]);
    const timed = await run({ definition: definition([step({ window })]) });
    if (timed.status !== 'ok') throw new Error('not ok');
    expect(timed.notices).toEqual([{ code: 'undatedExcluded' }]);
  });

  it('answers an anchor that is not found as not found', async () => {
    const { run } = rig({ rows: [] });
    expect((await failureOf(run()))?.code).toBe('NOT_FOUND');
  });
});

describe('a pattern run: the estimate before it', () => {
  const estimateOf = (matches: number): TemplateProbe => ({ templateId: 'pattern', read: () => ({ anchorFound: true, usable: true, matches, bounded: false, notices: [{ code: 'readBounded' as const }] }) });
  const probes = (matches: number) => new Map([['pattern', estimateOf(matches)]]);
  /** The stub probe reads through the pattern template with a limit of one, which no run here asks for. */
  const estimateReads = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'pattern' && call.parameters['limit'] === 1);

  it('reads no estimate when no probe is known for the template: the run goes straight to the read', async () => {
    const { run, executor } = rig({ rows: [oneStepRow('W-1', 'W-2')] });
    const answer = await run();
    expect(answer.status).toBe('ok');
    expect(estimateReads(executor)).toHaveLength(0);
  });

  it('stops as heavy with a lower bound at the threshold and no rows, when the probe read more than the threshold', async () => {
    const mapping = patternMappingOf({ heavy_op_threshold: 5 });
    const { run, reads } = rig({ mapping, rows: [oneStepRow('W-1', 'W-2')], probes: probes(6) });
    const answer = patternRunResponseSchema.parse(await run({ limit: 40 }));
    expect(answer).toMatchObject({ status: 'heavy', estimate: { value: 5, quality: 'lowerBound', scope: 'template:pattern:estimate' }, threshold: 5, continueLimit: 25, notices: [{ code: 'readBounded' }] });
    expect(reads()).toHaveLength(0);
  });

  it('runs when the probe read at most the threshold', async () => {
    const mapping = patternMappingOf({ heavy_op_threshold: 5 });
    const { run, reads } = rig({ mapping, rows: [oneStepRow('W-1', 'W-2')], probes: probes(5) });
    expect((await run()).status).toBe('ok');
    expect(reads()).toHaveLength(1);
  });

  it('skips the probe for a continue and reads a first page of at most 25, lowered by the page asked for', async () => {
    const mapping = patternMappingOf({ heavy_op_threshold: 5 });
    const first = rig({ mapping, rows: [oneStepRow('W-1', 'W-2')], probes: probes(6) });
    expect((await first.run({ continue: true, limit: 40 })).status).toBe('ok');
    expect(first.reads()[0]?.parameters['limit']).toBe(25);
    expect(estimateReads(first.executor)).toHaveLength(0);
    const small = rig({ mapping, rows: [oneStepRow('W-1', 'W-2')], probes: probes(6) });
    await small.run({ continue: true, limit: 10 });
    expect(small.reads()[0]?.parameters['limit']).toBe(10);
  });

  it('skips the probe for a page above max_page and for more steps than the source allows', async () => {
    const page = rig({ mapping: patternMappingOf({ max_page: 10, heavy_op_threshold: 5 }), probes: probes(6) });
    expect((await failureOf(page.run({ limit: 11 })))?.code).toBe('QUERY_BUDGET_EXCEEDED');
    expect(estimateReads(page.executor)).toHaveLength(0);
    const hops = rig({ mapping: patternMappingOf({ max_hops: 1, heavy_op_threshold: 5 }), probes: probes(6) });
    expect((await failureOf(hops.run({ definition: definition([step(), step()]) })))?.code).toBe('QUERY_BUDGET_EXCEEDED');
    expect(estimateReads(hops.executor)).toHaveLength(0);
  });
});

describe('a pattern run: the estimate of the pattern probe', () => {
  const counted = (matches: number, flags: { readonly bounded?: boolean; readonly stopListed?: boolean; readonly supernodes?: number } = {}): ExecuteOutcome => ({ status: 'rows', rows: [{ matches, bounded: flags.bounded === true, stopListed: flags.stopListed === true, supernodes: flags.supernodes ?? 0 }] });
  const heavy = patternMappingOf({ heavy_op_threshold: 5 });
  const withProbe = (count: ExecuteOutcome, mapping = heavy) => rig({ mapping, rows: [oneStepRow('W-1', 'W-2')], probes: defaultTemplateProbes(), count });

  it('stops as heavy with a lower bound at the threshold, the threshold and 25, no rows and no run statement, when the probe counted one more than the threshold', async () => {
    const { run, reads, countReads } = withProbe(counted(6));
    const answer = patternRunResponseSchema.parse(await run({ limit: 40 }));
    expect(answer).toMatchObject({ status: 'heavy', estimate: { value: 5, quality: 'lowerBound', scope: 'template:pattern:estimate' }, threshold: 5, continueLimit: 25 });
    expect(countReads()).toHaveLength(1);
    expect(reads()).toHaveLength(0);
  });

  it('runs when the probe counted at most the threshold, with or without a bound, and gives no heavy warning', async () => {
    for (const count of [counted(5), counted(5, { bounded: true }), counted(0), counted(5, { supernodes: 2, stopListed: true })]) {
      const { run, reads } = withProbe(count);
      expect((await run()).status).toBe('ok');
      expect(reads()).toHaveLength(1);
    }
  });

  it('gives the notices of the run’s own rule for the request in a heavy answer, never the entities left out, and readBounded only for a cut step', async () => {
    const two = rig({ mapping: heavy, rows: [], probes: defaultTemplateProbes(), count: counted(6, { bounded: false, stopListed: true, supernodes: 3 }) });
    const left = await two.run({ definition: definition([TOOL, BACK]), limit: 40 });
    expect(left).toMatchObject({ status: 'heavy' });
    const codes = (left as { notices: readonly { code: string }[] }).notices.map((notice) => notice.code);
    expect(codes).not.toContain('supernodesSkipped');
    expect(codes).not.toContain('stopListSkipped');
    expect(codes).not.toContain('readBounded');
    const cut = rig({ mapping: heavy, rows: [], probes: defaultTemplateProbes(), count: counted(6, { bounded: true }) });
    const cutAnswer = await cut.run({ definition: definition([TOOL, BACK]), limit: 40 });
    const cutCodes = (cutAnswer as { notices: readonly { code: string }[] }).notices.map((notice) => notice.code);
    expect(cutCodes).toContain('readBounded');
    expect(cutCodes).not.toContain('supernodesSkipped');
  });

  it('skips the probe for a continue and reads at most 25 rows', async () => {
    const { run, reads, countReads } = withProbe(counted(6));
    expect((await run({ continue: true, limit: 40 })).status).toBe('ok');
    expect(countReads()).toHaveLength(0);
    expect(reads()[0]?.parameters['limit']).toBe(25);
  });

  it('ends the request without a run when the probe finds no anchor, returns no usable count, times out or cannot reach the source', async () => {
    const cases: readonly [ExecuteOutcome, string][] = [
      [{ status: 'rows', rows: [] }, 'NOT_FOUND'],
      [{ status: 'rows', rows: [{ bounded: false }] }, 'INTERNAL_ERROR'],
      [{ status: 'timeout' }, 'QUERY_TIMEOUT'],
      [{ status: 'unavailable', reason: 'unreachable' }, 'SOURCE_UNAVAILABLE'],
    ];
    for (const [count, code] of cases) {
      const { run, reads } = withProbe(count);
      expect((await failureOf(run()))?.code, code).toBe(code);
      expect(reads()).toHaveLength(0);
    }
  });

  it('has an unknown estimate and no warning when no pattern probe is registered', async () => {
    const { run, reads, countReads } = rig({ mapping: heavy, rows: [oneStepRow('W-1', 'W-2')], probes: new Map() });
    expect((await run()).status).toBe('ok');
    expect(countReads()).toHaveLength(0);
    expect(reads()).toHaveLength(1);
  });

  it('keeps the count of a run that went on as the run’s own: the number of matches returned, labelled by the run’s rule', async () => {
    const { run } = withProbe(counted(2, { supernodes: 1 }));
    const answer = await run();
    expect(answer).toMatchObject({ status: 'ok', count: { value: 1, scope: 'template:pattern' } });
  });

  it('answers the same notices in a heavy answer as in the run for the same request, so the two agree on one rule', async () => {
    const windowed = definition([step({ window: { days: 30 } }), step({ direction: 'in' })]);
    const went = await withProbe(counted(2)).run({ definition: windowed });
    const stopped = await withProbe(counted(6)).run({ definition: windowed, limit: 40 });
    expect(went.status).toBe('ok');
    expect(stopped.status).toBe('heavy');
    const codes = (answer: { notices: readonly { code: string }[] }): string[] => answer.notices.map((notice) => notice.code).sort();
    expect(codes(stopped as { notices: readonly { code: string }[] })).toEqual(codes(went as { notices: readonly { code: string }[] }));
    expect(codes(stopped as { notices: readonly { code: string }[] })).toContain('undatedExcluded');
  });

  it('answers not found, and runs nothing, when the gate denies the probe', async () => {
    const { run, reads, countReads } = rig({ mapping: heavy, rows: [oneStepRow('W-1', 'W-2')], probes: defaultTemplateProbes(), count: counted(1), denyGate: true });
    expect((await failureOf(run()))?.code).toBe('NOT_FOUND');
    expect(countReads()).toHaveLength(0);
    expect(reads()).toHaveLength(0);
  });

  it('counts the request once for the rate limit whether the probe stops it or the run goes on', async () => {
    const stopped = withProbe(counted(6));
    await stopped.run({ limit: 40 });
    expect(stopped.requires()).toBe(1);
    const went = withProbe(counted(2));
    await went.run();
    expect(went.requires()).toBe(1);
  });

  it('goes on with the run’s own quality and notices when the probe flagged a supernode and the run read one', async () => {
    const supernoded = rig({ mapping: heavy, rows: [{ ...oneStepRow('W-1', 'W-2'), heavy: [plainMaker('W-SUPER')] }], probes: defaultTemplateProbes(), count: counted(2, { supernodes: 1 }) });
    const answer = await supernoded.run();
    expect(answer.status).toBe('ok');
    if (answer.status === 'ok') {
      expect(answer.count.quality).toBe('lowerBound');
      expect(answer.notices.map((notice) => notice.code)).toContain('supernodesSkipped');
    }
  });
});
