import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionRefusal, type AskClassification, type AskPatternOffer, type AskFolder, type AskRun, type AskRunResult, type AuditEvent, type ExtensionRefusalFields, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditUnavailableError } from '../audited.js';
import { loadAskFolder } from '../folder/load.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { createAskContinueRoute, createAskQuestionRoute, type QuestionRouteOptions } from './question-routes.js';
import type { RunRecord, RunStore } from './run-store.js';

afterAll(removeAskFolders);

const SOURCE = 'demo';
const NOW = 1_800_000_000_000;
const QUESTION = 'Which accounts share a shape with SENTINEL-QUESTION?';
const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');

const node = (stableId: string) => ({ ref: { sourceId: SOURCE, entityType: 'widget', stableId }, display: { title: `Account ${stableId}`, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const okResult = (): AskRunResult =>
  ({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 'test' }, matchIds: [node('A-2').ref], nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } }) as AskRunResult;
const heavyResult = (): AskRunResult =>
  ({ templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } }) as AskRunResult;

interface Rig {
  readonly route: ExtensionRoute;
  readonly continueRoute: ExtensionRoute;
  readonly events: AuditEvent[];
  readonly rows: RunRecord[];
  readonly runs: { asked: unknown; options: unknown; mask: boolean }[];
  readonly classified: unknown[];
  readonly signals: AbortSignal[];
  readonly logs: { fields: unknown; message: string }[];
  request(body: unknown, over?: Partial<ExtensionRequest>): ExtensionRequest;
}

async function rig(options: { patterns?: readonly AskPatternOffer[]; intents?: unknown; classify?: () => Promise<AskClassification>; run?: (continuing: boolean) => AskRun; sink?: 'fails'; readable?: boolean } = {}): Promise<Rig> {
  const folder: AskFolder | undefined = await loadAskFolder({ folder: makeAskFolder([SOURCE], options.intents), sourceIds: [SOURCE] }).then((loaded) => (loaded.ok ? loaded.folder : undefined));
  const events: AuditEvent[] = [];
  const rows: RunRecord[] = [];
  const runs: Rig['runs'] = [];
  const classified: unknown[] = [];
  const signals: AbortSignal[] = [];
  const logs: Rig['logs'] = [];
  const runStore: RunStore = { record: async (row) => void rows.push(row) };
  const routeOptions: QuestionRouteOptions = {
    folder: () => folder,
    runs: () => runStore,
    logger: () => ({ warn: (fields, message) => void logs.push({ fields, message }), info: (fields, message) => void logs.push({ fields, message }) }),
    now: () => NOW,
  };
  const request = (body: unknown, over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({
    principalId: 'p-1',
    principalRole: 'investigator',
    previewOn: true,
    traceId: 'tr-1',
    audit: { record: async (event) => (options.sink === 'fails' ? Promise.reject(new Error('down')) : void events.push(event)) },
    askClassifier: {
      availability: () => ({ available: true }),
      classify: async (input, signal) => {
        classified.push(input);
        signals.push(signal);
        return options.classify === undefined ? { ok: true, intent: 'shared', entities: { id: 'A-1' } } : options.classify();
      },
    },
    signal: new AbortController().signal,
    signText: sign,
    askSourceReadable: async () => {
      if (options.readable === false) throw new ExtensionRefusal({ code: 'NOT_FOUND' });
    },
    ...(options.patterns === undefined
      ? {}
      : {
          askPatterns: async () => ({ offers: options.patterns ?? [], cut: false }),
          askPatternFind: async (_sourceId: string, id: string) => options.patterns?.find((offer) => offer.id === id),
        }),
    askRunner: (scope) => ({
      run: async (asked, runOptions) => {
        runs.push({ asked, options: runOptions, mask: scope.mask });
        return options.run === undefined ? { status: 'ok', result: okResult() } : options.run(runOptions?.continue === true);
      },
    }),
    body,
    ...over,
  });
  return { route: createAskQuestionRoute(routeOptions), continueRoute: createAskContinueRoute(routeOptions), events, rows, runs, classified, signals, logs, request };
}

const ASK = { sourceId: SOURCE, question: QUESTION };
const detailOf = (event: AuditEvent | undefined): Record<string, unknown> => (event?.detail !== undefined && 'askRun' in event.detail ? { ...event.detail.askRun } : {});
const refusalOf = async (promise: Promise<unknown>): Promise<ExtensionRefusalFields | undefined> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExtensionRefusal) return { ...error } as unknown as ExtensionRefusalFields;
    throw error;
  }
  return undefined;
};

describe('a question of a template intent', () => {
  it('is classified, bound to the template and run once through the gate, and answered with its summary, one event and one row', async () => {
    const { route, request, events, rows, runs, classified } = await rig();
    const answer = (await route.handler(request(ASK))) as { answered: Record<string, unknown> };
    expect(runs).toEqual([{ asked: { templateId: 'shared-attribute', params: { ref: { entityType: 'widget', stableId: 'A-1' }, attributeType: 'shape', via: 'USES_SHAPE' } }, options: undefined, mask: false }]);
    expect(answer.answered).toMatchObject({ intent: 'shared', entities: { id: 'A-1' }, outcome: 'complete', result: { templateId: 'shared-attribute' } });
    expect(answer.answered['summary']).toBeDefined();
    expect(answer.answered['continueToken']).toBeUndefined();
    expect(classified).toEqual([{ sourceId: SOURCE, question: QUESTION, actorId: 'p-1', actorRole: 'investigator', traceId: 'tr-1' }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ask.question', result: 'success', sourceId: SOURCE, actorId: 'p-1', resourceType: 'ask-intent', resourceRef: 'shared', traceId: 'tr-1' });
    expect(detailOf(events[0])).toMatchObject({ intent: 'shared', kind: 'template', outcome: 'complete', templateId: 'shared-attribute', rowCount: 2 });
    expect(detailOf(events[0])['paramsHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows).toEqual([{ actorId: 'p-1', intent: 'shared', outcome: 'complete', rowCount: 2, elapsedMs: 0 }]);
    expect([detailOf(events[0])['patternId'], detailOf(events[0])['patternVersion']]).toEqual([undefined, undefined]);
  });

  it('refuses, before the runner and with one event, a value that does not fit the template, as invalid-inputs', async () => {
    const intents = { find: { parameters: ['q'], template: 'search', settings: { entityTypes: ['widget'], text: '$q' } } };
    const { route, request, runs, events, rows } = await rig({ intents, classify: async () => ({ ok: true, intent: 'find', entities: { q: 'x'.repeat(250) } }) });
    expect(await route.handler(request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'invalid-inputs', intent: 'find' }) });
    expect(runs).toEqual([]);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0])).toMatchObject({ outcome: 'refused', cause: 'invalid-inputs' });
    expect(rows).toEqual([]);
  });

  it('passes the mask of the request to the run', async () => {
    const { route, request, runs } = await rig();
    await route.handler(request({ ...ASK, mask: true }));
    expect(runs[0]?.mask).toBe(true);
  });

  it('writes events that hold no entity value, no question and no sentence', async () => {
    const { route, request, events } = await rig();
    await route.handler(request(ASK));
    expect(JSON.stringify(events)).not.toMatch(/A-1|A-2|SENTINEL|Which accounts|share a shape/);
  });

  it('has a parameter hash that differs for other values and does not hold them', async () => {
    const first = await rig();
    await first.route.handler(first.request(ASK));
    const second = await rig({ classify: async () => ({ ok: true, intent: 'shared', entities: { id: 'A-9' } }) });
    await second.route.handler(second.request(ASK));
    expect(detailOf(first.events[0])['paramsHash']).not.toBe(detailOf(second.events[0])['paramsHash']);
  });
});

describe('a question whose entities are not the intent\'s parameters', () => {
  it.each([
    ['missing', {}, 'missing-inputs', { parameters: ['id'], found: [], missing: ['id'], extra: [] }],
    ['extra', { id: 'A-1', more: 'x' }, 'extra-inputs', { parameters: ['id'], found: ['id', 'more'], missing: [], extra: ['more'] }],
  ])('runs nothing and says which (%s)', async (_name, entities, cause, names) => {
    const { route, request, events, rows, runs } = await rig({ classify: async () => ({ ok: true, intent: 'shared', entities }) });
    const answer = await route.handler(request(ASK));
    expect(answer).toEqual({ refused: expect.objectContaining({ cause, intent: 'shared', ...names }) });
    expect(runs).toEqual([]);
    expect(rows).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused' });
    expect(detailOf(events[0])).toMatchObject({ intent: 'shared', outcome: 'refused', cause });
    expect(JSON.stringify(events)).not.toContain('more');
  });
});

describe('a question the classifier refuses', () => {
  it.each(['no-intent', 'unknown-intent', 'bad-reply', 'model-declined', 'model-failed', 'no-ask-for-source'] as const)('answers the cause %s with its fixed sentence, one event and no run', async (cause) => {
    const { route, request, events, rows, runs } = await rig({ classify: async () => ({ ok: false, cause }) });
    const answer = (await route.handler(request(ASK))) as { refused: { cause: string; sentence: string } };
    expect(answer.refused.cause).toBe(cause);
    expect(answer.refused.sentence.length).toBeGreaterThan(5);
    expect(runs).toEqual([]);
    expect(rows).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ask.question', result: 'refused' });
    expect(detailOf(events[0])).toMatchObject({ outcome: 'refused', cause });
  });

  it('is the unsupported refusal for the Community cause, with no event', async () => {
    const { route, request, events } = await rig({ classify: async () => ({ ok: false, cause: 'unavailable' }) });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(events).toEqual([]);
  });

  it('is the audit-unavailable refusal when the classifier cannot write its event', async () => {
    const { route, request } = await rig({ classify: async () => Promise.reject(new AuditUnavailableError()) });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  });
});

describe('a run the gate refuses', () => {
  it('is a failed run: recorded, audited and given back as the gate gives it', async () => {
    const { route, request, events, rows } = await rig({ run: () => ({ status: 'refused', refusal: { code: 'SOURCE_BUSY' } }) });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'SOURCE_BUSY' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'failed' });
    expect(detailOf(events[0])).toMatchObject({ outcome: 'failed', cause: 'source-busy' });
    expect(rows).toEqual([{ actorId: 'p-1', intent: 'shared', outcome: 'failed', rowCount: 0, elapsedMs: 0 }]);
  });

  it('answers an anchor that is not there as nothing found: audited as refused and with no row', async () => {
    const { route, request, events, rows } = await rig({ run: () => ({ status: 'refused', refusal: { code: 'NOT_FOUND' } }) });
    expect(await route.handler(request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'nothing-found', intent: 'shared' }) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused' });
    expect(rows).toEqual([]);
  });
});

describe('what comes before a question is classified', () => {
  it('refuses a source the person may not read before the classifier is asked', async () => {
    const { route, request, classified, events } = await rig({ readable: false });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'NOT_FOUND' });
    expect(classified).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each(['askRunner', 'signText', 'askSourceReadable'] as const)('is the unsupported refusal when the application gives no %s', async (name) => {
    const { route, request } = await rig();
    expect(await refusalOf(route.handler(request(ASK, { [name]: undefined })))).toMatchObject({ code: 'ASK_UNSUPPORTED' });
  });

  it('withholds the answer when the event cannot be written', async () => {
    const { route, request, rows } = await rig({ sink: 'fails' });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(rows).toEqual([]);
  });

  it('hands the abort signal of the request to the classifier', async () => {
    const { route, request, signals } = await rig();
    const controller = new AbortController();
    await route.handler(request(ASK, { signal: controller.signal }));
    expect(signals).toEqual([controller.signal]);
  });
});

const fileQueryResult = (): AskRunResult =>
  ({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 2, scope: 'rows' }, nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } }) as AskRunResult;

describe('a file-query intent', () => {
  const ask = { classify: async (): Promise<AskClassification> => ({ ok: true, intent: 'byId', entities: { id: 'A-1' } }) };

  it('runs the query of the folder through the runner with the entities as its values, and answers with its summary, one event with the query hash and one row', async () => {
    const { route, request, runs, events, rows } = await rig({ ...ask, run: () => ({ status: 'ok', result: fileQueryResult() }) });
    const answer = (await route.handler(request(ASK))) as { answered: Record<string, unknown> };
    expect(runs).toEqual([{ asked: { fileQuery: { intent: 'byId', values: { id: 'A-1' } } }, options: undefined, mask: false }]);
    expect(answer.answered).toMatchObject({ intent: 'byId', entities: { id: 'A-1' }, outcome: 'complete', result: { templateId: 'file-query' } });
    expect(answer.answered['summary']).toBeDefined();
    expect(events).toHaveLength(1);
    expect(detailOf(events[0])).toMatchObject({ intent: 'byId', kind: 'query', outcome: 'complete', rowCount: 2 });
    expect(detailOf(events[0])['querySha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(detailOf(events[0])['templateId']).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/A-1|A-2|SENTINEL/);
    expect(rows).toEqual([{ actorId: 'p-1', intent: 'byId', outcome: 'complete', rowCount: 2, elapsedMs: 0 }]);
  });

  it('answers nothing found, audited as refused with no row, when the query returned no node and no relationship', async () => {
    const empty = { templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 0, scope: 'rows' }, nodes: [], edges: [], notices: [], warnings: [] } } as AskRunResult;
    const { route, request, events, rows } = await rig({ ...ask, run: () => ({ status: 'ok', result: empty }) });
    expect(await route.handler(request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'nothing-found', intent: 'byId' }) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused' });
    expect(detailOf(events[0])).toMatchObject({ kind: 'query', outcome: 'refused', cause: 'nothing-found', rowCount: 0 });
    expect(rows).toEqual([]);
  });

  it('is partial when the read was cut', async () => {
    const cut = { templateId: 'file-query', result: { ...(fileQueryResult() as { result: object }).result, count: { quality: 'lowerBound', value: 50, scope: 'rows' }, notices: [{ code: 'readBounded' }] } } as AskRunResult;
    const { route, request, events } = await rig({ ...ask, run: () => ({ status: 'ok', result: cut }) });
    expect(await route.handler(request(ASK))).toMatchObject({ answered: { outcome: 'partial' } });
    expect(events[0]).toMatchObject({ result: 'partial' });
  });

  it('refuses missing or extra entities before the runner, as for a template', async () => {
    const { route, request, runs } = await rig({ classify: async () => ({ ok: true, intent: 'byId', entities: { id: 'A-1', more: 'x' } }) });
    expect(await route.handler(request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'extra-inputs', intent: 'byId', extra: ['more'] }) });
    expect(runs).toEqual([]);
  });

  it('gives back the refusal of the gate rule that refused the query, and records a failed run', async () => {
    const { route, request, events, rows } = await rig({ ...ask, run: () => ({ status: 'refused', refusal: { code: 'INVALID_REQUEST', reason: 'file-query-result' } }) });
    expect(await refusalOf(route.handler(request(ASK)))).toMatchObject({ code: 'INVALID_REQUEST', reason: 'file-query-result' });
    expect(detailOf(events[0])).toMatchObject({ kind: 'query', outcome: 'failed', cause: 'invalid-request' });
    expect(rows).toEqual([{ actorId: 'p-1', intent: 'byId', outcome: 'failed', rowCount: 0, elapsedMs: 0 }]);
  });
});

describe('a result that stops as heavy, and Continue', () => {
  async function heavyAnswer() {
    const rigged = await rig({ run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : heavyResult() }) });
    const first = (await rigged.route.handler(rigged.request(ASK))) as { answered: { continueToken: string; summary?: unknown; outcome: string } };
    return { rigged, first };
  }
  const continueBody = (token: string, over: Record<string, unknown> = {}) => ({ sourceId: SOURCE, intent: 'shared', entities: { id: 'A-1' }, continueToken: token, ...over });

  it('stops with a token and no summary, partial, and writes an event but no row', async () => {
    const { rigged, first } = await heavyAnswer();
    expect(first.answered.outcome).toBe('partial');
    expect(first.answered.continueToken).toMatch(/^[0-9]{13}\.[0-9a-f]{64}$/);
    expect(first.answered.summary).toBeUndefined();
    expect(rigged.events).toHaveLength(1);
    expect(rigged.events[0]).toMatchObject({ result: 'partial' });
    expect(rigged.rows).toEqual([]);
  });

  it('is continued by the token, with no classification, the page summarized, its own event and its row, and the token may be used again', async () => {
    const { rigged, first } = await heavyAnswer();
    const classifiedBefore = rigged.classified.length;
    for (let round = 0; round < 2; round += 1) {
      const answer = (await rigged.continueRoute.handler(rigged.request(continueBody(first.answered.continueToken)))) as { answered: { outcome: string; summary?: unknown } };
      expect(answer.answered.outcome).toBe('complete');
      expect(answer.answered.summary).toBeDefined();
    }
    expect(rigged.classified.length).toBe(classifiedBefore);
    expect(rigged.runs.map((run) => run.options)).toEqual([undefined, { continue: true }, { continue: true }]);
    expect(rigged.events.map((event) => event.action)).toEqual(['ask.question', 'ask.continue', 'ask.continue']);
    expect(rigged.rows).toHaveLength(2);
  });

  it.each([
    ['another intent', { intent: 'byId' }],
    ['other entities', { entities: { id: 'A-2' } }],
    ['another source', { sourceId: 'other' }],
    ['the other mask', { mask: true }],
    ['an intent not in the folder', { intent: 'gone' }],
  ])('refuses a token used with %s, runs nothing and writes an event with the refusal', async (_name, over) => {
    const { rigged, first } = await heavyAnswer();
    const eventsBefore = rigged.events.length;
    const runsBefore = rigged.runs.length;
    expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(first.answered.continueToken, over))))).toMatchObject({ code: 'INVALID_REQUEST', reason: 'continue-invalid' });
    expect(rigged.runs.length).toBe(runsBefore);
    expect(rigged.events.length).toBe(eventsBefore + 1);
    expect(rigged.events.at(-1)).toMatchObject({ action: 'ask.continue', result: 'refused' });
  });

  it('refuses a token after the definition of its intent changed, and writes an event with no source', async () => {
    const { rigged, first } = await heavyAnswer();
    const changed = makeAskFolder([SOURCE]);
    writeFileSync(join(changed, SOURCE, 'intents.json'), JSON.stringify({ shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE', limit: 5 } } }));
    const reloaded = await loadAskFolder({ folder: changed, sourceIds: [SOURCE] }).then((loaded) => (loaded.ok ? loaded.folder : undefined));
    expect(reloaded?.intent(SOURCE, 'shared')).toBeDefined();
    const other = createAskContinueRoute({ folder: () => reloaded, runs: () => undefined, logger: () => undefined, now: () => NOW });
    expect(await refusalOf(other.handler(rigged.request(continueBody(first.answered.continueToken))))).toMatchObject({ reason: 'continue-invalid' });
    expect(rigged.events.at(-1)).toMatchObject({ action: 'ask.continue', result: 'refused' });
    expect(rigged.events.at(-1)?.sourceId).toBeUndefined();
  });

  it('refuses a token of another person and an expired one', async () => {
    const { rigged, first } = await heavyAnswer();
    expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(first.answered.continueToken), { principalId: 'p-2' })))).toMatchObject({ reason: 'continue-invalid' });
    const late = createAskContinueRoute({ folder: () => undefined, runs: () => undefined, logger: () => undefined, now: () => NOW + 16 * 60 * 1000 });
    expect(await refusalOf(late.handler(rigged.request(continueBody(first.answered.continueToken))))).toMatchObject({ reason: 'continue-invalid' });
  });

  it('refuses before anything when the application gives no signing capability, and a source the person may not read after the token', async () => {
    const { rigged, first } = await heavyAnswer();
    expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(first.answered.continueToken), { signText: undefined })))).toMatchObject({ code: 'ASK_UNSUPPORTED' });
    const closed = await rig({ readable: false });
    expect(await refusalOf(closed.continueRoute.handler(closed.request(continueBody(first.answered.continueToken))))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

const PATTERN_HELD = '0195a000-0000-7000-8000-000000000001';
const PATTERN_ASKED = '0195a000-0000-7000-8000-000000000002';
const offerOf = (id: string, startingEntity: 'held' | 'asked', name: string, version = 3): AskPatternOffer => ({
  id,
  version,
  name,
  projection: { kind: 'definition', anchorType: 'widget', startingEntity, steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'gadget', conditions: [], windowed: false }] },
});
const HELD = offerOf(PATTERN_HELD, 'held', 'SECRET-HELD-NAME');
const ASKED = offerOf(PATTERN_ASKED, 'asked', 'SECRET-ASKED-NAME', 2);
const savedResult = (): AskRunResult => ({ templateId: 'saved-pattern', result: (okResult() as { result: unknown }).result }) as AskRunResult;
const savedHeavy = (): AskRunResult => ({ templateId: 'saved-pattern', result: (heavyResult() as { result: unknown }).result }) as AskRunResult;
const asks = (entities: Record<string, string>) => ({ classify: async (): Promise<AskClassification> => ({ ok: true, intent: 'saved-pattern', entities }) });
const everything = (value: unknown): string => JSON.stringify(value);
const SECRETS = /SECRET-HELD-NAME|SECRET-ASKED-NAME|SECRET-ANCHOR/;
/** Nothing the person typed or named (a label, an anchor) is in an event, a row, a log line or a refusal. */
const expectNoLeak = (rigged: { events: unknown; rows: unknown; logs: unknown }, ...more: unknown[]): void => void expect(everything([rigged.events, rigged.rows, rigged.logs, ...more])).not.toMatch(SECRETS);

describe('a question that names a saved pattern', () => {
  const patterns = [HELD, ASKED];

  it('shows the classifier the catalog of the caller’s patterns, with names and descriptions and no id or version', async () => {
    const { route, request, classified } = await rig({ patterns, ...asks({ pattern: 'pat_1' }) });
    await route.handler(request(ASK));
    const catalog = (classified[0] as { patternCatalog?: string }).patternCatalog ?? '';
    expect(catalog).toContain('SECRET-HELD-NAME');
    expect(catalog).toContain('SECRET-ASKED-NAME');
    expect(catalog).not.toMatch(/0195a000|version/i);
  });

  it('runs a held pattern with its id and version through the runner, and answers with the pattern’s id, its label and the summary', async () => {
    const { route, request, runs, events, rows } = await rig({ patterns: [HELD], ...asks({ pattern: 'pat_1' }), run: () => ({ status: 'ok', result: savedResult() }) });
    const answer = (await route.handler(request(ASK))) as { answered: Record<string, unknown> };
    expect(runs).toEqual([{ asked: { templateId: 'saved-pattern', params: { patternId: PATTERN_HELD, patternVersion: 3 } }, options: undefined, mask: false }]);
    expect(answer.answered).toMatchObject({ intent: 'saved-pattern', entities: { pattern: PATTERN_HELD }, outcome: 'complete', patternName: 'SECRET-HELD-NAME', result: { templateId: 'saved-pattern' } });
    expect(answer.answered['summary']).toBeDefined();
    expect(events).toHaveLength(1);
    expect(detailOf(events[0])).toMatchObject({ intent: 'saved-pattern', kind: 'template', outcome: 'complete', templateId: 'saved-pattern', patternId: PATTERN_HELD, patternVersion: 3, rowCount: 2 });
    expect(detailOf(events[0])['paramsHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows).toEqual([{ actorId: 'p-1', intent: 'saved-pattern', outcome: 'complete', rowCount: 2, elapsedMs: 0 }]);
  });

  it('runs an asked pattern with the anchor as a reference of the type the pattern starts at, never a type from the reply', async () => {
    const { route, request, runs } = await rig({ patterns: [ASKED], ...asks({ pattern: 'pat_1', anchor: 'SECRET-ANCHOR' }), run: () => ({ status: 'ok', result: savedResult() }) });
    await route.handler(request(ASK));
    expect(runs[0]?.asked).toEqual({ templateId: 'saved-pattern', params: { patternId: PATTERN_ASKED, patternVersion: 2, ref: { entityType: 'widget', stableId: 'SECRET-ANCHOR' } } });
  });

  it('keeps the typed name and the anchor out of every event, row and log line', async () => {
    const rigged = await rig({ patterns: [ASKED], ...asks({ pattern: 'pat_1', anchor: 'SECRET-ANCHOR' }), run: () => ({ status: 'ok', result: savedResult() }) });
    await rigged.route.handler(rigged.request(ASK));
    expectNoLeak(rigged);
  });

  it.each([
    ['a key that is not in the catalog', { pattern: 'pat_9' }, 'nothing-found'],
    ['an id instead of a key', { pattern: PATTERN_HELD }, 'nothing-found'],
    ['no pattern', { anchor: 'x' }, 'missing-inputs'],
    ['an anchor for a held pattern', { pattern: 'pat_1', anchor: 'SECRET-ANCHOR' }, 'extra-inputs'],
  ])('refuses %s before the runner, with one event and no row', async (_name, entities, cause) => {
    const rigged = await rig({ patterns: [HELD], ...asks(entities) });
    const { route, request, runs, events, rows } = rigged;
    const answer = await route.handler(request(ASK));
    expect(answer).toEqual({ refused: expect.objectContaining({ cause }) });
    expectNoLeak(rigged, answer);
    expect(runs).toEqual([]);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0])).toMatchObject({ outcome: 'refused', cause });
    expect(detailOf(events[0])['patternName']).toBeUndefined();
    if (cause === 'nothing-found') expect([detailOf(events[0])['patternId'], detailOf(events[0])['patternVersion']]).toEqual([undefined, undefined]);
    expect(rows).toEqual([]);
  });

  it('asks for the anchor of an asked pattern, naming the inputs', async () => {
    const rigged = await rig({ patterns: [ASKED], ...asks({ pattern: 'pat_1' }) });
    const answer = await rigged.route.handler(rigged.request(ASK));
    expect(answer).toEqual({ refused: expect.objectContaining({ cause: 'missing-inputs', parameters: ['pattern', 'anchor'], missing: ['anchor'] }) });
    expectNoLeak(rigged, answer);
  });

  it('is an unknown intent when the application lists no patterns, and the classifier is shown no catalog', async () => {
    const { route, request, classified } = await rig({ ...asks({ pattern: 'pat_1' }) });
    expect(await route.handler(request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'unknown-intent' }) });
    expect((classified[0] as { patternCatalog?: string }).patternCatalog).toBeUndefined();
  });

  it('fails as the application’s error, with no model call and no event, when the patterns cannot be listed', async () => {
    const { route, request, classified, events } = await rig({ patterns: [HELD], ...asks({ pattern: 'pat_1' }) });
    const failing = request(ASK, { askPatterns: async () => Promise.reject(new ExtensionRefusal({ code: 'NOT_FOUND' })) });
    expect(await refusalOf(route.handler(failing))).toMatchObject({ code: 'NOT_FOUND' });
    expect(classified).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers nothing found, with no row, when the pattern is gone by the time it runs, and records a failed run for a conflict', async () => {
    const gone = await rig({ patterns: [HELD], ...asks({ pattern: 'pat_1' }), run: () => ({ status: 'refused', refusal: { code: 'NOT_FOUND' } }) });
    expect(await gone.route.handler(gone.request(ASK))).toEqual({ refused: expect.objectContaining({ cause: 'nothing-found' }) });
    expect(gone.rows).toEqual([]);
    const changed = await rig({ patterns: [HELD], ...asks({ pattern: 'pat_1' }), run: () => ({ status: 'refused', refusal: { code: 'CONFLICT', reason: 'pattern-changed' } }) });
    expect(await refusalOf(changed.route.handler(changed.request(ASK)))).toMatchObject({ code: 'CONFLICT', reason: 'pattern-changed' });
    expect(changed.rows).toEqual([{ actorId: 'p-1', intent: 'saved-pattern', outcome: 'failed', rowCount: 0, elapsedMs: 0 }]);
    expect(detailOf(changed.events[0])).toMatchObject({ outcome: 'failed', cause: 'conflict', patternId: PATTERN_HELD, patternVersion: 3 });
    expectNoLeak(changed);
    expectNoLeak(gone);
  });

  describe('that stops as heavy', () => {
    const continueBody = (token: string, over: Record<string, unknown> = {}) => ({ sourceId: SOURCE, intent: 'saved-pattern', entities: { pattern: PATTERN_HELD }, continueToken: token, ...over });
    async function stopped(offers: readonly AskPatternOffer[] = [HELD], entities: Record<string, string> = { pattern: 'pat_1' }) {
      const rigged = await rig({ patterns: offers, ...asks(entities), run: (continuing) => ({ status: 'ok', result: continuing ? savedResult() : savedHeavy() }) });
      const first = (await rigged.route.handler(rigged.request(ASK))) as { answered: { continueToken: string; entities: unknown; patternName: string; summary?: unknown } };
      return { rigged, first };
    }

    it('answers the stop with a token, no summary and no row, and Continue runs the pattern for a page without a model call, naming it', async () => {
      const { rigged, first } = await stopped();
      expect(first.answered.continueToken).toMatch(/^[0-9]{13}\.[0-9a-f]{64}$/);
      expect(first.answered.summary).toBeUndefined();
      expect(rigged.rows).toEqual([]);
      const classifiedBefore = rigged.classified.length;
      const page = (await rigged.continueRoute.handler(rigged.request(continueBody(first.answered.continueToken)))) as { answered: Record<string, unknown> };
      expect(page.answered).toMatchObject({ outcome: 'complete', patternName: 'SECRET-HELD-NAME', entities: { pattern: PATTERN_HELD } });
      expect(rigged.runs.map((run) => run.options)).toEqual([undefined, { continue: true }]);
      expect(rigged.classified.length).toBe(classifiedBefore);
      expect(rigged.events.map((event) => event.action)).toEqual(['ask.question', 'ask.continue']);
      expect(everything(rigged.events)).not.toContain('SECRET-HELD-NAME');
    });

    it('continues an asked pattern with the anchor as a reference of the type the pattern starts at, and names the anchor in the entities of the page', async () => {
      const { rigged, first } = await stopped([ASKED], { pattern: 'pat_1', anchor: 'SECRET-ANCHOR' });
      const body = continueBody(first.answered.continueToken, { entities: { pattern: PATTERN_ASKED, anchor: 'SECRET-ANCHOR' } });
      const page = (await rigged.continueRoute.handler(rigged.request(body))) as { answered: Record<string, unknown> };
      expect(page.answered).toMatchObject({ outcome: 'complete', patternName: 'SECRET-ASKED-NAME', entities: { pattern: PATTERN_ASKED, anchor: 'SECRET-ANCHOR' } });
      expect(rigged.runs[1]).toMatchObject({ asked: { templateId: 'saved-pattern', params: { patternId: PATTERN_ASKED, patternVersion: 2, ref: { entityType: 'widget', stableId: 'SECRET-ANCHOR' } } }, options: { continue: true } });
      expectNoLeak(rigged);
    });

    it('refuses the token after the pattern was edited, and a pattern that is gone, an id that is not one, a find that fails, with an event that names no source', async () => {
      const { rigged, first } = await stopped();
      const token = first.answered.continueToken;
      const edited = { ...HELD, version: 4 };
      const cases: [string, Partial<ExtensionRequest>, Record<string, unknown>?][] = [
        ['edited', { askPatternFind: async () => edited }],
        ['gone', { askPatternFind: async () => undefined }],
        ['failing', { askPatternFind: async () => Promise.reject(new Error('down')) }],
        ['not an id', {}, { entities: { pattern: 'pat_1' } }],
      ];
      for (const [name, over, body] of cases) {
        expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(token, body), over))), name).toMatchObject({ code: 'INVALID_REQUEST', reason: 'continue-invalid' });
        expect(rigged.events.at(-1), name).toMatchObject({ action: 'ask.continue', result: 'refused' });
        expect(rigged.events.at(-1)?.sourceId, name).toBeUndefined();
      }
      expect(rigged.runs).toHaveLength(1);
      let finds = 0;
      const counting = { askPatternFind: async (_sourceId: string, id: string) => ((finds += 1), id === PATTERN_HELD ? HELD : undefined) };
      const forged = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
      expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(forged), counting)))).toMatchObject({ reason: 'continue-invalid' });
      expect(finds).toBe(1);
      expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(token, { entities: { pattern: 'pat_1' } }), counting)))).toMatchObject({ reason: 'continue-invalid' });
      expect(finds).toBe(1);
      expectNoLeak(rigged);
      expect(await refusalOf(rigged.continueRoute.handler(rigged.request(continueBody(token), { askPatternFind: undefined })))).toMatchObject({ code: 'ASK_UNSUPPORTED' });
    });
  });
});
