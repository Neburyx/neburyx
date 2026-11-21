import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { askRunAuditDetailSchema, parseAuditDetail, type AuditEvent } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../../../services/api/src/gate/templates/shared-attribute-count.js';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { oneStepRow } from '../../../services/api/src/testing/pattern-fixtures.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { sharedMappingOf, sharedRow } from '../../../services/api/src/testing/shared-attribute-fixtures.js';
import type { ExecuteCall } from '../../../services/api/src/gate/executor.js';
import { expectedBody, expectNoValue, expectProviderInput, SafetyCheckFailed } from './checks.js';
import { CLASSIFICATION, folderOf, handFolder, reply, SHARED_INTENTS } from './fixtures.js';
import { HOSTILE_VALUES } from './hostile.js';
import { recordingRunStore, startPatternRig, startRig, type Rig } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

const sentinels = HOSTILE_VALUES.map((entry) => entry.sentinel);
const QUESTION_SENTINEL = 'SENTINEL-QUESTION-9';
const LABEL_SENTINEL = 'SENTINEL-LABEL-9';
const ANCHOR_SENTINEL = 'SENTINEL-ANCHOR-9';
const ALL = [...sentinels, QUESTION_SENTINEL, LABEL_SENTINEL, ANCHOR_SENTINEL];
const question = (text: string): string => `${text} ${QUESTION_SENTINEL}`;

async function widgetRig(extra: { readonly mapping?: Parameters<typeof startRig>[0]['mapping']; readonly respond?: Parameters<typeof startRig>[0]['respond']; readonly folder?: string; readonly gateFolder?: Parameters<typeof startRig>[0]['gateFolder'] } = {}): Promise<Rig> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  return startRig({ extension, stub, rows: store.rows, folder: extra.folder ?? folderOf(), respond: extra.respond ?? (() => Promise.resolve(entityRows(widget(1)))), ...(extra.mapping === undefined ? {} : { mapping: extra.mapping }), ...(extra.gateFolder === undefined ? {} : { gateFolder: extra.gateFolder }) });
}

const hostile = (index: number): string => HOSTILE_VALUES[index]?.value ?? '';
const bodiesOf = (...answers: { readonly status: number; readonly body: unknown }[]) => answers.filter((answer) => answer.status >= 400).map((answer) => answer.body);

describe('no record of any case holds a value, the question or a label', () => {
  it('holds nothing of them after an answered question, a partial one, a stop and its Continue, every refusal and a failed run', async () => {
    const rig = await widgetRig();
    const problems: { status: number; body: unknown }[] = [];
    const asks: [string, string][] = [
      ['widgetById', reply('widgetById', { id: hostile(0) })],
      ['byId', reply('byId', { id: hostile(1) })],
      ['findWidgets', reply('findWidgets', { q: hostile(4) })],
      ['no intent', reply(null)],
      ['unknown intent', reply('wipe', { id: hostile(2) })],
      ['bad reply', `{"intent":"byId","entities":{"id":"${hostile(3).replace(/["\\\u0000-\u001f]/g, '')}"},"query":"x"}`],
      ['missing', reply('widgetById', {})],
      ['extra', reply('widgetById', { id: hostile(5), more: hostile(6) })],
    ];
    for (const [name, text] of asks) problems.push(await rig.ask(question(name), text));
    // a stop, then its Continue, over the shared-attribute template with a count above the threshold
    const heavy = await heavyRig();
    const stop = await heavy.ask(question('stop'), reply('sharedWith', { id: hostile(6) }));
    const token = (stop.body['answered'] as { continueToken: string }).continueToken;
    problems.push(stop, await heavy.post('/v1/ask/continue', { sourceId: 'demo', intent: 'sharedWith', entities: { id: hostile(6) }, continueToken: token }), await heavy.post('/v1/ask/continue', { sourceId: 'demo', intent: 'sharedWith', entities: { id: hostile(8) }, continueToken: token }));
    // a failed run: a write forced past the loader, and a result of a type the mapping does not name
    const forced = await widgetRig({ gateFolder: () => handFolder({ byId: "MATCH (n) WHERE n.id = $id DETACH DELETE n // SENTINEL_TEXT" }) });
    problems.push(await forced.ask(question('forced'), reply('byId', { id: hostile(9) })));
    const unmapped = await widgetRig({ respond: () => Promise.resolve({ status: 'rows' as const, rows: [{ n: { $type: 'node', elementId: 'x', labels: ['Stranger'], properties: { secret: 'SENTINEL_UNMAPPED' } } }] }) });
    problems.push(await unmapped.ask(question('unmapped'), reply('byId', { id: hostile(10) })));
    for (const each of [rig, heavy, forced, unmapped]) {
      expect(each.appEvents.length).toBeGreaterThan(0);
      expect(each.rows.length + each.appEvents.length).toBeGreaterThan(0);
      expectNoValue([each.appEvents, each.modelEvents, each.rows, each.logs, bodiesOf(...problems)], [...ALL, 'SENTINEL_TEXT', 'SENTINEL_UNMAPPED']);
    }
    // every event of every rig, the extension's own as well, holds the fields its contract names and no other
    for (const each of [rig, heavy, forced, unmapped]) for (const event of [...each.appEvents, ...each.modelEvents]) if (event.detail !== undefined) expect(() => parseAuditDetail(event.detail), JSON.stringify(event)).not.toThrow();
    // each question that ran has one run event, with the intent that was asked and the hash of its parameters; a question refused before it ran has the event of its refusal and no hash
    const questionEvents = (each: Rig): AuditEvent[] => each.appEvents.filter((event) => event.action === 'ask.question');
    const detailOf = (event: AuditEvent) => askRunAuditDetailSchema.parse((event.detail as { askRun?: unknown }).askRun);
    expect(questionEvents(rig)).toHaveLength(asks.length);
    expect(questionEvents(rig).map((event) => detailOf(event).intent)).toEqual(['widgetById', 'byId', 'findWidgets', undefined, undefined, undefined, 'widgetById', 'widgetById']);
    for (const event of questionEvents(rig).filter((candidate) => candidate.result === 'success')) expect(detailOf(event).paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(questionEvents(rig).filter((event) => event.result === 'success').length).toBeGreaterThan(0);
    expect(questionEvents(heavy).map((event) => detailOf(event).intent)).toEqual(['sharedWith']);
    for (const each of [forced, unmapped]) expect(questionEvents(each).map((event) => event.result)).toEqual(['failed']);
    for (const each of [rig, heavy, forced, unmapped]) await each.close();
  });

  it('holds nothing of a saved pattern\'s label or anchor: not its run, not its refusals, not its Continue', async () => {
    const store = recordingRunStore();
    const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
    const rig = await startPatternRig({ extension, stub, rows: store.rows, folder: folderOf(), answer: (call) => Promise.resolve({ status: 'rows' as const, rows: call.templateId === 'pattern' ? [oneStepRow(ANCHOR_SENTINEL, 'W-2')] : call.templateId === 'pattern-count' ? [{ matches: 1, bounded: false, stopListed: false, supernodes: 0 }] : [] }) });
    await rig.save(`Ring ${LABEL_SENTINEL}`);
    await rig.ask(question('prime'), reply(null));
    const key = /pat_\d+(?=, named "Ring SENTINEL-LABEL-9)/.exec(stub.requests[0] ?? '')?.[0] ?? /pat_\d+(?=, named \\"Ring SENTINEL-LABEL-9)/.exec(stub.requests[0] ?? '')?.[0] ?? '';
    expect(key).not.toBe('');
    const answers = [
      await rig.ask(question('run it'), reply('saved-pattern', { pattern: key, anchor: ANCHOR_SENTINEL })),
      await rig.ask(question('wrong key'), reply('saved-pattern', { pattern: 'pat_9', anchor: ANCHOR_SENTINEL })),
      await rig.ask(question('no pattern'), reply('saved-pattern', { anchor: ANCHOR_SENTINEL })),
      await rig.post('/v1/ask/continue', { sourceId: 'demo', intent: 'saved-pattern', entities: { pattern: '0195a000-0000-7000-8000-000000000001', anchor: ANCHOR_SENTINEL }, continueToken: `${Date.now() + 60_000}.${'a'.repeat(64)}` }),
    ];
    // the pattern did run, so the scan below covers a run and not only refusals
    expect(answers[0]?.body).toMatchObject({ answered: { intent: 'saved-pattern', patternName: `Ring ${LABEL_SENTINEL}` } });
    expect(rig.appEvents.some((event) => event.action === 'ask.question' && event.result === 'success' && JSON.stringify(event.detail).includes('patternId'))).toBe(true);
    expect(answers.slice(1).map((answer) => answer.status)).toEqual([200, 200, 400]);
    expectNoValue([rig.appEvents, rig.modelEvents, rig.rows, rig.logs, bodiesOf(...answers)], [LABEL_SENTINEL, ANCHOR_SENTINEL, QUESTION_SENTINEL]);
    await rig.close();
  });

  it('canary: a sink that adds a sentinel to each event is caught by the scan', async () => {
    const rig = await widgetRig();
    await rig.ask(question('canary'), reply('widgetById', { id: 'W-001' }));
    const leaky = rig.appEvents.map((event) => ({ ...event, detail: { ...(event.detail as object), leaked: sentinels[0] } }));
    expect(() => expectNoValue([leaky], sentinels)).toThrow(SafetyCheckFailed);
    await rig.close();
  });
});

/** The shared-attribute template with a count above the threshold, so that a run stops as heavy. */
async function heavyRig(): Promise<Rig> {
  return widgetRig({
    folder: folderOf(SHARED_INTENTS),
    mapping: sharedMappingOf({ budgets: { heavy_op_threshold: 3 } }),
    respond: (call: ExecuteCall) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'rows' as const, rows: [{ matches: 4, anchorBounded: false, skipped: false }] } : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }),
  });
}

describe('nothing is withheld or redacted on the way', () => {
  const PERSONAL = ['+1 415 555 0100', 'someone@example.test', 'Maria Fernandez-Lopez'];

  it('sends the model the question exactly as typed, runs the values exactly as typed, and answers with them exactly as typed', async () => {
    const rig = await widgetRig();
    const typed = `Is ${PERSONAL[2]} (${PERSONAL[0]}, ${PERSONAL[1]}) in the data?`;
    const answer = await rig.ask(typed, reply('byId', { id: PERSONAL[1] }));
    expectProviderInput(stub.requests, 0, expectedBody({ model: 'claude-haiku-5-5', instructions: CLASSIFICATION, values: typed, cache: true }));
    expect(rig.reads().some((read) => Object.values(read.parameters).includes(PERSONAL[1]))).toBe(true);
    expect(JSON.stringify(answer.body)).toContain(PERSONAL[1] ?? '');
    await rig.close();
  });

  it('masks the personal property of the result nodes when masking is asked for, and nothing else: the model and the source receive the same, exactly as typed', async () => {
    const store = recordingRunStore();
    const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
    const rig = await startRig({ extension, stub, rows: store.rows, folder: folderOf(), respond: () => Promise.resolve(entityRows(widget(1, { ownerName: 'SENTINEL-OWNER-9' }))) });
    const typed = `Is ${PERSONAL[2]} in the data?`;
    const plain = await rig.ask(typed, reply('widgetById', { id: 'W-001' }));
    const masked = await rig.ask(typed, reply('widgetById', { id: 'W-001' }), { mask: true });
    expect(JSON.stringify(plain.body)).toContain('SENTINEL-OWNER-9');
    expect(JSON.stringify(masked.body)).not.toContain('SENTINEL-OWNER-9');
    expect(masked.body).toMatchObject({ answered: { intent: 'widgetById' } });
    expectProviderInput(stub.requests, 0, expectedBody({ model: 'claude-haiku-5-5', instructions: CLASSIFICATION, values: typed, cache: true }));
    expectProviderInput(stub.requests, 1, expectedBody({ model: 'claude-haiku-5-5', instructions: CLASSIFICATION, values: typed, cache: true }));
    // the reads of the intent: the lookup of the value (a batched read of elements) is another read and holds the id the same way
    const parameters = rig.reads().filter((read) => read.templateId !== 'entity-load-many').map((read) => JSON.stringify(read.parameters));
    expect(new Set(parameters).size).toBe(1);
    // and the lookup holds the typed value only as the reference it looks up: the same two reads for the plain and the masked question, the value in no other parameter
    const lookups = rig.reads().filter((read) => read.templateId === 'entity-load-many');
    expect(lookups.length).toBeGreaterThan(0);
    for (const read of lookups) {
      expect(Object.keys(read.parameters).sort()).toEqual(['limit', 'refs']);
      expect((read.parameters['refs'] as { stableId: string }[]).map((ref) => ref.stableId)).toEqual(['W-001']);
    }
    expect(new Set(lookups.map((read) => JSON.stringify(read.parameters))).size).toBeLessThanOrEqual(lookups.length / 2);
    await rig.close();
  });
});
