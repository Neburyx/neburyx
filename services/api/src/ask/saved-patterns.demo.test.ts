import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { askPlanResponseSchema, askRunResponseSchema, parseExtensionRefusal, type AskPlan, type AskPlanInput, type AskPlanner, type AuditEvent as ContractEvent, type ExtensionRequest } from '@neburyx/contracts';
import { askPlanRoute as defaultPlanRoute, createAskPlanRoute, createAskRunRoute, questionVocabulary } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import type { PatternRow } from '../db/patterns-repository.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createTemplateRunService } from '../graph/template-run-service.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { createStoredReferences } from '../investigations/stored-references.js';
import { aiMappingViewOf } from '../profile/mapping-view.js';
import { parseMapping } from '../mapping/load.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import { createPatternRunService } from '../patterns/run-service.js';
import { createSavedPatternRunService } from '../patterns/saved-run-service.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Principal } from '../seams/seams.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { memoryPatterns, type MemoryPatterns } from '../testing/memory-patterns.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createAskPlanRunnerFactory } from './plan-runner.js';
import { createAskPatternLister } from './patterns-lister.js';
import { createMemoryPlanStore } from '../../../../ee/ask/src/testing/memory-plans.js';

void defaultPlanRoute;

const PACKS = resolve(import.meta.dirname, '..', '..', '..', '..', 'domain-packs');
const person = (id: string): Principal => ({ id, displayName: id, role: 'administrator' });
const ALICE = person('0192f000-0000-7000-8000-00000000000a');
const BOB = person('0192f000-0000-7000-8000-00000000000b');
const NOW = new Date('2026-03-10T12:00:00.000Z');
const audit = { record: () => Promise.resolve() };

const loaded = (pack: string, id: string) => {
  const [source] = parseMapping(readFileSync(join(PACKS, pack, 'neburyx.yaml'), 'utf8'), pack).sources;
  if (source === undefined) throw new Error('no source');
  return { ...source, id };
};
const MAPPING: MappingModel = { sources: [loaded('banking-fraud', 'bank'), loaded('insurance-claims', 'ins')] };

interface PackCase {
  readonly source: string;
  readonly anchorType: string;
  readonly arrivesAt: string;
  readonly relationship: string;
  readonly definition: Record<string, unknown>;
  readonly row: () => Record<string, unknown>;
}

const row = (anchor: ReturnType<typeof plainNode>, match: ReturnType<typeof plainNode>, relationship: string, endKey: string, endType: string) => ({
  a: anchor, bounded: false, stopListed: false, heavy: [], x: match, endKey, endElement: String(match.elementId), endType, mid: [], r1: plainRelationship(relationship, anchor, match), hops: 1,
});

/** The one step of a pack the proof walks: a relationship with no identifier of its own, between two entity types, read from the pack's own mapping so no word of a pack is written here. */
function caseOf(source: SourceModel): PackCase {
  const step = source.relationships.find((candidate) => candidate.stableId === undefined && candidate.from !== candidate.to) ?? source.relationships.find((candidate) => candidate.stableId === undefined);
  const from = source.entities.find((entity) => entity.type === step?.from);
  const to = source.entities.find((entity) => entity.type === step?.to);
  if (step === undefined || from === undefined || to === undefined) throw new Error('the pack has no usable relationship');
  const node = (entity: typeof from, id: string) => plainNode([entity.label], { [entity.stableId]: id });
  return {
    source: source.id,
    anchorType: from.type,
    arrivesAt: to.type,
    relationship: step.type,
    definition: { anchorType: from.type, steps: [{ relationshipTypes: [step.type], direction: 'out', arrivesAt: to.type }] },
    row: () => row(node(from, 'X-1'), node(to, 'X-2'), step.type, 'X-2', to.type),
  };
}
const CASES: readonly PackCase[] = MAPPING.sources.map(caseOf);

const mac = (canonical: string): string => createHmac('sha256', 'demo-key').update(canonical).digest('hex');
const PLACEHOLDER = (type: string) => `‹${type}#1›`;

function harness(options: { readonly rowsOf?: (call: ExecuteCall) => Record<string, unknown>[] } = {}) {
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { ...defaults, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const sources = new Map(CASES.map((entry) => [entry.source, entry]));
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: call.templateId === 'pattern' ? [sources.get(call.sourceId)?.row() ?? {}] : [] });
  const sourceOf = (id: string) => MAPPING.sources.find((candidate) => candidate.id === id) ?? MAPPING.sources[0];
  const executor = new TestExecutor((call) => (call.templateId === 'schema-indexes' ? Promise.resolve(schemaAnswer(onlineIndexesOf(sourceOf(call.sourceId) ?? (() => { throw new Error('no source'); })()))) : answer(call)));
  const parts = testSourceGate(MAPPING, { executor, seams: { policy: seams.policy, coordinator: defaults.coordinator, audit: seams.audit } });
  const access = createSourceAccess({ mapping: MAPPING, seams, logger: { warn: () => undefined } });
  const patternRuns = createPatternRunService({ gate: parts.gate, mapping: MAPPING, access, now: () => NOW, probes: new Map() });
  const templateRuns = createTemplateRunService({ gate: parts.gate, mapping: MAPPING, access, now: () => NOW, probes: new Map() });
  const patterns: MemoryPatterns = memoryPatterns();
  const savedRuns = createSavedPatternRunService({ store: patterns, mapping: MAPPING, access, references: createStoredReferences(MAPPING, TEST_REFERENCE_KEYS), patternRuns, templateRuns, logger: { warn: () => undefined } as never });
  const runners = createAskPlanRunnerFactory({ savedRuns, mapping: MAPPING } as never);
  const lister = createAskPatternLister({ store: patterns, mapping: MAPPING, access });
  const plans = createMemoryPlanStore();
  const planned: AskPlanInput[] = [];
  let choose: (input: AskPlanInput) => AskPlan = () => ({ kind: 'unsupported', reason: 'none' });
  const planner: AskPlanner = { availability: () => ({ available: true }), plan: async (input) => (planned.push(input), choose(input)) };
  const save = async (source: string, definition: Record<string, unknown>, owner: Principal, over: Partial<Parameters<MemoryPatterns['savePattern']>[0]> = {}): Promise<PatternRow> => {
    const saved = await patterns.savePattern({ sourceId: source, name: `PRIVATE-NAME-${Math.random().toString(36).slice(2, 8)}`, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition, anchor: null, ...over }, { principal: owner, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    return saved.row;
  };
  const set = (pattern: PatternRow, change: Partial<PatternRow>): void => void patterns.patternRows.splice(patterns.patternRows.findIndex((held) => held.id === pattern.id), 1, { ...pattern, ...change });
  const requestOf = (principal: Principal, body: unknown, sourceId: string): ExtensionRequest => ({
    principalId: principal.id, principalRole: 'administrator', previewOn: true, traceId: 'tr-1', audit: { record: async (event: ContractEvent) => void events.push(event as AuditEvent) }, askPlanner: planner, previewMac: mac, policyVersionOf: () => 'none',
    askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => undefined }),
    askPatterns: lister({ principal, traceId: 'tr-1' }),
    askPlanRunner: runners({ principal, traceId: 'tr-1', signal: new AbortController().signal }), body,
  });
  const ask = async (principal: Principal, source: string, type: string, pick: (input: AskPlanInput) => AskPlan) => {
    choose = pick;
    const placeholder = PLACEHOLDER(type);
    const resolveStub = async ({ message }: { message: string }) => ({ status: 'resolved' as const, text: `${placeholder}${message.slice(4)}`, spans: [{ start: 0, end: placeholder.length, placeholder, typedStart: 0, typedEnd: 4 }], placeholders: new Map([[placeholder, { kind: 'entity' as const, ref: { sourceId: source, entityType: type, stableId: 'X-1' } }]]), capReached: false });
    const sourceModel = MAPPING.sources.find((candidate) => candidate.id === source);
    if (sourceModel === undefined) throw new Error('no source');
    const view = aiMappingViewOf({ sources: [sourceModel] });
    const route = createAskPlanRoute({ resolve: resolveStub as never, plans: () => plans, view: () => view, vocabulary: () => questionVocabulary({ view }) });
    const message = 'Acme is the same as it is';
    const shown = await route.handler(requestOf(principal, { message, sourceId: source }, source));
    const parsed = askPlanResponseSchema.parse(shown);
    if (!('previewHash' in parsed)) throw new Error('no preview');
    return askPlanResponseSchema.parse(await route.handler(requestOf(principal, { message, sourceId: source, send: true, previewHash: parsed.previewHash }, source)));
  };
  const run = async (principal: Principal, planId: string, source: string) => createAskRunRoute({ plans: () => plans }).handler(requestOf(principal, { planId }, source));
  const reads = () => executor.calls.filter((call) => call.templateId === 'pattern');
  const key = (input: AskPlanInput): string => {
    const line = input.patterns?.text.split('\n').find((candidate) => candidate.startsWith('pat_1'));
    if (line === undefined) throw new Error('no pat_1 offered');
    return 'pat_1';
  };
  const savedPlan = (type: string, input: AskPlanInput): AskPlan => ({ kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'The saved pattern fits.', params: { patternKey: key(input), ref: { entityType: type, stableId: PLACEHOLDER(type) } } }) as AskPlan;
  return { events, patterns, plans, planned, save, set, ask, run, reads, savedPlan, rowsOf: options.rowsOf };
}

describe.each(CASES)('a saved pattern on the demo pack of $source', (entry) => {
  it('is offered by structure, planned by key, confirmed and run through the saved run, and the run is audited with the pattern’s id and version and no name', async () => {
    const h = harness();
    const pattern = await h.save(entry.source, entry.definition, ALICE);
    const plan = await h.ask(ALICE, entry.source, entry.anchorType, (input) => h.savedPlan(entry.anchorType, input));
    expect(plan).toMatchObject({ plan: { templateId: 'saved-pattern', params: { patternId: pattern.id, patternVersion: pattern.version } } });
    const [input] = h.planned;
    expect(input?.patterns?.text).toContain(`starts at an entity of type ${entry.anchorType} that the question gives; step 1: out over ${entry.relationship} to ${entry.arrivesAt}`);
    expect(JSON.stringify(input)).not.toContain(pattern.id);
    expect(JSON.stringify(input)).not.toContain(pattern.name);
    const planId = 'planId' in plan ? plan.planId : '';
    const answer = askRunResponseSchema.parse(await h.run(ALICE, planId, entry.source));
    expect(answer).toMatchObject({ planId, outcome: 'complete', result: { templateId: 'saved-pattern', result: { status: 'ok' } } });
    expect(h.reads()).toHaveLength(1);
    const event = h.events.find((candidate) => candidate.action === 'ask.run');
    expect(event?.detail).toMatchObject({ askRun: { templateId: 'saved-pattern', patternId: pattern.id, patternVersion: pattern.version, rowCount: answer.result.templateId === 'saved-pattern' && answer.result.result.status === 'ok' ? answer.result.result.nodes.length : -1 } });
    expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE-NAME/);
  });

  it('is refused at the run when it was changed after the plan, and when its owner unshared it, with nothing read', async () => {
    const changed = harness();
    const first = await changed.save(entry.source, entry.definition, ALICE);
    const plan = await changed.ask(ALICE, entry.source, entry.anchorType, (input) => changed.savedPlan(entry.anchorType, input));
    changed.set(first, { version: first.version + 1 });
    const refusal = parseExtensionRefusal(await changed.run(ALICE, 'planId' in plan ? plan.planId : '', entry.source).catch((error: unknown) => error));
    expect(refusal).toEqual({ code: 'CONFLICT', reason: 'pattern-changed' });
    expect(changed.reads()).toEqual([]);

    const shared = harness();
    const theirs = await shared.save(entry.source, entry.definition, BOB);
    shared.set(theirs, { visibility: 'shared' });
    const sharedPlan = await shared.ask(ALICE, entry.source, entry.anchorType, (input) => shared.savedPlan(entry.anchorType, input));
    shared.set({ ...theirs, visibility: 'shared' }, { visibility: 'private' });
    expect(parseExtensionRefusal(await shared.run(ALICE, 'planId' in sharedPlan ? sharedPlan.planId : '', entry.source).catch((error: unknown) => error))).toEqual({ code: 'NOT_FOUND' });
    expect(shared.reads()).toEqual([]);
  });

  it('offers a pattern of another person only while it is shared, and never a private pattern, a deleted one or one of another source, in the planner input, a plan or an event', async () => {
    const h = harness();
    const mine = await h.save(entry.source, entry.definition, ALICE);
    const bobsShared = await h.save(entry.source, entry.definition, BOB);
    h.set(bobsShared, { visibility: 'shared' });
    const bobsPrivate = await h.save(entry.source, entry.definition, BOB);
    const elsewhere = CASES.find((other) => other.source !== entry.source);
    const other = elsewhere === undefined ? undefined : await h.save(elsewhere.source, elsewhere.definition, ALICE);
    const deleted = await h.save(entry.source, entry.definition, ALICE);
    h.patterns.deletedPatterns.set(deleted.id, { deletedAt: '2026-03-01T00:00:00.000Z', purgeAfter: '2026-04-01T00:00:00.000Z' });
    const plan = await h.ask(ALICE, entry.source, entry.anchorType, (input) => h.savedPlan(entry.anchorType, input));
    const [input] = h.planned;
    expect([...(input?.patterns?.entries.keys() ?? [])]).toEqual(['pat_1', 'pat_2']);
    const everything = JSON.stringify([input, plan, h.events]);
    for (const secret of [bobsPrivate.id, bobsPrivate.name, deleted.id, deleted.name, other?.id ?? 'none', other?.name ?? 'none', bobsShared.name, mine.name]) expect(everything).not.toContain(secret);
  });
});
