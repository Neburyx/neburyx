import { auditDetailSchema, assistantTurnAuditDetailSchema, type AssistantThreadTurnWrite } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, answerOf, ok, rig, type Rig, type RigOptions } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore } from './run-store.js';
import { createMemoryAssistantThreadStore } from './thread-store.js';
import { ROUTER_PROMPT_VERSION } from './router.js';
import { OVERVIEW_PROMPT_ID, OVERVIEW_PROMPT_VERSION } from './verdict-overview.js';

afterAll(removeAskFolders);

const PERSON = '0192f000-0000-7000-8000-000000000001';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const EDGE_KEY = JSON.stringify(['edge', 'demo', 'stored', 'SENT', 'A-1', 'A-2', 'e-1']);
const linked = (refs: { edges: readonly { stableId: string }[] }) => refs.edges.map((ref) => ({ ref: { ...ref, sourceId: 'demo', type: 'SENT', from: 'A-1', to: 'A-2' }, from: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' }, to: { sourceId: 'demo', entityType: 'widget', stableId: 'A-2' }, type: 'SENT', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }));
const BODY = { ...VIEW_BODY, viewElementKeys: [...VIEW_BODY.viewElementKeys, EDGE_KEY], investigationId: INVESTIGATION, message: 'Is this customer laundering money? SENTINEL-MESSAGE' };
const VERDICT = ok('{"route":"refuse","cause":"verdict"}');
const SENTENCE = 'Account A-1 is in view zzcanaryzz';
const GOOD = ok(JSON.stringify({ sentences: [{ text: SENTENCE, cites: ['e1', 'n1', 'n2'] }] }));
const drain = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
};

async function turn(over: Partial<RigOptions> = {}, body: unknown = BODY) {
  const runs = createMemoryAssistantRunStore();
  const threads = createMemoryAssistantThreadStore();
  const r: Rig = await rig({ reply: VERDICT, overview: GOOD, view: GOOD, readEdges: linked as never, runStore: runs, threadStore: threads, ...over });
  const answer = await answerOf(r.route.handler(r.request(body, { principalId: PERSON })));
  await drain();
  return { r, runs, threads, answer };
}
const closed = (r: Rig) => {
  const events = r.events.filter((event) => event.action === 'assistant.turn.closed');
  expect(events).toHaveLength(1);
  const detail = auditDetailSchema.parse(events[0]?.detail);
  return assistantTurnAuditDetailSchema.parse('turn' in detail ? detail.turn : undefined);
};
const stored = (t: Awaited<ReturnType<typeof turn>>): AssistantThreadTurnWrite[] => t.threads.threads.get(`${INVESTIGATION}:${PERSON}`)?.turns ?? [];

describe('the records of a verdict refusal with an overview', () => {
  it('has one audit event and one stored call for each model call, the overview under its own prompt, with the instructions, values and reply in the stored run', async () => {
    const t = await turn();
    const [run] = t.runs.runs;
    expect(run?.callStarts.map((call) => call.number)).toEqual([1, 2]);
    expect(run?.callStarts[1]?.instructionsText).toContain('SENTINEL-OVERVIEW-PROMPT');
    expect(run?.callStarts[1]?.valuesText).toContain('Elements in view:');
    expect(run?.callEnds[1]).toMatchObject({ number: 2, status: 'answered' });
    expect(run?.callEnds[1]?.replyText).toContain('zzcanaryzz');
    const overviewEvents = t.r.events.filter((event) => event.action === 'assistant.overview');
    expect(overviewEvents).toHaveLength(1);
    expect(JSON.stringify(overviewEvents[0])).toContain(run?.id ?? 'no-run');
    expect(t.r.events.filter((event) => event.action === 'assistant.route')).toHaveLength(1);
    const { turn: ending } = { turn: closed(t.r) };
    expect(ending).toMatchObject({ promptId: OVERVIEW_PROMPT_ID, promptVersion: String(OVERVIEW_PROMPT_VERSION) });
  });

  it('closes the turn as a verdict refusal with the added call and the number of elements cited, and no sentence or message text in any audit event', async () => {
    const t = await turn();
    expect(closed(t.r)).toMatchObject({ route: 'refuse', outcome: 'refused', cause: 'verdict', modelCalls: 2, citedElements: 3, steps: 0 });
    const everything = JSON.stringify(t.r.events);
    expect(everything).not.toContain('zzcanaryzz');
    expect(everything).not.toContain('SENTINEL-MESSAGE');
    expect(everything).not.toContain('Account A-1');
  });

  it('stores one thread turn as a refusal of a verdict, as references only, as a refusal without an overview is stored', async () => {
    const withOverview = await turn();
    const plain = await turn({ overview: undefined, view: undefined });
    const [kept] = stored(withOverview);
    const [alone] = stored(plain);
    expect(stored(withOverview)).toHaveLength(1);
    for (const key of ['route', 'outcome', 'cause', 'entities', 'citationRefs', 'steps'] as const) expect(kept?.[key], key).toEqual(alone?.[key]);
    expect(kept).toMatchObject({ route: 'refuse', outcome: 'refused', cause: 'verdict', entities: [], citationRefs: [], steps: 0 });
    // the model metadata is that of the turn's last call, as for any turn: the overview's call here, the router's without one
    expect(kept).toMatchObject({ modelRef: 'fixture-model', promptVersion: String(OVERVIEW_PROMPT_VERSION) });
    expect(alone).toMatchObject({ promptVersion: String(ROUTER_PROMPT_VERSION) });
    expect(kept?.questionHash).toMatch(/^[0-9a-f]{64}$/);
    // the question as typed and the answer in its stored form are the thread's text: the fixed sentence frozen, the overview as written
    expect(kept?.question).toContain('SENTINEL');
    expect(kept?.answer?.blocks[0]).toMatchObject({ kind: 'refusal', sentence: { form: 'frozen' }, overview: [{ form: 'unbound', text: expect.stringContaining('Account A-1') }] });
    expect(JSON.stringify({ ...kept, question: undefined, answer: undefined })).not.toContain('SENTINEL');
    expect(JSON.stringify(alone?.answer)).not.toContain('Account A-1');
  });

  it('leaves the context of the next turn as a plain verdict refusal leaves it', async () => {
    const threads = createMemoryAssistantThreadStore();
    const contextAfter = async (over: Partial<RigOptions>) => {
      const first = await rig({ reply: VERDICT, threadStore: threads, ...over });
      await answerOf(first.route.handler(first.request(BODY, { principalId: PERSON })));
      await drain();
      return JSON.stringify(threads.threads.get(`${INVESTIGATION}:${PERSON}`)?.turns.map((kept) => ({ route: kept.route, outcome: kept.outcome, cause: kept.cause, entities: kept.entities, citationRefs: kept.citationRefs })));
    };
    const withOverview = await contextAfter({ overview: GOOD, view: GOOD });
    const alone = await contextAfter({});
    expect(withOverview.split('}')[0]).toBe(alone.split('}')[0]);
    expect(withOverview).not.toContain('Account A-1');
  });

  it('leaves the audit events, the stored run and the thread entry of a refusal without an overview as they were', async () => {
    const t = await turn({ overview: undefined, view: undefined });
    expect(closed(t.r)).toMatchObject({ route: 'refuse', outcome: 'refused', cause: 'verdict', modelCalls: 1, promptId: 'assistant.route' });
    expect(closed(t.r)).not.toHaveProperty('citedElements');
    expect(t.runs.runs[0]?.callStarts).toHaveLength(1);
    expect(stored(t)).toHaveLength(1);
  });
});
