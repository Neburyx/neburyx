import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { startAssistantRig } from './assistant-rig.js';
import { expectNoValue } from './checks.js';
import { folderOf, reply } from './fixtures.js';
import { recordingRunStore, startRig } from './rig.js';
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

/** A value the person wrote that no record may hold: it stands for an id and for nothing else. */
const WRITTEN = 'SENTINEL-WRITTEN-77';
const ROUTE = (id: string): string => JSON.stringify({ route: 'ask', intent: 'widgetById', entities: { id } });
const INTENT_TEMPLATES = ['entity-load', 'file-query', 'shared-attribute', 'shared-attribute-count'];

const start = (over: { held?: readonly string[]; unexportable?: string } = {}) => startAssistantRig({ stub, threads: true, respond: () => undefined, ...over });
const lookupsOf = (rig: Awaited<ReturnType<typeof start>>) => rig.reads().filter((read) => read.templateId === 'entity-load-many');
const refusalOf = (body: Record<string, unknown>) => (body['answer'] as { refused?: Record<string, unknown> } | undefined)?.refused;

const CASES = [
  ['an element of another type', 'GT-1', ['gadget/GT-1'], undefined, 'other-type'],
  ['an id that exists as nothing', WRITTEN, [], undefined, 'not-found'],
  ['an element the person may not export', 'W-9', undefined, 'W-9', 'hidden'],
] as const;

describe('a value the person writes for a role that needs a type, through the real application of the assistant', () => {
  it.each(CASES)('answers %s with the fixed refusal and runs nothing of the intent: only the lookup reached the source, through the gate, and the closing event holds the cause and the kind and no value', async (_name, id, held, unexportable, kind) => {
    const rig = await start({ ...(held === undefined ? {} : { held }), ...(unexportable === undefined ? {} : { unexportable }) });
    const before = rig.reads().length;
    const answer = await rig.turn('Show that widget', [ROUTE(id)]);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'answered', route: 'ask', answer: { refused: { cause: 'value-not-fit', intent: 'widgetById', valueNotFit: { kind, needed: 'widget' } } } });
    expect(JSON.stringify(answer.body)).not.toMatch(/nothing found|nothing in this source/i);
    // the lookup is a read of the turn through a registered template, and the intent's own templates did not run
    expect(lookupsOf(rig).length).toBeGreaterThan(0);
    expect(rig.reads().slice(before).filter((read) => INTENT_TEMPLATES.includes(read.templateId))).toEqual([]);
    // the lookup is audited: the read by references and the gate's own event, and the turn's closing event names the cause and the kind
    const events = rig.events();
    expect(events.some((event) => event.action === 'graph.read_refs' && event.result === 'success')).toBe(true);
    expect(events.some((event) => event.action === 'entity.load')).toBe(true);
    expect(events.find((event) => event.action === 'assistant.turn.closed')).toMatchObject({ result: 'refused', detail: { turn: { route: 'ask', outcome: 'refused', cause: 'value-not-fit', valueKind: kind } } });
    // no record holds the value (the router's own reply is the one place it was written)
    await rig.threadWritten(1);
    expectNoValue([events, rig.logs, answer.headers, rig.threadRows()], [WRITTEN]);
    await rig.close();
  });

  it('cites the element of another type with the title the gate gave it', async () => {
    const rig = await start({ held: ['gadget/GT-1'] });
    const answer = await rig.turn('Show that widget', [ROUTE('GT-1')]);
    expect(refusalOf(answer.body)).toMatchObject({ sentence: expect.stringMatching(/is a gadget; this question needs a widget\. Nothing was run\.$/), valueNotFit: { kind: 'other-type', found: 'gadget', citation: { type: 'gadget', ref: { entityType: 'gadget', stableId: 'GT-1' } } } });
    await rig.close();
  });

  it('canary: the same request for a value that is a widget of the source runs the intent, so the check that the intent ran no read fails on it', async () => {
    const rig = await start({ held: ['widget/W-1'] });
    const before = rig.reads().length;
    const answer = await rig.turn('Show that widget', [ROUTE('W-1'), '{"done":true}', JSON.stringify({ sentences: [{ text: 'Widget W-1 was read.', cites: ['r1'] }] })]);
    expect(answer.body).toMatchObject({ status: 'answered', route: 'ask', reads: [{ tool: 'widgetById', subject: 'W-1' }] });
    expect(rig.reads().slice(before).some((read) => INTENT_TEMPLATES.includes(read.templateId))).toBe(true);
    await rig.close();
  });

  it('is asked with the masking of the turn and counted against the person\'s rate by the reader, not as a step: a turn of one step still answers', async () => {
    const rig = await startAssistantRig({ stub, maxSteps: 1, respond: () => undefined, held: [] });
    const answer = await rig.turn('Show that widget', [ROUTE(WRITTEN)], { mask: true });
    expect(answer.body).toMatchObject({ status: 'answered', route: 'ask', answer: { refused: { cause: 'value-not-fit' } } });
    await rig.close();
  });
});

describe('a value the person writes for a role that needs a type, through the real application of Ask', () => {
  const askRig = async (held?: readonly string[]) => {
    const store = recordingRunStore();
    const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
    return { store, rig: await startRig({ extension, stub, rows: store.rows, folder: folderOf(), respond: () => Promise.resolve({ status: 'rows' as const, rows: [] }), ...(held === undefined ? {} : { held }) }) };
  };

  it('answers an id that exists as nothing with the fixed refusal, runs nothing of the intent, writes one refused event with the cause and the kind and no value, and records no run row', async () => {
    const { store, rig } = await askRig([]);
    const answer = await rig.ask('Show it', reply('widgetById', { id: WRITTEN }));
    expect(answer.body).toMatchObject({ refused: { cause: 'value-not-fit', intent: 'widgetById', sentence: 'There is no widget with that id. Nothing was run.', valueNotFit: { kind: 'not-found', needed: 'widget' } } });
    expect(rig.reads().filter((read) => INTENT_TEMPLATES.includes(read.templateId))).toEqual([]);
    const events = rig.appEvents.filter((event) => event.action === 'ask.question');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'refused', detail: { askRun: { cause: 'value-not-fit', valueKind: 'not-found' } } });
    expect(rig.appEvents.some((event) => event.action === 'graph.read_refs')).toBe(true);
    expect(store.rows).toEqual([]);
    expectNoValue([rig.appEvents, rig.logs, answer.body, store.rows], [WRITTEN]);
    await rig.close();
  });

  it('canary: a widget of the source runs the intent', async () => {
    const { rig } = await askRig(['widget/W-001']);
    const answer = await rig.ask('Show it', reply('widgetById', { id: 'W-001' }));
    expect(JSON.stringify(answer.body)).not.toContain('value-not-fit');
    expect(rig.reads().some((read) => read.templateId === 'entity-load')).toBe(true);
    await rig.close();
  });
});
