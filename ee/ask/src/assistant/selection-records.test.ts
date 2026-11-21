import { auditDetailSchema, assistantTurnAuditDetailSchema, type AssistantThreadTurnWrite } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, VIEW_KEYS, answerOf, ok, rig, type Rig } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore } from './run-store.js';
import { createMemoryAssistantThreadStore } from './thread-store.js';

afterAll(removeAskFolders);

const PERSON = '0192f000-0000-7000-8000-000000000001';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] }));
const drain = async (): Promise<void> => {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
};

async function turn(selectionKeys?: readonly string[]) {
  const runs = createMemoryAssistantRunStore();
  const threads = createMemoryAssistantThreadStore();
  const r: Rig = await rig({ reply: ok('{"route":"view"}'), view: GOOD, runStore: runs, threadStore: threads });
  await answerOf(r.route.handler(r.request({ ...VIEW_BODY, investigationId: INVESTIGATION, ...(selectionKeys === undefined ? {} : { selectionKeys }) }, { principalId: PERSON })));
  await drain();
  return { r, runs, threads };
}
const closed = (r: Rig) => {
  const events = r.events.filter((event) => event.action === 'assistant.turn.closed');
  expect(events).toHaveLength(1);
  const detail = auditDetailSchema.parse(events[0]?.detail);
  return assistantTurnAuditDetailSchema.parse('turn' in detail ? detail.turn : undefined);
};
const stored = (t: Awaited<ReturnType<typeof turn>>): AssistantThreadTurnWrite[] => t.threads.threads.get(`${INVESTIGATION}:${PERSON}`)?.turns ?? [];
/** What a turn left, without the ids and the figures of the calls themselves. */
const traceOf = (t: Awaited<ReturnType<typeof turn>>): string =>
  JSON.stringify({
    events: t.r.events.map((event) => JSON.parse(JSON.stringify(event, (name, value: unknown) => (['traceId', 'runId', 'tokensIn', 'tokensOut', 'durationMs', 'selectedElements', 'promptSha256'].includes(name) ? undefined : value)))),
    thread: stored(t).map((entry) => ({ ...entry, id: undefined, runId: undefined, tokensIn: undefined, tokensOut: undefined })),
  });

describe('the selection and the records of a turn', () => {
  it('is a count in the closing event, with no key, title or reference of a selected element', async () => {
    const t = await turn([VIEW_KEYS[1] ?? '']);
    expect(closed(t.r)).toMatchObject({ route: 'view', outcome: 'answered', selectedElements: 1 });
    const text = JSON.stringify(t.r.events);
    expect(text).not.toContain('A-2');
    expect(text).not.toContain(VIEW_KEYS[1] ?? 'no-key');
  });

  it('is absent from the closing event when nothing is selected, when the list is empty and when no key is in the view', async () => {
    for (const selection of [undefined, [], [JSON.stringify(['node', 'demo', 'widget', 'A-9'])]]) expect(closed((await turn(selection)).r), JSON.stringify(selection)).not.toHaveProperty('selectedElements');
  });

  it('changes no hash, no thread entry and no audit event of the turn, apart from the count and the calls’ own figures, for the same replies', async () => {
    const without = await turn();
    const withSelection = await turn([VIEW_KEYS[0] ?? '', VIEW_KEYS[1] ?? '']);
    expect(traceOf(withSelection)).toBe(traceOf(without));
    expect(stored(withSelection)[0]?.questionHash).toBe(stored(without)[0]?.questionHash);
    expect(closed(withSelection.r)).toMatchObject({ selectedElements: 2 });
  });

  it('is in the stored run only as part of the values the calls were sent, and in no audit event or thread row', async () => {
    const t = await turn([VIEW_KEYS[1] ?? '']);
    const [run] = t.runs.runs;
    expect(run?.callStarts[1]?.valuesText).toContain('The person has selected these elements in view, by key: n2.');
    expect(run?.callStarts[0]?.valuesText).toContain('(selected)');
    expect(JSON.stringify(t.r.events)).not.toContain('The person has selected');
    expect(JSON.stringify(t.r.events)).not.toContain('(selected)');
    expect(JSON.stringify(stored(t))).not.toContain('selected');
  });
});
